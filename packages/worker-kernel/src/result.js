import { deepFreeze } from "./freeze.js";

export const WORKER_RESULT_VERSION = "dsh-dsworker/worker-result/v1";
export const WORKER_STATUSES = Object.freeze(["green", "red", "aborted"]);

const results = new WeakSet();

/** @param {any} input */
export function createWorkerResult(input) {
  const result = deepFreeze({
    version: WORKER_RESULT_VERSION,
    status: input.status,
    code: input.code,
    contractSha256: input.contractSha256,
    sessionId: input.sessionId,
    workspaceIdentity: input.workspaceIdentity,
    modelSelection: input.modelSelection,
    authoritative: input.authoritative,
    delta: input.delta,
    lifecycle: input.lifecycle,
    containment: input.containment,
    cleanup: input.cleanup,
    failures: input.failures,
  });
  results.add(result);
  return result;
}

/** @param {unknown} value */
export function isWorkerResult(value) {
  return value !== null && typeof value === "object" && results.has(value);
}

/** @param {unknown} result */
export function workerExitCode(result) {
  if (!isWorkerResult(result)) {
    throw new TypeError("workerExitCode requires a genuine WorkerResult");
  }
  if (result.status === "green") return 0;
  if (result.status === "red") return 1;
  return 2;
}
