import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import {
  freezeMessage,
  LlmAdapter,
  LlmRuntime,
  MessageId,
} from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import {
  joinContextSections,
  renderContextSections,
  renderPrompt,
} from "@deepseek-ai/dsh-system-prompt";
import { defineTool, ToolRuntime } from "@deepseek-ai/dsh-tools";
import {
  isTaskCheckToolBinding,
  isTaskCheckTerminalObservation,
  TASK_CHECK_TOOL_NAME,
  TaskCheckPluginApiError,
  TaskCheckPluginConfigurationError,
} from "@dsh-dsworker/plugin-task-check";
import * as TaskCheckPlugin from "@dsh-dsworker/plugin-task-check";
import {
  createTaskCheckBinding,
  disposeTaskCheckBinding,
} from "@dsh-dsworker/task-check-local";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";
import {
  loadPythonArgvLexerContract,
  materializePythonArgvLexer,
  TASK_CHECK_FIXTURE_ROOT,
  TEST_BASE_ENVIRONMENT,
} from "../helpers/task-check-fixtures.mjs";

let sessionSequence = 0;

function toolCallChunks(calls) {
  return calls.flatMap((call, index) => {
    const block = {
      type: "tool-call",
      id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    };
    return [
      { type: "block-start", index, blockType: "tool-call" },
      {
        type: "tool-call-delta",
        index,
        id: call.id,
        name: call.name,
        argumentsDelta: JSON.stringify(call.arguments),
      },
      { type: "block-end", index, block },
    ];
  });
}

class TaskCheckFakeAdapter extends LlmAdapter {
  constructor(firstCalls) {
    super();
    this.firstCalls = firstCalls;
    this.requests = [];
  }

  providerInfo(provider) {
    return { id: provider, name: "Deterministic task-check fake" };
  }

  async *stream(options) {
    this.requests.push(options);
    if (this.requests.length === 1) {
      for (const chunk of toolCallChunks(this.firstCalls)) yield chunk;
      yield {
        type: "usage",
        usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "red result observed" };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "text", text: "red result observed" },
    };
    yield {
      type: "usage",
      usage: { inputTokens: 4, cacheReadTokens: 3, outputTokens: 3 },
    };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

async function createHarness(workspace, adapter) {
  const root = new Context();
  await root.plugin(LlmRuntime);
  await root.plugin(SessionStore);
  await root.plugin(AgentRegistry);
  await root.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    persona: "Synthetic task-check integration agent.",
  });
  await root.plugin(ToolRuntime, { mode: "native" });
  await root.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 4 });
  await root.plugin(TaskCheckPlugin);
  await root.plugin(
    Object.assign(
      (ctx) => ctx.llm.registerAdapter(["fake-task-check"], adapter),
      { inject: ["llm"] },
    ),
  );
  let sentinelExecutions = 0;
  const handle = await root.agents.create({
    sessionId: SessionId(`task-check-plugin-${++sessionSequence}`),
    meta: { cwd: workspace },
    agentOptions: { provider: "fake-task-check", model: "fake-model" },
    setup(agentCtx) {
      agentCtx.tools.register(
        defineTool({
          name: "sentinel_after_check",
          description: "Test-only sentinel that must not run after GREEN.",
          parameters: {},
          output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: value }],
          },
          async execute() {
            sentinelExecutions += 1;
            return "sentinel-ran";
          },
        }),
      );
    },
  });
  return { root, handle, sentinelExecutions: () => sentinelExecutions };
}

function followup(agent, id) {
  agent.followup(
    freezeMessage({
      id: MessageId(id),
      role: "user",
      content: [{ type: "text", text: "Check the completed task once." }],
      source: { kind: "user" },
    }),
  );
}

function cancellationContract() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "task-check-plugin-cancellation",
      objective: "Prove rc.6 cancellation cannot conclude an authoritative turn.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: { mutable: [{ path: "marker.txt", kind: "file" }], immutable: [] },
      commands: {
        semantic: [
          {
            id: "wait-for-cancellation",
            executable: "node",
            argv: ["-e", "setInterval(() => {}, 1000)"],
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

test("real rc.6 GREEN commits, concludes the turn, and denies later same-batch tools", async (t) => {
  const temp = await mkdtemp("/tmp/dsh-dsworker-task-check-plugin-green.");
  const workspace = join(temp, "workspace");
  await mkdir(workspace);
  const contract = await loadPythonArgvLexerContract();
  await materializePythonArgvLexer(workspace, "initial");
  const localBinding = await createTaskCheckBinding({
    contract,
    workspaceRoot: workspace,
    baseEnvironment: TEST_BASE_ENVIRONMENT,
  });
  await copyFile(
    join(TASK_CHECK_FIXTURE_ROOT, "lexer.green.py"),
    join(workspace, "lexer.py"),
  );
  const adapter = new TaskCheckFakeAdapter([
    { id: "check-green", name: TASK_CHECK_TOOL_NAME, arguments: {} },
    { id: "after-green", name: "sentinel_after_check", arguments: {} },
  ]);
  let harness;
  let pluginBinding;
  const terminalObservations = [];
  try {
    harness = await createHarness(workspace, adapter);
    const liveResults = [];
    harness.root.on(
      "tools/result",
      (exec, result) => {
        if (exec.agent === harness.handle.agent) liveResults.push({ exec, result });
      },
      { global: true },
    );

    const scope = scopeOf(harness.handle.agent.ctx);
    const beforeTools = harness.root.tools.schemas(scope);
    const beforeAssembly = await harness.root.systemPrompt.assemble({
      scope,
      agent: harness.handle.agent,
    });
    pluginBinding = harness.root.taskCheckTool.bind(
      harness.handle.agent,
      contract,
      localBinding,
      {
        onTerminalObservation(observation) {
          terminalObservations.push(observation);
          throw new Error("test-only contained terminal observer failure");
        },
      },
    );
    assert.equal(isTaskCheckToolBinding(pluginBinding), true);
    assert.equal(pluginBinding.contract, contract);
    assert.equal(pluginBinding.taskCheckBinding, localBinding);
    assert.equal(Object.isFrozen(pluginBinding), true);

    const afterTools = harness.root.tools.schemas(scope);
    const afterAssembly = await harness.root.systemPrompt.assemble({
      scope,
      agent: harness.handle.agent,
    });
    assert.equal(renderPrompt(afterAssembly), renderPrompt(beforeAssembly));
    assert.equal(
      joinContextSections(renderContextSections(afterAssembly)),
      joinContextSections(renderContextSections(beforeAssembly)),
    );
    assert.deepEqual(
      afterTools.filter((tool) => tool.name !== TASK_CHECK_TOOL_NAME),
      beforeTools,
    );
    assert.deepEqual(
      afterTools.map((tool) => tool.name).sort(),
      ["sentinel_after_check", TASK_CHECK_TOOL_NAME],
    );
    const schema = afterTools.find((tool) => tool.name === TASK_CHECK_TOOL_NAME);
    assert.equal(schema.parameters.additionalProperties, false);
    assert.deepEqual(schema.parameters.required, []);

    followup(harness.handle.agent, "task-check-green-user");
    await harness.handle.agent.whenIdle();

    assert.equal(adapter.requests.length, 1, "GREEN must prevent a second LLM step");
    assert.deepEqual(
      adapter.requests[0].tools.map((tool) => tool.name).sort(),
      ["sentinel_after_check", TASK_CHECK_TOOL_NAME],
    );
    assert.equal(harness.sentinelExecutions(), 0);
    const taskResult = liveResults.find(
      ({ exec }) => exec.name === TASK_CHECK_TOOL_NAME,
    )?.result;
    const sentinelResult = liveResults.find(
      ({ exec }) => exec.name === "sentinel_after_check",
    )?.result;
    assert.equal(taskResult?.isError, false);
    assert.equal(taskResult?.value.status, "green");
    assert.equal(taskResult?.value.contractSha256, contract.contractSha256);
    assert.equal(taskResult?.concludesTurn, true);
    assert.equal(terminalObservations.length, 1);
    assert.equal(isTaskCheckTerminalObservation(terminalObservations[0]), true);
    assert.equal(terminalObservations[0].kind, "verdict");
    assert.equal(terminalObservations[0].status, "green");
    assert.equal(terminalObservations[0].code, "green-committed");
    assert.equal(terminalObservations[0].commit.concludesTurn, true);
    assert.equal(terminalObservations[0].taskCheckResult.status, "green");
    t.assert.snapshot({
      ...taskResult?.value,
      workspaceIdentity: "<WORKSPACE_IDENTITY>",
    });
    assert.equal(sentinelResult?.isError, true);
    assert.match(sentinelResult?.error.message ?? "", /task_check is GREEN/u);
    assert.equal(
      await readFile(join(workspace, "lexer.py"), "utf8"),
      await readFile(
        join(TASK_CHECK_FIXTURE_ROOT, "lexer.green.py"),
        "utf8",
      ),
    );
  } finally {
    pluginBinding?.dispose();
    if (harness !== undefined) {
      await harness.handle.dispose();
      await harness.root.fiber.dispose();
    }
    disposeTaskCheckBinding(localBinding);
    await rm(temp, { recursive: true, force: true });
  }
});

test("real rc.6 RED does not conclude and the adapter never reruns the checker", async () => {
  const temp = await mkdtemp("/tmp/dsh-dsworker-task-check-plugin-red.");
  const workspace = join(temp, "workspace");
  await mkdir(workspace);
  const contract = await loadPythonArgvLexerContract();
  await materializePythonArgvLexer(workspace, "initial");
  const localBinding = await createTaskCheckBinding({
    contract,
    workspaceRoot: workspace,
    baseEnvironment: TEST_BASE_ENVIRONMENT,
  });
  const adapter = new TaskCheckFakeAdapter([
    { id: "check-red", name: TASK_CHECK_TOOL_NAME, arguments: {} },
  ]);
  let harness;
  let pluginBinding;
  const terminalObservations = [];
  try {
    harness = await createHarness(workspace, adapter);
    const liveResults = [];
    harness.root.on(
      "tools/result",
      (exec, result) => {
        if (exec.agent === harness.handle.agent) liveResults.push({ exec, result });
      },
      { global: true },
    );
    pluginBinding = harness.root.taskCheckTool.bind(
      harness.handle.agent,
      contract,
      localBinding,
      { onTerminalObservation: (observation) => terminalObservations.push(observation) },
    );
    followup(harness.handle.agent, "task-check-red-user");
    await harness.handle.agent.whenIdle();

    assert.equal(adapter.requests.length, 2, "RED must not conclude the agent turn");
    const taskResult = liveResults.find(
      ({ exec }) => exec.name === TASK_CHECK_TOOL_NAME,
    )?.result;
    assert.equal(taskResult?.isError, false);
    assert.equal(taskResult?.value.status, "red");
    assert.equal(taskResult?.concludesTurn, undefined);
    assert.equal(terminalObservations.length, 1);
    assert.equal(terminalObservations[0].kind, "verdict");
    assert.equal(terminalObservations[0].status, "red");
    assert.equal(terminalObservations[0].code, "red-committed");
    assert.equal(terminalObservations[0].taskCheckResult.status, "red");

    const repeated = await harness.root.tools.execute({
      callId: "task-check-repeat",
      name: TASK_CHECK_TOOL_NAME,
      arguments: {},
      agent: harness.handle.agent,
      signal: new AbortController().signal,
    });
    assert.equal(repeated.isError, true);
    assert.equal(repeated.error.info?.code, "TASK_CHECK_ALREADY_USED");
  } finally {
    pluginBinding?.dispose();
    if (harness !== undefined) {
      await harness.handle.dispose();
      await harness.root.fiber.dispose();
    }
    disposeTaskCheckBinding(localBinding);
    await rm(temp, { recursive: true, force: true });
  }
});

test("real rc.6 cancellation supersedes ABORTED summary and never concludes", async () => {
  const temp = await mkdtemp("/tmp/dsh-dsworker-task-check-plugin-aborted.");
  const workspace = join(temp, "workspace");
  await mkdir(workspace);
  const contract = cancellationContract();
  const localBinding = await createTaskCheckBinding({
    contract,
    workspaceRoot: workspace,
    baseEnvironment: TEST_BASE_ENVIRONMENT,
  });
  let harness;
  let pluginBinding;
  const terminalObservations = [];
  try {
    harness = await createHarness(workspace, new TaskCheckFakeAdapter([]));
    pluginBinding = harness.root.taskCheckTool.bind(
      harness.handle.agent,
      contract,
      localBinding,
      { onTerminalObservation: (observation) => terminalObservations.push(observation) },
    );
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 50);
    const aborted = await harness.root.tools.execute({
      callId: "task-check-aborted",
      name: TASK_CHECK_TOOL_NAME,
      arguments: {},
      agent: harness.handle.agent,
      signal: controller.signal,
    });
    clearTimeout(abortTimer);
    assert.equal(aborted.isError, true);
    assert.equal(aborted.error.info?.code, "ABORTED");
    assert.equal(aborted.concludesTurn, undefined);
    assert.equal(terminalObservations.length, 1);
    assert.equal(terminalObservations[0].kind, "verdict");
    assert.equal(terminalObservations[0].status, "aborted");
    assert.equal(terminalObservations[0].code, "aborted-committed");
    assert.equal(terminalObservations[0].taskCheckResult.status, "aborted");

    const afterAbort = await harness.root.tools.execute({
      callId: "sentinel-after-abort",
      name: "sentinel_after_check",
      arguments: {},
      agent: harness.handle.agent,
      signal: new AbortController().signal,
    });
    assert.equal(afterAbort.isError, false);
    assert.equal(afterAbort.value, "sentinel-ran");
    assert.equal(harness.sentinelExecutions(), 1);
  } finally {
    pluginBinding?.dispose();
    if (harness !== undefined) {
      await harness.handle.dispose();
      await harness.root.fiber.dispose();
    }
    disposeTaskCheckBinding(localBinding);
    await rm(temp, { recursive: true, force: true });
  }
});

test("binding is exact-identity, workspace-bound, agent-local, and disposable", async () => {
  const temp = await mkdtemp("/tmp/dsh-dsworker-task-check-plugin-binding.");
  const workspace = join(temp, "workspace");
  const otherWorkspace = join(temp, "other");
  await mkdir(workspace);
  await mkdir(otherWorkspace);
  const contract = await loadPythonArgvLexerContract();
  const contractCopy = parseTaskContract(JSON.parse(JSON.stringify({
    authority: contract.authority,
    metadata: contract.metadata,
  })));
  await materializePythonArgvLexer(workspace, "initial");
  const localBinding = await createTaskCheckBinding({
    contract,
    workspaceRoot: workspace,
    baseEnvironment: TEST_BASE_ENVIRONMENT,
  });
  const adapter = new TaskCheckFakeAdapter([]);
  let harness;
  let otherHarness;
  let pluginBinding;
  try {
    harness = await createHarness(workspace, adapter);
    otherHarness = await createHarness(otherWorkspace, new TaskCheckFakeAdapter([]));
    assert.throws(
      () => harness.root.taskCheckTool.bind(harness.handle.agent, contract, {}),
      (error) =>
        error instanceof TaskCheckPluginConfigurationError &&
        error.code === "invalid-task-check-binding",
    );
    assert.throws(
      () =>
        harness.root.taskCheckTool.bind(
          harness.handle.agent,
          contractCopy,
          localBinding,
        ),
      (error) =>
        error instanceof TaskCheckPluginConfigurationError &&
        error.code === "task-contract-binding-identity-mismatch",
    );
    assert.throws(
      () =>
        otherHarness.root.taskCheckTool.bind(
          otherHarness.handle.agent,
          contract,
          localBinding,
        ),
      (error) =>
        error instanceof TaskCheckPluginConfigurationError &&
        error.code === "workspace-binding-mismatch",
    );
    assert.throws(
      () =>
        harness.root.taskCheckTool.bind(
          harness.handle.agent,
          contract,
          localBinding,
          { unexpected: true },
        ),
      (error) =>
        error instanceof TaskCheckPluginApiError &&
        error.code === "invalid-bind-options",
    );
    assert.throws(
      () =>
        harness.root.taskCheckTool.bind(
          harness.handle.agent,
          contract,
          localBinding,
          { onTerminalObservation: "not-a-function" },
        ),
      (error) =>
        error instanceof TaskCheckPluginApiError &&
        error.code === "invalid-terminal-observer",
    );

    pluginBinding = harness.root.taskCheckTool.bind(
      harness.handle.agent,
      contract,
      localBinding,
    );
    assert.throws(
      () =>
        harness.root.taskCheckTool.bind(
          harness.handle.agent,
          contract,
          localBinding,
        ),
      (error) =>
        error instanceof TaskCheckPluginConfigurationError &&
        error.code === "agent-already-bound",
    );
    assert.ok(harness.root.tools.get(TASK_CHECK_TOOL_NAME, harness.handle.agent));
    assert.equal(
      otherHarness.root.tools.get(TASK_CHECK_TOOL_NAME, otherHarness.handle.agent),
      undefined,
    );
    pluginBinding.dispose();
    pluginBinding = undefined;
    assert.equal(
      harness.root.tools.get(TASK_CHECK_TOOL_NAME, harness.handle.agent),
      undefined,
    );
  } finally {
    pluginBinding?.dispose();
    if (harness !== undefined) {
      await harness.handle.dispose();
      await harness.root.fiber.dispose();
    }
    if (otherHarness !== undefined) {
      await otherHarness.handle.dispose();
      await otherHarness.root.fiber.dispose();
    }
    disposeTaskCheckBinding(localBinding);
    await rm(temp, { recursive: true, force: true });
  }
});
