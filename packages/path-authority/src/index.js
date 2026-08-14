import {
  TASK_CONTRACT_VERSION,
  TaskContractError,
  isContractPathDescendant,
  isTaskContract,
  normalizeContractPath,
} from "@dsh-dsworker/task-contract";
import {
  PathAuthorityApiError,
  PathAuthorityError,
  PathAuthorityUnsupportedError,
} from "./errors.js";

export {
  PathAuthorityApiError,
  PathAuthorityError,
  PathAuthorityUnsupportedError,
};

export const PATH_AUTHORITY_POLICY_VERSION =
  "dsh-dsworker/path-authority/v1";

export const FILE_MUTATION_OPERATIONS = Object.freeze([
  "create-file",
  "replace-file",
  "edit-file",
  "remove-file",
]);

export const DIRECTORY_MUTATION_OPERATIONS = Object.freeze([
  "create-directory",
  "remove-directory",
]);

export const STRUCTURED_MUTATION_OPERATIONS = Object.freeze([
  ...FILE_MUTATION_OPERATIONS,
  ...DIRECTORY_MUTATION_OPERATIONS,
]);

const compiledPolicies = new WeakSet();
const policyByContract = new WeakMap();

/** @template T @param {T} value @param {WeakSet<object>} [seen] @returns {Readonly<T>} */
function deepFreeze(value, seen = new WeakSet()) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    seen.has(value)
  ) {
    return /** @type {Readonly<T>} */ (value);
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
}

/** @param {unknown} value */
function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Read one own data property without invoking an accessor. This is used only
 * to classify an apparent unsupported TaskContract version before the genuine
 * TaskContract brand check rejects every structural lookalike.
 *
 * @param {unknown} value
 * @param {string} key
 */
function ownDataValue(value, key) {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

/** @param {unknown} value */
function taskContractVersionHint(value) {
  const authority = ownDataValue(value, "authority");
  return ownDataValue(authority, "version");
}

/**
 * Copy a closed request object's data properties without retaining the caller
 * object or invoking accessors.
 *
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {readonly string[]} required
 * @param {string} path
 */
function requestData(value, allowed, required, path) {
  if (!isPlainRecord(value)) {
    throw new PathAuthorityApiError(
      "invalid-request-object",
      path,
      `${path} must be a plain data object`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new PathAuthorityApiError(
      "invalid-request-key",
      path,
      `${path} may not contain symbol keys`,
    );
  }
  const output = {};
  for (const key of Object.getOwnPropertyNames(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new PathAuthorityApiError(
        "invalid-request-property",
        `${path}.${key}`,
        `${path}.${key} must be an enumerable data property`,
      );
    }
    if (!allowed.includes(key)) {
      throw new PathAuthorityApiError(
        "unknown-request-field",
        `${path}.${key}`,
        `${path}.${key} is not part of this API`,
      );
    }
    output[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(output, key)) {
      throw new PathAuthorityApiError(
        "missing-request-field",
        `${path}.${key}`,
        `${path}.${key} is required`,
      );
    }
  }
  return output;
}

/** @param {unknown} value @param {string} path */
function requiredApiString(value, path) {
  if (typeof value !== "string") {
    throw new PathAuthorityApiError(
      "invalid-request-string",
      path,
      `${path} must be a string`,
    );
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function optionalApiBoolean(value, path) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new PathAuthorityApiError(
      "invalid-request-boolean",
      path,
      `${path} must be a boolean when present`,
    );
  }
  return value;
}

/**
 * @param {readonly {path: string, kind: "file" | "directory", sha256?: string}[]} entries
 * @param {string} normalizedPath
 */
function mostSpecificMatch(entries, normalizedPath) {
  let selected = null;
  for (const entry of entries) {
    let relation = null;
    if (entry.path === normalizedPath) relation = "exact";
    else if (
      entry.kind === "directory" &&
      isContractPathDescendant(entry.path, normalizedPath)
    ) {
      relation = "descendant";
    }
    if (
      relation !== null &&
      (selected === null || entry.path.length > selected.entry.path.length)
    ) {
      selected = { entry, relation };
    }
  }
  return selected;
}

/**
 * @param {"mutable" | "immutable"} mode
 * @param {{entry: {path: string, kind: "file" | "directory", sha256?: string}, relation: "exact" | "descendant"}} match
 */
function matchedAuthority(mode, match) {
  return deepFreeze({
    mode,
    relation: match.relation,
    path: match.entry.path,
    kind: match.entry.kind,
    entry: match.entry,
  });
}

/** @param {Record<string, unknown>} fields */
function decisionRecord(fields) {
  return deepFreeze({
    decision: fields.decision,
    code: fields.code,
    operation: fields.operation,
    requestedPath: fields.requestedPath,
    normalizedPath: fields.normalizedPath ?? null,
    matchedAuthority: fields.matchedAuthority ?? null,
    pathError: fields.pathError ?? null,
    contractSha256: fields.contractSha256,
    boundary: "lexical-only",
    symlinkPolicy: "unsupported",
    requiresFilesystemBinding: fields.requiresFilesystemBinding ?? false,
    executionAuthorized: false,
  });
}

/**
 * @param {ReturnType<typeof compilePathAuthority>} policy
 * @param {unknown} request
 */
function decidePath(policy, request) {
  const data = requestData(
    request,
    ["operation", "path", "requiresSymlinkResolution"],
    ["operation", "path"],
    "$.request",
  );
  const operation = requiredApiString(data.operation, "$.request.operation");
  const requestedPath = requiredApiString(data.path, "$.request.path");
  const requiresSymlinkResolution = optionalApiBoolean(
    data.requiresSymlinkResolution,
    "$.request.requiresSymlinkResolution",
  );

  let normalizedPath;
  try {
    normalizedPath = normalizeContractPath(requestedPath, "$.request.path");
  } catch (error) {
    if (!(error instanceof TaskContractError)) throw error;
    return decisionRecord({
      decision: "deny",
      code: "invalid-path",
      operation,
      requestedPath,
      normalizedPath: null,
      pathError: {
        category: error.category,
        code: error.code,
        path: error.path,
      },
      contractSha256: policy.contractSha256,
    });
  }

  const isFileOperation = FILE_MUTATION_OPERATIONS.includes(operation);
  const isDirectoryOperation = DIRECTORY_MUTATION_OPERATIONS.includes(operation);
  if (!isFileOperation && !isDirectoryOperation) {
    const code =
      operation === "rename-source" || operation === "rename-destination"
        ? "rename-requires-atomic-helper"
        : "unknown-operation";
    return decisionRecord({
      decision: "unsupported",
      code,
      operation,
      requestedPath,
      normalizedPath,
      contractSha256: policy.contractSha256,
    });
  }
  const immutableMatch = mostSpecificMatch(
    policy.rules.immutable,
    normalizedPath,
  );
  if (immutableMatch !== null) {
    const authority = matchedAuthority("immutable", immutableMatch);
    const code =
      immutableMatch.entry.kind === "file"
        ? "immutable-file-exact"
        : immutableMatch.relation === "exact"
          ? "immutable-directory-self"
          : "immutable-directory-descendant";
    return decisionRecord({
      decision: "deny",
      code,
      operation,
      requestedPath,
      normalizedPath,
      matchedAuthority: authority,
      contractSha256: policy.contractSha256,
    });
  }

  const mutableMatch = mostSpecificMatch(policy.rules.mutable, normalizedPath);
  if (mutableMatch === null) {
    return decisionRecord({
      decision: "deny",
      code: "outside-mutable-authority",
      operation,
      requestedPath,
      normalizedPath,
      contractSha256: policy.contractSha256,
    });
  }
  const authority = matchedAuthority("mutable", mutableMatch);
  if (
    mutableMatch.relation === "exact" &&
    ((isFileOperation && mutableMatch.entry.kind !== "file") ||
      (isDirectoryOperation && mutableMatch.entry.kind !== "directory"))
  ) {
    return decisionRecord({
      decision: "deny",
      code: "authority-kind-mismatch",
      operation,
      requestedPath,
      normalizedPath,
      matchedAuthority: authority,
      contractSha256: policy.contractSha256,
    });
  }
  if (requiresSymlinkResolution) {
    return decisionRecord({
      decision: "unsupported",
      code: "symlink-resolution-required",
      operation,
      requestedPath,
      normalizedPath,
      matchedAuthority: authority,
      contractSha256: policy.contractSha256,
      requiresFilesystemBinding: true,
    });
  }

  const code =
    mutableMatch.entry.kind === "file"
      ? "mutable-file-exact"
      : mutableMatch.relation === "exact"
        ? "mutable-directory-self"
        : "mutable-directory-descendant";
  return decisionRecord({
    decision: "allow",
    code,
    operation,
    requestedPath,
    normalizedPath,
    matchedAuthority: authority,
    contractSha256: policy.contractSha256,
    requiresFilesystemBinding: true,
  });
}

/** @param {Record<string, unknown>} fields */
function renameRecord(fields) {
  return deepFreeze({
    decision: fields.decision,
    code: fields.code,
    kind: fields.kind,
    destinationMode: fields.destinationMode,
    sourcePath: fields.sourcePath,
    destinationPath: fields.destinationPath,
    normalizedSourcePath: fields.source?.normalizedPath ?? null,
    normalizedDestinationPath: fields.destination?.normalizedPath ?? null,
    source: fields.source ?? null,
    destination: fields.destination ?? null,
    contractSha256: fields.contractSha256,
    boundary: "lexical-only",
    symlinkPolicy: "unsupported",
    requiresFilesystemBinding: fields.requiresFilesystemBinding ?? false,
    executionAuthorized: false,
  });
}

/**
 * Evaluate removal authority and destination authority as one lexical policy
 * question. This helper performs no filesystem operation.
 *
 * @param {ReturnType<typeof compilePathAuthority>} policy
 * @param {unknown} request
 */
function decideRename(policy, request) {
  const data = requestData(
    request,
    [
      "kind",
      "sourcePath",
      "destinationPath",
      "destinationMode",
      "requiresSymlinkResolution",
    ],
    ["kind", "sourcePath", "destinationPath", "destinationMode"],
    "$.request",
  );
  const kind = requiredApiString(data.kind, "$.request.kind");
  const sourcePath = requiredApiString(data.sourcePath, "$.request.sourcePath");
  const destinationPath = requiredApiString(
    data.destinationPath,
    "$.request.destinationPath",
  );
  const destinationMode = requiredApiString(
    data.destinationMode,
    "$.request.destinationMode",
  );
  const requiresSymlinkResolution = optionalApiBoolean(
    data.requiresSymlinkResolution,
    "$.request.requiresSymlinkResolution",
  );

  const validKind = kind === "file" || kind === "directory";
  const validDestinationMode =
    destinationMode === "create" || destinationMode === "replace";
  const sourceOperation =
    kind === "file"
      ? "remove-file"
      : kind === "directory"
        ? "remove-directory"
        : "unknown-rename-kind";
  const destinationOperation =
    kind === "file"
      ? destinationMode === "replace"
        ? "replace-file"
        : destinationMode === "create"
          ? "create-file"
          : "unknown-rename-mode"
      : kind === "directory"
        ? "create-directory"
        : "unknown-rename-kind";
  const source = decidePath(policy, {
    operation: sourceOperation,
    path: sourcePath,
    requiresSymlinkResolution,
  });
  const destination = decidePath(policy, {
    operation: destinationOperation,
    path: destinationPath,
    requiresSymlinkResolution,
  });

  const base = {
    kind,
    destinationMode,
    sourcePath,
    destinationPath,
    source,
    destination,
    contractSha256: policy.contractSha256,
  };
  if (source.decision === "deny" && destination.decision === "deny") {
    return renameRecord({
      ...base,
      decision: "deny",
      code: "rename-source-and-destination-denied",
    });
  }
  if (source.decision === "deny") {
    return renameRecord({ ...base, decision: "deny", code: "rename-source-denied" });
  }
  if (destination.decision === "deny") {
    return renameRecord({
      ...base,
      decision: "deny",
      code: "rename-destination-denied",
    });
  }
  if (!validKind) {
    return renameRecord({
      ...base,
      decision: "unsupported",
      code: "unsupported-rename-kind",
    });
  }
  if (!validDestinationMode) {
    return renameRecord({
      ...base,
      decision: "unsupported",
      code: "unsupported-rename-destination-mode",
    });
  }
  if (source.decision === "unsupported" || destination.decision === "unsupported") {
    return renameRecord({
      ...base,
      decision: "unsupported",
      code: "rename-path-unsupported",
      requiresFilesystemBinding:
        source.requiresFilesystemBinding || destination.requiresFilesystemBinding,
    });
  }
  if (source.normalizedPath === destination.normalizedPath) {
    return renameRecord({
      ...base,
      decision: "unsupported",
      code: "rename-identical-path",
      requiresFilesystemBinding: true,
    });
  }
  if (
    kind === "directory" &&
    (isContractPathDescendant(source.normalizedPath, destination.normalizedPath) ||
      isContractPathDescendant(destination.normalizedPath, source.normalizedPath))
  ) {
    return renameRecord({
      ...base,
      decision: "unsupported",
      code: "rename-overlapping-trees",
      requiresFilesystemBinding: true,
    });
  }
  if (kind === "directory" && destinationMode === "replace") {
    return renameRecord({
      ...base,
      decision: "unsupported",
      code: "directory-replacement-unproven",
      requiresFilesystemBinding: true,
    });
  }
  return renameRecord({
    ...base,
    decision: "allow",
    code:
      kind === "file"
        ? "rename-file-lexically-authorized"
        : "rename-directory-lexically-authorized",
    requiresFilesystemBinding: true,
  });
}

/**
 * Compile one genuine immutable TaskContract into an immutable lexical policy.
 * The exact contract and its exact frozen path arrays remain the only source of
 * authority; no source JSON or reconstructed rule set is accepted.
 *
 * @param {unknown} contract
 */
export function compilePathAuthority(contract) {
  const hintedVersion = taskContractVersionHint(contract);
  if (
    hintedVersion !== undefined &&
    hintedVersion !== TASK_CONTRACT_VERSION
  ) {
    throw new PathAuthorityUnsupportedError(
      "unsupported-task-contract-version",
      "$.authority.version",
      `path-authority supports only '${TASK_CONTRACT_VERSION}'`,
    );
  }
  if (!isTaskContract(contract)) {
    throw new PathAuthorityApiError(
      "unparsed-task-contract",
      "$",
      "compilePathAuthority requires the exact object returned by parseTaskContract",
    );
  }
  if (contract.authority.version !== TASK_CONTRACT_VERSION) {
    throw new PathAuthorityUnsupportedError(
      "unsupported-task-contract-version",
      "$.authority.version",
      `path-authority supports only '${TASK_CONTRACT_VERSION}'`,
    );
  }
  if (contract.authority.workspace.symlinkPolicy !== "unsupported") {
    throw new PathAuthorityUnsupportedError(
      "unsupported-symlink-policy",
      "$.authority.workspace.symlinkPolicy",
      "path-authority v1 preserves only TaskContract symlinkPolicy 'unsupported'",
    );
  }

  const cached = policyByContract.get(contract);
  if (cached !== undefined) return cached;

  const identity = deepFreeze({
    contractSha256: contract.contractSha256,
    contractVersion: contract.authority.version,
    taskId: contract.authority.taskId,
  });
  const rules = deepFreeze({
    mutable: contract.authority.paths.mutable,
    immutable: contract.authority.paths.immutable,
  });
  const debug = deepFreeze({
    policyVersion: PATH_AUTHORITY_POLICY_VERSION,
    authorityIdentity: identity,
    boundary: "lexical-only",
    symlinkPolicy: contract.authority.workspace.symlinkPolicy,
    operations: {
      file: FILE_MUTATION_OPERATIONS,
      directory: DIRECTORY_MUTATION_OPERATIONS,
      rename: {
        kinds: ["file", "directory"],
        destinationModes: ["create", "replace"],
      },
    },
    rules,
  });

  let policy;
  const decide = Object.freeze((request) => decidePath(policy, request));
  const rename = Object.freeze((request) => decideRename(policy, request));
  const describe = Object.freeze(() => debug);
  policy = deepFreeze({
    policyVersion: PATH_AUTHORITY_POLICY_VERSION,
    contract,
    contractSha256: contract.contractSha256,
    identity,
    rules,
    symlinkPolicy: contract.authority.workspace.symlinkPolicy,
    decide,
    decideRename: rename,
    describe,
  });
  compiledPolicies.add(policy);
  policyByContract.set(contract, policy);
  return policy;
}

/** @param {unknown} value */
export function isCompiledPathAuthority(value) {
  return value !== null && typeof value === "object" && compiledPolicies.has(value);
}
