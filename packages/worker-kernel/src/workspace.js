import { cp, lstat, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { WorkerKernelApiError } from "./errors.js";

const RUN_PREFIX = "/tmp/dsh-dsworker-run.";

/** @param {unknown} sourceWorkspaceRoot */
export async function materializeWorkerWorkspace(sourceWorkspaceRoot) {
  if (
    typeof sourceWorkspaceRoot !== "string" ||
    sourceWorkspaceRoot.length === 0 ||
    !isAbsolute(sourceWorkspaceRoot) ||
    /[\u0000-\u001f\u007f]/u.test(sourceWorkspaceRoot)
  ) {
    throw new WorkerKernelApiError(
      "invalid-source-workspace",
      "$.sourceWorkspaceRoot",
      "sourceWorkspaceRoot must be an absolute path without control characters",
    );
  }
  const source = resolve(sourceWorkspaceRoot);
  let sourceStat;
  try {
    sourceStat = await lstat(source);
  } catch {
    throw new WorkerKernelApiError(
      "source-workspace-unavailable",
      "$.sourceWorkspaceRoot",
      "sourceWorkspaceRoot must name an existing directory",
    );
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new WorkerKernelApiError(
      "invalid-source-workspace-type",
      "$.sourceWorkspaceRoot",
      "sourceWorkspaceRoot must be a real directory, not a symlink",
    );
  }

  const runRoot = await mkdtemp(RUN_PREFIX);
  const workspaceRoot = join(runRoot, "workspace");
  try {
    await cp(source, workspaceRoot, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
  } catch (error) {
    await rm(runRoot, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({ runRoot, workspaceRoot, sourceWorkspaceRoot: source });
}

/** @param {string} runRoot */
export async function removeWorkerWorkspace(runRoot) {
  const resolved = resolve(runRoot);
  if (!resolved.startsWith(RUN_PREFIX) || resolved === RUN_PREFIX) {
    throw new Error("refusing to remove a non-worker temporary root");
  }
  await rm(resolved, { recursive: true, force: true });
}
