import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  isWorkerResult,
  runWorker,
  workerExitCode,
  WorkerKernelApiError,
} from "@dsh-dsworker/worker-kernel";
import { ExecutionContainmentUnavailableError } from "@dsh-dsworker/execution-containment";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";

function minimalContract() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "worker-kernel-unit",
      objective: "Call the authoritative checker once.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: { mutable: [{ path: "work.txt", kind: "file" }], immutable: [] },
      commands: {
        semantic: [
          {
            id: "semantic-noop",
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
}

test("worker API accepts only a genuine TaskContract and closed input", async () => {
  const common = {
    sourceWorkspaceRoot: "/tmp/not-reached",
    baseEnvironment: { PATH: "/usr/bin:/bin" },
    runtimeFactory: async () => ({}),
    sessionId: "worker-unit",
  };
  await assert.rejects(
    runWorker({ contract: { authority: {} }, ...common }),
    (error) =>
      error instanceof WorkerKernelApiError &&
      error.code === "unparsed-task-contract",
  );
  await assert.rejects(
    runWorker({ contract: minimalContract(), ...common, provider: "forbidden" }),
    (error) =>
      error instanceof WorkerKernelApiError && error.code === "unknown-field",
  );
  assert.throws(
    () => workerExitCode({ status: "green" }),
    /genuine WorkerResult/u,
  );
});

test("an accepted run returns one immutable RED infrastructure outcome on runtime failure", async () => {
  const temp = await mkdtemp("/tmp/dsh-dsworker-worker-unit.");
  const source = join(temp, "source");
  await mkdir(source);
  let factoryBinding;
  try {
    const result = await runWorker({
      contract: minimalContract(),
      sourceWorkspaceRoot: source,
      baseEnvironment: { PATH: "/usr/bin:/bin" },
      runtimeFactory: async (binding) => {
        factoryBinding = binding;
        throw new Error("test-only runtime failure");
      },
      sessionId: "worker-unit-runtime-failure",
    });
    assert.equal(isWorkerResult(result), true);
    assert.equal(result.status, "red");
    assert.equal(result.code, "worker-lifecycle-failure");
    assert.equal(workerExitCode(result), 1);
    assert.equal(result.cleanup.taskCheckBinding, "disposed");
    assert.equal(result.cleanup.workspaceDeltaBinding, "disposed");
    assert.equal(result.cleanup.workspace, "disposed");
    assert.deepEqual(Object.keys(factoryBinding).sort(), [
      "contractSha256",
      "workspaceRoot",
    ]);
    assert.equal(Object.isFrozen(factoryBinding), true);
    assert.equal(existsSync(factoryBinding.workspaceRoot), false);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.cleanup), true);
    assert.throws(() => {
      result.status = "green";
    }, TypeError);
    assert.throws(() => result.failures.push({}), TypeError);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a returned invalid runtime is still disposed and cleanup failure stays fail-closed", async () => {
  const temp = await mkdtemp("/tmp/dsh-dsworker-worker-unit-cleanup.");
  const source = join(temp, "source");
  await mkdir(source);
  let disposeCalled = 0;
  try {
    const result = await runWorker({
      contract: minimalContract(),
      sourceWorkspaceRoot: source,
      baseEnvironment: { PATH: "/usr/bin:/bin" },
      runtimeFactory: async () => ({
        ctx: {},
        async dispose() {
          disposeCalled += 1;
          throw new Error("test-only cleanup failure");
        },
      }),
      sessionId: "worker-unit-cleanup-failure",
    });
    assert.equal(disposeCalled, 1);
    assert.equal(result.status, "red");
    assert.equal(result.code, "cleanup-failure");
    assert.equal(result.cleanup.runtime, "failed");
    assert.equal(result.cleanup.taskCheckBinding, "disposed");
    assert.equal(result.cleanup.workspaceDeltaBinding, "disposed");
    assert.equal(result.cleanup.workspace, "disposed");
    assert.deepEqual(
      result.failures.map((failure) => failure.code),
      ["worker-lifecycle-failure", "runtime-cleanup-failed"],
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("containment binding setup failure is typed infrastructure RED and never reaches an Agent", async () => {
  const temp = await mkdtemp("/tmp/dsh-dsworker-worker-containment-failure.");
  const source = join(temp, "source");
  await mkdir(source);
  let createCalled = false;
  let disposed = false;
  try {
    const result = await runWorker({
      contract: minimalContract(),
      sourceWorkspaceRoot: source,
      baseEnvironment: { PATH: "/usr/bin:/bin" },
      runtimeFactory: async () => ({
        ctx: {
          agents: {
            create: async () => {
              createCalled = true;
              throw new Error("must not create an Agent");
            },
          },
          agentDefaultModel: {
            currentSelection: () => ({ provider: "unused", model: "unused" }),
          },
          agentPresets: { defaultId: "unused", mount: async () => {} },
          subprocess: {
            bindExecutionContainment: () => {
              throw new ExecutionContainmentUnavailableError(
                "test-backend-unavailable",
                "$.subprocess",
                "test-only setup failure",
              );
            },
          },
          pathGuard: { bind: () => ({ dispose() {} }) },
          taskCheckTool: { bind: () => ({ dispose() {} }) },
        },
        async dispose() {
          disposed = true;
        },
      }),
      sessionId: "worker-containment-setup-failure",
    });
    assert.equal(createCalled, false);
    assert.equal(disposed, true);
    assert.equal(result.status, "red");
    assert.equal(result.code, "containment-test-backend-unavailable");
    assert.equal(result.containment.status, "unavailable");
    assert.equal(result.containment.code, "test-backend-unavailable");
    assert.equal(result.cleanup.executionContainment, "disposed");
    assert.equal(result.cleanup.workspaceDeltaBinding, "disposed");
    assert.equal(result.cleanup.workspace, "disposed");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
