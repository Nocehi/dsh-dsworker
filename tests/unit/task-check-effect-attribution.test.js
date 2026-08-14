import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateTaskCheck } from "@dsh-dsworker/task-check-core";
import { summarizeTaskCheckResult } from "@dsh-dsworker/plugin-task-check";
import {
  parseTaskContract,
  TASK_CONTRACT_VERSION,
} from "@dsh-dsworker/task-contract";

const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4640991b7852b855";
const SNAPSHOT_SHA = "0".repeat(64);

function contract() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "effect-attribution-unit",
      objective: "Keep phase attribution as host-only evidence.",
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
            executable: "true",
            argv: [],
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
  });
}

function snapshot() {
  return {
    ok: true,
    code: "snapshot-complete",
    entryCount: 1,
    totalFileBytes: 1,
    snapshotSha256: SNAPSHOT_SHA,
    failure: null,
  };
}

function allowedScope(path = "main.txt") {
  return {
    ok: true,
    changedPaths: [path],
    changes: [
      {
        path,
        change: "changed",
        beforeType: "file",
        afterType: "file",
        authority: [
          {
            decision: "allow",
            code: "mutable-file-exact",
            operation: "replace-file",
          },
        ],
        allowed: true,
      },
    ],
    findings: [],
  };
}

function emptyImmutable() {
  return { ok: true, checked: [], findings: [] };
}

function commandOutcome(taskContract) {
  return {
    command: taskContract.authority.commands.semantic[0],
    phase: "semantic",
    cwd: "/tmp/effect-attribution-unit",
    startedAt: "2026-08-14T00:00:00.000Z",
    completedAt: "2026-08-14T00:00:00.001Z",
    exitCode: 0,
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

function evaluationInput(taskContract, effectAttribution) {
  const scope = allowedScope();
  const immutable = emptyImmutable();
  return {
    contract: taskContract,
    contractSha256: taskContract.contractSha256,
    workspaceIdentity: "1".repeat(64),
    baseline: snapshot(),
    preCommands: snapshot(),
    postCommands: snapshot(),
    scope: { preCommands: scope, postCommands: scope },
    immutable: {
      baseline: immutable,
      preCommands: immutable,
      postCommands: immutable,
    },
    commands: [commandOutcome(taskContract)],
    infrastructureFailures: [],
    cancelled: false,
    ...(effectAttribution === undefined ? {} : { effectAttribution }),
  };
}

test("effect attribution is frozen host evidence and does not change GREEN", () => {
  const taskContract = contract();
  const scope = allowedScope();
  const result = evaluateTaskCheck(
    taskContract,
    evaluationInput(taskContract, {
      modelPhase: scope,
      authoritativeCommandPhase: scope,
      final: scope,
    }),
  );

  assert.equal(result.status, "green");
  assert.equal(result.greenPredicate.scopeValid, true);
  assert.equal(result.effectAttribution.modelPhase.from, "baseline");
  assert.equal(result.effectAttribution.modelPhase.to, "preCommands");
  assert.equal(result.effectAttribution.authoritativeCommandPhase.from, "preCommands");
  assert.equal(result.effectAttribution.authoritativeCommandPhase.to, "postCommands");
  assert.equal(result.effectAttribution.final.from, "baseline");
  assert.equal(result.effectAttribution.final.to, "postCommands");
  assert.equal(Object.isFrozen(result.effectAttribution), true);
  assert.equal(Object.isFrozen(result.effectAttribution.modelPhase.changes), true);

  const summary = summarizeTaskCheckResult(result);
  assert.equal(Object.hasOwn(summary, "effectAttribution"), false);
  assert.equal(JSON.stringify(summary).includes("authoritativeCommandPhase"), false);
});

test("direct core callers may omit effect attribution without changing v1 behavior", () => {
  const taskContract = contract();
  const result = evaluateTaskCheck(taskContract, evaluationInput(taskContract));
  assert.equal(result.status, "green");
  assert.equal(result.effectAttribution, null);
});
