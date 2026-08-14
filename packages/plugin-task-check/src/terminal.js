import { isTaskCheckResult } from "@dsh-dsworker/task-check-core";
import { deepFreeze } from "./freeze.js";

export const TASK_CHECK_TERMINAL_OBSERVATION_VERSION =
  "dsh-dsworker/task-check-terminal-observation/v1";

const observations = new WeakSet();

/** @param {unknown} value */
function errorCode(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** @param {unknown} value */
function jsonIdentity(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Convert the final rc.6 tools/result commit plus the host-retained verdict into
 * one bounded, host-only terminal observation. The complete ToolExecutionResult
 * is deliberately not retained: its rendered content belongs to model/session
 * presentation, not worker authority.
 *
 * @param {{
 *   contractSha256: string,
 *   exec: any,
 *   finalResult: any,
 *   pending?: {taskCheckResult: unknown, summary: unknown, concludeFailed?: boolean}
 * }} input
 */
export function createTaskCheckTerminalObservation(input) {
  const finalErrorCode = input.finalResult?.isError
    ? errorCode(input.finalResult.error?.info?.code)
    : null;
  const commit = {
    isError: input.finalResult?.isError === true,
    errorCode: finalErrorCode,
    concludesTurn: input.finalResult?.concludesTurn === true,
  };

  let status = null;
  let code = "missing-host-verdict";
  let valid = false;
  let taskCheckResult = null;
  if (input.pending !== undefined && isTaskCheckResult(input.pending.taskCheckResult)) {
    taskCheckResult = input.pending.taskCheckResult;
    status = taskCheckResult.status;
    const sameProjection =
      input.finalResult?.isError === false &&
      jsonIdentity(input.finalResult.value) === jsonIdentity(input.pending.summary);
    if (input.pending.concludeFailed === true) {
      code = "conclude-turn-failed";
    } else if (status === "green") {
      valid = sameProjection && commit.concludesTurn;
      code = valid ? "green-committed" : "green-commit-mismatch";
    } else if (status === "red") {
      valid = sameProjection && !commit.concludesTurn;
      code = valid ? "red-committed" : "red-commit-mismatch";
    } else if (status === "aborted") {
      valid =
        commit.isError &&
        (commit.errorCode === "ABORTED" ||
          commit.errorCode === "ABORTED_BEFORE_DISPATCH");
      code = valid ? "aborted-committed" : "aborted-commit-mismatch";
    } else {
      code = "unknown-host-verdict";
    }
  }

  if (
    taskCheckResult !== null &&
    taskCheckResult.contractSha256 !== input.contractSha256
  ) {
    valid = false;
    code = "contract-digest-mismatch";
  }

  const observation = deepFreeze({
    version: TASK_CHECK_TERMINAL_OBSERVATION_VERSION,
    kind: valid ? "verdict" : "infrastructure-failure",
    status: valid ? status : null,
    code,
    contractSha256: input.contractSha256,
    toolCallId:
      typeof input.exec?.callId === "string" ? input.exec.callId : null,
    commit,
    taskCheckResult: valid ? taskCheckResult : null,
  });
  observations.add(observation);
  return observation;
}

/** @param {unknown} value */
export function isTaskCheckTerminalObservation(value) {
  return value !== null && typeof value === "object" && observations.has(value);
}
