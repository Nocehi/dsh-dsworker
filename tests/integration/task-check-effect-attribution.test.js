import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  createTaskCheckBinding,
  disposeTaskCheckBinding,
  runTaskCheck,
} from "@dsh-dsworker/task-check-local";
import {
  parseTaskContract,
  TASK_CONTRACT_VERSION,
} from "@dsh-dsworker/task-contract";
import {
  createWorkspaceDeltaBinding,
  disposeWorkspaceDeltaBinding,
  exportWorkspaceDelta,
} from "@dsh-dsworker/workspace-delta";
import { TEST_BASE_ENVIRONMENT } from "../helpers/task-check-fixtures.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function command(id, script) {
  return {
    id,
    executable: "node",
    argv: ["-e", script],
    cwd: { kind: "workspace-root" },
    environment: {},
    timeoutMs: 1_000,
    expected: { exitCodes: [0] },
  };
}

function contract() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "task-check-effect-attribution",
      objective: "Characterize authoritative command effects separately from model-phase effects.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: [{ path: "src/target.txt", kind: "file" }],
        immutable: [],
      },
      commands: {
        semantic: [
          command(
            "repair-target",
            "require('node:fs').writeFileSync('src/target.txt', 'correct\\n', 'utf8')",
          ),
        ],
        validation: [
          command(
            "verify-target",
            "if (require('node:fs').readFileSync('src/target.txt', 'utf8') !== 'correct\\n') process.exit(41)",
          ),
        ],
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

test("GREEN attributes model-phase and authoritative-command effects separately", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-effect-attribution.");
  const source = join(root, "source");
  const workspace = join(root, "workspace");
  const taskContract = contract();
  let taskCheckBinding;
  let deltaBinding;

  try {
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "src", "target.txt"), "old\n", "utf8");
    await cp(source, workspace, { recursive: true, preserveTimestamps: true });

    deltaBinding = await createWorkspaceDeltaBinding({
      contract: taskContract,
      sourceWorkspaceRoot: source,
      workspaceRoot: workspace,
    });
    taskCheckBinding = await createTaskCheckBinding({
      contract: taskContract,
      workspaceRoot: workspace,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
    });

    // This is the state submitted to TaskCheck by the scripted model phase.
    await writeFile(join(workspace, "src", "target.txt"), "wrong\n", "utf8");

    const result = await runTaskCheck(taskCheckBinding, {
      contract: taskContract,
      workspaceRoot: workspace,
    });

    assert.equal(result.status, "green");
    assert.equal(result.scope.preCommands.ok, true);
    assert.equal(result.scope.postCommands.ok, true);
    assert.deepEqual(result.scope.preCommands.changedPaths, ["src/target.txt"]);
    assert.deepEqual(result.scope.postCommands.changedPaths, ["src/target.txt"]);

    assert.notEqual(result.effectAttribution, null);
    assert.deepEqual(result.effectAttribution.modelPhase.changedPaths, ["src/target.txt"]);
    assert.equal(result.effectAttribution.modelPhase.from, "baseline");
    assert.equal(result.effectAttribution.modelPhase.to, "preCommands");
    assert.deepEqual(
      result.effectAttribution.authoritativeCommandPhase.changedPaths,
      ["src/target.txt"],
    );
    assert.equal(
      result.effectAttribution.authoritativeCommandPhase.from,
      "preCommands",
    );
    assert.equal(
      result.effectAttribution.authoritativeCommandPhase.to,
      "postCommands",
    );
    assert.deepEqual(result.effectAttribution.final.changedPaths, ["src/target.txt"]);
    assert.equal(result.effectAttribution.final.from, "baseline");
    assert.equal(result.effectAttribution.final.to, "postCommands");
    assert.equal(Object.isFrozen(result.effectAttribution), true);
    assert.equal(
      Object.isFrozen(result.effectAttribution.authoritativeCommandPhase.changes),
      true,
    );

    assert.deepEqual(
      result.commands.map(({ phase, commandId, passed }) => ({
        phase,
        commandId,
        passed,
      })),
      [
        { phase: "semantic", commandId: "repair-target", passed: true },
        { phase: "validation", commandId: "verify-target", passed: true },
      ],
    );
    assert.equal(await readFile(join(workspace, "src", "target.txt"), "utf8"), "correct\n");

    const delta = await exportWorkspaceDelta(deltaBinding, {
      contract: taskContract,
      sourceWorkspaceRoot: source,
      workspaceRoot: workspace,
    });
    assert.deepEqual(delta.changedPaths, ["src/target.txt"]);
    assert.equal(delta.changes[0].kind, "modify");
    assert.equal(delta.changes[0].beforeSha256, sha256("old\n"));
    assert.equal(delta.changes[0].afterSha256, sha256("correct\n"));
    assert.equal(
      Buffer.from(delta.changes[0].afterContentBase64, "base64").toString("utf8"),
      "correct\n",
    );
    assert.match(delta.reviewPatch.text, /-old\n\+correct\n/u);
  } finally {
    if (taskCheckBinding !== undefined) disposeTaskCheckBinding(taskCheckBinding);
    if (deltaBinding !== undefined) disposeWorkspaceDeltaBinding(deltaBinding);
    await rm(root, { recursive: true, force: true });
  }
});
