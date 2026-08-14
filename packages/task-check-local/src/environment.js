import { TaskCheckLocalApiError } from "./errors.js";
import { deepFreeze, isPlainDataObject } from "./freeze.js";

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const CREDENTIAL_KEY = /(?:^|_)(?:authorization|proxy_?authorization|api_?key|access_?token|refresh_?token|auth_?token|token|secret|password|passwd|cookie|credentials?)(?:$|_)/iu;
const sanitizedEnvironments = new WeakSet();

/**
 * Clone a runner-supplied base environment, dropping every credential-shaped
 * key. Nothing is inherited from process.env.
 *
 * @param {unknown} value
 */
export function sanitizeBaseEnvironment(value) {
  if (!isPlainDataObject(value)) {
    throw new TaskCheckLocalApiError(
      "invalid-base-environment",
      "$.baseEnvironment",
      "baseEnvironment must be a plain data object",
    );
  }
  const environment = {};
  const strippedCredentialKeys = [];
  for (const key of Object.keys(value).sort()) {
    if (!ENVIRONMENT_KEY.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) {
      throw new TaskCheckLocalApiError(
        "invalid-environment-key",
        `$.baseEnvironment.${key}`,
        `base environment key '${key}' is invalid`,
      );
    }
    const entry = value[key];
    if (typeof entry !== "string" || entry.includes("\u0000")) {
      throw new TaskCheckLocalApiError(
        "invalid-environment-value",
        `$.baseEnvironment.${key}`,
        `base environment value '${key}' must be a NUL-free string`,
      );
    }
    if (CREDENTIAL_KEY.test(key)) {
      strippedCredentialKeys.push(key);
      continue;
    }
    environment[key] = entry;
  }
  if (typeof environment.PATH !== "string" || environment.PATH.length === 0) {
    throw new TaskCheckLocalApiError(
      "missing-path",
      "$.baseEnvironment.PATH",
      "baseEnvironment must provide PATH for bare executable lookup",
    );
  }
  const result = deepFreeze({
    environment,
    policy: {
      source: "runner-supplied-only",
      inheritsProcessEnvironment: false,
      executableLookupOwner: "runner-base-environment-PATH",
      retainedKeys: Object.keys(environment),
      strippedCredentialKeys,
    },
  });
  sanitizedEnvironments.add(result);
  return result;
}

/** @param {unknown} value */
export function isSanitizedBaseEnvironment(value) {
  return value !== null && typeof value === "object" && sanitizedEnvironments.has(value);
}
