import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import {
  runWorker,
  workerExitCode,
} from "@dsh-dsworker/worker-kernel";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";
import {
  sha256Utf8,
  stableStringify,
  utf8Bytes,
} from "../../packages/plugin-request-trace/src/canonical.js";
import { createTransientProfileRuntime } from "../../packages/worker-kernel/src/transient-runtime.js";
import {
  loadPythonArgvLexerContract,
  materializePythonArgvLexer,
  TEST_BASE_ENVIRONMENT,
} from "../helpers/task-check-fixtures.mjs";

const EXPECTED_SYSTEM_SHA =
  "a9f1dd473d1921667863cd1a7ad3f59ef11d9b9f3123063da426d9ec1014a7e0";
const EXPECTED_BOUND_TOOLS_SHA =
  "182fd310541d14b80cfcba00837587894dd42f34a60ca089e9411f1835db700e";
const SCRIPTED_PROVIDER = "worker-scripted-provider";
const SCRIPTED_MODEL = "worker-scripted-model";
const execFileAsync = promisify(execFile);

function toolCallChunks(name, callId, args) {
  const raw = JSON.stringify(args);
  const block = { type: "tool-call", id: callId, name, arguments: raw };
  return [
    { type: "block-start", index: 0, blockType: "tool-call" },
    {
      type: "tool-call-delta",
      index: 0,
      id: callId,
      name,
      argumentsDelta: raw,
    },
    { type: "block-end", index: 0, block },
    { type: "usage", usage: { inputTokens: 8, cacheReadTokens: 0, outputTokens: 2 } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
}

function textChunks(text) {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 8, cacheReadTokens: 0, outputTokens: 2 } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

class ScriptedAdapter extends LlmAdapter {
  constructor(script) {
    super();
    this.script = script;
    this.requests = [];
  }

  providerInfo(provider) {
    return { id: provider, name: "Worker scripted adapter" };
  }

  async *stream(options) {
    this.requests.push(options);
    for (const chunk of this.script(this.requests.length, options)) yield chunk;
  }
}

function scriptedRuntimeFactory(adapter, state) {
  return async (binding) => {
    state.workspaceRoot = binding.workspaceRoot;
    const transient = await createTransientProfileRuntime(binding);
    const registration = transient.ctx.llm.registerAdapter(
      [SCRIPTED_PROVIDER],
      adapter,
    );
    let disposed = false;
    return {
      ctx: {
        agents: transient.ctx.agents,
        agentDefaultModel: {
          currentSelection: () => ({
            provider: SCRIPTED_PROVIDER,
            model: SCRIPTED_MODEL,
          }),
        },
        agentPresets: transient.ctx.agentPresets,
        subprocess: transient.ctx.subprocess,
        pathGuard: transient.ctx.pathGuard,
        taskCheckTool: transient.ctx.taskCheckTool,
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        registration();
        await transient.dispose();
        state.runtimeDisposed = true;
        if (state.failRuntimeDispose) throw new Error("test-only runtime cleanup failure");
      },
    };
  };
}

async function sourceFixture(kind) {
  const root = await mkdtemp("/tmp/dsh-dsworker-worker-source.");
  const source = join(root, "source");
  await mkdir(source);
  await materializePythonArgvLexer(source, kind);
  return { root, source };
}

async function gitSourceFixture() {
  const root = await mkdtemp("/tmp/dsh-dsworker-worker-git-source.");
  const source = join(root, "source");
  await mkdir(source);
  await execFileAsync("git", ["init", "--quiet", source]);
  await writeFile(join(source, "tracked.txt"), "baseline\n", "utf8");
  await execFileAsync("git", ["-C", source, "add", "tracked.txt"]);
  await execFileAsync("git", [
    "-C",
    source,
    "-c",
    "user.name=dsh-dsworker tests",
    "-c",
    "user.email=dsh-dsworker@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "baseline",
  ]);
  return { root, source };
}

function gitBootstrapContract() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "worker-git-bootstrap",
      objective: "Run task_check without invoking Bash.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: [{ path: "tracked.txt", kind: "file" }],
        immutable: [{ path: ".git", kind: "directory" }],
      },
      commands: {
        semantic: [
          {
            id: "semantic-noop",
            executable: "true",
            argv: [],
            cwd: { kind: "workspace-root" },
            environment: {},
            timeoutMs: 10_000,
            expected: { exitCodes: [0] },
          },
        ],
        validation: [],
        finish: [],
      },
      retry: { mode: "none", maxAttempts: 1 },
      terminal: {
        success: "all-authoritative-commands-pass",
        failure: "fail-closed",
      },
    },
  });
}

function assertCleanup(result, state) {
  assert.deepEqual(
    {
      taskCheckToolBinding: result.cleanup.taskCheckToolBinding,
      pathGuardBinding: result.cleanup.pathGuardBinding,
      agent: result.cleanup.agent,
      taskCheckBinding: result.cleanup.taskCheckBinding,
      workspaceDeltaBinding: result.cleanup.workspaceDeltaBinding,
      containmentRuntimeBinding: result.cleanup.containmentRuntimeBinding,
      runtime: result.cleanup.runtime,
      executionContainment: result.cleanup.executionContainment,
      workspace: result.cleanup.workspace,
    },
    {
      taskCheckToolBinding: "disposed",
      pathGuardBinding: "disposed",
      agent: "disposed",
      taskCheckBinding: "disposed",
      workspaceDeltaBinding: "disposed",
      containmentRuntimeBinding: "disposed",
      runtime: "disposed",
      executionContainment: "disposed",
      workspace: "disposed",
    },
  );
  assert.equal(state.runtimeDisposed, true);
  assert.equal(existsSync(state.workspaceRoot), false);
}

test("real rc.6 worker lifecycle maps authoritative GREEN and preserves pinned geometry", async () => {
  const fixture = await sourceFixture("green");
  const contract = await loadPythonArgvLexerContract();
  const adapter = new ScriptedAdapter(() =>
    toolCallChunks("task_check", "worker-green-check", {}),
  );
  const state = {};
  const sourceLexerBefore = await readFile(join(fixture.source, "lexer.py"));
  try {
    const result = await runWorker({
      contract,
      sourceWorkspaceRoot: fixture.source,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      runtimeFactory: scriptedRuntimeFactory(adapter, state),
      sessionId: "worker-green-session",
    });
    assert.equal(result.status, "green");
    assert.equal(result.code, "authoritative-green");
    assert.equal(workerExitCode(result), 0);
    assert.equal(result.authoritative.observed, true);
    assert.equal(result.authoritative.status, "green");
    assert.equal(result.authoritative.taskCheckResult.status, "green");
    assert.equal(result.delta.promotable, true);
    assert.deepEqual(result.delta.changedPaths, []);
    assert.equal(result.lifecycle.turnReason.kind, "completed");
    assert.equal(result.lifecycle.modelRequestCount, 1);
    assert.deepEqual(result.lifecycle.toolCalls.map((call) => call.name), ["task_check"]);
    assert.deepEqual(result.modelSelection, {
      provider: SCRIPTED_PROVIDER,
      model: SCRIPTED_MODEL,
      reasoningEffort: null,
    });
    assert.equal(adapter.requests.length, 1);
    const request = adapter.requests[0];
    assert.equal(utf8Bytes(request.system), 1544);
    assert.equal(sha256Utf8(request.system), EXPECTED_SYSTEM_SHA);
    const toolsCanonical = stableStringify(request.tools);
    assert.equal(utf8Bytes(toolsCanonical), 7350);
    assert.equal(sha256Utf8(toolsCanonical), EXPECTED_BOUND_TOOLS_SHA);
    assert.deepEqual(
      request.tools.map((tool) => tool.name).sort(),
      ["bash", "edit", "glob", "grep", "read", "task_check", "write"],
    );
    assert.equal(request.messages.length, 1);
    assert.equal(request.messages[0].content[0].text, contract.authority.objective);
    assert.equal(request.provider, SCRIPTED_PROVIDER);
    assert.equal(request.model, SCRIPTED_MODEL);
    assertCleanup(result, state);
    assert.deepEqual(await readFile(join(fixture.source, "lexer.py")), sourceLexerBefore);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("authoritative RED synchronously stops rc.6 before model request two without relabeling", async () => {
  const fixture = await sourceFixture("initial");
  const contract = await loadPythonArgvLexerContract();
  const adapter = new ScriptedAdapter((requestIndex) =>
    requestIndex === 1
      ? toolCallChunks("task_check", "worker-red-check", {})
      : textChunks("THIS SECOND REQUEST MUST NOT OCCUR"),
  );
  const state = {};
  try {
    const result = await runWorker({
      contract,
      sourceWorkspaceRoot: fixture.source,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      runtimeFactory: scriptedRuntimeFactory(adapter, state),
      sessionId: "worker-red-session",
    });
    assert.equal(adapter.requests.length, 1);
    assert.equal(result.status, "red");
    assert.equal(result.code, "authoritative-red");
    assert.equal(result.authoritative.status, "red");
    assert.equal(result.authoritative.taskCheckResult.status, "red");
    assert.equal(result.delta, null);
    assert.equal(result.lifecycle.turnReason.kind, "aborted");
    assert.equal(result.lifecycle.turnReason.reasonKind, "hook");
    assert.equal(result.lifecycle.stepCount, 1);
    assert.equal(workerExitCode(result), 1);
    assertCleanup(result, state);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cleanup failure after authoritative GREEN suppresses the promotable delta", async () => {
  const fixture = await sourceFixture("green");
  const contract = await loadPythonArgvLexerContract();
  const adapter = new ScriptedAdapter(() =>
    toolCallChunks("task_check", "worker-green-cleanup-failure", {}),
  );
  const state = { failRuntimeDispose: true };
  try {
    const result = await runWorker({
      contract,
      sourceWorkspaceRoot: fixture.source,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      runtimeFactory: scriptedRuntimeFactory(adapter, state),
      sessionId: "worker-green-cleanup-failure-session",
    });
    assert.equal(result.status, "red");
    assert.equal(result.code, "cleanup-failure");
    assert.equal(result.authoritative.status, "green");
    assert.equal(result.delta, null);
    assert.equal(result.cleanup.runtime, "failed");
    assert.equal(result.cleanup.workspace, "disposed");
    assert.equal(existsSync(state.workspaceRoot), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function abortContract() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "worker-authoritative-abort",
      objective: "Run the authoritative checker once and await cancellation.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: { mutable: [{ path: "started.txt", kind: "file" }], immutable: [] },
      commands: {
        semantic: [
          {
            id: "wait-for-worker-abort",
            executable: "node",
            argv: [
              "-e",
              "require('node:fs').writeFileSync('started.txt', 'started'); setInterval(() => {}, 1000)",
            ],
            cwd: { kind: "workspace-root" },
            environment: {},
            timeoutMs: 60_000,
            expected: { exitCodes: [0] },
          },
        ],
        validation: [],
        finish: [],
      },
      retry: { mode: "none", maxAttempts: 1 },
      terminal: {
        success: "all-authoritative-commands-pass",
        failure: "fail-closed",
      },
    },
  });
}

function containedBashContract() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "worker-contained-bash",
      objective: "Create done.txt with the exact text ok, then run task_check.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: { mutable: [{ path: "done.txt", kind: "file" }], immutable: [] },
      commands: {
        semantic: [
          {
            id: "verify-done",
            executable: "node",
            argv: [
              "-e",
              "const f=require('node:fs');process.exit(f.readFileSync('done.txt','utf8')==='ok\\n'?0:9)",
            ],
            cwd: { kind: "workspace-root" },
            environment: {},
            timeoutMs: 10_000,
            expected: { exitCodes: [0] },
          },
        ],
        validation: [],
        finish: [],
      },
      retry: { mode: "none", maxAttempts: 1 },
      terminal: {
        success: "all-authoritative-commands-pass",
        failure: "fail-closed",
      },
    },
  });
}

function zigCacheWorkerContract() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "worker-model-bash-private-zig-cache",
      objective: "Make one legitimate Zig source edit, run Zig, then call task_check.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: { mutable: [{ path: "task.zig", kind: "file" }], immutable: [] },
      commands: {
        semantic: [
          {
            id: "verify-zig-source",
            executable: "zig",
            argv: ["test", "task.zig"],
            cwd: { kind: "workspace-root" },
            environment: {
              ZIG_GLOBAL_CACHE_DIR: "/tmp/zig-cache/global",
              ZIG_LOCAL_CACHE_DIR: "/tmp/zig-cache/local",
            },
            timeoutMs: 120_000,
            expected: { exitCodes: [0] },
          },
        ],
        validation: [],
        finish: [],
      },
      retry: { mode: "none", maxAttempts: 1 },
      terminal: {
        success: "all-authoritative-commands-pass",
        failure: "fail-closed",
      },
    },
  });
}

test("full rc.6 worker bootstrap is Git-index-neutral before any model Bash call", async () => {
  const { root, source } = await gitSourceFixture();
  const contract = gitBootstrapContract();
  const adapter = new ScriptedAdapter(() =>
    toolCallChunks("task_check", "worker-git-bootstrap-check", {}),
  );
  const state = {};
  try {
    const result = await runWorker({
      contract,
      sourceWorkspaceRoot: source,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      runtimeFactory: scriptedRuntimeFactory(adapter, state),
      sessionId: "worker-git-bootstrap-session",
    });
    assert.equal(adapter.requests.length, 1);
    assert.equal(result.lifecycle.modelRequestCount, 1);
    assert.deepEqual(result.lifecycle.toolCalls.map((call) => call.name), [
      "task_check",
    ]);
    assert.equal(result.status, "green");
    assert.equal(result.code, "authoritative-green");
    assert.deepEqual(
      result.authoritative.taskCheckResult.scope.preCommands.changedPaths,
      [],
    );
    assert.deepEqual(
      result.authoritative.taskCheckResult.scope.postCommands.changedPaths,
      [],
    );
    assert.equal(result.authoritative.taskCheckResult.immutable.ok, true);
    assert.deepEqual(result.delta.changedPaths, []);
    assertCleanup(result, state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real rc.6 worker permits source edit plus read-only Git inspection with immutable .git", async () => {
  const { root, source } = await gitSourceFixture();
  const contract = gitBootstrapContract();
  const adapter = new ScriptedAdapter((requestIndex) =>
    requestIndex === 1
      ? toolCallChunks("bash", "worker-git-read-only-call", {
          command:
            "printf 'changed\\n' > tracked.txt; git status --short >/dev/null; git status --porcelain >/dev/null; git diff --check",
          description: "Edit source and inspect Git without changing metadata",
        })
      : toolCallChunks("task_check", "worker-git-read-only-check", {}),
  );
  const state = {};
  try {
    const result = await runWorker({
      contract,
      sourceWorkspaceRoot: source,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      runtimeFactory: scriptedRuntimeFactory(adapter, state),
      sessionId: "worker-git-read-only-session",
    });
    assert.equal(adapter.requests.length, 2);
    assert.equal(result.lifecycle.modelRequestCount, 2);
    assert.deepEqual(result.lifecycle.toolCalls.map((call) => call.name), [
      "bash",
      "task_check",
    ]);
    assert.equal(result.status, "green");
    assert.equal(result.code, "authoritative-green");
    assert.deepEqual(
      result.authoritative.taskCheckResult.scope.preCommands.changedPaths,
      ["tracked.txt"],
    );
    assert.deepEqual(
      result.authoritative.taskCheckResult.scope.postCommands.changedPaths,
      ["tracked.txt"],
    );
    assert.equal(result.authoritative.taskCheckResult.immutable.ok, true);
    assert.deepEqual(result.delta.changedPaths, ["tracked.txt"]);
    assert.deepEqual(result.containment.boundaries.immutableGit, {
      status: "read-only",
      contractSha256: contract.contractSha256,
      path: ".git",
      kind: "directory",
      mountTargets: ["workspace-native/.git", "/workspace/.git"],
    });
    for (const request of adapter.requests) {
      assert.equal(utf8Bytes(request.system), 1544);
      assert.equal(sha256Utf8(request.system), EXPECTED_SYSTEM_SHA);
      const toolsCanonical = stableStringify(request.tools);
      assert.equal(utf8Bytes(toolsCanonical), 7350);
      assert.equal(sha256Utf8(toolsCanonical), EXPECTED_BOUND_TOOLS_SHA);
    }
    assertCleanup(result, state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real rc.6 AgentLoop routes model Bash through containment before task_check", async () => {
  const fixtureRoot = await mkdtemp("/tmp/dsh-dsworker-worker-bash-source.");
  const source = join(fixtureRoot, "source");
  const outside = join(fixtureRoot, "outside.txt");
  await mkdir(source);
  await writeFile(outside, "guard\n", "utf8");
  const contract = containedBashContract();
  const adapter = new ScriptedAdapter((requestIndex) =>
    requestIndex === 1
      ? toolCallChunks("bash", "worker-contained-bash-call", {
          command: `printf bad > '${outside}' 2>/dev/null || true; printf 'ok\\n' > done.txt`,
          description: "Create contained completion file",
        })
      : toolCallChunks("task_check", "worker-contained-bash-check", {}),
  );
  const state = {};
  try {
    const result = await runWorker({
      contract,
      sourceWorkspaceRoot: source,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      runtimeFactory: scriptedRuntimeFactory(adapter, state),
      sessionId: "worker-contained-bash-session",
    });
    assert.equal(adapter.requests.length, 2);
    assert.equal(result.lifecycle.modelRequestCount, 2);
    assert.deepEqual(result.lifecycle.toolCalls.map((call) => call.name), [
      "bash",
      "task_check",
    ]);
    assert.equal(result.status, "green");
    assert.equal(result.code, "authoritative-green");
    assert.deepEqual(result.authoritative.taskCheckResult.scope.postCommands.changedPaths, [
      "done.txt",
    ]);
    assert.deepEqual(result.delta.changedPaths, ["done.txt"]);
    assert.equal(result.delta.changes[0].kind, "create");
    assert.equal(
      Buffer.from(result.delta.changes[0].afterContentBase64, "base64").toString("utf8"),
      "ok\n",
    );
    assert.equal(await readFile(outside, "utf8"), "guard\n");
    assert.equal(existsSync(join(source, "done.txt")), false);
    assert.equal(result.containment.backend, "bubblewrap");
    assert.ok(result.containment.preparedExecutions >= 2);
    for (const request of adapter.requests) {
      assert.equal(utf8Bytes(request.system), 1544);
      assert.equal(sha256Utf8(request.system), EXPECTED_SYSTEM_SHA);
      const toolsCanonical = stableStringify(request.tools);
      assert.equal(utf8Bytes(toolsCanonical), 7350);
      assert.equal(sha256Utf8(toolsCanonical), EXPECTED_BOUND_TOOLS_SHA);
    }
    assertCleanup(result, state);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("real rc.6 WorkerKernel keeps ordinary model-Bash Zig caches out of task authority", async () => {
  const fixtureRoot = await mkdtemp("/tmp/dsh-dsworker-worker-zig-cache-source.");
  const source = join(fixtureRoot, "source");
  await mkdir(source);
  await writeFile(
    join(source, "task.zig"),
    "const std = @import(\"std\");\ntest \"task\" { try std.testing.expectEqual(@as(u8, 1), 1); }\n",
    "utf8",
  );
  const contract = zigCacheWorkerContract();
  const adapter = new ScriptedAdapter((requestIndex) =>
    requestIndex === 1
      ? toolCallChunks("bash", "worker-zig-cache-bash", {
          command:
            "printf '\\n// legitimate model edit\\n' >> task.zig; zig test task.zig",
          description: "Edit and test Zig source using runner-owned private caches",
        })
      : toolCallChunks("task_check", "worker-zig-cache-check", {}),
  );
  const state = {};
  try {
    const result = await runWorker({
      contract,
      sourceWorkspaceRoot: source,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      runtimeFactory: scriptedRuntimeFactory(adapter, state),
      sessionId: "worker-zig-cache-session",
    });
    assert.equal(adapter.requests.length, 2);
    assert.deepEqual(result.lifecycle.toolCalls.map((call) => call.name), [
      "bash",
      "task_check",
    ]);
    assert.equal(result.status, "green");
    assert.equal(result.code, "authoritative-green");
    assert.deepEqual(
      result.authoritative.taskCheckResult.scope.preCommands.changedPaths,
      ["task.zig"],
    );
    assert.deepEqual(
      result.authoritative.taskCheckResult.scope.postCommands.changedPaths,
      ["task.zig"],
    );
    assert.equal(
      result.authoritative.taskCheckResult.scope.findings.some((finding) =>
        finding.path.startsWith(".zig-cache"),
      ),
      false,
    );
    assert.deepEqual(result.delta.changedPaths, ["task.zig"]);
    for (const request of adapter.requests) {
      assert.equal(utf8Bytes(request.system), 1544);
      assert.equal(sha256Utf8(request.system), EXPECTED_SYSTEM_SHA);
      const toolsCanonical = stableStringify(request.tools);
      assert.equal(utf8Bytes(toolsCanonical), 7350);
      assert.equal(sha256Utf8(toolsCanonical), EXPECTED_BOUND_TOOLS_SHA);
    }
    assertCleanup(result, state);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("external cancellation during task_check yields one authoritative ABORTED outcome", async () => {
  const fixtureRoot = await mkdtemp("/tmp/dsh-dsworker-worker-abort-source.");
  const source = join(fixtureRoot, "source");
  await mkdir(source);
  const contract = abortContract();
  const adapter = new ScriptedAdapter(() =>
    toolCallChunks("task_check", "worker-aborted-check", {}),
  );
  const state = {};
  const controller = new AbortController();
  try {
    const running = runWorker({
      contract,
      sourceWorkspaceRoot: source,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      runtimeFactory: scriptedRuntimeFactory(adapter, state),
      sessionId: "worker-aborted-session",
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (
        state.workspaceRoot !== undefined &&
        existsSync(join(state.workspaceRoot, "started.txt"))
      ) {
        break;
      }
      await delay(10);
    }
    assert.equal(existsSync(join(state.workspaceRoot, "started.txt")), true);
    controller.abort();
    const result = await running;
    assert.equal(adapter.requests.length, 1);
    assert.equal(result.status, "aborted");
    assert.equal(result.code, "authoritative-aborted");
    assert.equal(result.authoritative.status, "aborted");
    assert.equal(result.authoritative.taskCheckResult.status, "aborted");
    assert.equal(result.delta, null);
    assert.equal(result.lifecycle.turnReason.kind, "aborted");
    assert.equal(result.lifecycle.turnReason.reasonKind, "user");
    assert.equal(workerExitCode(result), 2);
    assertCleanup(result, state);
  } finally {
    controller.abort();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("missing terminal observation is a typed RED infrastructure failure", async () => {
  const fixture = await sourceFixture("green");
  const contract = await loadPythonArgvLexerContract();
  const adapter = new ScriptedAdapter(() => textChunks("model says done"));
  const state = {};
  try {
    const result = await runWorker({
      contract,
      sourceWorkspaceRoot: fixture.source,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      runtimeFactory: scriptedRuntimeFactory(adapter, state),
      sessionId: "worker-missing-terminal-session",
    });
    assert.equal(adapter.requests.length, 1);
    assert.equal(result.status, "red");
    assert.equal(result.code, "missing-terminal-observation");
    assert.equal(result.authoritative.observed, false);
    assert.equal(result.delta, null);
    assert.deepEqual(result.failures, [
      { category: "infrastructure", code: "missing-terminal-observation" },
    ]);
    assertCleanup(result, state);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("malformed task_check invocation stops before request two as infrastructure RED", async () => {
  const fixture = await sourceFixture("green");
  const contract = await loadPythonArgvLexerContract();
  const adapter = new ScriptedAdapter((requestIndex) =>
    requestIndex === 1
      ? toolCallChunks("task_check", "worker-malformed-check", { unexpected: true })
      : textChunks("THIS SECOND REQUEST MUST NOT OCCUR"),
  );
  const state = {};
  try {
    const result = await runWorker({
      contract,
      sourceWorkspaceRoot: fixture.source,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      runtimeFactory: scriptedRuntimeFactory(adapter, state),
      sessionId: "worker-malformed-terminal-session",
    });
    assert.equal(adapter.requests.length, 1);
    assert.equal(result.status, "red");
    assert.equal(result.code, "malformed-terminal-observation");
    assert.equal(result.authoritative.observed, false);
    assert.equal(result.delta, null);
    assert.equal(result.authoritative.code, "missing-host-verdict");
    assert.deepEqual(result.failures, [
      { category: "infrastructure", code: "malformed-terminal-observation" },
    ]);
    assertCleanup(result, state);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
