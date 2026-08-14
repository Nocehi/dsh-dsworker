import { createHash } from "node:crypto";

const SECRET_KEY = /(?:^|[-_])(authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie|credentials?)(?:$|[-_])/iu;

/**
 * Convert JSON-compatible input into an object with recursively sorted keys.
 * Object properties whose value is undefined follow JSON.stringify and are
 * omitted; undefined array entries become null.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [ancestors]
 * @returns {unknown}
 */
export function canonicalize(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON accepts only finite numbers");
    }
    return value;
  }
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("canonical JSON cannot encode cyclic input");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalize(entry, ancestors) ?? null);
    }

    const output = {};
    for (const key of Object.keys(value).sort()) {
      const encoded = canonicalize(value[key], ancestors);
      if (encoded !== undefined) output[key] = encoded;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

/** @param {unknown} value */
export function stableStringify(value) {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) {
    throw new TypeError("canonical JSON root cannot be undefined");
  }
  return encoded;
}

/** @param {string} value */
export function sha256Utf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** @param {string} value */
export function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Redact values selected by secret-shaped keys before hashing diagnostics.
 * This function is defensive: rc.6 GenerateOptions and request/header do not
 * contain credentials, and trace records never serialize this intermediate.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [ancestors]
 * @returns {unknown}
 */
export function redactSecretShaped(value, ancestors = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) {
    throw new TypeError("secret redaction cannot traverse cyclic input");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactSecretShaped(entry, ancestors));
    }
    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = SECRET_KEY.test(key)
        ? "[redacted-secret-shaped-field]"
        : redactSecretShaped(value[key], ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

/** @param {unknown} value */
export function safeDigest(value) {
  return sha256Utf8(stableStringify(redactSecretShaped(value)));
}

/**
 * Snapshot every enumerable adapter-visible request field except AbortSignal.
 * AbortSignal is a host cancellation capability, not provider/model input; its
 * state is asserted separately by integration tests.
 *
 * @param {Record<string, unknown>} options
 */
export function adapterVisibleRequest(options) {
  const snapshot = {};
  for (const key of Object.keys(options)) {
    if (key === "signal") continue;
    snapshot[key] = options[key];
  }
  return canonicalize(snapshot);
}
