import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { boot } from "@deepseek-ai/dsh-app-boot";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { defineTool, ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";
import {
  createExecutionContainment,
  disposeExecutionContainment,
} from "@dsh-dsworker/execution-containment";
import * as PathGuardModule from "@dsh-dsworker/plugin-path-guard";
import { materializeProfile } from "../../scripts/materialize-profile.mjs";
import { rc6CliPath, REPO_ROOT } from "../../scripts/local-resolution.mjs";

const DSH_CLI = rc6CliPath();

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function contractForFixture() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "path-guard-rc6-integration",
      objective: "Exercise only structured filesystem mutation guards.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: [
          { path: "created.py", kind: "file" },
          { path: "deep/level/new.py", kind: "file" },
          { path: "lexer.py", kind: "file" },
          { path: "linked-parent-in/file.py", kind: "file" },
          { path: "linked-parent-out/file.py", kind: "file" },
          { path: "linked-target.py", kind: "file" },
          { path: "missing-parent/new.py", kind: "file" },
          { path: "src", kind: "directory" },
          { path: "unicode/雪/檔案.py", kind: "file" },
        ],
        immutable: [
          {
            path: "test_lexer.py",
            kind: "file",
            sha256: sha256('AUTHORITY = "immutable"\n'),
          },
        ],
      },
      commands: {
        semantic: [
          {
            id: "not-executed",
            executable: "python",
            argv: ["-m", "pytest", "-q", "test_lexer.py"],
            cwd: { kind: "workspace-root" },
            environment: { PYTHONDONTWRITEBYTECODE: "1" },
            timeoutMs: 30_000,
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

function cleanEnvironment(dshHome) {
  return {
    PATH: "/usr/bin:/bin",
    DSH_HOME: dshHome,
    DSH_REQUEST_TRACE_PATH: join(dshHome, "traces", "requests.jsonl"),
    DSH_TELEMETRY_DISABLED: "1",
  };
}

async function dumpTransientConfig(dshHome) {
  const materialized = await materializeProfile(dshHome);
  const output = join(materialized.profileDir, "composed.cordis.yml");
  const dumpFile = await open(output, "w", 0o600);
  try {
    const result = spawnSync(
      process.execPath,
      [DSH_CLI, "--profile", "headless-dev", "--dump-config"],
      {
        cwd: REPO_ROOT,
        env: cleanEnvironment(dshHome),
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", dumpFile.fd, "pipe"],
      },
    );
    assert.equal(
      result.status,
      0,
      `dump-config failed: ${result.stderr ?? result.stdout ?? ""}`,
    );
  } finally {
    await dumpFile.close();
  }
  return { configPath: output, materialized };
}

async function writeFixture(workspace, outer) {
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "src-other"), { recursive: true });
  await mkdir(join(workspace, "deep", "level"), { recursive: true });
  await mkdir(join(workspace, "unicode", "雪"), { recursive: true });
  await mkdir(join(workspace, "real-parent"), { recursive: true });
  await mkdir(join(outer, "outside"), { recursive: true });
  await writeFile(join(workspace, "lexer.py"), 'value = "old"\n', "utf8");
  await writeFile(
    join(workspace, "test_lexer.py"),
    'AUTHORITY = "immutable"\n',
    "utf8",
  );
  await writeFile(join(workspace, "src", "inside.py"), "inside = 1\n", "utf8");
  await writeFile(
    join(workspace, "src-other", "outside.py"),
    "outside = 1\n",
    "utf8",
  );
  await writeFile(
    join(workspace, "real-parent", "file.py"),
    "linked = 1\n",
    "utf8",
  );
  await writeFile(join(outer, "outside", "file.py"), "outside = 1\n", "utf8");
  await symlink("real-parent", join(workspace, "linked-parent-in"));
  await symlink(join(outer, "outside"), join(workspace, "linked-parent-out"));
  await symlink("lexer.py", join(workspace, "linked-target.py"));
}

test("real rc.6 ToolRuntime guards lean structured filesystem mutations", async () => {
  const temp = await mkdtemp("/tmp/dsh-dsworker-path-guard.");
  const dshHome = join(temp, "home");
  const workspace = join(temp, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFixture(workspace, temp);
  const immutablePath = join(workspace, "test_lexer.py");
  const immutableBefore = sha256(await readFile(immutablePath));
  const { configPath } = await dumpTransientConfig(dshHome);
  const priorDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  let root;
  let handle;
  let guardBinding;
  let executionContainment;
  let subprocessBinding;
  try {
    root = await boot("dsh-dsworker-path-guard-test", configPath, [
      { id: "request-trace", disabled: true },
    ]);
    assert.ok(root.get("pathGuard", false), "path-guard Loader row is not active");
    executionContainment = await createExecutionContainment({ workspaceRoot: workspace });
    subprocessBinding = root.subprocess.bindExecutionContainment(executionContainment);
    handle = await root.agents.create({
      sessionId: SessionId("path-guard-rc6-session"),
      meta: { cwd: workspace },
      agentOptions: { provider: "unused-fake", model: "unused-model" },
      setup: async (agentCtx) => {
        await root.agentPresets.mount(agentCtx, "lean-coding");
      },
    });
    const decisions = [];
    guardBinding = root.pathGuard.bind(handle.agent, contractForFixture(), {
      onDecision: (record) => decisions.push(record),
    });
    assert.equal(guardBinding.workspaceRoot, workspace);
    assert.equal(guardBinding.policy.contract, guardBinding.contract);

    const bodyStage = [];
    root.on(
      "tools/execute",
      async (exec, next) => {
        bodyStage.push({ callId: exec.callId, name: exec.name });
        return next();
      },
      { global: true },
    );
    let callIndex = 0;
    const call = async (name, args) => {
      callIndex += 1;
      return root.tools.execute({
        callId: `path-guard-call-${callIndex}`,
        name,
        arguments: args,
        agent: handle.agent,
        signal: new AbortController().signal,
      });
    };
    const assertDeniedBeforeBody = async (name, args, verify) => {
      const before = bodyStage.length;
      const result = await call(name, args);
      assert.equal(result.isError, true);
      assert.match(result.error.message, /path guard denied structured mutation/u);
      assert.equal(bodyStage.length, before, "denied call reached tools/execute");
      await verify();
      return result;
    };

    const readMutable = await call("read", { file_path: "lexer.py" });
    assert.equal(readMutable.isError, false);
    const edit = await call("edit", {
      file_path: "lexer.py",
      old_string: 'value = "old"',
      new_string: 'value = "edited"',
    });
    assert.equal(edit.isError, false, edit.error?.message);
    assert.equal(await readFile(join(workspace, "lexer.py"), "utf8"), 'value = "edited"\n');

    const replace = await call("write", {
      file_path: "lexer.py",
      content: 'value = "replaced"\n',
    });
    assert.equal(replace.isError, false, replace.error?.message);
    assert.equal(
      await readFile(join(workspace, "lexer.py"), "utf8"),
      'value = "replaced"\n',
    );

    const create = await call("write", {
      file_path: "created.py",
      content: "created = True\n",
    });
    assert.equal(create.isError, false, create.error?.message);
    assert.equal(await readFile(join(workspace, "created.py"), "utf8"), "created = True\n");

    const deep = await call("write", {
      file_path: "deep/level/new.py",
      content: "deep = True\n",
    });
    assert.equal(deep.isError, false, deep.error?.message);
    const unicode = await call("write", {
      file_path: "unicode/雪/檔案.py",
      content: "snow = True\n",
    });
    assert.equal(unicode.isError, false, unicode.error?.message);

    const readImmutable = await call("read", { file_path: "test_lexer.py" });
    assert.equal(readImmutable.isError, false);
    const glob = await call("glob", { pattern: "*.py" });
    assert.equal(glob.isError, false, glob.error?.message);
    const grep = await call("grep", { pattern: "replaced", path: "." });
    assert.equal(grep.isError, false, grep.error?.message);
    const decisionsBeforeBash = decisions.length;
    const bash = await call("bash", {
      command: "printf path-guard-bash-uncovered",
      description: "Print harmless guard coverage marker",
    });
    assert.equal(bash.isError, false, bash.error?.message);
    assert.equal(
      decisions.length,
      decisionsBeforeBash,
      "path guard must not produce a Bash authority decision",
    );

    await assertDeniedBeforeBody(
      "edit",
      {
        file_path: "test_lexer.py",
        old_string: "immutable",
        new_string: "mutated",
      },
      async () => {
        assert.equal(sha256(await readFile(immutablePath)), immutableBefore);
      },
    );
    await assertDeniedBeforeBody(
      "write",
      { file_path: "foo.py", content: "x\n" },
      async () => assert.equal(existsSync(join(workspace, "foo.py")), false),
    );
    await assertDeniedBeforeBody(
      "write",
      { file_path: "../escape.py", content: "x\n" },
      async () => assert.equal(existsSync(join(temp, "escape.py")), false),
    );
    const absoluteTarget = join(temp, "absolute-escape.py");
    await assertDeniedBeforeBody(
      "write",
      { file_path: absoluteTarget, content: "x\n" },
      async () => assert.equal(existsSync(absoluteTarget), false),
    );
    await assertDeniedBeforeBody(
      "write",
      { file_path: "src-other/new.py", content: "x\n" },
      async () =>
        assert.equal(existsSync(join(workspace, "src-other", "new.py")), false),
    );
    await assertDeniedBeforeBody(
      "write",
      { file_path: "missing-parent/new.py", content: "x\n" },
      async () =>
        assert.equal(existsSync(join(workspace, "missing-parent")), false),
    );
    await assertDeniedBeforeBody(
      "write",
      { file_path: "linked-parent-in/file.py", content: "x\n" },
      async () =>
        assert.equal(
          await readFile(join(workspace, "real-parent", "file.py"), "utf8"),
          "linked = 1\n",
        ),
    );
    await assertDeniedBeforeBody(
      "write",
      { file_path: "linked-parent-out/file.py", content: "x\n" },
      async () =>
        assert.equal(
          await readFile(join(temp, "outside", "file.py"), "utf8"),
          "outside = 1\n",
        ),
    );
    await assertDeniedBeforeBody(
      "write",
      { file_path: "linked-target.py", content: "x\n" },
      async () =>
        assert.equal(
          await readFile(join(workspace, "lexer.py"), "utf8"),
          'value = "replaced"\n',
        ),
    );

    assert.ok(
      decisions.some(
        (record) =>
          record.finalGuardDecision === "permit" &&
          record.operation === "edit-file",
      ),
    );
    assert.ok(
      decisions.some(
        (record) =>
          record.finalGuardDecision === "permit" &&
          record.operation === "create-file",
      ),
    );
    assert.ok(
      decisions.some(
        (record) =>
          record.finalGuardDecision === "deny" &&
          record.denialCode === "target-symlink",
      ),
    );
    assert.ok(decisions.every((record) => Object.isFrozen(record)));
    assert.ok(
      decisions.every(
        (record) => record.contractSha256 === guardBinding.contractSha256,
      ),
    );
    assert.equal(
      decisions.some((record) => record.toolName === "bash"),
      false,
      "path guard must not claim to police bash",
    );
  } finally {
    guardBinding?.dispose();
    if (handle !== undefined) await handle.dispose();
    subprocessBinding?.dispose();
    if (root !== undefined) await root.fiber.dispose();
    if (executionContainment !== undefined) {
      disposeExecutionContainment(executionContainment);
    }
    if (priorDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorDshHome;
    await rm(temp, { recursive: true, force: true });
  }
});

test("rc.6 guard disposal removes both proof listener and monotonic guard", async () => {
  const temp = await mkdtemp("/tmp/dsh-dsworker-path-guard-dispose.");
  const root = new Context();
  try {
    await root.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      persona: "Host-only disposal fixture.",
    });
    await root.plugin(ToolRuntime, { mode: "native" });
    await root.plugin(LocalFileSystem, { cwd: temp });
    root.provide("agents", { get: () => undefined });
    let bodyCalls = 0;
    root.tools.register(
      defineTool({
        name: "write",
        description: "Test-only body counter.",
        parameters: {
          file_path: { type: "string", required: true },
          content: { type: "string", required: true },
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
        },
        async execute() {
          bodyCalls += 1;
          return "executed";
        },
      }),
    );
    const guardFiber = root.plugin(PathGuardModule);
    await guardFiber;
    const input = {
      callId: "dispose-before",
      name: "write",
      arguments: { file_path: "fixture.txt", content: "x" },
      signal: new AbortController().signal,
    };
    const denied = await root.tools.execute(input);
    assert.equal(denied.isError, true);
    assert.equal(bodyCalls, 0);
    assert.ok(root.get("pathGuard", false));

    await guardFiber.dispose();
    assert.equal(root.get("pathGuard", false), undefined);
    const allowed = await root.tools.execute({ ...input, callId: "dispose-after" });
    assert.equal(allowed.isError, false, allowed.error?.message);
    assert.equal(bodyCalls, 1);
  } finally {
    await root.fiber.dispose();
    await rm(temp, { recursive: true, force: true });
  }
});

test("rc.6 resolves pre-execute approval before the monotonic path guard", async () => {
  const temp = await mkdtemp("/tmp/dsh-dsworker-path-guard-order.");
  const workspace = join(temp, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "lexer.py"), "value = 1\n", "utf8");
  const root = new Context();
  let binding;
  try {
    await root.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      persona: "Approval ordering fixture.",
    });
    await root.plugin(ToolRuntime, { mode: "native" });
    await root.plugin(LocalFileSystem, { cwd: workspace });
    let bodyCalls = 0;
    root.tools.register(
      defineTool({
        name: "write",
        description: "Test approval ordering.",
        parameters: {
          file_path: { type: "string", required: true },
          content: { type: "string", required: true },
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
        },
        async execute() {
          bodyCalls += 1;
          return "executed";
        },
      }),
    );
    const fakeAgent = {
      id: SessionId("ordering-session"),
      session: { header: Object.freeze({ cwd: workspace }) },
    };
    root.provide("agents", {
      get(id) {
        return id === fakeAgent.id ? fakeAgent : undefined;
      },
    });
    await root.plugin(PathGuardModule);
    binding = root.pathGuard.bind(fakeAgent, contractForFixture());
    const order = [];
    root.on(
      "tools/pre-execute",
      async (_exec, _next) => {
        order.push("pre-ask");
        return { kind: "ask", reason: "ordering proof" };
      },
      { global: true },
    );
    root.provide("approval", {
      async request() {
        order.push("approval");
        return "allowed-once";
      },
    });
    const decisionRecords = [];
    binding.dispose();
    binding = root.pathGuard.bind(fakeAgent, contractForFixture(), {
      onDecision(record) {
        order.push("guard");
        decisionRecords.push(record);
      },
    });

    const result = await root.tools.execute({
      callId: "approval-order-call",
      name: "write",
      arguments: { file_path: "foo.py", content: "x" },
      agent: fakeAgent,
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, true);
    assert.deepEqual(order, ["pre-ask", "approval", "guard"]);
    assert.equal(decisionRecords[0].denialCode, "outside-mutable-authority");
    assert.equal(bodyCalls, 0);
  } finally {
    binding?.dispose();
    await root.fiber.dispose();
    await rm(temp, { recursive: true, force: true });
  }
});
