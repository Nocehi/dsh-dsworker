import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { compilePathAuthority } from "@dsh-dsworker/path-authority";
import {
  assertExecutionContainmentWorkspace,
  containmentDisposition,
  createExecutionContainment,
  disposeExecutionContainment,
  isExecutionContainment,
} from "@dsh-dsworker/execution-containment";
import { evaluateTaskCheck } from "@dsh-dsworker/task-check-core";
import { isTaskContract } from "@dsh-dsworker/task-contract";
import {
  TaskCheckLocalApiError,
  TaskCheckLocalConfigurationError,
} from "./errors.js";
import { sanitizeBaseEnvironment } from "./environment.js";
import {
  DEFAULT_COMMAND_OUTPUT_BYTES,
  DEFAULT_TERMINATION_GRACE_MS,
  executeContractCommand,
} from "./executor.js";
import { deepFreeze, isPlainDataObject } from "./freeze.js";
import {
  captureWorkspaceSnapshot,
  normalizeSnapshotLimits,
  snapshotSummary,
} from "./snapshot.js";
import {
  compareWorkspaceSnapshots,
  verifyImmutableAuthority,
} from "./scope.js";

export const TASK_CHECK_BINDING_VERSION =
  "dsh-dsworker/task-check-local-binding/v1";

const bindings = new WeakSet();
const states = new WeakMap();
const activeWorkspaceRoots = new Map();

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {unknown} value @param {string} path @param {number} fallback */
function positiveIntegerOption(value, path, fallback) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new TaskCheckLocalApiError(
      "invalid-local-check-limit",
      path,
      path + " must be a positive safe integer",
    );
  }
  return candidate;
}

/** @param {unknown} input @param {readonly string[]} allowed @param {readonly string[]} required @param {string} path */
function closedInput(input, allowed, required, path) {
  if (!isPlainDataObject(input)) {
    throw new TaskCheckLocalApiError(
      "invalid-input",
      path,
      path + " must be a plain data object",
    );
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new TaskCheckLocalApiError(
        "unknown-field",
        path + "." + key,
        path + "." + key + " is not part of this API",
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(input, key)) {
      throw new TaskCheckLocalApiError(
        "missing-field",
        path + "." + key,
        path + "." + key + " is required",
      );
    }
  }
  return input;
}

/** @param {string} root */
async function workspaceIdentity(root) {
  let realRoot = null;
  let device = null;
  let inode = null;
  try {
    const stat = await lstat(root, { bigint: true });
    realRoot = await realpath(root);
    device = stat.dev.toString();
    inode = stat.ino.toString();
  } catch {
    // The baseline snapshot carries the typed filesystem failure. Identity
    // still pins the exact runner-supplied absolute path.
  }
  return sha256(
    Buffer.from(
      JSON.stringify({
        root,
        realRoot,
        device,
        inode,
      }),
      "utf8",
    ),
  );
}

/** @param {string} code */
function unavailableSnapshotSummary(code) {
  return deepFreeze({
    ok: false,
    code,
    entryCount: 0,
    totalFileBytes: 0,
    snapshotSha256: null,
    failure: { code, path: null, nodeType: null },
  });
}

/** @param {string} code @param {readonly string[]} checked */
function unavailableImmutable(code, checked) {
  return deepFreeze({
    ok: false,
    checked: [...checked],
    findings: [{ code }],
  });
}

/** @param {string} code */
function unavailableScope(code) {
  return deepFreeze({
    ok: false,
    changedPaths: [],
    changes: [],
    findings: [{ code }],
  });
}

/**
 * Capture an immutable pre-mutation baseline for one exact TaskContract and
 * runner-supplied absolute workspace. No command is executed.
 *
 * @param {unknown} input
 */
export async function createTaskCheckBinding(input) {
  const data = closedInput(
    input,
    [
      "contract",
      "workspaceRoot",
      "baseEnvironment",
      "snapshotLimits",
      "maxOutputBytes",
      "terminationGraceMs",
      "executionContainment",
    ],
    ["contract", "workspaceRoot", "baseEnvironment"],
    "$",
  );
  if (!isTaskContract(data.contract)) {
    throw new TaskCheckLocalConfigurationError(
      "unparsed-task-contract",
      "$.contract",
      "task-check binding requires the exact object returned by parseTaskContract",
    );
  }
  if (
    typeof data.workspaceRoot !== "string" ||
    !isAbsolute(data.workspaceRoot) ||
    data.workspaceRoot.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(data.workspaceRoot)
  ) {
    throw new TaskCheckLocalConfigurationError(
      "invalid-workspace-root",
      "$.workspaceRoot",
      "workspaceRoot must be an absolute path without control characters",
    );
  }
  const root = resolve(data.workspaceRoot);
  if (activeWorkspaceRoots.has(root)) {
    throw new TaskCheckLocalConfigurationError(
      "workspace-already-bound",
      "$.workspaceRoot",
      "the workspace already has an active task-check baseline",
    );
  }
  const baseEnvironment = sanitizeBaseEnvironment(data.baseEnvironment);
  const snapshotLimits = normalizeSnapshotLimits(data.snapshotLimits ?? {});
  const maxOutputBytes = positiveIntegerOption(
    data.maxOutputBytes,
    "$.maxOutputBytes",
    DEFAULT_COMMAND_OUTPUT_BYTES,
  );
  const terminationGraceMs = positiveIntegerOption(
    data.terminationGraceMs,
    "$.terminationGraceMs",
    DEFAULT_TERMINATION_GRACE_MS,
  );
  const reservation = Object.freeze({ initializing: true, workspaceRoot: root });
  activeWorkspaceRoots.set(root, reservation);
  let executionContainment;
  let ownsExecutionContainment = false;
  try {
    if (data.executionContainment === undefined) {
      executionContainment = await createExecutionContainment({
        workspaceRoot: root,
        contract: data.contract,
      });
      ownsExecutionContainment = true;
    } else {
      if (!isExecutionContainment(data.executionContainment)) {
        throw new TaskCheckLocalConfigurationError(
          "invalid-execution-containment",
          "$.executionContainment",
          "executionContainment must be a genuine containment object",
        );
      }
      try {
        assertExecutionContainmentWorkspace(data.executionContainment, root);
      } catch {
        throw new TaskCheckLocalConfigurationError(
          "containment-workspace-mismatch",
          "$.executionContainment",
          "executionContainment is bound to a different workspace",
        );
      }
      executionContainment = data.executionContainment;
    }
    const baseline = await captureWorkspaceSnapshot(root, snapshotLimits);
    const immutableBaseline = verifyImmutableAuthority(
      data.contract,
      baseline,
      baseline,
    );
    const identity = await workspaceIdentity(root);
    compilePathAuthority(data.contract);

    let binding;
    const dispose = Object.freeze(() => disposeTaskCheckBinding(binding));
    binding = deepFreeze({
      version: TASK_CHECK_BINDING_VERSION,
      contract: data.contract,
      contractSha256: data.contract.contractSha256,
      workspaceRoot: root,
      workspaceIdentity: identity,
      baseline: snapshotSummary(baseline),
      snapshotLimits,
      commandLimits: {
        maxOutputBytes,
        terminationGraceMs,
      },
      environmentPolicy: baseEnvironment.policy,
      containment: containmentDisposition(executionContainment),
      dispose,
    });
    const state = {
      binding,
      contract: data.contract,
      policy: compilePathAuthority(data.contract),
      workspaceRoot: root,
      baseline,
      immutableBaseline,
      baseEnvironment,
      snapshotLimits,
      maxOutputBytes,
      terminationGraceMs,
      executionContainment,
      ownsExecutionContainment,
      started: false,
      running: false,
      disposed: false,
    };
    bindings.add(binding);
    states.set(binding, state);
    activeWorkspaceRoots.set(root, state);
    return binding;
  } catch (error) {
    if (ownsExecutionContainment && executionContainment !== undefined) {
      try {
        disposeExecutionContainment(executionContainment);
      } catch {}
    }
    if (activeWorkspaceRoots.get(root) === reservation) {
      activeWorkspaceRoots.delete(root);
    }
    throw error;
  }
}

/** @param {unknown} binding */
export function isTaskCheckBinding(binding) {
  return binding !== null && typeof binding === "object" && bindings.has(binding);
}

/**
 * Release an inactive binding. Baseline data is never persisted.
 * @param {unknown} binding
 */
export function disposeTaskCheckBinding(binding) {
  if (!isTaskCheckBinding(binding)) {
    throw new TaskCheckLocalApiError(
      "invalid-task-check-binding",
      "$.binding",
      "dispose requires a genuine task-check binding",
    );
  }
  const state = states.get(binding);
  if (state.disposed) return;
  if (state.running) {
    throw new TaskCheckLocalConfigurationError(
      "task-check-running",
      "$.binding",
      "cannot dispose a task-check binding while commands are active",
    );
  }
  state.disposed = true;
  if (activeWorkspaceRoots.get(state.workspaceRoot) === state) {
    activeWorkspaceRoots.delete(state.workspaceRoot);
  }
  if (state.ownsExecutionContainment) {
    disposeExecutionContainment(state.executionContainment);
  }
}

/** @param {any} state @param {string} code @param {boolean} cancelled */
function rejectedBindingResult(state, code, cancelled = false) {
  const unavailable = unavailableSnapshotSummary(code);
  const scope = unavailableScope(code);
  const immutable = unavailableImmutable(
    code,
    state.contract.authority.paths.immutable.map((entry) => entry.path),
  );
  return evaluateTaskCheck(state.contract, {
    contract: state.contract,
    contractSha256: state.contract.contractSha256,
    workspaceIdentity: state.binding.workspaceIdentity,
    baseline: snapshotSummary(state.baseline),
    preCommands: unavailable,
    postCommands: unavailable,
    scope: { preCommands: scope, postCommands: scope },
    immutable: {
      baseline: state.immutableBaseline,
      preCommands: immutable,
      postCommands: immutable,
    },
    commands: [],
    infrastructureFailures: [{ category: "binding", code }],
    cancelled,
  });
}

/**
 * Run exactly one terminal check against the binding's baseline.
 *
 * @param {unknown} binding
 * @param {unknown} input
 */
export async function runTaskCheck(binding, input) {
  if (!isTaskCheckBinding(binding)) {
    throw new TaskCheckLocalApiError(
      "invalid-task-check-binding",
      "$.binding",
      "runTaskCheck requires a genuine task-check binding",
    );
  }
  const data = closedInput(
    input,
    ["contract", "workspaceRoot", "signal"],
    ["contract", "workspaceRoot"],
    "$.input",
  );
  const state = states.get(binding);
  if (state.disposed) {
    throw new TaskCheckLocalConfigurationError(
      "task-check-binding-disposed",
      "$.binding",
      "cannot run a disposed task-check binding",
    );
  }
  if (state.started) {
    throw new TaskCheckLocalConfigurationError(
      "task-check-already-started",
      "$.binding",
      "a task-check binding is single-use",
    );
  }
  state.started = true;
  state.running = true;
  try {
    if (data.contract !== state.contract) {
      return rejectedBindingResult(state, "task-contract-identity-mismatch");
    }
    if (
      typeof data.workspaceRoot !== "string" ||
      !isAbsolute(data.workspaceRoot) ||
      resolve(data.workspaceRoot) !== state.workspaceRoot
    ) {
      return rejectedBindingResult(state, "workspace-binding-mismatch");
    }
    if (data.signal !== undefined && !(data.signal instanceof AbortSignal)) {
      throw new TaskCheckLocalApiError(
        "invalid-abort-signal",
        "$.input.signal",
        "signal must be an AbortSignal when present",
      );
    }
    if (data.signal?.aborted) {
      return rejectedBindingResult(state, "check-cancelled-before-snapshot", true);
    }

    const preCommandsSnapshot = await captureWorkspaceSnapshot(
      state.workspaceRoot,
      state.snapshotLimits,
    );
    const preScope = compareWorkspaceSnapshots(
      state.contract,
      state.baseline,
      preCommandsSnapshot,
    );
    const preImmutable = verifyImmutableAuthority(
      state.contract,
      state.baseline,
      preCommandsSnapshot,
    );
    const commands = [];
    const preAuthorityValid =
      state.baseline.ok &&
      state.immutableBaseline.ok &&
      preCommandsSnapshot.ok &&
      preScope.ok &&
      preImmutable.ok;
    let cancelled = false;
    if (preAuthorityValid) {
      outer: for (const phase of ["semantic", "validation", "finish"]) {
        for (const command of state.contract.authority.commands[phase]) {
          const outcome = await executeContractCommand({
            contract: state.contract,
            command,
            phase,
            workspaceRoot: state.workspaceRoot,
            baseEnvironment: state.baseEnvironment,
            executionContainment: state.executionContainment,
            signal: data.signal,
            maxOutputBytes: state.maxOutputBytes,
            terminationGraceMs: state.terminationGraceMs,
          });
          commands.push(outcome);
          if (outcome.aborted) {
            cancelled = true;
            break outer;
          }
        }
      }
    }
    cancelled = cancelled || (data.signal?.aborted ?? false);

    const postCommandsSnapshot = await captureWorkspaceSnapshot(
      state.workspaceRoot,
      state.snapshotLimits,
    );
    const postScope = compareWorkspaceSnapshots(
      state.contract,
      state.baseline,
      postCommandsSnapshot,
    );
    const commandEffects = compareWorkspaceSnapshots(
      state.contract,
      preCommandsSnapshot,
      postCommandsSnapshot,
    );
    const postImmutable = verifyImmutableAuthority(
      state.contract,
      state.baseline,
      postCommandsSnapshot,
    );
    cancelled = cancelled || (data.signal?.aborted ?? false);
    return evaluateTaskCheck(state.contract, {
      contract: state.contract,
      contractSha256: state.contract.contractSha256,
      workspaceIdentity: state.binding.workspaceIdentity,
      baseline: snapshotSummary(state.baseline),
      preCommands: snapshotSummary(preCommandsSnapshot),
      postCommands: snapshotSummary(postCommandsSnapshot),
      scope: {
        preCommands: preScope,
        postCommands: postScope,
      },
      immutable: {
        baseline: state.immutableBaseline,
        preCommands: preImmutable,
        postCommands: postImmutable,
      },
      commands,
      infrastructureFailures: [],
      cancelled,
      effectAttribution: {
        modelPhase: preScope,
        authoritativeCommandPhase: commandEffects,
        final: postScope,
      },
    });
  } finally {
    state.running = false;
  }
}
