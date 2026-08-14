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
import { isTaskCheckResult } from "@dsh-dsworker/task-check-core";
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
      taskId: "task-check-authoritative-finalization",
      objective: "Characterize TaskCheck v1 finalization of an authorized pre-command state.",
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
            "finalize-target",
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

test("TaskCheck v1 permits authoritative finalization before GREEN and WorkspaceDelta", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-authoritative-finalization.");
  const source = join(root, "source");
  const workspace = join(root, "workspace");
  const taskContract = contract();
  let taskCheckBinding;
  let deltaBinding;

  try {
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "src", "target.txt"), "old\n", "utf8");
    await cp(source, workspace, { recursive: true, preserveTimestamps: true });
    assert.equal(await readFile(join(source, "src", "target.txt"), "utf8"), "old\n");
    assert.equal(await readFile(join(workspace, "src", "target.txt"), "utf8"), "old\n");

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

    // This is only the state present at the pre-command checkpoint. The
    // characterization makes no causal authorship claim about that state.
    await writeFile(join(workspace, "src", "target.txt"), "wrong\n", "utf8");
    assert.equal(await readFile(join(workspace, "src", "target.txt"), "utf8"), "wrong\n");

    const result = await runTaskCheck(taskCheckBinding, {
      contract: taskContract,
      workspaceRoot: workspace,
    });

    assert.equal(isTaskCheckResult(result), true);
    assert.equal(result.status, "green");
    assert.equal(result.scope.preCommands.ok, true);
    assert.equal(result.scope.postCommands.ok, true);
    assert.deepEqual(result.scope.preCommands.changedPaths, ["src/target.txt"]);
    assert.deepEqual(result.scope.postCommands.changedPaths, ["src/target.txt"]);
    assert.deepEqual(
      result.commands.map(({ phase, commandId, passed }) => ({
        phase,
        commandId,
        passed,
      })),
      [
        { phase: "semantic", commandId: "finalize-target", passed: true },
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
    assert.equal(delta.changes.length, 1);
    assert.equal(delta.changes[0].path, "src/target.txt");
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
