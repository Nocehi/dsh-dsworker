import { isGuardBinding } from "./binding.js";
import { deepFreeze } from "./freeze.js";

/** @param {Record<string, unknown>} fields */
function filesystemRecord(fields) {
  return deepFreeze({
    decision: fields.decision,
    code: fields.code,
    operation: fields.operation ?? null,
    normalizedPath: fields.normalizedPath ?? null,
    targetState: fields.targetState ?? null,
    checkedPrefixes: fields.checkedPrefixes ?? [],
    workspaceRoot: fields.workspaceRoot ?? null,
  });
}

/** @param {unknown} fs */
function hasFilesystemSeam(fs) {
  return (
    fs !== null &&
    typeof fs === "object" &&
    typeof fs.resolve === "function" &&
    typeof fs.lstat === "function" &&
    typeof fs.contains === "function"
  );
}

/**
 * Prove that a lexically normalized structured file mutation stays under the
 * bound workspace and crosses no symlink path entry. No contents are read and
 * no filesystem mutation is performed.
 *
 * @param {unknown} fs
 * @param {unknown} binding
 * @param {{operation: "edit-file" | "write-file", normalizedPath: string}} request
 * @param {AbortSignal | undefined} signal
 */
export async function proveFilesystemBinding(fs, binding, request, signal) {
  if (!isGuardBinding(binding)) {
    return filesystemRecord({
      decision: "deny",
      code: "invalid-guard-binding",
    });
  }
  if (!hasFilesystemSeam(fs)) {
    return filesystemRecord({
      decision: "deny",
      code: "filesystem-proof-unavailable",
      workspaceRoot: binding.workspaceRoot,
    });
  }
  if (
    request === null ||
    typeof request !== "object" ||
    (request.operation !== "edit-file" && request.operation !== "write-file") ||
    typeof request.normalizedPath !== "string" ||
    request.normalizedPath.length === 0
  ) {
    return filesystemRecord({
      decision: "deny",
      code: "invalid-filesystem-proof-request",
      workspaceRoot: binding.workspaceRoot,
    });
  }

  const checkedPrefixes = [];
  try {
    const rootInfo = await fs.lstat(binding.workspaceRoot, {}, signal);
    if (rootInfo === undefined) {
      return filesystemRecord({
        decision: "deny",
        code: "workspace-root-missing",
        normalizedPath: request.normalizedPath,
        checkedPrefixes,
        workspaceRoot: binding.workspaceRoot,
      });
    }
    if (rootInfo.type === "symlink") {
      return filesystemRecord({
        decision: "unsupported",
        code: "workspace-root-symlink",
        normalizedPath: request.normalizedPath,
        checkedPrefixes,
        workspaceRoot: binding.workspaceRoot,
      });
    }
    if (rootInfo.type !== "directory") {
      return filesystemRecord({
        decision: "deny",
        code: "workspace-root-not-directory",
        normalizedPath: request.normalizedPath,
        checkedPrefixes,
        workspaceRoot: binding.workspaceRoot,
      });
    }
    const rootTarget = await fs.resolve(binding.workspaceRoot, { signal });
    const segments = request.normalizedPath.split("/");
    let targetState = "missing";
    for (let index = 0; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index + 1).join("/");
      const isTarget = index === segments.length - 1;
      checkedPrefixes.push(prefix);
      const info = await fs.lstat(prefix, { cwd: binding.workspaceRoot }, signal);
      if (info === undefined) {
        if (!isTarget) {
          return filesystemRecord({
            decision: "deny",
            code: "implicit-parent-creation-unproven",
            normalizedPath: request.normalizedPath,
            checkedPrefixes,
            workspaceRoot: binding.workspaceRoot,
          });
        }
        targetState = "missing";
        break;
      }
      if (info.type === "symlink") {
        return filesystemRecord({
          decision: "unsupported",
          code: isTarget ? "target-symlink" : "parent-symlink",
          normalizedPath: request.normalizedPath,
          checkedPrefixes,
          workspaceRoot: binding.workspaceRoot,
        });
      }
      if (!isTarget && info.type !== "directory") {
        return filesystemRecord({
          decision: "deny",
          code: "parent-not-directory",
          normalizedPath: request.normalizedPath,
          checkedPrefixes,
          workspaceRoot: binding.workspaceRoot,
        });
      }
      if (isTarget) targetState = info.type;
    }

    if (request.operation === "edit-file" && targetState === "missing") {
      return filesystemRecord({
        decision: "deny",
        code: "edit-target-missing",
        operation: "edit-file",
        normalizedPath: request.normalizedPath,
        targetState,
        checkedPrefixes,
        workspaceRoot: binding.workspaceRoot,
      });
    }
    if (targetState !== "missing" && targetState !== "file") {
      return filesystemRecord({
        decision: "deny",
        code: "target-not-regular-file",
        operation:
          request.operation === "edit-file"
            ? "edit-file"
            : "replace-file",
        normalizedPath: request.normalizedPath,
        targetState,
        checkedPrefixes,
        workspaceRoot: binding.workspaceRoot,
      });
    }

    const target = await fs.resolve(request.normalizedPath, {
      cwd: binding.workspaceRoot,
      signal,
    });
    if (!fs.contains(rootTarget, target)) {
      return filesystemRecord({
        decision: "deny",
        code: "resolved-target-outside-workspace",
        normalizedPath: request.normalizedPath,
        targetState,
        checkedPrefixes,
        workspaceRoot: binding.workspaceRoot,
      });
    }
    const operation =
      request.operation === "edit-file"
        ? "edit-file"
        : targetState === "missing"
          ? "create-file"
          : "replace-file";
    return filesystemRecord({
      decision: "allow",
      code:
        targetState === "missing"
          ? "missing-target-parent-chain-proven"
          : "existing-regular-file-chain-proven",
      operation,
      normalizedPath: request.normalizedPath,
      targetState,
      checkedPrefixes,
      workspaceRoot: binding.workspaceRoot,
    });
  } catch {
    return filesystemRecord({
      decision: "deny",
      code: "filesystem-proof-error",
      normalizedPath: request.normalizedPath,
      checkedPrefixes,
      workspaceRoot: binding.workspaceRoot,
    });
  }
}
