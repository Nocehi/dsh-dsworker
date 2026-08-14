import { isAbsolute } from "node:path";
import {
  compilePathAuthority,
  isCompiledPathAuthority,
} from "@dsh-dsworker/path-authority";
import { isTaskContract } from "@dsh-dsworker/task-contract";
import {
  PathGuardApiError,
  PathGuardConfigurationError,
} from "./errors.js";
import { deepFreeze, isPlainDataObject } from "./freeze.js";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const bindings = new WeakSet();

/** @param {unknown} value */
function parseWorkspaceRoot(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTER.test(value) ||
    !isAbsolute(value)
  ) {
    throw new PathGuardConfigurationError(
      "invalid-workspace-root",
      "$.workspaceRoot",
      "workspaceRoot must be an absolute path without control characters",
    );
  }
  return value;
}

/**
 * Build an immutable runtime binding from the one genuine TaskContract and its
 * genuine compiled policy. Supplying the policy explicitly makes identity
 * mismatches testable; normal callers use {@link compileGuardBinding}.
 *
 * @param {unknown} input
 */
export function createGuardBinding(input) {
  if (!isPlainDataObject(input)) {
    throw new PathGuardApiError(
      "invalid-binding-input",
      "$",
      "createGuardBinding requires a plain data object",
    );
  }
  const allowed = ["contract", "policy", "workspaceRoot"];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new PathGuardApiError(
        "unknown-binding-field",
        `$.${key}`,
        `$.${key} is not part of the path-guard binding API`,
      );
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(input, key)) {
      throw new PathGuardApiError(
        "missing-binding-field",
        `$.${key}`,
        `$.${key} is required`,
      );
    }
  }
  const { contract, policy } = input;
  if (!isTaskContract(contract)) {
    throw new PathGuardConfigurationError(
      "unparsed-task-contract",
      "$.contract",
      "path guard requires the exact object returned by parseTaskContract",
    );
  }
  if (!isCompiledPathAuthority(policy)) {
    throw new PathGuardConfigurationError(
      "uncompiled-path-authority",
      "$.policy",
      "path guard requires the exact object returned by compilePathAuthority",
    );
  }
  if (
    policy.contract !== contract ||
    policy.contractSha256 !== contract.contractSha256
  ) {
    throw new PathGuardConfigurationError(
      "task-contract-policy-identity-mismatch",
      "$.policy",
      "compiled policy does not retain the exact supplied TaskContract",
    );
  }
  const binding = deepFreeze({
    contract,
    policy,
    contractSha256: contract.contractSha256,
    workspaceRoot: parseWorkspaceRoot(input.workspaceRoot),
    symlinkPolicy: contract.authority.workspace.symlinkPolicy,
    boundary: "workspace-filesystem-proof",
  });
  bindings.add(binding);
  return binding;
}

/**
 * Compile and bind a genuine TaskContract to one runner-supplied workspace.
 *
 * @param {unknown} contract
 * @param {unknown} workspaceRoot
 */
export function compileGuardBinding(contract, workspaceRoot) {
  return createGuardBinding({
    contract,
    policy: compilePathAuthority(contract),
    workspaceRoot,
  });
}

/** @param {unknown} value */
export function isGuardBinding(value) {
  return value !== null && typeof value === "object" && bindings.has(value);
}
