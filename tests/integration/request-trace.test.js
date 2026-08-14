import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import {
  adapterVisibleRequest,
  stableStringify,
} from "../../packages/plugin-request-trace/src/canonical.js";
import * as RequestTraceModule from "../../packages/plugin-request-trace/src/index.js";
import {
  freezeMessage,
  LlmAdapter,
  LlmRuntime,
  MessageId,
} from "@deepseek-ai/dsh-llm";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { defineTool, ToolRuntime } from "@deepseek-ai/dsh-tools";
import {
  TASK_CONTRACT_VERSION,
  isTaskContract,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";
import {
  compilePathAuthority,
  isCompiledPathAuthority,
} from "@dsh-dsworker/path-authority";
import * as PathGuardModule from "@dsh-dsworker/plugin-path-guard";
import * as TaskCheckPluginModule from "@dsh-dsworker/plugin-task-check";
import { isTaskCheckResult } from "@dsh-dsworker/task-check-core";
import {
  createTaskCheckBinding,
  disposeTaskCheckBinding,
  runTaskCheck,
} from "@dsh-dsworker/task-check-local";

class TwoStepFakeAdapter extends LlmAdapter {
  constructor() {
    super();
    this.requests = [];
    this.frozen = [];
  }

  providerInfo(provider) {
    return { id: provider, name: "Deterministic fake" };
  }

  async *stream(options) {
    this.requests.push(adapterVisibleRequest(options));
    this.frozen.push({
      root: Object.isFrozen(options),
      messages: Object.isFrozen(options.messages),
      tools: options.tools === undefined || Object.isFrozen(options.tools),
      signalAborted: options.signal?.aborted ?? false,
    });

    if (this.requests.length === 1) {
      const block = {
        type: "tool-call",
        id: "call-1",
        name: "echo_fixture",
        arguments: '{"text":"ping"}',
      };
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "call-1",
        name: "echo_fixture",
        argumentsDelta: '{"text":"ping"}',
      };
      yield { type: "block-end", index: 0, block };
      yield {
        type: "usage",
        usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 3 },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }

    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "synthetic complete" };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "text", text: "synthetic complete" },
    };
    yield {
      type: "usage",
      usage: { inputTokens: 2, cacheReadTokens: 8, outputTokens: 2 },
    };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

function deterministicUuidFactory() {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
  };
}

async function runSynthetic({
  trace,
  pathGuard = false,
  sidecar,
  taskContract,
  pathAuthority,
  taskCheckResult,
  taskCheckPlugin = false,
}) {
  if (taskContract !== undefined) assert.equal(isTaskContract(taskContract), true);
  if (pathAuthority !== undefined) {
    assert.equal(isCompiledPathAuthority(pathAuthority), true);
    assert.equal(pathAuthority.contract, taskContract);
    assert.equal(pathAuthority.contractSha256, taskContract.contractSha256);
  }
  if (taskCheckResult !== undefined) {
    assert.equal(isTaskCheckResult(taskCheckResult), true);
    assert.equal(taskCheckResult.contract, taskContract);
    assert.equal(taskCheckResult.contractSha256, taskContract.contractSha256);
  }
  const originalRandomUuid = globalThis.crypto.randomUUID;
  globalThis.crypto.randomUUID = deterministicUuidFactory();
  const root = new Context();
  let handle;
  let guardBinding;
  try {
    await root.plugin(LlmRuntime);
    await root.plugin(SessionStore);
    await root.plugin(AgentRegistry);
    await root.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      persona: "Synthetic coding agent.",
    });
    await root.plugin(ToolRuntime, { mode: "native" });
    await root.plugin(LocalFileSystem, { cwd: "/tmp" });
    await root.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    if (pathGuard) await root.plugin(PathGuardModule);
    if (taskCheckPlugin) await root.plugin(TaskCheckPluginModule);
    if (trace) {
      await root.plugin(RequestTraceModule, { destination: sidecar });
    }

    const adapter = new TwoStepFakeAdapter();
    await root.plugin(
      Object.assign(
        (ctx) => {
          ctx.llm.registerAdapter(["fake"], adapter);
        },
        { inject: ["llm"] },
      ),
    );

    const events = [];
    root.on("session/event", (_session, event) => events.push(event));
    handle = await root.agents.create({
      sessionId: SessionId("synthetic-session"),
      meta: { cwd: "/tmp" },
      agentOptions: { provider: "fake", model: "fake-model" },
      setup(agentCtx) {
        agentCtx.tools.register(
          defineTool({
            name: "echo_fixture",
            description: "Return a deterministic echo value.",
            parameters: {
              text: { type: "string", required: true },
            },
            output: {
              schema: { type: "string" },
              render: (_args, value) => [{ type: "text", text: value }],
            },
            async execute(args) {
              return `echo:${args.text}`;
            },
          }),
        );
      },
    });
    if (pathGuard) {
      guardBinding = root.pathGuard.bind(handle.agent, taskContract);
    }

    handle.agent.followup(
      freezeMessage({
        id: MessageId("msg-user-1"),
        role: "user",
        content: [{ type: "text", text: "Use the echo tool exactly once." }],
        source: { kind: "user" },
      }),
    );
    await handle.agent.whenIdle();

    const trajectory = events
      .filter((event) => event.type === "tool/call" || event.type === "tool/result")
      .map((event) =>
        event.type === "tool/call"
          ? {
              type: event.type,
              callId: event.data.callId,
              name: event.data.name,
              arguments: event.data.arguments,
            }
          : {
              type: event.type,
              callId: event.data.message.source.callId,
              isError: event.data.message.content[0].isError ?? false,
              content: event.data.message.content[0].content,
            },
      );
    const final = events
      .filter((event) => event.type === "assistant/message")
      .at(-1)?.data.message.content;
    const taskCheckPluginMounted =
      root.get("taskCheckTool", false) !== undefined;

    await handle.dispose();
    handle = undefined;
    const cleanAgentDisposal = root.agents.get(SessionId("synthetic-session")) === undefined;
    await root.fiber.dispose();

    return {
      requests: adapter.requests,
      requestBytes: adapter.requests.map((request) =>
        Buffer.from(stableStringify(request), "utf8"),
      ),
      frozen: adapter.frozen,
      eventTypes: events.map((event) => event.type),
      trajectory,
      final,
      cleanAgentDisposal,
      pathGuardMounted: pathGuard,
      pathGuardContractSha256: guardBinding?.contractSha256 ?? null,
      taskCheckPluginMounted:
        taskCheckPluginMounted,
    };
  } finally {
    guardBinding?.dispose();
    if (handle !== undefined) await handle.dispose();
    if (root.fiber.state !== 4) await root.fiber.dispose();
    globalThis.crypto.randomUUID = originalRandomUuid;
  }
}

test("host authority libraries and observer preserve exact adapter-visible requests and trajectory", async () => {
  const temp = await mkdtemp("/tmp/dsh-dsworker-integration.");
  let taskCheckBinding;
  const offSidecar = join(temp, "off", "requests.jsonl");
    const contractSidecar = join(temp, "contract", "requests.jsonl");
    const guardSidecar = join(temp, "guard", "requests.jsonl");
    const onSidecar = join(temp, "on", "requests.jsonl");
  try {
    const off = await runSynthetic({ trace: false, sidecar: offSidecar });
    const taskCheckPluginOnly = await runSynthetic({
      trace: false,
      taskCheckPlugin: true,
      sidecar: join(temp, "task-check-plugin", "requests.jsonl"),
    });
    const taskContract = parseTaskContract({
      authority: {
        version: TASK_CONTRACT_VERSION,
        taskId: "synthetic-host-only",
        objective: "Host-only authority that must never enter the model request.",
        workspace: {
          root: "runner-supplied",
          commandCwdPolicy: "workspace-relative-only",
          symlinkPolicy: "unsupported",
        },
        paths: {
          mutable: [{ path: "fixture.txt", kind: "file" }],
          immutable: [{ path: "authority.txt", kind: "file" }],
        },
        commands: {
          semantic: [
            {
              id: "not-executed",
              executable: "true",
              argv: [],
              cwd: { kind: "workspace-root" },
              environment: {},
              timeoutMs: 1_000,
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
    const pathAuthority = compilePathAuthority(taskContract);
    const taskCheckRoot = join(temp, "task-check");
    await mkdir(taskCheckRoot);
    await writeFile(join(taskCheckRoot, "fixture.txt"), "fixture\n", "utf8");
    await writeFile(join(taskCheckRoot, "authority.txt"), "authority\n", "utf8");
    taskCheckBinding = await createTaskCheckBinding({
      contract: taskContract,
      workspaceRoot: taskCheckRoot,
      baseEnvironment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    const taskCheckResult = await runTaskCheck(taskCheckBinding, {
      contract: taskContract,
      workspaceRoot: taskCheckRoot,
    });
    assert.equal(taskCheckResult.status, "green");
    assert.deepEqual(
      pathAuthority.decide({ operation: "edit-file", path: "fixture.txt" }),
      {
        decision: "allow",
        code: "mutable-file-exact",
        operation: "edit-file",
        requestedPath: "fixture.txt",
        normalizedPath: "fixture.txt",
        matchedAuthority: {
          mode: "mutable",
          relation: "exact",
          path: "fixture.txt",
          kind: "file",
          entry: taskContract.authority.paths.mutable[0],
        },
        pathError: null,
        contractSha256: taskContract.contractSha256,
        boundary: "lexical-only",
        symlinkPolicy: "unsupported",
        requiresFilesystemBinding: true,
        executionAuthorized: false,
      },
    );
    const contractOnly = await runSynthetic({
      trace: false,
      sidecar: contractSidecar,
      taskContract,
      pathAuthority,
      taskCheckResult,
    });
    const guardOnly = await runSynthetic({
      trace: false,
      pathGuard: true,
      sidecar: guardSidecar,
      taskContract,
      pathAuthority,
      taskCheckResult,
    });
    const on = await runSynthetic({
      trace: true,
      pathGuard: true,
      sidecar: onSidecar,
      taskContract,
      pathAuthority,
      taskCheckResult,
    });

    assert.equal(off.requests.length, 2);
    assert.equal(on.requests.length, 2);
    assert.equal(contractOnly.requests.length, 2);
    assert.equal(guardOnly.requests.length, 2);
    assert.equal(taskCheckPluginOnly.requests.length, 2);
    assert.deepEqual(contractOnly.requests, off.requests);
    assert.deepEqual(guardOnly.requests, off.requests);
    assert.deepEqual(taskCheckPluginOnly.requests, off.requests);
    assert.deepEqual(on.requests, off.requests);
    assert.equal(on.requestBytes.length, off.requestBytes.length);
    for (let index = 0; index < off.requestBytes.length; index += 1) {
      assert.equal(
        Buffer.compare(contractOnly.requestBytes[index], off.requestBytes[index]),
        0,
      );
      assert.equal(Buffer.compare(guardOnly.requestBytes[index], off.requestBytes[index]), 0);
      assert.equal(
        Buffer.compare(taskCheckPluginOnly.requestBytes[index], off.requestBytes[index]),
        0,
      );
      assert.equal(Buffer.compare(on.requestBytes[index], off.requestBytes[index]), 0);
    }
    assert.deepEqual(contractOnly.trajectory, off.trajectory);
    assert.deepEqual(contractOnly.final, off.final);
    assert.deepEqual(contractOnly.eventTypes, off.eventTypes);
    assert.deepEqual(guardOnly.trajectory, off.trajectory);
    assert.deepEqual(guardOnly.final, off.final);
    assert.deepEqual(guardOnly.eventTypes, off.eventTypes);
    assert.deepEqual(taskCheckPluginOnly.trajectory, off.trajectory);
    assert.deepEqual(taskCheckPluginOnly.final, off.final);
    assert.deepEqual(taskCheckPluginOnly.eventTypes, off.eventTypes);
    assert.deepEqual(on.trajectory, off.trajectory);
    assert.deepEqual(on.final, off.final);
    assert.deepEqual(on.eventTypes, off.eventTypes);
    assert.equal(on.final[0].text, "synthetic complete");
    assert.deepEqual(
      on.trajectory.map((item) => item.type),
      ["tool/call", "tool/result"],
    );
    assert.ok(on.frozen.every((item) => item.root && item.messages && item.tools));
    assert.ok(on.frozen.every((item) => item.signalAborted === false));
    assert.equal(off.cleanAgentDisposal, true);
    assert.equal(contractOnly.cleanAgentDisposal, true);
    assert.equal(guardOnly.cleanAgentDisposal, true);
    assert.equal(taskCheckPluginOnly.cleanAgentDisposal, true);
    assert.equal(on.cleanAgentDisposal, true);

    assert.equal(existsSync(offSidecar), false);
    assert.equal(existsSync(contractSidecar), false);
    assert.equal(existsSync(guardSidecar), false);
    assert.equal(existsSync(onSidecar), true);
    assert.equal(guardOnly.pathGuardMounted, true);
    assert.equal(guardOnly.pathGuardContractSha256, taskContract.contractSha256);
    assert.equal(taskCheckPluginOnly.taskCheckPluginMounted, true);
    const records = (await readFile(onSidecar, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((record) => record.requestIndex),
      [1, 2],
    );
    assert.deepEqual(records[0].outerToolCallIds, ["call-1"]);
    assert.deepEqual(records[1].outerToolCallIds, []);
    assert.deepEqual(records[0].codeDispatchIds, []);
    assert.equal(records[0].headerChangeReason, "initial");
    assert.equal(records[1].headerChangeReason, null);
    assert.ok(records[0].durableContextCauses.some((cause) => cause.type === "user/message"));
    assert.ok(records[1].durableContextCauses.some((cause) => cause.type === "assistant/message"));
    assert.ok(records[1].durableContextCauses.some((cause) => cause.type === "tool/result"));
    assert.deepEqual(
      [
        records[0].inputTokens,
        records[0].cacheReadTokens,
        records[0].cacheMissTokens,
        records[0].outputTokens,
      ],
      [10, 0, 10, 3],
    );
    assert.deepEqual(
      [
        records[1].inputTokens,
        records[1].cacheReadTokens,
        records[1].cacheMissTokens,
        records[1].outputTokens,
      ],
      [2, 8, 2, 2],
    );
    assert.ok(records.every((record) => record.systemSha256 !== null));
    assert.ok(records.every((record) => record.toolsSha256 !== null));
    assert.ok(records.every((record) => record.messagePrefixSha256 !== null));
    assert.ok(records.every((record) => record.headerDigest !== null));
    assert.ok(records.every((record) => record.compactionGeneration === 0));
    assert.ok(records.every((record) => record.startedAt.endsWith("Z")));
    assert.ok(records.every((record) => record.firstTokenAt?.endsWith("Z")));
    assert.ok(records.every((record) => record.completedAt.endsWith("Z")));
  } finally {
    if (taskCheckBinding !== undefined) disposeTaskCheckBinding(taskCheckBinding);
    await rm(temp, { recursive: true, force: true });
  }
});

test("cancellation reaches quiescence and produces one aborted trace", async () => {
  const temp = await mkdtemp("/tmp/dsh-dsworker-cancel.");
  const sidecar = join(temp, "requests.jsonl");
  const root = new Context();
  let handle;
  try {
    await root.plugin(LlmRuntime);
    await root.plugin(SessionStore);
    await root.plugin(AgentRegistry);
    await root.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      persona: "Cancellation fixture.",
    });
    await root.plugin(ToolRuntime, { mode: "native" });
    await root.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    await root.plugin(RequestTraceModule, { destination: sidecar });

    let announceStart;
    const started = new Promise((resolve) => {
      announceStart = resolve;
    });
    class BlockingAdapter extends LlmAdapter {
      providerInfo(provider) {
        return { id: provider, name: "Blocking fake" };
      }
      async *stream(options) {
        announceStart();
        await new Promise((resolve) => {
          options.signal.addEventListener("abort", resolve, { once: true });
        });
        options.signal.throwIfAborted();
      }
    }
    await root.plugin(
      Object.assign(
        (ctx) => ctx.llm.registerAdapter(["blocking-fake"], new BlockingAdapter()),
        { inject: ["llm"] },
      ),
    );
    handle = await root.agents.create({
      sessionId: SessionId("cancel-session"),
      meta: { cwd: "/tmp" },
      agentOptions: { provider: "blocking-fake", model: "fake-model" },
    });
    handle.agent.followup(
      freezeMessage({
        id: MessageId("cancel-user-message"),
        role: "user",
        content: [{ type: "text", text: "Wait." }],
        source: { kind: "user" },
      }),
    );
    await started;
    handle.agent.cancel("user");
    await handle.agent.whenIdle();
    await handle.dispose();
    handle = undefined;
    await root.fiber.dispose();

    const records = (await readFile(sidecar, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].finishReason, "aborted");
    assert.equal(records[0].streamOutcome, "finished");
  } finally {
    if (handle !== undefined) await handle.dispose();
    if (root.fiber.state !== 4) await root.fiber.dispose();
    await rm(temp, { recursive: true, force: true });
  }
});
