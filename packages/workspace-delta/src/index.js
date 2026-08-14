import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  captureWorkspaceSnapshot,
  compareWorkspaceSnapshots,
  normalizeSnapshotLimits,
} from "@dsh-dsworker/task-check-local";
import { isTaskContract } from "@dsh-dsworker/task-contract";
import { WorkspaceDeltaError } from "./errors.js";
import { deepFreeze, isPlainObject } from "./freeze.js";

export { WorkspaceDeltaError };

export const WORKSPACE_DELTA_VERSION = "dsh-dsworker/workspace-delta/v1";
export const WORKSPACE_DELTA_ARTIFACT_VERSION =
  "dsh-dsworker/workspace-delta-artifact/v1";

const bindings = new WeakSet();
const bindingStates = new WeakMap();
const deltas = new WeakSet();
const SAFE_PATCH_PATH = /^[A-Za-z0-9._/-]+$/u;
const FORBIDDEN_DELTA_ROOTS = Object.freeze([".git", ".zig-cache", "zig-out"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {unknown} value @param {string} path */
function absoluteRoot(value, path) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new WorkspaceDeltaError(
      "invalid-workspace-root",
      path,
      `${path} must be an absolute path without control characters`,
    );
  }
  return resolve(value);
}

/** @param {unknown} input @param {readonly string[]} allowed @param {readonly string[]} required */
function closedInput(input, allowed, required) {
  if (!isPlainObject(input)) {
    throw new WorkspaceDeltaError(
      "invalid-input",
      "$",
      "workspace-delta input must be a plain object",
    );
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new WorkspaceDeltaError(
        "unknown-field",
        `$.${key}`,
        `$.${key} is not part of this API`,
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(input, key)) {
      throw new WorkspaceDeltaError(
        "missing-field",
        `$.${key}`,
        `$.${key} is required`,
      );
    }
  }
  return input;
}

/** @param {any} snapshot */
function treeProjection(snapshot) {
  return snapshot.entries.map((entry) => ({
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    size: entry.size,
    sha256: entry.sha256,
  }));
}

/** @param {any} snapshot */
function treeIdentity(snapshot) {
  const projection = treeProjection(snapshot);
  const bytes = Buffer.from(JSON.stringify(projection), "utf8");
  return deepFreeze({
    kind: "workspace-content-tree-sha256",
    sha256: sha256(bytes),
    entryCount: snapshot.entryCount,
    totalFileBytes: snapshot.totalFileBytes,
  });
}

/** @param {any} left @param {any} right */
function sameTree(left, right) {
  return left.sha256 === right.sha256 && left.entryCount === right.entryCount;
}

/** @param {any} snapshot @param {string} path */
function snapshotEntry(snapshot, path) {
  return snapshot.entries.find((entry) => entry.path === path);
}

/** @param {string} path */
function forbiddenDeltaPath(path) {
  return FORBIDDEN_DELTA_ROOTS.some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

/** @param {string} root @param {string} relativePath @param {any} expected */
async function readVerifiedFile(root, relativePath, expected) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(
      join(root, ...relativePath.split("/")),
      constants.O_RDONLY | noFollow,
    );
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) {
      throw new WorkspaceDeltaError(
        "unsupported-file-node",
        `$.changes.${relativePath}`,
        "delta files must be ordinary single-link files",
      );
    }
    const bytes = await handle.readFile();
    if (
      Number(stat.size) !== expected.size ||
      Number(stat.mode & 0o7777n) !== expected.mode ||
      sha256(bytes) !== expected.sha256
    ) {
      throw new WorkspaceDeltaError(
        "file-changed-during-export",
        `$.changes.${relativePath}`,
        "file identity changed after the final snapshot",
      );
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** @param {Buffer | null} value @param {string} path */
function patchText(value, path) {
  if (value === null) return null;
  let text;
  try {
    text = UTF8_DECODER.decode(value);
  } catch {
    throw new WorkspaceDeltaError(
      "binary-delta-unsupported",
      `$.changes.${path}`,
      "v1 review patches support UTF-8 source files only",
    );
  }
  if (text.includes("\u0000")) {
    throw new WorkspaceDeltaError(
      "binary-delta-unsupported",
      `$.changes.${path}`,
      "v1 review patches do not support NUL bytes",
    );
  }
  return text;
}

/** @param {string} text */
function linesOf(text) {
  if (text.length === 0) return [];
  const raw = text.split("\n");
  const endsWithNewline = text.endsWith("\n");
  if (endsWithNewline) raw.pop();
  return raw.map((line, index) => ({
    text: line,
    newline: endsWithNewline || index < raw.length - 1,
  }));
}

/** @param {string} prefix @param {readonly {text: string, newline: boolean}[]} lines */
function renderPatchLines(prefix, lines) {
  let output = "";
  for (const line of lines) {
    output += `${prefix}${line.text}\n`;
    if (!line.newline) output += "\\ No newline at end of file\n";
  }
  return output;
}

/** @param {number} count */
function hunkRange(count) {
  return count === 0 ? "0,0" : `1,${count}`;
}

/** @param {number} mode */
function gitFileMode(mode) {
  return (0o100000 | mode).toString(8);
}

/** @param {any} change @param {Buffer | null} before @param {Buffer | null} after */
function renderChangePatch(change, before, after) {
  const path = change.path;
  if (!SAFE_PATCH_PATH.test(path) || path.includes("//")) {
    throw new WorkspaceDeltaError(
      "review-path-unsupported",
      `$.changes.${path}`,
      "v1 review patches require portable ASCII source paths",
    );
  }
  const beforeLines = linesOf(patchText(before, path) ?? "");
  const afterLines = linesOf(patchText(after, path) ?? "");
  let output = `diff --git a/${path} b/${path}\n`;
  if (change.kind === "create") {
    output += `new file mode ${gitFileMode(change.afterMode)}\n`;
    output += `--- /dev/null\n+++ b/${path}\n`;
  } else if (change.kind === "delete") {
    output += `deleted file mode ${gitFileMode(change.beforeMode)}\n`;
    output += `--- a/${path}\n+++ /dev/null\n`;
  } else {
    output += `--- a/${path}\n+++ b/${path}\n`;
  }
  output += `@@ -${hunkRange(beforeLines.length)} +${hunkRange(afterLines.length)} @@\n`;
  output += renderPatchLines("-", beforeLines);
  output += renderPatchLines("+", afterLines);
  return output;
}

/**
 * Bind the exact source tree and freshly materialized worker tree before an
 * Agent can mutate either. The source root is observed host-side only.
 * @param {unknown} input
 */
export async function createWorkspaceDeltaBinding(input) {
  const data = closedInput(
    input,
    ["contract", "sourceWorkspaceRoot", "workspaceRoot", "snapshotLimits"],
    ["contract", "sourceWorkspaceRoot", "workspaceRoot"],
  );
  if (!isTaskContract(data.contract)) {
    throw new WorkspaceDeltaError(
      "unparsed-task-contract",
      "$.contract",
      "workspace delta requires the exact parsed TaskContract",
    );
  }
  const sourceRoot = absoluteRoot(data.sourceWorkspaceRoot, "$.sourceWorkspaceRoot");
  const workspaceRoot = absoluteRoot(data.workspaceRoot, "$.workspaceRoot");
  if (sourceRoot === workspaceRoot) {
    throw new WorkspaceDeltaError(
      "workspace-alias",
      "$.workspaceRoot",
      "source and worker workspaces must be different roots",
    );
  }
  const limits = normalizeSnapshotLimits(data.snapshotLimits ?? {});
  const [sourceSnapshot, workspaceSnapshot] = await Promise.all([
    captureWorkspaceSnapshot(sourceRoot, limits),
    captureWorkspaceSnapshot(workspaceRoot, limits),
  ]);
  if (!sourceSnapshot.ok || !workspaceSnapshot.ok) {
    throw new WorkspaceDeltaError(
      "baseline-snapshot-invalid",
      "$",
      "source and worker baseline snapshots must both be complete",
    );
  }
  const sourceIdentity = treeIdentity(sourceSnapshot);
  const workspaceIdentity = treeIdentity(workspaceSnapshot);
  if (!sameTree(sourceIdentity, workspaceIdentity)) {
    throw new WorkspaceDeltaError(
      "materialized-tree-mismatch",
      "$.workspaceRoot",
      "materialized worker tree does not match the source content tree",
    );
  }
  let binding;
  const dispose = Object.freeze(() => disposeWorkspaceDeltaBinding(binding));
  binding = deepFreeze({
    version: WORKSPACE_DELTA_VERSION,
    contract: data.contract,
    contractSha256: data.contract.contractSha256,
    sourceWorkspaceRoot: sourceRoot,
    workspaceRoot,
    sourceIdentity,
    dispose,
  });
  bindings.add(binding);
  bindingStates.set(binding, {
    contract: data.contract,
    sourceRoot,
    workspaceRoot,
    sourceSnapshot,
    workspaceSnapshot,
    sourceIdentity,
    limits,
    exported: false,
    disposed: false,
  });
  return binding;
}

/** @param {unknown} value */
export function isWorkspaceDeltaBinding(value) {
  return value !== null && typeof value === "object" && bindings.has(value);
}

/** @param {unknown} binding */
export function disposeWorkspaceDeltaBinding(binding) {
  if (!isWorkspaceDeltaBinding(binding)) {
    throw new WorkspaceDeltaError(
      "invalid-binding",
      "$.binding",
      "dispose requires a genuine WorkspaceDelta binding",
    );
  }
  const state = bindingStates.get(binding);
  state.disposed = true;
}

/**
 * Export an exact UTF-8 source delta. Callers must gate this operation on an
 * authoritative GREEN terminal observation; the API itself never interprets
 * model or WorkerResult state.
 * @param {unknown} binding
 * @param {unknown} input
 */
export async function exportWorkspaceDelta(binding, input) {
  if (!isWorkspaceDeltaBinding(binding)) {
    throw new WorkspaceDeltaError(
      "invalid-binding",
      "$.binding",
      "export requires a genuine WorkspaceDelta binding",
    );
  }
  const data = closedInput(
    input,
    ["contract", "sourceWorkspaceRoot", "workspaceRoot"],
    ["contract", "sourceWorkspaceRoot", "workspaceRoot"],
  );
  const state = bindingStates.get(binding);
  if (state.disposed) {
    throw new WorkspaceDeltaError(
      "binding-disposed",
      "$.binding",
      "cannot export through a disposed binding",
    );
  }
  if (state.exported) {
    throw new WorkspaceDeltaError(
      "delta-already-exported",
      "$.binding",
      "a workspace delta binding is single-use",
    );
  }
  state.exported = true;
  if (data.contract !== state.contract) {
    throw new WorkspaceDeltaError(
      "task-contract-identity-mismatch",
      "$.contract",
      "delta export requires the exact bound TaskContract",
    );
  }
  if (
    absoluteRoot(data.sourceWorkspaceRoot, "$.sourceWorkspaceRoot") !== state.sourceRoot ||
    absoluteRoot(data.workspaceRoot, "$.workspaceRoot") !== state.workspaceRoot
  ) {
    throw new WorkspaceDeltaError(
      "workspace-binding-mismatch",
      "$",
      "delta export roots differ from the bound roots",
    );
  }

  const [sourceCurrent, workspaceFinal] = await Promise.all([
    captureWorkspaceSnapshot(state.sourceRoot, state.limits),
    captureWorkspaceSnapshot(state.workspaceRoot, state.limits),
  ]);
  if (!sourceCurrent.ok || !workspaceFinal.ok) {
    throw new WorkspaceDeltaError(
      "final-snapshot-invalid",
      "$",
      "source and final worker snapshots must both be complete",
    );
  }
  const sourceCurrentIdentity = treeIdentity(sourceCurrent);
  if (!sameTree(state.sourceIdentity, sourceCurrentIdentity)) {
    throw new WorkspaceDeltaError(
      "source-tree-changed",
      "$.sourceWorkspaceRoot",
      "source tree changed after the worker baseline was frozen",
    );
  }
  const scope = compareWorkspaceSnapshots(
    state.contract,
    state.workspaceSnapshot,
    workspaceFinal,
  );
  if (!scope.ok) {
    throw new WorkspaceDeltaError(
      "delta-outside-mutable-authority",
      "$.workspaceRoot",
      "final changes are not a subset of TaskContract mutable authority",
    );
  }

  const baselineByPath = new Map(
    state.workspaceSnapshot.entries.map((entry) => [entry.path, entry]),
  );
  const finalByPath = new Map(
    workspaceFinal.entries.map((entry) => [entry.path, entry]),
  );
  const projectionChangedPaths = [
    ...new Set([...baselineByPath.keys(), ...finalByPath.keys()]),
  ]
    .filter((path) => {
      const before = baselineByPath.get(path);
      const after = finalByPath.get(path);
      if (before === undefined || after === undefined) return true;
      return (
        before.type !== after.type ||
        before.mode !== after.mode ||
        before.size !== after.size ||
        before.sha256 !== after.sha256
      );
    })
    .sort();
  const entries = [];
  let reviewPatch = "";
  for (const path of projectionChangedPaths) {
    if (forbiddenDeltaPath(path)) {
      throw new WorkspaceDeltaError(
        "ephemeral-or-vcs-path",
        `$.changes.${path}`,
        "VCS metadata and build-cache paths are never promotable",
      );
    }
    const before = baselineByPath.get(path);
    const after = finalByPath.get(path);
    if (
      (before !== undefined && before.type !== "file") ||
      (after !== undefined && after.type !== "file") ||
      (before !== undefined && after !== undefined && before.mode !== after.mode)
    ) {
      throw new WorkspaceDeltaError(
        "non-file-delta-unsupported",
        `$.changes.${path}`,
        "v1 promotion supports file create, content modify, and file delete only",
      );
    }
    const kind = before === undefined ? "create" : after === undefined ? "delete" : "modify";
    const sourceBefore = before === undefined ? undefined : snapshotEntry(sourceCurrent, path);
    if (
      (before === undefined && sourceBefore !== undefined) ||
      (before !== undefined &&
        (sourceBefore === undefined ||
          sourceBefore.type !== "file" ||
          sourceBefore.sha256 !== before.sha256 ||
          sourceBefore.mode !== before.mode))
    ) {
      throw new WorkspaceDeltaError(
        "source-entry-mismatch",
        `$.changes.${path}`,
        "source entry no longer matches the worker baseline",
      );
    }
    const beforeBytes =
      before === undefined
        ? null
        : await readVerifiedFile(state.sourceRoot, path, sourceBefore);
    const afterBytes =
      after === undefined
        ? null
        : await readVerifiedFile(state.workspaceRoot, path, after);
    const entry = {
      path,
      kind,
      beforeSha256: before?.sha256 ?? null,
      afterSha256: after?.sha256 ?? null,
      beforeMode: before?.mode ?? null,
      afterMode: after?.mode ?? null,
      afterBytes: afterBytes?.length ?? 0,
      afterContentBase64: afterBytes?.toString("base64") ?? null,
    };
    entries.push(entry);
    reviewPatch += renderChangePatch(entry, beforeBytes, afterBytes);
  }

  const finalIdentity = treeIdentity(workspaceFinal);
  const artifactPayload = {
    version: WORKSPACE_DELTA_ARTIFACT_VERSION,
    contractSha256: state.contract.contractSha256,
    sourceTreeSha256: state.sourceIdentity.sha256,
    finalTreeSha256: finalIdentity.sha256,
    entries,
  };
  const artifactBytes = Buffer.from(JSON.stringify(artifactPayload), "utf8");
  const delta = deepFreeze({
    version: WORKSPACE_DELTA_VERSION,
    promotable: true,
    contractSha256: state.contract.contractSha256,
    source: state.sourceIdentity,
    final: finalIdentity,
    changedPaths: entries.map((entry) => entry.path),
    changes: entries,
    artifact: {
      version: WORKSPACE_DELTA_ARTIFACT_VERSION,
      sha256: sha256(artifactBytes),
      bytes: artifactBytes.length,
    },
    reviewPatch: {
      format: "unified-diff",
      sha256: sha256(Buffer.from(reviewPatch, "utf8")),
      bytes: Buffer.byteLength(reviewPatch, "utf8"),
      text: reviewPatch,
    },
  });
  deltas.add(delta);
  return delta;
}

/** @param {unknown} value */
export function isWorkspaceDelta(value) {
  return value !== null && typeof value === "object" && deltas.has(value);
}
