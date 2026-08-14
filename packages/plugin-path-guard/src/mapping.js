import { deepFreeze, isPlainDataObject } from "./freeze.js";

export const READ_ONLY_TOOLS = Object.freeze(["glob", "grep", "read"]);
export const STRUCTURED_MUTATION_TOOLS = Object.freeze(["edit", "write"]);
export const OUTSIDE_PATH_GUARD_TOOLS = Object.freeze(["bash"]);
export const LEAN_TOOL_SURFACE = Object.freeze([
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
  "write",
]);

/** @param {unknown} value @param {string} key */
function ownDataValue(value, key) {
  if (!isPlainDataObject(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

/**
 * Classify the six reviewed lean-preset tools without claiming anything about
 * tools introduced by a different composition.
 *
 * @param {unknown} name
 */
export function classifyLeanTool(name) {
  if (typeof name !== "string") {
    return deepFreeze({ classification: "unsupported", code: "invalid-tool-name" });
  }
  if (READ_ONLY_TOOLS.includes(name)) {
    return deepFreeze({ classification: "read-only", code: "read-only-tool", toolName: name });
  }
  if (STRUCTURED_MUTATION_TOOLS.includes(name)) {
    return deepFreeze({
      classification: "structured-mutation",
      code: "structured-filesystem-tool",
      toolName: name,
    });
  }
  if (OUTSIDE_PATH_GUARD_TOOLS.includes(name)) {
    return deepFreeze({
      classification: "outside-path-guard",
      code: "bash-outside-path-guard",
      toolName: name,
    });
  }
  return deepFreeze({
    classification: "uncovered",
    code: "tool-outside-reviewed-lean-surface",
    toolName: name,
  });
}

/**
 * Convert one known rc.6 structured filesystem mutation call into a bounded
 * intent. This function reads only the path field; it never retains content or
 * edit strings. Unknown tools and malformed arguments are machine-readable
 * unsupported mappings, not thrown policy decisions.
 *
 * @param {unknown} execution
 */
export function extractMutationIntent(execution) {
  if (!isPlainDataObject(execution)) {
    return deepFreeze({ status: "unsupported", code: "invalid-execution" });
  }
  const toolName = ownDataValue(execution, "name");
  const toolCallId = ownDataValue(execution, "callId");
  if (toolName !== "edit" && toolName !== "write") {
    return deepFreeze({
      status: "unsupported",
      code: "unknown-mutation-tool",
      toolName: typeof toolName === "string" ? toolName : null,
      toolCallId: typeof toolCallId === "string" ? toolCallId : null,
    });
  }
  const args = ownDataValue(execution, "arguments");
  if (!isPlainDataObject(args)) {
    return deepFreeze({
      status: "unsupported",
      code: "malformed-tool-arguments",
      toolName,
      toolCallId: typeof toolCallId === "string" ? toolCallId : null,
    });
  }
  const requestedPath = ownDataValue(args, "file_path");
  if (typeof requestedPath !== "string" || requestedPath.trim().length === 0) {
    return deepFreeze({
      status: "unsupported",
      code: "malformed-file-path",
      toolName,
      toolCallId: typeof toolCallId === "string" ? toolCallId : null,
    });
  }
  return deepFreeze({
    status: "mapped",
    operation: toolName === "edit" ? "edit-file" : "write-file",
    requestedPath,
    toolName,
    toolCallId: typeof toolCallId === "string" ? toolCallId : null,
  });
}
