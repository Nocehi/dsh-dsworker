import { foldConsumedWork, installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  containmentDisposition,
  containmentFailureDisposition,
  createExecutionContainment,
  disposeExecutionContainment,
} from "@dsh-dsworker/execution-containment";
import { isTaskCheckTerminalObservation } from "@dsh-dsworker/plugin-task-check";
import {
  createTaskCheckBinding,
  disposeTaskCheckBinding,
} from "@dsh-dsworker/task-check-local";
import { isTaskContract } from "@dsh-dsworker/task-contract";
import {
  createWorkspaceDeltaBinding,
  disposeWorkspaceDeltaBinding,
  exportWorkspaceDelta,
} from "@dsh-dsworker/workspace-delta";
import { WorkerKernelApiError } from "./errors.js";
import { isPlainObject } from "./freeze.js";
import {
  createWorkerResult,
  isWorkerResult,
  workerExitCode,
  WORKER_RESULT_VERSION,
  WORKER_STATUSES,
} from "./result.js";
import {
  materializeWorkerWorkspace,
  removeWorkerWorkspace,
} from "./workspace.js";

export {
  isWorkerResult,
  WorkerKernelApiError,
  workerExitCode,
  WORKER_RESULT_VERSION,
  WORKER_STATUSES,
};

/** @param {unknown} input */
function parseInput(input) {
  if (!isPlainObject(input)) {
    throw new WorkerKernelApiError("invalid-input", "$", "runWorker requires a plain object");
  }
  const allowed = [
    "contract",
    "sourceWorkspaceRoot",
    "baseEnvironment",
    "runtimeFactory",
    "sessionId",
    "signal",
  ];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new WorkerKernelApiError(
        "unknown-field",
        `$.${key}`,
        `$.${key} is not part of the worker API`,
      );
    }
  }
  for (const key of allowed.slice(0, 5)) {
    if (!Object.hasOwn(input, key)) {
      throw new WorkerKernelApiError(
        "missing-field",
        `$.${key}`,
        `$.${key} is required`,
      );
    }
  }
  if (!isTaskContract(input.contract)) {
    throw new WorkerKernelApiError(
      "unparsed-task-contract",
      "$.contract",
      "runWorker requires the exact object returned by parseTaskContract",
    );
  }
  if (!isPlainObject(input.baseEnvironment)) {
    throw new WorkerKernelApiError(
      "invalid-base-environment",
      "$.baseEnvironment",
      "baseEnvironment must be a runner-supplied plain object",
    );
  }
  if (typeof input.runtimeFactory !== "function") {
    throw new WorkerKernelApiError(
      "invalid-runtime-factory",
      "$.runtimeFactory",
      "runtimeFactory must be a function",
    );
  }
  if (
    typeof input.sessionId !== "string" ||
    input.sessionId.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(input.sessionId)
  ) {
    throw new WorkerKernelApiError(
      "invalid-session-id",
      "$.sessionId",
      "sessionId must be a non-empty string without control characters",
    );
  }
  if (
    input.signal !== undefined &&
    (input.signal === null ||
      typeof input.signal !== "object" ||
      typeof input.signal.aborted !== "boolean" ||
      typeof input.signal.addEventListener !== "function")
  ) {
    throw new WorkerKernelApiError(
      "invalid-abort-signal",
      "$.signal",
      "signal must be an AbortSignal when present",
    );
  }
  return input;
}

/** @param {unknown} runtime */
function requireRuntime(runtime) {
  if (
    !isPlainObject(runtime) ||
    Object.keys(runtime).some((key) => key !== "ctx" && key !== "dispose") ||
    runtime.ctx === null ||
    typeof runtime.ctx !== "object" ||
    typeof runtime.dispose !== "function"
  ) {
    throw new Error("runtimeFactory must return exactly { ctx, dispose }");
  }
  const ctx = runtime.ctx;
  if (
    typeof ctx.agents?.create !== "function" ||
    typeof ctx.agentDefaultModel?.currentSelection !== "function" ||
    typeof ctx.agentPresets?.mount !== "function" ||
    typeof ctx.subprocess?.bindExecutionContainment !== "function" ||
    typeof ctx.pathGuard?.bind !== "function" ||
    typeof ctx.taskCheckTool?.bind !== "function"
  ) {
    throw new Error("runtime is missing a required rc.6 worker host service");
  }
  return runtime;
}

/** @param {unknown} selection */
function requireSelection(selection) {
  if (
    !isPlainObject(selection) ||
    typeof selection.provider !== "string" ||
    selection.provider.length === 0 ||
    typeof selection.model !== "string" ||
    selection.model.length === 0 ||
    (selection.reasoningEffort !== undefined &&
      typeof selection.reasoningEffort !== "string")
  ) {
    throw new Error("agentDefaultModel returned an invalid rc.6 model selection");
  }
  return Object.freeze({ ...selection });
}

/** @param {readonly any[]} events */
function lifecycleSummary(events) {
  const consumed = foldConsumedWork(events);
  const reason = consumed.end?.data?.reason;
  const reasonSummary =
    reason === undefined
      ? null
      : reason.kind === "error"
        ? { kind: "error", code: reason.error?.code ?? "UNKNOWN" }
        : reason.kind === "aborted"
          ? {
              kind: "aborted",
              reasonKind: reason.reason?.kind ?? "unknown",
            }
          : { kind: reason.kind };
  const toolCalls = events
    .filter((event) => event.type === "tool/call")
    .map((event) => ({
      turn: event.data.turn,
      step: event.data.step,
      callId: String(event.data.callId),
      name: event.data.name,
    }));
  const modelRequestCount = events.filter(
    (event) => event.type === "step/start",
  ).length;
  return {
    consumedTurn: consumed.end?.data?.turn ?? null,
    turnReason: reasonSummary,
    droppedUnrun: consumed.droppedUnrun,
    stepCount: modelRequestCount,
    modelRequestCount,
    toolCalls,
  };
}

/** @param {string} code */
function infrastructureFailure(code) {
  return Object.freeze({ category: "infrastructure", code });
}

/**
 * Run one objective from one genuine TaskContract through one freshly staged
 * workspace and one rc.6 Agent. The runtime factory owns provider/model
 * composition; this kernel only reads and forwards the existing
 * agentDefaultModel selection.
 *
 * @param {unknown} input
 */
export async function runWorker(input) {
  const data = parseInput(input);
  const failures = [];
  const cleanupFailures = [];
  const cleanup = {
    taskCheckToolBinding: "not-created",
    pathGuardBinding: "not-created",
    agent: "not-created",
    taskCheckBinding: "not-created",
    workspaceDeltaBinding: "not-created",
    containmentRuntimeBinding: "not-created",
    runtime: "not-created",
    executionContainment: "not-created",
    workspace: "not-created",
  };
  let staged;
  let taskCheckBinding;
  let workspaceDeltaBinding;
  let executionContainment;
  let containmentRuntimeBinding;
  let runtime;
  let handle;
  let pathGuardBinding;
  let taskCheckToolBinding;
  let terminalObservation;
  let duplicateTerminalObservation = false;
  let firstSeq = 0;
  let lifecycle = {
    consumedTurn: null,
    turnReason: null,
    droppedUnrun: false,
    stepCount: 0,
    modelRequestCount: 0,
    toolCalls: [],
  };
  let workspaceIdentity = null;
  let primaryCode = null;
  let containmentSummary = null;
  let modelSelection = null;
  let candidateDelta = null;
  let deltaFailureCode = null;
  let externalAbort = data.signal?.aborted === true;
  let removeAbortListener;

  try {
    staged = await materializeWorkerWorkspace(data.sourceWorkspaceRoot);
    cleanup.workspace = "pending";

    workspaceDeltaBinding = await createWorkspaceDeltaBinding({
      contract: data.contract,
      sourceWorkspaceRoot: staged.sourceWorkspaceRoot,
      workspaceRoot: staged.workspaceRoot,
    });
    cleanup.workspaceDeltaBinding = "pending";

    executionContainment = await createExecutionContainment({
      workspaceRoot: staged.workspaceRoot,
      contract: data.contract,
    });
    cleanup.executionContainment = "pending";

    taskCheckBinding = await createTaskCheckBinding({
      contract: data.contract,
      workspaceRoot: staged.workspaceRoot,
      baseEnvironment: data.baseEnvironment,
      executionContainment,
    });
    cleanup.taskCheckBinding = "pending";
    workspaceIdentity = taskCheckBinding.workspaceIdentity;
    if (!taskCheckBinding.baseline.ok) {
      primaryCode = "baseline-snapshot-invalid";
      failures.push(infrastructureFailure(primaryCode));
    }
    externalAbort ||= data.signal?.aborted === true;

    if (primaryCode === null && !externalAbort) {
      const runtimeCandidate = await data.runtimeFactory(
        Object.freeze({
          workspaceRoot: staged.workspaceRoot,
          contractSha256: data.contract.contractSha256,
        }),
      );
      if (
        runtimeCandidate !== null &&
        typeof runtimeCandidate === "object" &&
        typeof runtimeCandidate.dispose === "function"
      ) {
        runtime = runtimeCandidate;
        cleanup.runtime = "pending";
      }
      runtime = requireRuntime(runtimeCandidate);
      containmentRuntimeBinding = runtime.ctx.subprocess.bindExecutionContainment(
        executionContainment,
      );
      cleanup.containmentRuntimeBinding = "pending";
      const selection = requireSelection(
        runtime.ctx.agentDefaultModel.currentSelection(),
      );
      modelSelection = Object.freeze({
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort ?? null,
      });
      const presetId = runtime.ctx.agentPresets.defaultId;
      if (typeof presetId !== "string" || presetId.length === 0) {
        throw new Error("agentPresets has no valid default preset id");
      }
      handle = await runtime.ctx.agents.create({
        sessionId: SessionId(data.sessionId),
        meta: { cwd: staged.workspaceRoot, agentPreset: presetId },
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
        },
        setup: async (agentCtx) => {
          await runtime.ctx.agentPresets.mount(agentCtx, presetId);
          installModelSelection(agentCtx, {
            current: selection,
            assembled: undefined,
          });
        },
      });
      cleanup.agent = "pending";
      pathGuardBinding = runtime.ctx.pathGuard.bind(handle.agent, data.contract);
      cleanup.pathGuardBinding = "pending";
      const onTerminalObservation = (observation) => {
        if (terminalObservation !== undefined) {
          duplicateTerminalObservation = true;
          handle.agent.cancel({
            kind: "hook",
            reason: "dsh-dsworker-duplicate-terminal-observation",
          });
          return;
        }
        terminalObservation = observation;
        if (
          !isTaskCheckTerminalObservation(observation) ||
          observation.kind !== "verdict" ||
          observation.status === "red"
        ) {
          handle.agent.cancel({
            kind: "hook",
            reason: "dsh-dsworker-terminal-stop",
          });
        }
      };
      taskCheckToolBinding = runtime.ctx.taskCheckTool.bind(
        handle.agent,
        data.contract,
        taskCheckBinding,
        { onTerminalObservation },
      );
      cleanup.taskCheckToolBinding = "pending";

      const abortAgent = () => {
        externalAbort = true;
        handle.agent.cancel({ kind: "user" });
      };
      if (data.signal !== undefined) {
        data.signal.addEventListener("abort", abortAgent, { once: true });
        removeAbortListener = () =>
          data.signal.removeEventListener("abort", abortAgent);
      }

      if (data.signal?.aborted === true) {
        abortAgent();
      } else {
        firstSeq = handle.agent.session.seq;
        handle.agent.followup(
          createUserMessage({
            content: [
              { type: "text", text: data.contract.authority.objective },
            ],
            source: { kind: "user" },
          }),
        );
        await handle.agent.whenIdle();
        removeAbortListener?.();
        removeAbortListener = undefined;
        lifecycle = lifecycleSummary(
          handle.agent.session.events.slice(firstSeq),
        );
      }
    }
  } catch (error) {
    if (
      error?.category === "unavailable" ||
      error?.category === "execution" ||
      error?.category === "api"
    ) {
      primaryCode ??= "containment-" + String(error.code ?? "setup-failed");
      containmentSummary ??= containmentFailureDisposition(error);
    } else if (error?.category === "workspace-delta") {
      primaryCode ??= `workspace-delta-${String(error.code ?? "setup-failed")}`;
    } else {
      primaryCode ??= "worker-lifecycle-failure";
    }
    failures.push(infrastructureFailure(primaryCode));
    if (handle?.agent?.status === "running") {
      handle.agent.cancel({
        kind: "hook",
        reason: "dsh-dsworker-lifecycle-failure",
      });
      try {
        await handle.agent.whenIdle();
      } catch {
        // Cleanup below remains authoritative for resource settlement.
      }
    }
    if (handle !== undefined) {
      lifecycle = lifecycleSummary(handle.agent.session.events.slice(firstSeq));
    }
  } finally {
    removeAbortListener?.();
    const provisionalGreen =
      !duplicateTerminalObservation &&
      terminalObservation !== undefined &&
      isTaskCheckTerminalObservation(terminalObservation) &&
      terminalObservation.kind === "verdict" &&
      terminalObservation.status === "green" &&
      lifecycle.turnReason?.kind === "completed" &&
      !externalAbort;
    if (provisionalGreen && workspaceDeltaBinding !== undefined) {
      try {
        candidateDelta = await exportWorkspaceDelta(workspaceDeltaBinding, {
          contract: data.contract,
          sourceWorkspaceRoot: staged.sourceWorkspaceRoot,
          workspaceRoot: staged.workspaceRoot,
        });
      } catch (error) {
        deltaFailureCode = `workspace-delta-${String(error?.code ?? "export-failed")}`;
        primaryCode ??= deltaFailureCode;
        failures.push(infrastructureFailure(deltaFailureCode));
      }
    }
    const settle = async (field, operation) => {
      if (cleanup[field] === "not-created") return;
      try {
        await operation();
        cleanup[field] = "disposed";
      } catch {
        cleanup[field] = "failed";
        cleanupFailures.push(
          infrastructureFailure(`${field}-cleanup-failed`),
        );
      }
    };
    await settle("taskCheckToolBinding", async () => taskCheckToolBinding.dispose());
    await settle("pathGuardBinding", async () => pathGuardBinding.dispose());
    await settle("agent", async () => handle.dispose());
    await settle("taskCheckBinding", async () =>
      disposeTaskCheckBinding(taskCheckBinding),
    );
    await settle("workspaceDeltaBinding", async () =>
      disposeWorkspaceDeltaBinding(workspaceDeltaBinding),
    );
    await settle("containmentRuntimeBinding", async () =>
      containmentRuntimeBinding.dispose(),
    );
    await settle("runtime", async () => runtime.dispose());
    if (executionContainment !== undefined && containmentSummary === null) {
      containmentSummary = containmentDisposition(executionContainment);
    }
    await settle("executionContainment", async () =>
      disposeExecutionContainment(executionContainment),
    );
    await settle("workspace", async () =>
      removeWorkerWorkspace(staged.runRoot),
    );
  }

  let status;
  let code;
  let authoritative;
  if (duplicateTerminalObservation) {
    status = "red";
    code = "duplicate-terminal-observation";
    failures.push(infrastructureFailure(code));
    authoritative = {
      observed: false,
      status: null,
      code,
      taskCheckResult: null,
    };
  } else if (
    terminalObservation !== undefined &&
    isTaskCheckTerminalObservation(terminalObservation) &&
    terminalObservation.kind === "verdict"
  ) {
    authoritative = {
      observed: true,
      status: terminalObservation.status,
      code: terminalObservation.code,
      taskCheckResult: terminalObservation.taskCheckResult,
    };
    if (terminalObservation.status === "green") {
      if (deltaFailureCode !== null) {
        status = "red";
        code = deltaFailureCode;
      } else if (lifecycle.turnReason?.kind === "completed" && !externalAbort) {
        status = "green";
        code = "authoritative-green";
      } else if (externalAbort) {
        status = "aborted";
        code = "worker-aborted-after-green-commit";
      } else {
        status = "red";
        code = "green-without-completed-turn";
        failures.push(infrastructureFailure(code));
      }
    } else if (terminalObservation.status === "red") {
      status = "red";
      code = "authoritative-red";
    } else {
      status = "aborted";
      code = "authoritative-aborted";
    }
  } else if (terminalObservation !== undefined) {
    status = "red";
    code = "malformed-terminal-observation";
    failures.push(infrastructureFailure(code));
    authoritative = {
      observed: false,
      status: null,
      code: terminalObservation.code ?? code,
      taskCheckResult: null,
    };
  } else if (externalAbort) {
    status = "aborted";
    code = "worker-aborted";
    authoritative = {
      observed: false,
      status: null,
      code: "no-authoritative-observation-before-abort",
      taskCheckResult: null,
    };
  } else {
    status = "red";
    code = primaryCode ?? "missing-terminal-observation";
    if (!failures.some((failure) => failure.code === code)) {
      failures.push(infrastructureFailure(code));
    }
    authoritative = {
      observed: false,
      status: null,
      code,
      taskCheckResult: null,
    };
  }

  if (cleanupFailures.length > 0) {
    status = "red";
    code = "cleanup-failure";
    failures.push(...cleanupFailures);
  }

  return createWorkerResult({
    status,
    code,
    contractSha256: data.contract.contractSha256,
    sessionId: data.sessionId,
    workspaceIdentity,
    modelSelection,
    authoritative,
    delta: status === "green" && cleanupFailures.length === 0 ? candidateDelta : null,
    lifecycle,
    containment: containmentSummary ?? containmentFailureDisposition({ code: primaryCode ?? "containment-not-created" }),
    cleanup: { ...cleanup, failures: cleanupFailures },
    failures,
  });
}
