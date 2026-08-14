import { createHash } from "node:crypto";
import { isTaskContract } from "@dsh-dsworker/task-contract";
import { TaskCheckCoreError } from "./errors.js";
import { deepFreeze, isPlainDataObject } from "./freeze.js";

export { TaskCheckCoreError };

export const TASK_CHECK_RESULT_VERSION = "dsh-dsworker/task-check-result/v1";
export const TASK_CHECK_PHASES = Object.freeze([
  "semantic",
  "validation",
  "finish",
]);
export const TASK_CHECK_STATUSES = Object.freeze(["green", "red", "aborted"]);

const SHA256 = /^[a-f0-9]{64}$/u;
const results = new WeakSet();

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** The digest names the exact structural process argv, including argv[0]. */
export function commandArgvSha256(command) {
  if (command === null || typeof command !== "object") {
    throw new TaskCheckCoreError("commandArgvSha256 requires a command object", {
      code: "invalid-command",
      path: "$.command",
    });
  }
  return sha256(Buffer.from(JSON.stringify([command.executable, ...command.argv]), "utf8"));
}

/** @param {unknown} value @param {string} path */
function apiObject(value, path) {
  if (!isPlainDataObject(value)) {
    throw new TaskCheckCoreError(`${path} must be a plain data object`, {
      code: "invalid-object",
      path,
    });
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {Record<string, any>} value @param {readonly string[]} allowed @param {readonly string[]} required @param {string} path */
function closedObject(value, allowed, required, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TaskCheckCoreError(`${path}.${key} is not part of this API`, {
        code: "unknown-field",
        path: `${path}.${key}`,
      });
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TaskCheckCoreError(`${path}.${key} is required`, {
        code: "missing-field",
        path: `${path}.${key}`,
      });
    }
  }
}

/** @param {unknown} value @param {string} path */
function requiredString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TaskCheckCoreError(`${path} must be a non-empty string`, {
      code: "invalid-string",
      path,
    });
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function nullableString(value, path) {
  if (value !== null && typeof value !== "string") {
    throw new TaskCheckCoreError(`${path} must be a string or null`, {
      code: "invalid-nullable-string",
      path,
    });
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function requiredBoolean(value, path) {
  if (typeof value !== "boolean") {
    throw new TaskCheckCoreError(`${path} must be boolean`, {
      code: "invalid-boolean",
      path,
    });
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function requiredNonnegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TaskCheckCoreError(`${path} must be a non-negative safe integer`, {
      code: "invalid-integer",
      path,
    });
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function requiredTimestamp(value, path) {
  const timestamp = requiredString(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp)) {
    throw new TaskCheckCoreError(`${path} must be an ISO-8601 UTC timestamp`, {
      code: "invalid-timestamp",
      path,
    });
  }
  return timestamp;
}

/** @param {unknown} value @param {string} path */
function requiredSha256(value, path) {
  const digest = requiredString(value, path);
  if (!SHA256.test(digest)) {
    throw new TaskCheckCoreError(`${path} must be a lowercase SHA-256`, {
      code: "invalid-sha256",
      path,
    });
  }
  return digest;
}

/** @param {unknown} value @param {string} path */
function cloneJson(value, path) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) {
    return value;
  }
  if (Array.isArray(value)) {
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TaskCheckCoreError(`${path} must be a dense JSON array`, {
          code: "invalid-array",
          path,
        });
      }
      output.push(cloneJson(value[index], `${path}[${index}]`));
    }
    return output;
  }
  const record = apiObject(value, path);
  const output = {};
  for (const key of Object.keys(record).sort()) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw new TaskCheckCoreError(`${path}.${key} is not safe JSON data`, {
        code: "unsafe-key",
        path: `${path}.${key}`,
      });
    }
    output[key] = cloneJson(record[key], `${path}.${key}`);
  }
  return output;
}

/** @param {unknown} value @param {string} path */
function cloneFindings(value, path) {
  if (!Array.isArray(value)) {
    throw new TaskCheckCoreError(`${path} must be an array`, {
      code: "invalid-array",
      path,
    });
  }
  return value.map((entry, index) => cloneJson(entry, `${path}[${index}]`));
}

/** @param {unknown} value @param {string} path */
function parseSnapshot(value, path) {
  const data = apiObject(value, path);
  closedObject(
    data,
    ["ok", "code", "entryCount", "totalFileBytes", "snapshotSha256", "failure"],
    ["ok", "code", "entryCount", "totalFileBytes", "snapshotSha256", "failure"],
    path,
  );
  return {
    ok: requiredBoolean(data.ok, `${path}.ok`),
    code: requiredString(data.code, `${path}.code`),
    entryCount: requiredNonnegativeInteger(data.entryCount, `${path}.entryCount`),
    totalFileBytes: requiredNonnegativeInteger(data.totalFileBytes, `${path}.totalFileBytes`),
    snapshotSha256:
      data.snapshotSha256 === null
        ? null
        : requiredSha256(data.snapshotSha256, `${path}.snapshotSha256`),
    failure:
      data.failure === null ? null : cloneJson(data.failure, `${path}.failure`),
  };
}

/** @param {unknown} value @param {string} path @param {"scope" | "immutable"} kind */
function parseCheckpoint(value, path, kind) {
  const data = apiObject(value, path);
  const listField = kind === "scope" ? "changedPaths" : "checked";
  const allowed = kind === "scope"
    ? ["ok", listField, "findings", "changes"]
    : ["ok", listField, "findings"];
  closedObject(data, allowed, ["ok", listField, "findings"], path);
  const ok = requiredBoolean(data.ok, `${path}.ok`);
  if (!Array.isArray(data[listField]) || data[listField].some((entry) => typeof entry !== "string")) {
    throw new TaskCheckCoreError(`${path}.${listField} must be a string array`, {
      code: "invalid-string-array",
      path: `${path}.${listField}`,
    });
  }
  const findings = cloneFindings(data.findings, `${path}.findings`);
  if (ok !== (findings.length === 0)) {
    throw new TaskCheckCoreError(`${path}.ok contradicts findings`, {
      code: `contradictory-${kind}`,
      path,
    });
  }
  return {
    ok,
    [listField]: [...data[listField]],
    ...(kind === "scope"
      ? { changes: cloneFindings(data.changes ?? [], `${path}.changes`) }
      : {}),
    findings,
  };
}

/** @param {unknown} value @param {string} path @param {"scope" | "immutable"} kind */
function parseCheckpoints(value, path, kind) {
  const data = apiObject(value, path);
  const names = kind === "scope"
    ? ["preCommands", "postCommands"]
    : ["baseline", "preCommands", "postCommands"];
  closedObject(data, names, names, path);
  const parsed = {};
  for (const name of names) {
    parsed[name] = parseCheckpoint(data[name], `${path}.${name}`, kind);
  }
  const findings = names.flatMap((checkpoint) =>
    parsed[checkpoint].findings.map((finding) => ({ checkpoint, ...finding })),
  );
  return {
    ok: names.every((name) => parsed[name].ok),
    ...parsed,
    findings,
  };
}

/** @param {unknown} value @param {string} path @param {any} authorityCommand @param {string} phase */
function parseCommandOutcome(value, path, authorityCommand, phase) {
  const data = apiObject(value, path);
  const fields = [
    "command", "phase", "cwd", "startedAt", "completedAt", "exitCode", "signal",
    "timedOut", "aborted", "spawnError", "outputLimitExceeded", "processTreeLeak", "stdoutBytes", "stderrBytes",
    "stdoutSha256", "stderrSha256",
  ];
  closedObject(data, fields, fields, path);
  if (data.command !== authorityCommand) {
    throw new TaskCheckCoreError(`${path}.command is not the exact TaskContract command`, {
      code: "command-identity-mismatch",
      path: `${path}.command`,
    });
  }
  if (data.phase !== phase) {
    throw new TaskCheckCoreError(`${path}.phase does not preserve TaskContract order`, {
      code: "command-phase-mismatch",
      path: `${path}.phase`,
    });
  }
  const exitCode = data.exitCode;
  if (exitCode !== null && !Number.isSafeInteger(exitCode)) {
    throw new TaskCheckCoreError(`${path}.exitCode must be an integer or null`, {
      code: "invalid-exit-code",
      path: `${path}.exitCode`,
    });
  }
  const signal = nullableString(data.signal, `${path}.signal`);
  const spawnError = nullableString(data.spawnError, `${path}.spawnError`);
  const timedOut = requiredBoolean(data.timedOut, `${path}.timedOut`);
  const aborted = requiredBoolean(data.aborted, `${path}.aborted`);
  const outputLimitExceeded = requiredBoolean(
    data.outputLimitExceeded,
    `${path}.outputLimitExceeded`,
  );
  const processTreeLeak = requiredBoolean(data.processTreeLeak, `${path}.processTreeLeak`);
  const passed =
    !timedOut &&
    !aborted &&
    !outputLimitExceeded &&
    !processTreeLeak &&
    spawnError === null &&
    signal === null &&
    exitCode !== null &&
    authorityCommand.expected.exitCodes.includes(exitCode);
  return {
    phase,
    commandId: authorityCommand.id,
    executable: authorityCommand.executable,
    argvSha256: commandArgvSha256(authorityCommand),
    cwd: requiredString(data.cwd, `${path}.cwd`),
    startedAt: requiredTimestamp(data.startedAt, `${path}.startedAt`),
    completedAt: requiredTimestamp(data.completedAt, `${path}.completedAt`),
    exitCode,
    signal,
    timedOut,
    aborted,
    spawnError,
    outputLimitExceeded,
    processTreeLeak,
    stdoutBytes: requiredNonnegativeInteger(data.stdoutBytes, `${path}.stdoutBytes`),
    stderrBytes: requiredNonnegativeInteger(data.stderrBytes, `${path}.stderrBytes`),
    stdoutSha256: requiredSha256(data.stdoutSha256, `${path}.stdoutSha256`),
    stderrSha256: requiredSha256(data.stderrSha256, `${path}.stderrSha256`),
    stdoutExcerpt: null,
    stderrExcerpt: null,
    outputRetention: "digest-and-byte-count-only",
    expectedExitCodes: authorityCommand.expected.exitCodes,
    passed,
  };
}

/** @param {any} command */
function commandFailure(command) {
  let code = "unexpected-exit-code";
  if (command.aborted) code = "command-cancelled";
  else if (command.timedOut) code = "command-timeout";
  else if (command.outputLimitExceeded) code = "command-output-limit-exceeded";
  else if (command.processTreeLeak) code = "command-process-tree-leak";
  else if (command.spawnError !== null) code = "command-spawn-failure";
  else if (command.signal !== null) code = "command-signal-termination";
  return {
    category: "command",
    code,
    phase: command.phase,
    commandId: command.commandId,
  };
}

/**
 * Assemble the sole authoritative terminal predicate from deterministic host
 * facts. This pure function never reads a filesystem or executes a command.
 *
 * @param {unknown} contract
 * @param {unknown} input
 */
export function evaluateTaskCheck(contract, input) {
  if (!isTaskContract(contract)) {
    throw new TaskCheckCoreError(
      "evaluateTaskCheck requires the exact object returned by parseTaskContract",
      { code: "unparsed-task-contract", path: "$.contract" },
    );
  }
  const data = apiObject(input, "$.input");
  const fields = [
    "contract", "contractSha256", "workspaceIdentity", "baseline", "preCommands",
    "postCommands", "scope", "immutable", "commands", "infrastructureFailures",
    "cancelled",
  ];
  closedObject(data, fields, fields, "$.input");
  if (data.contract !== contract || data.contractSha256 !== contract.contractSha256) {
    throw new TaskCheckCoreError("task-check authority identity mismatch", {
      code: "task-contract-identity-mismatch",
      path: "$.input.contract",
    });
  }
  const workspaceIdentity = requiredSha256(data.workspaceIdentity, "$.input.workspaceIdentity");
  const baseline = parseSnapshot(data.baseline, "$.input.baseline");
  const preCommands = parseSnapshot(data.preCommands, "$.input.preCommands");
  const postCommands = parseSnapshot(data.postCommands, "$.input.postCommands");
  const scope = parseCheckpoints(data.scope, "$.input.scope", "scope");
  const immutable = parseCheckpoints(data.immutable, "$.input.immutable", "immutable");
  if (!Array.isArray(data.commands)) {
    throw new TaskCheckCoreError("$.input.commands must be an array", {
      code: "invalid-array",
      path: "$.input.commands",
    });
  }
  const expectedCommands = TASK_CHECK_PHASES.flatMap((phase) =>
    contract.authority.commands[phase].map((command) => ({ phase, command })),
  );
  if (data.commands.length > expectedCommands.length) {
    throw new TaskCheckCoreError("more command outcomes than TaskContract commands", {
      code: "command-count-mismatch",
      path: "$.input.commands",
    });
  }
  const commands = data.commands.map((entry, index) =>
    parseCommandOutcome(
      entry,
      `$.input.commands[${index}]`,
      expectedCommands[index].command,
      expectedCommands[index].phase,
    ),
  );
  const infrastructureFailures = cloneFindings(
    data.infrastructureFailures,
    "$.input.infrastructureFailures",
  );
  const cancelled = requiredBoolean(data.cancelled, "$.input.cancelled");
  const allCommandsPresent = commands.length === expectedCommands.length;
  const commandsPass = allCommandsPresent && commands.every((command) => command.passed);

  const failures = [
    ...(!baseline.ok ? [{ category: "snapshot", checkpoint: "baseline", code: baseline.code }] : []),
    ...(!preCommands.ok ? [{ category: "snapshot", checkpoint: "preCommands", code: preCommands.code }] : []),
    ...(!postCommands.ok ? [{ category: "snapshot", checkpoint: "postCommands", code: postCommands.code }] : []),
    ...scope.findings.map((finding) => ({ category: "scope", ...finding })),
    ...immutable.findings.map((finding) => ({ category: "immutable", ...finding })),
    ...commands.filter((command) => !command.passed).map(commandFailure),
    ...(!allCommandsPresent
      ? [{ category: "command", code: "authoritative-commands-incomplete" }]
      : []),
    ...infrastructureFailures,
  ];
  const aborted = cancelled || commands.some((command) => command.aborted);
  const green =
    baseline.ok &&
    preCommands.ok &&
    postCommands.ok &&
    scope.ok &&
    immutable.ok &&
    commandsPass &&
    !aborted &&
    infrastructureFailures.length === 0;
  const status = aborted ? "aborted" : green ? "green" : "red";

  const result = deepFreeze({
    version: TASK_CHECK_RESULT_VERSION,
    status,
    contract,
    contractSha256: contract.contractSha256,
    workspaceIdentity,
    baseline,
    preCommands,
    postCommands,
    scope,
    immutable,
    commands,
    failures,
    greenPredicate: {
      baselineValid: baseline.ok,
      preCommandSnapshotValid: preCommands.ok,
      postCommandSnapshotValid: postCommands.ok,
      scopeValid: scope.ok,
      immutableValid: immutable.ok,
      allCommandsPresent,
      commandsPass,
      notAborted: !aborted,
      infrastructureIntact: infrastructureFailures.length === 0,
    },
  });
  results.add(result);
  return result;
}

/** @param {unknown} value */
export function isTaskCheckResult(value) {
  return value !== null && typeof value === "object" && results.has(value);
}
