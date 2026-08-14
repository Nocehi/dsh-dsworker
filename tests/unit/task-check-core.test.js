import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TaskCheckCoreError,
  commandArgvSha256,
  evaluateTaskCheck,
  isTaskCheckResult,
} from "@dsh-dsworker/task-check-core";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";

function contractInput(argv = ["--version"]) {
  return {
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "core-unit",
      objective: "Prove the pure terminal predicate.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: { mutable: [{ path: "main.txt", kind: "file" }], immutable: [] },
      commands: {
        semantic: [
          {
            id: "semantic",
            executable: "node",
            argv,
            cwd: { kind: "workspace-root" },
            environment: {},
            timeoutMs: 1_000,
            expected: { exitCodes: [0] },
          },
        ],
        validation: [],
        finish: [],
      },
      retry: { mode: "none", maxAttempts: 1 },
      terminal: {
        success: "all-authoritative-commands-pass",
        failure: "fail-closed",
      },
    },
  };
}

const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SNAPSHOT_SHA = "0".repeat(64);
const TASK_CHECK_RESULT_V1_PUBLIC_KEYS = Object.freeze([
  "version",
  "status",
  "contract",
  "contractSha256",
  "workspaceIdentity",
  "baseline",
  "preCommands",
  "postCommands",
  "scope",
  "immutable",
  "commands",
  "failures",
  "greenPredicate",
]);

function snapshot(ok = true, code = "snapshot-complete") {
  return {
    ok,
    code,
    entryCount: 0,
    totalFileBytes: 0,
    snapshotSha256: ok ? SNAPSHOT_SHA : null,
    failure: ok ? null : { code, path: null, nodeType: null },
  };
}

function scope(ok = true) {
  return {
    ok,
    changedPaths: [],
    findings: ok ? [] : [{ code: "outside-mutable-authority", path: "foo" }],
  };
}

function immutable(ok = true) {
  return {
    ok,
    checked: [],
    findings: ok ? [] : [{ code: "immutable-state-changed", path: "authority" }],
  };
}

function commandOutcome(command, fields = {}) {
  return {
    command,
    phase: "semantic",
    cwd: "/tmp/unit",
    startedAt: "2026-08-14T00:00:00.000Z",
    completedAt: "2026-08-14T00:00:00.001Z",
    exitCode: fields.exitCode ?? 0,
    signal: fields.signal ?? null,
    timedOut: fields.timedOut ?? false,
    aborted: fields.aborted ?? false,
    spawnError: fields.spawnError ?? null,
    outputLimitExceeded: fields.outputLimitExceeded ?? false,
    processTreeLeak: fields.processTreeLeak ?? false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutSha256: EMPTY_SHA,
    stderrSha256: EMPTY_SHA,
  };
}

function evaluationInput(contract, overrides = {}) {
  const goodSnapshot = snapshot();
  const goodScope = scope();
  const goodImmutable = immutable();
  return {
    contract,
    contractSha256: contract.contractSha256,
    workspaceIdentity: "1".repeat(64),
    baseline: goodSnapshot,
    preCommands: goodSnapshot,
    postCommands: goodSnapshot,
    scope: { preCommands: goodScope, postCommands: goodScope },
    immutable: {
      baseline: goodImmutable,
      preCommands: goodImmutable,
      postCommands: goodImmutable,
    },
    commands: [commandOutcome(contract.authority.commands.semantic[0])],
    infrastructureFailures: [],
    cancelled: false,
    ...overrides,
  };
}

test("one pure predicate produces a genuine deeply immutable GREEN", () => {
  const contract = parseTaskContract(contractInput());
  const result = evaluateTaskCheck(contract, evaluationInput(contract));
  assert.equal(isTaskCheckResult(result), true);
  assert.equal(result.status, "green");
  assert.equal(result.contract, contract);
  assert.equal(result.contractSha256, contract.contractSha256);
  assert.deepEqual(Object.keys(result), TASK_CHECK_RESULT_V1_PUBLIC_KEYS);
  assert.deepEqual(result.greenPredicate, {
    baselineValid: true,
    preCommandSnapshotValid: true,
    postCommandSnapshotValid: true,
    scopeValid: true,
    immutableValid: true,
    allCommandsPresent: true,
    commandsPass: true,
    notAborted: true,
    infrastructureIntact: true,
  });
  assert.equal(result.commands[0].passed, true);
  assert.equal(result.commands[0].outputRetention, "digest-and-byte-count-only");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.commands), true);
  assert.equal(Object.isFrozen(result.greenPredicate), true);
  assert.throws(() => result.failures.push({ code: "mutation" }), TypeError);
  assert.throws(() => {
    result.commands[0].passed = false;
  }, TypeError);
});

test("RED and ABORTED remain typed and cannot become GREEN by caller assertion", () => {
  const contract = parseTaskContract(contractInput());
  const command = contract.authority.commands.semantic[0];
  const red = evaluateTaskCheck(
    contract,
    evaluationInput(contract, {
      commands: [commandOutcome(command, { exitCode: 7 })],
    }),
  );
  assert.equal(red.status, "red");
  assert.equal(red.commands[0].passed, false);
  assert.ok(red.failures.some((failure) => failure.code === "unexpected-exit-code"));

  const aborted = evaluateTaskCheck(
    contract,
    evaluationInput(contract, {
      commands: [commandOutcome(command, { exitCode: null, aborted: true })],
      cancelled: true,
    }),
  );
  assert.equal(aborted.status, "aborted");
  assert.ok(aborted.failures.some((failure) => failure.code === "command-cancelled"));

  const incomplete = evaluateTaskCheck(
    contract,
    evaluationInput(contract, { commands: [] }),
  );
  assert.equal(incomplete.status, "red");
  assert.equal(incomplete.greenPredicate.allCommandsPresent, false);
});

test("exact TaskContract and exact command identities are mandatory", () => {
  const contract = parseTaskContract(contractInput());
  const copy = parseTaskContract(contractInput());
  assert.throws(
    () => evaluateTaskCheck(contract, evaluationInput(copy)),
    (error) =>
      error instanceof TaskCheckCoreError &&
      error.code === "task-contract-identity-mismatch",
  );
  const wrongCommand = structuredClone(contract.authority.commands.semantic[0]);
  const input = evaluationInput(contract);
  input.commands = [commandOutcome(wrongCommand)];
  assert.throws(
    () => evaluateTaskCheck(contract, input),
    (error) =>
      error instanceof TaskCheckCoreError &&
      error.code === "command-identity-mismatch",
  );
  assert.throws(
    () => evaluateTaskCheck(structuredClone(contract), evaluationInput(contract)),
    (error) =>
      error instanceof TaskCheckCoreError &&
      error.code === "unparsed-task-contract",
  );
});

test("argv identity preserves empty, whitespace, quotes, slashes, and Unicode", () => {
  const argv = ["", "two words", "\"quoted\"", "back\\slash", "廣東話"];
  const left = parseTaskContract(contractInput(argv));
  const right = parseTaskContract(contractInput([...argv]));
  const changed = parseTaskContract(contractInput([...argv.slice(0, 4), "广东话"]));
  assert.equal(
    commandArgvSha256(left.authority.commands.semantic[0]),
    commandArgvSha256(right.authority.commands.semantic[0]),
  );
  assert.notEqual(
    commandArgvSha256(left.authority.commands.semantic[0]),
    commandArgvSha256(changed.authority.commands.semantic[0]),
  );
});
