import {
  TaskContractParseError,
  TaskContractSemanticError,
} from "./errors.js";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;

/**
 * Normalize one platform-independent contract path. Both slash spellings are
 * separators, repeated separators and `.` segments collapse, and every `..`
 * segment is rejected instead of resolved.
 *
 * @param {unknown} value
 * @param {string} [location]
 * @returns {string}
 */
export function normalizeContractPath(value, location = "$path") {
  if (typeof value !== "string") {
    throw new TaskContractParseError(
      "invalid-path-type",
      location,
      `${location} must be a string`,
    );
  }
  if (value.length === 0 || CONTROL_CHARACTER.test(value)) {
    throw new TaskContractSemanticError(
      "invalid-path",
      location,
      `${location} must be a non-empty path without control characters`,
    );
  }

  const slashed = value.replaceAll("\\", "/");
  if (slashed.startsWith("/") || WINDOWS_DRIVE_PREFIX.test(slashed)) {
    throw new TaskContractSemanticError(
      "absolute-path",
      location,
      `${location} must be relative to the runner-supplied workspace`,
    );
  }

  const normalized = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new TaskContractSemanticError(
        "path-traversal",
        location,
        `${location} may not contain '..' traversal`,
      );
    }
    normalized.push(segment);
  }
  if (normalized.length === 0) {
    throw new TaskContractSemanticError(
      "empty-path",
      location,
      `${location} does not identify a file or directory`,
    );
  }
  return normalized.join("/");
}

/** @param {string} parent @param {string} candidate */
export function isPathDescendant(parent, candidate) {
  return candidate.startsWith(`${parent}/`);
}
