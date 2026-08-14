import {
  assertDenseJsonArray,
  cloneMetadata,
  deepFreeze,
  plainDataObjectKeys,
  sha256Utf8,
  stableJson,
} from "./canonical.js";
import {
  TaskContractError,
  TaskContractParseError,
  TaskContractSemanticError,
  TaskContractUnsupportedError,
} from "./errors.js";
import { isPathDescendant, normalizeContractPath } from "./path.js";

export {
  TaskContractError,
  TaskContractParseError,
  TaskContractSemanticError,
  TaskContractUnsupportedError,
  isPathDescendant as isContractPathDescendant,
  normalizeContractPath,
};

export const TASK_CONTRACT_VERSION = "dsh-dsworker/task-contract/v1";
export const MAX_COMMAND_TIMEOUT_MS = 3_600_000;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const FORBIDDEN_ENVIRONMENT_KEY = /(?:^|_)(authorization|proxy_?authorization|api_?key|access_?token|refresh_?token|secret|password|cookie|credentials?)(?:$|_)/iu;
const UNSAFE_ENVIRONMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER = /[\u0000\u007f]/u;
const PHASES = ["semantic", "validation", "finish"];
const parsedContracts = new WeakSet();

/** @param {unknown} value @param {string} path */
function assertRecord(value, path) {
  plainDataObjectKeys(value, path);
}

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} allowed
 * @param {readonly string[]} required
 * @param {string} path
 */
function assertClosedObject(value, allowed, required, path) {
  for (const key of plainDataObjectKeys(value, path)) {
    if (!allowed.includes(key)) {
      throw new TaskContractParseError(
        "unknown-field",
        `${path}.${key}`,
        `${path}.${key} is not part of the v1 schema`,
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TaskContractParseError(
        "missing-field",
        `${path}.${key}`,
        `${path}.${key} is required`,
      );
    }
  }
}

/** @param {unknown} value @param {string} path */
function requiredString(value, path) {
  if (typeof value !== "string") {
    throw new TaskContractParseError(
      "invalid-string",
      path,
      `${path} must be a string`,
    );
  }
  if (CONTROL_CHARACTER.test(value)) {
    throw new TaskContractSemanticError(
      "control-character",
      path,
      `${path} may not contain NUL or DEL`,
    );
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function identifier(value, path) {
  const parsed = requiredString(value, path);
  if (!IDENTIFIER.test(parsed)) {
    throw new TaskContractSemanticError(
      "invalid-identifier",
      path,
      `${path} must match ${IDENTIFIER.source}`,
    );
  }
  return parsed;
}

/** @param {unknown} value @param {string} path */
function parseWorkspace(value, path) {
  assertRecord(value, path);
  assertClosedObject(
    value,
    ["root", "commandCwdPolicy", "symlinkPolicy"],
    ["root", "commandCwdPolicy", "symlinkPolicy"],
    path,
  );
  if (
    value.root !== "runner-supplied" ||
    value.commandCwdPolicy !== "workspace-relative-only" ||
    value.symlinkPolicy !== "unsupported"
  ) {
    throw new TaskContractUnsupportedError(
      "unsupported-workspace-policy",
      path,
      "v1 supports only a runner-supplied root, workspace-relative command cwd, and unsupported symlinks",
    );
  }
  return {
    root: "runner-supplied",
    commandCwdPolicy: "workspace-relative-only",
    symlinkPolicy: "unsupported",
  };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {boolean} immutable
 */
function parsePathEntry(value, path, immutable) {
  assertRecord(value, path);
  assertClosedObject(
    value,
    immutable ? ["path", "kind", "sha256"] : ["path", "kind"],
    ["path", "kind"],
    path,
  );
  if (value.kind !== "file" && value.kind !== "directory") {
    throw new TaskContractUnsupportedError(
      "unsupported-path-kind",
      `${path}.kind`,
      `${path}.kind must be 'file' or 'directory'`,
    );
  }
  const entry = {
    path: normalizeContractPath(value.path, `${path}.path`),
    kind: value.kind,
  };
  if (Object.hasOwn(value, "sha256")) {
    if (value.kind !== "file") {
      throw new TaskContractSemanticError(
        "directory-digest",
        `${path}.sha256`,
        "v1 can attach a content digest only to an immutable file",
      );
    }
    if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) {
      throw new TaskContractSemanticError(
        "invalid-sha256",
        `${path}.sha256`,
        `${path}.sha256 must be 64 lowercase hexadecimal characters`,
      );
    }
    entry.sha256 = value.sha256;
  }
  return entry;
}

/** @param {unknown} value @param {string} path @param {boolean} immutable */
function parsePathList(value, path, immutable) {
  try {
    assertDenseJsonArray(value, path);
  } catch (error) {
    if (!(error instanceof TaskContractParseError) || error.code !== "invalid-array") {
      throw error;
    }
    throw new TaskContractParseError(
      "invalid-path-list",
      path,
      `${path} must be an array`,
    );
  }
  const entries = value.map((entry, index) =>
    parsePathEntry(entry, `${path}[${index}]`, immutable),
  );
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new TaskContractSemanticError(
        "duplicate-path",
        path,
        `${path} contains duplicate normalized path '${entry.path}'`,
      );
    }
    seen.add(entry.path);
  }
  return entries.sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    if (left.kind < right.kind) return -1;
    if (left.kind > right.kind) return 1;
    return 0;
  });
}

/** @param {unknown} value @param {string} path */
function parsePaths(value, path) {
  assertRecord(value, path);
  assertClosedObject(value, ["mutable", "immutable"], ["mutable", "immutable"], path);
  const mutable = parsePathList(value.mutable, `${path}.mutable`, false);
  const immutable = parsePathList(value.immutable, `${path}.immutable`, true);

  const allEntries = [...mutable, ...immutable];
  for (let leftIndex = 0; leftIndex < allEntries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < allEntries.length; rightIndex += 1) {
      const left = allEntries[leftIndex];
      const right = allEntries[rightIndex];
      if (left.kind === "file" && isPathDescendant(left.path, right.path)) {
        throw new TaskContractSemanticError(
          "impossible-path-layout",
          path,
          `file '${left.path}' cannot contain '${right.path}'`,
        );
      }
      if (right.kind === "file" && isPathDescendant(right.path, left.path)) {
        throw new TaskContractSemanticError(
          "impossible-path-layout",
          path,
          `file '${right.path}' cannot contain '${left.path}'`,
        );
      }
    }
  }

  for (const mutableEntry of mutable) {
    for (const immutableEntry of immutable) {
      const conflict =
        mutableEntry.path === immutableEntry.path ||
        (mutableEntry.kind === "directory" &&
          isPathDescendant(mutableEntry.path, immutableEntry.path)) ||
        (immutableEntry.kind === "directory" &&
          isPathDescendant(immutableEntry.path, mutableEntry.path));
      if (conflict) {
        throw new TaskContractSemanticError(
          "path-authority-conflict",
          path,
          `mutable '${mutableEntry.path}' conflicts with immutable '${immutableEntry.path}'`,
        );
      }
    }
  }
  return { mutable, immutable };
}

/** @param {unknown} value @param {string} path */
function parseCwd(value, path) {
  assertRecord(value, path);
  if (value.kind === "workspace-root") {
    assertClosedObject(value, ["kind"], ["kind"], path);
    return { kind: "workspace-root" };
  }
  if (value.kind === "workspace-relative") {
    assertClosedObject(value, ["kind", "path"], ["kind", "path"], path);
    return {
      kind: "workspace-relative",
      path: normalizeContractPath(value.path, `${path}.path`),
    };
  }
  throw new TaskContractUnsupportedError(
    "unsupported-cwd-policy",
    `${path}.kind`,
    `${path}.kind must be 'workspace-root' or 'workspace-relative'`,
  );
}

/** @param {unknown} value @param {string} path */
function parseEnvironment(value, path) {
  assertRecord(value, path);
  const environment = {};
  for (const key of Object.keys(value).sort()) {
    if (!ENVIRONMENT_KEY.test(key) || UNSAFE_ENVIRONMENT_KEYS.has(key)) {
      throw new TaskContractSemanticError(
        "invalid-environment-key",
        `${path}.${key}`,
        `${path} key '${key}' is not a portable environment variable name`,
      );
    }
    if (FORBIDDEN_ENVIRONMENT_KEY.test(key)) {
      throw new TaskContractSemanticError(
        "credential-environment-key",
        `${path}.${key}`,
        `${path} may not embed a credential-shaped environment override`,
      );
    }
    const parsed = requiredString(value[key], `${path}.${key}`);
    environment[key] = parsed;
  }
  return environment;
}

/** @param {unknown} value @param {string} path */
function parseTimeout(value, path) {
  if (!Number.isSafeInteger(value)) {
    throw new TaskContractParseError(
      "invalid-timeout-type",
      path,
      `${path} must be a safe integer number of milliseconds`,
    );
  }
  if (value < 1 || value > MAX_COMMAND_TIMEOUT_MS) {
    throw new TaskContractSemanticError(
      "invalid-timeout",
      path,
      `${path} must be between 1 and ${MAX_COMMAND_TIMEOUT_MS}`,
    );
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function parseExpected(value, path) {
  assertRecord(value, path);
  assertClosedObject(value, ["exitCodes"], ["exitCodes"], path);
  try {
    assertDenseJsonArray(value.exitCodes, `${path}.exitCodes`);
  } catch (error) {
    if (!(error instanceof TaskContractParseError) || error.code !== "invalid-array") {
      throw error;
    }
    throw new TaskContractParseError(
      "invalid-exit-codes",
      `${path}.exitCodes`,
      `${path}.exitCodes must be a non-empty array`,
    );
  }
  if (value.exitCodes.length === 0) {
    throw new TaskContractParseError(
      "invalid-exit-codes",
      `${path}.exitCodes`,
      `${path}.exitCodes must be a non-empty array`,
    );
  }
  const exitCodes = [];
  const seen = new Set();
  for (let index = 0; index < value.exitCodes.length; index += 1) {
    const exitCode = value.exitCodes[index];
    if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
      throw new TaskContractSemanticError(
        "invalid-exit-code",
        `${path}.exitCodes[${index}]`,
        "exit codes must be unique integers between 0 and 255",
      );
    }
    if (seen.has(exitCode)) {
      throw new TaskContractSemanticError(
        "duplicate-exit-code",
        `${path}.exitCodes[${index}]`,
        `duplicate expected exit code ${exitCode}`,
      );
    }
    seen.add(exitCode);
    exitCodes.push(exitCode);
  }
  exitCodes.sort((left, right) => left - right);
  return { exitCodes };
}

/** @param {unknown} value @param {string} path */
function parseExecutable(value, path) {
  const parsed = requiredString(value, path);
  if (
    parsed.length === 0 ||
    parsed.trim().length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(parsed)
  ) {
    throw new TaskContractSemanticError(
      "empty-executable",
      path,
      `${path} must name an executable`,
    );
  }
  if (
    parsed === "." ||
    parsed === ".." ||
    parsed.includes("/") ||
    parsed.includes("\\") ||
    /^[A-Za-z]:/u.test(parsed)
  ) {
    return normalizeContractPath(parsed, path);
  }
  return parsed;
}

/** @param {unknown} value @param {string} path */
function parseArgv(value, path) {
  try {
    assertDenseJsonArray(value, path);
  } catch (error) {
    if (!(error instanceof TaskContractParseError) || error.code !== "invalid-array") {
      throw error;
    }
    throw new TaskContractParseError(
      "malformed-argv",
      path,
      `${path} must be an array of strings`,
    );
  }
  return value.map((argument, index) => {
    if (typeof argument !== "string" || argument.includes("\u0000")) {
      throw new TaskContractParseError(
        "malformed-argv",
        `${path}[${index}]`,
        `${path}[${index}] must be a NUL-free string`,
      );
    }
    return argument;
  });
}

/** @param {unknown} value @param {string} path */
function parseCommand(value, path) {
  assertRecord(value, path);
  assertClosedObject(
    value,
    ["id", "executable", "argv", "cwd", "environment", "timeoutMs", "expected"],
    ["id", "executable", "argv", "cwd", "environment", "timeoutMs", "expected"],
    path,
  );
  return {
    id: identifier(value.id, `${path}.id`),
    executable: parseExecutable(value.executable, `${path}.executable`),
    argv: parseArgv(value.argv, `${path}.argv`),
    cwd: parseCwd(value.cwd, `${path}.cwd`),
    environment: parseEnvironment(value.environment, `${path}.environment`),
    timeoutMs: parseTimeout(value.timeoutMs, `${path}.timeoutMs`),
    expected: parseExpected(value.expected, `${path}.expected`),
  };
}

/** @param {unknown} value @param {string} path */
function parseCommands(value, path) {
  assertRecord(value, path);
  assertClosedObject(value, PHASES, PHASES, path);
  const commands = {};
  const ids = new Set();
  for (const phase of PHASES) {
    const phasePath = `${path}.${phase}`;
    try {
      assertDenseJsonArray(value[phase], phasePath);
    } catch (error) {
      if (!(error instanceof TaskContractParseError) || error.code !== "invalid-array") {
        throw error;
      }
      throw new TaskContractParseError(
        "invalid-command-list",
        phasePath,
        `${phasePath} must be an array`,
      );
    }
    if (phase === "semantic" && value[phase].length === 0) {
      throw new TaskContractSemanticError(
        "missing-semantic-command",
        phasePath,
        "at least one semantic command is required",
      );
    }
    commands[phase] = value[phase].map((command, index) => {
      const parsed = parseCommand(command, `${phasePath}[${index}]`);
      if (ids.has(parsed.id)) {
        throw new TaskContractSemanticError(
          "duplicate-command-id",
          `${phasePath}[${index}].id`,
          `command id '${parsed.id}' is duplicated`,
        );
      }
      ids.add(parsed.id);
      return parsed;
    });
  }
  return commands;
}

/** @param {unknown} value @param {string} path */
function parseRetry(value, path) {
  assertRecord(value, path);
  assertClosedObject(value, ["mode", "maxAttempts"], ["mode", "maxAttempts"], path);
  if (value.mode !== "none" || value.maxAttempts !== 1) {
    throw new TaskContractUnsupportedError(
      "unsupported-retry-policy",
      path,
      "v1 supports exactly one attempt with retry mode 'none'",
    );
  }
  return { mode: "none", maxAttempts: 1 };
}

/** @param {unknown} value @param {string} path */
function parseTerminal(value, path) {
  assertRecord(value, path);
  assertClosedObject(value, ["success", "failure"], ["success", "failure"], path);
  if (
    value.success !== "all-authoritative-commands-pass" ||
    value.failure !== "fail-closed"
  ) {
    throw new TaskContractUnsupportedError(
      "unsupported-terminal-policy",
      path,
      "v1 requires all authoritative commands to pass and otherwise fails closed",
    );
  }
  return {
    success: "all-authoritative-commands-pass",
    failure: "fail-closed",
  };
}

/** @param {unknown} value */
function parseAuthority(value) {
  const path = "$.authority";
  assertRecord(value, path);
  assertClosedObject(
    value,
    ["version", "taskId", "objective", "workspace", "paths", "commands", "retry", "terminal"],
    ["version", "taskId", "objective", "workspace", "paths", "commands", "retry", "terminal"],
    path,
  );
  if (value.version !== TASK_CONTRACT_VERSION) {
    throw new TaskContractUnsupportedError(
      "unsupported-version",
      `${path}.version`,
      `supported version is '${TASK_CONTRACT_VERSION}'`,
    );
  }
  const objective = requiredString(value.objective, `${path}.objective`).replaceAll(
    /\r\n?/gu,
    "\n",
  );
  if (objective.trim().length === 0) {
    throw new TaskContractSemanticError(
      "missing-objective",
      `${path}.objective`,
      "objective must contain non-whitespace text",
    );
  }
  if (Buffer.byteLength(objective, "utf8") > 262_144) {
    throw new TaskContractSemanticError(
      "objective-too-large",
      `${path}.objective`,
      "objective exceeds the v1 limit of 262144 UTF-8 bytes",
    );
  }
  return {
    version: TASK_CONTRACT_VERSION,
    taskId: identifier(value.taskId, `${path}.taskId`),
    objective,
    workspace: parseWorkspace(value.workspace, `${path}.workspace`),
    paths: parsePaths(value.paths, `${path}.paths`),
    commands: parseCommands(value.commands, `${path}.commands`),
    retry: parseRetry(value.retry, `${path}.retry`),
    terminal: parseTerminal(value.terminal, `${path}.terminal`),
  };
}

/**
 * Validate, normalize, hash, and deeply freeze one task contract. Passing an
 * already parsed TaskContract returns the exact same authority object.
 *
 * @param {unknown} input
 */
export function parseTaskContract(input) {
  if (input !== null && typeof input === "object" && parsedContracts.has(input)) {
    return input;
  }
  assertRecord(input, "$");
  assertClosedObject(input, ["authority", "metadata"], ["authority"], "$");
  const authority = parseAuthority(input.authority);
  let metadata = {};
  if (Object.hasOwn(input, "metadata")) {
    assertRecord(input.metadata, "$.metadata");
    metadata = cloneMetadata(input.metadata, "$.metadata");
  }
  const canonical = stableJson(authority);
  const contract = {
    authority,
    metadata,
    contractSha256: sha256Utf8(canonical),
  };
  deepFreeze(contract);
  parsedContracts.add(contract);
  return contract;
}

/** @param {unknown} value */
export function isTaskContract(value) {
  return value !== null && typeof value === "object" && parsedContracts.has(value);
}

/**
 * Return the exact canonical authority JSON, excluding metadata and the digest
 * itself. Only successfully parsed contracts are accepted.
 *
 * @param {unknown} contract
 */
export function canonicalTaskContract(contract) {
  if (!isTaskContract(contract)) {
    throw new TaskContractParseError(
      "unparsed-contract",
      "$",
      "canonicalTaskContract requires a parsed immutable TaskContract",
    );
  }
  return stableJson(contract.authority);
}

/** @param {unknown} contract */
export function canonicalTaskContractBytes(contract) {
  return Buffer.from(canonicalTaskContract(contract), "utf8");
}
