import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  createWorkspaceDeltaBinding,
  disposeWorkspaceDeltaBinding,
  exportWorkspaceDelta,
  isWorkspaceDelta,
  WorkspaceDeltaError,
} from "@dsh-dsworker/workspace-delta";
import {
  parseTaskContract,
  TASK_CONTRACT_VERSION,
} from "@dsh-dsworker/task-contract";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deltaContract() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "workspace-delta-unit",
      objective: "Change only the declared source files.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: [
          { path: "alpha.txt", kind: "file" },
          { path: "new.txt", kind: "file" },
          { path: "remove.txt", kind: "file" },
        ],
        immutable: [],
      },
      commands: {
        semantic: [
          {
            id: "semantic-noop",
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

async function runGitApply(root, patch, check) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["apply", ...(check ? ["--check"] : []), "-"], {
      cwd: root,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`git apply failed: ${stderr}`));
    });
    child.stdin.end(patch, "utf8");
  });
}

test("GREEN-only handoff primitive exports deterministic create/modify/delete artifact", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-delta-unit.");
  const source = join(root, "source");
  const workspace = join(root, "workspace");
  const reproduction = join(root, "reproduction");
  const contract = deltaContract();
  await mkdir(source);
  await writeFile(join(source, "alpha.txt"), "before alpha\n", "utf8");
  await writeFile(join(source, "remove.txt"), "remove me\n", "utf8");
  await cp(source, workspace, { recursive: true, preserveTimestamps: true });
  await cp(source, reproduction, { recursive: true, preserveTimestamps: true });
  const binding = await createWorkspaceDeltaBinding({
    contract,
    sourceWorkspaceRoot: source,
    workspaceRoot: workspace,
  });
  try {
    await writeFile(join(workspace, "alpha.txt"), "after alpha\n", "utf8");
    await writeFile(join(workspace, "new.txt"), "new file\n", "utf8");
    await unlink(join(workspace, "remove.txt"));
    const delta = await exportWorkspaceDelta(binding, {
      contract,
      sourceWorkspaceRoot: source,
      workspaceRoot: workspace,
    });
    assert.equal(isWorkspaceDelta(delta), true);
    assert.equal(delta.promotable, true);
    assert.deepEqual(delta.changedPaths, ["alpha.txt", "new.txt", "remove.txt"]);
    assert.deepEqual(
      delta.changes.map(({ path, kind }) => ({ path, kind })),
      [
        { path: "alpha.txt", kind: "modify" },
        { path: "new.txt", kind: "create" },
        { path: "remove.txt", kind: "delete" },
      ],
    );
    assert.equal(delta.changes[0].beforeSha256, sha256("before alpha\n"));
    assert.equal(delta.changes[0].afterSha256, sha256("after alpha\n"));
    assert.equal(delta.changes[1].beforeSha256, null);
    assert.equal(delta.changes[2].afterSha256, null);
    assert.equal(Object.isFrozen(delta), true);
    assert.equal(Object.isFrozen(delta.changes), true);
    assert.throws(() => delta.changedPaths.push("escape"), TypeError);
    assert.equal(
      sha256(Buffer.from(delta.reviewPatch.text, "utf8")),
      delta.reviewPatch.sha256,
    );
    await runGitApply(reproduction, delta.reviewPatch.text, true);
    await runGitApply(reproduction, delta.reviewPatch.text, false);
    assert.equal(await readFile(join(reproduction, "alpha.txt"), "utf8"), "after alpha\n");
    assert.equal(await readFile(join(reproduction, "new.txt"), "utf8"), "new file\n");
    await assert.rejects(readFile(join(reproduction, "remove.txt")), /ENOENT/u);
  } finally {
    disposeWorkspaceDeltaBinding(binding);
    await rm(root, { recursive: true, force: true });
  }
});

test("delta export fails closed for unauthorized, ephemeral, or changed source state", async () => {
  const cases = [
    {
      name: "outside authority",
      mutate: (workspace) => writeFile(join(workspace, "outside.txt"), "bad\n"),
      code: "delta-outside-mutable-authority",
    },
    {
      name: "source drift",
      mutate: (_workspace, source) => writeFile(join(source, "alpha.txt"), "drift\n"),
      code: "source-tree-changed",
    },
  ];
  for (const scenario of cases) {
    const root = await mkdtemp("/tmp/dsh-dsworker-delta-deny.");
    const source = join(root, "source");
    const workspace = join(root, "workspace");
    const contract = deltaContract();
    await mkdir(source);
    await writeFile(join(source, "alpha.txt"), "before\n");
    await writeFile(join(source, "remove.txt"), "keep\n");
    await cp(source, workspace, { recursive: true, preserveTimestamps: true });
    const binding = await createWorkspaceDeltaBinding({
      contract,
      sourceWorkspaceRoot: source,
      workspaceRoot: workspace,
    });
    try {
      await scenario.mutate(workspace, source);
      await assert.rejects(
        exportWorkspaceDelta(binding, {
          contract,
          sourceWorkspaceRoot: source,
          workspaceRoot: workspace,
        }),
        (error) =>
          error instanceof WorkspaceDeltaError && error.code === scenario.code,
        scenario.name,
      );
    } finally {
      disposeWorkspaceDeltaBinding(binding);
      await rm(root, { recursive: true, force: true });
    }
  }
});
