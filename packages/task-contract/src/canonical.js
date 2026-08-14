import { createHash } from "node:crypto";
import { TaskContractParseError } from "./errors.js";

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SECRET_SHAPED_KEY = /(?:^|[-_])(authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie|credentials?)(?:$|[-_])/iu;

/** @param {unknown} value */
export function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Return keys for one JSON-like data object without invoking accessors.
 *
 * @param {unknown} value
 * @param {string} path
 */
export function plainDataObjectKeys(value, path) {
  if (!isPlainRecord(value)) {
    throw new TaskContractParseError(
      "invalid-object",
      path,
      `${path} must be a plain object`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TaskContractParseError(
      "non-json-object-key",
      path,
      `${path} may not contain symbol keys`,
    );
  }
  const keys = Object.getOwnPropertyNames(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TaskContractParseError(
        "non-json-object-property",
        `${path}.${key}`,
        `${path}.${key} must be an enumerable data property`,
      );
    }
  }
  return keys.sort();
}

/**
 * Reject sparse, accessor-backed, symbol-bearing, or extra-property arrays.
 * Those shapes cannot originate in JSON without losing semantics.
 *
 * @param {unknown} value
 * @param {string} path
 */
export function assertDenseJsonArray(value, path) {
  if (!Array.isArray(value)) {
    throw new TaskContractParseError(
      "invalid-array",
      path,
      `${path} must be an array`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TaskContractParseError(
      "non-json-array-key",
      path,
      `${path} may not contain symbol keys`,
    );
  }
  const names = Object.getOwnPropertyNames(value);
  const expectedNames = new Set(["length"]);
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    expectedNames.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TaskContractParseError(
        "sparse-or-accessor-array",
        `${path}[${index}]`,
        `${path} must be a dense array of data properties`,
      );
    }
  }
  for (const name of names) {
    if (!expectedNames.has(name)) {
      throw new TaskContractParseError(
        "non-json-array-key",
        `${path}.${name}`,
        `${path} may not contain extra array properties`,
      );
    }
  }
}

/**
 * Clone optional metadata into sorted, JSON-only data. Metadata is deliberately
 * absent from the authority digest, but is still immutable and rejects
 * credential-shaped fields.
 *
 * @param {unknown} value
 * @param {string} path
 * @param {WeakSet<object>} [ancestors]
 * @returns {unknown}
 */
export function cloneMetadata(value, path, ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TaskContractParseError(
        "non-canonical-metadata-number",
        path,
        `${path} must contain only finite canonical JSON numbers`,
      );
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TaskContractParseError(
      "non-json-metadata",
      path,
      `${path} contains a value that JSON cannot represent`,
    );
  }
  if (ancestors.has(value)) {
    throw new TaskContractParseError(
      "cyclic-metadata",
      path,
      `${path} contains a cycle`,
    );
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertDenseJsonArray(value, path);
      return value.map((entry, index) =>
        cloneMetadata(entry, `${path}[${index}]`, ancestors),
      );
    }
    const output = {};
    for (const key of plainDataObjectKeys(value, path)) {
      const childPath = `${path}.${key}`;
      if (UNSAFE_OBJECT_KEYS.has(key)) {
        throw new TaskContractParseError(
          "unsafe-metadata-key",
          childPath,
          `${childPath} is not an allowed metadata key`,
        );
      }
      if (SECRET_SHAPED_KEY.test(key)) {
        throw new TaskContractParseError(
          "secret-shaped-metadata-key",
          childPath,
          `${childPath} may not carry credential-shaped data`,
        );
      }
      output[key] = cloneMetadata(value[key], childPath, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Locale-independent canonical JSON: object keys use ECMAScript code-unit
 * order, arrays retain their already-normalized semantic order, and no
 * whitespace or terminal newline is emitted.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableJson(value) {
  const canonicalize = (entry) => {
    if (entry === null || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) return entry.map(canonicalize);
    const output = {};
    for (const key of Object.keys(entry).sort()) {
      output[key] = canonicalize(entry[key]);
    }
    return output;
  };
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) {
    throw new TypeError("canonical task-contract JSON cannot be undefined");
  }
  return encoded;
}

/** @param {string} value */
export function sha256Utf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** @template T @param {T} value @param {WeakSet<object>} [seen] @returns {Readonly<T>} */
export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return /** @type {Readonly<T>} */ (value);
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
}
