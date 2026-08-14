import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateTaskCheck } from "@dsh-dsworker/task-check-core";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";
import {
  isTaskCheckToolSummary,
  MAX_SUMMARY_CHANGED_PATHS,
  MAX_SUMMARY_COMMANDS,
  MAX_SUMMARY_FAILURES,
  MAX_SUMMARY_STRING_CODE_POINTS,
  summarizeTaskCheckResult,
  TASK_CHECK_OUTPUT_SCHEMA,
  TASK_CHECK_PARAMETERS_SCHEMA,
  TaskCheckPluginApiError,
} from "@dsh-dsworker/plugin-task-check";

const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SNAPSHOT_SHA = "0".repeat(64);
const SECRET_SENTINEL = "sk-secret-shaped-value-must-never-reach-summary";

function contractWithCommands(count) {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "task-check-plugin-unit",
      objective: `Do not serialize ${SECRET_SENTINEL}`,
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: { mutable: [{ path: "main.txt", kind: "file" }], immutable: [] },
      commands: {
        semantic: Array.from({ length: count }, (_, index) => ({
          id: `semantic-${index}`,
          executable: "node",
          argv: ["-e", `void ${index}`, SECRET_SENTINEL],
          cwd: { kind: "workspace-root" },
          environment: { PUBLIC_MARKER: SECRET_SENTINEL },
          timeoutMs: 1_000,
          expected: { exitCodes: [0] },
        })),
        validation: [],
        finish: [],
      },
      retry: { mode: "none", maxAttempts: 1 },
      terminal: {
        success: "all-authoritative-commands-pass",
        failure: "fail-closed",
      },
    },
  });
}

function snapshot() {
  return {
    ok: true,
    code: "snapshot-complete",
    entryCount: 0,
    totalFileBytes: 0,
    snapshotSha256: SNAPSHOT_SHA,
    failure: null,
  };
}

function immutable() {
  return { ok: true, checked: [], findings: [] };
}

function scope(changedPaths = []) {
  const findings = changedPaths.map((path) => ({
    code: "outside-mutable-authority",
    path,
  }));
  return {
    ok: findings.length === 0,
    changedPaths,
    changes: changedPaths.map((path) => ({ path, change: "created" })),
    findings,
  };
}

function commandOutcome(command, exitCode) {
  return {
    command,
    phase: "semantic",
    cwd: "/tmp/plugin-unit",
    startedAt: "2026-08-14T00:00:00.000Z",
    completedAt: "2026-08-14T00:00:00.001Z",
    exitCode,
    signal: null,
    timedOut: false,
    aborted: false,
    spawnError: null,
    outputLimitExceeded: false,
    processTreeLeak: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutSha256: EMPTY_SHA,
    stderrSha256: EMPTY_SHA,
  };
}

function resultFor(
  contract,
  { exitCode = 0, changedPaths = [], infrastructureFailures = [] } = {},
) {
  const checkpoint = scope(changedPaths);
  const immutableCheckpoint = immutable();
  return evaluateTaskCheck(contract, {
    contract,
    contractSha256: contract.contractSha256,
    workspaceIdentity: "1".repeat(64),
    baseline: snapshot(),
    preCommands: snapshot(),
    postCommands: snapshot(),
    scope: { preCommands: checkpoint, postCommands: checkpoint },
    immutable: {
      baseline: immutableCheckpoint,
      preCommands: immutableCheckpoint,
      postCommands: immutableCheckpoint,
    },
    commands: contract.authority.commands.semantic.map((command) =>
      commandOutcome(command, exitCode),
    ),
    infrastructureFailures,
    cancelled: false,
  });
}

test("task_check summary is typed, deeply immutable, and omits authority payloads", () => {
  const contract = contractWithCommands(1);
  const summary = summarizeTaskCheckResult(resultFor(contract));

  assert.equal(isTaskCheckToolSummary(summary), true);
  assert.equal(summary.status, "green");
  assert.equal(summary.contractSha256, contract.contractSha256);
  assert.equal(summary.commands.total, 1);
  assert.equal(summary.commands.passed, 1);
  assert.equal(summary.failures.total, 0);
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.commands.items), true);
  assert.equal(Object.isFrozen(summary.greenPredicate), true);
  assert.throws(() => summary.commands.items.push({}), TypeError);
  assert.throws(() => {
    summary.status = "red";
  }, TypeError);

  const encoded = JSON.stringify(summary);
  assert.equal(encoded.includes(SECRET_SENTINEL), false);
  assert.equal(encoded.includes("objective"), false);
  assert.equal(encoded.includes("environment"), false);
  assert.equal(encoded.includes("stdout"), false);
  assert.equal(encoded.includes("stderr"), false);
  assert.equal(encoded.includes("argv"), false);
});

test("task_check summary bounds commands, failures, paths, and Unicode strings", () => {
  const contract = contractWithCommands(MAX_SUMMARY_COMMANDS + 8);
  const longPath = `${"雪".repeat(MAX_SUMMARY_STRING_CODE_POINTS + 20)}.txt`;
  const changedPaths = Array.from(
    { length: MAX_SUMMARY_CHANGED_PATHS + 9 },
    (_, index) => (index === 0 ? longPath : `outside-${index}.txt`),
  );
  const summary = summarizeTaskCheckResult(
    resultFor(contract, { exitCode: 7, changedPaths }),
  );

  assert.equal(summary.status, "red");
  assert.equal(summary.commands.items.length, MAX_SUMMARY_COMMANDS);
  assert.equal(summary.commands.omitted, 8);
  assert.equal(summary.scope.preChangedPaths.length, MAX_SUMMARY_CHANGED_PATHS);
  assert.equal(summary.scope.preChangedPathsOmitted, 9);
  assert.equal(
    [...summary.scope.preChangedPaths[0]].length,
    MAX_SUMMARY_STRING_CODE_POINTS,
  );
  assert.equal(summary.failures.items.length, MAX_SUMMARY_FAILURES);
  assert.equal(
    summary.failures.omitted,
    summary.failures.total - MAX_SUMMARY_FAILURES,
  );
});

test("secret-shaped host failure fields are redacted from model output", () => {
  const contract = contractWithCommands(1);
  const summary = summarizeTaskCheckResult(
    resultFor(contract, {
      infrastructureFailures: [
        { category: "configuration", code: SECRET_SENTINEL, path: "safe.txt" },
      ],
    }),
  );
  const encoded = JSON.stringify(summary);
  assert.equal(summary.status, "red");
  assert.equal(encoded.includes(SECRET_SENTINEL), false);
  assert.equal(summary.failures.items.at(-1).code, "<redacted>");
});

test("task_check projection rejects structural lookalikes and schemas are closed", () => {
  assert.throws(
    () => summarizeTaskCheckResult({ status: "green" }),
    (error) =>
      error instanceof TaskCheckPluginApiError &&
      error.code === "invalid-task-check-result",
  );
  assert.deepEqual(TASK_CHECK_PARAMETERS_SCHEMA, {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  });
  assert.equal(TASK_CHECK_OUTPUT_SCHEMA.additionalProperties, false);
  assert.equal(Object.isFrozen(TASK_CHECK_PARAMETERS_SCHEMA), true);
  assert.equal(Object.isFrozen(TASK_CHECK_OUTPUT_SCHEMA.properties.commands), true);
});
