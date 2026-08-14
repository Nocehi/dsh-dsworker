import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  createExecutionContainment,
  disposeExecutionContainment,
} from "@dsh-dsworker/execution-containment";
import {
  captureWorkspaceSnapshot,
  createTaskCheckBinding,
  disposeTaskCheckBinding,
  runTaskCheck,
} from "@dsh-dsworker/task-check-local";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";
import { createTransientProfileRuntime } from "../../packages/worker-kernel/src/transient-runtime.js";
import { TEST_BASE_ENVIRONMENT } from "../helpers/task-check-fixtures.mjs";

const execFileAsync = promisify(execFile);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function indexFacts(workspaceRoot) {
  const path = join(workspaceRoot, ".git", "index");
  const stat = await lstat(path, { bigint: true });
  const bytes = await readFile(path);
  return Object.freeze({
    exists: true,
    type: stat.isFile() ? "file" : "other",
    mode: Number(stat.mode & 0o7777n),
    size: Number(stat.size),
    sha256: sha256(bytes),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

async function gitFixture() {
  const root = await mkdtemp("/tmp/dsh-dsworker-git-optional-locks.");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await execFileAsync("git", ["init", "--quiet", workspace]);
  await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
  await execFileAsync("git", ["-C", workspace, "add", "tracked.txt"]);
  await execFileAsync("git", [
    "-C",
    workspace,
    "-c",
    "user.name=dsh-dsworker tests",
    "-c",
    "user.email=dsh-dsworker@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "baseline",
  ]);
  return { root, workspace };
}

function gitContract({ commands = [] } = {}) {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "git-optional-locks",
      objective: "Keep read-only Git inspection observationally pure.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: [{ path: "tracked.txt", kind: "file" }],
        immutable: [{ path: ".git", kind: "directory" }],
      },
      commands: {
        semantic: [
          {
            id: "semantic-noop",
            executable: "true",
            argv: [],
            cwd: { kind: "workspace-root" },
            environment: {},
            timeoutMs: 10_000,
            expected: { exitCodes: [0] },
          },
        ],
        validation: [],
        finish: commands,
      },
      retry: { mode: "none", maxAttempts: 1 },
      terminal: {
        success: "all-authoritative-commands-pass",
        failure: "fail-closed",
      },
    },
  });
}

async function runBash(ctx, workspaceRoot, command) {
  return ctx.shell.run(
    ctx.shell.resolve({
      command,
      workdir: workspaceRoot,
      timeoutMs: 10_000,
      sandboxPolicy: {
        mode: "workspace-write",
        workspaceRoot,
      },
    }),
  );
}

test("read-only Git inspection is index-neutral through the model Bash containment seam", async () => {
  const { root, workspace } = await gitFixture();
  let containment;
  let runtime;
  let runtimeBinding;
  try {
    const afterClone = await indexFacts(workspace);
    containment = await createExecutionContainment({ workspaceRoot: workspace });
    runtime = await createTransientProfileRuntime({ workspaceRoot: workspace });
    runtimeBinding = runtime.ctx.subprocess.bindExecutionContainment(containment);
    assert.deepEqual(await indexFacts(workspace), afterClone, "runtime bootstrap changed .git/index");

    await appendFile(join(workspace, "tracked.txt"), "dirty\n", "utf8");
    const beforeInspection = await indexFacts(workspace);
    const commands = [
      "git rev-parse HEAD",
      "git status --short",
      "git status --porcelain",
      "git diff --stat",
      "git diff --check",
      "git diff",
      "git ls-files",
    ];
    const output = new Map();
    for (const command of commands) {
      const result = await runBash(runtime.ctx, workspace, command);
      assert.equal(result.exitCode, 0, `${command}: ${result.stderr.text}`);
      assert.deepEqual(
        await indexFacts(workspace),
        beforeInspection,
        `${command} changed .git/index`,
      );
      output.set(command, result.stdout.text);
    }
    assert.match(output.get("git status --short"), /tracked\.txt/u);
    assert.match(output.get("git status --porcelain"), /tracked\.txt/u);
    assert.match(output.get("git diff"), /\+dirty/u);
    assert.match(output.get("git ls-files"), /^tracked\.txt\s*$/u);
  } finally {
    runtimeBinding?.dispose();
    if (runtime !== undefined) await runtime.dispose();
    if (containment !== undefined) disposeExecutionContainment(containment);
    await rm(root, { recursive: true, force: true });
  }
});

test("TaskCheck Git inspection uses the same index-neutral execution policy", async () => {
  const contract = gitContract({
    commands: [
      {
        id: "read-only-status",
        executable: "git",
        argv: ["status", "--short"],
        cwd: { kind: "workspace-root" },
        environment: {},
        timeoutMs: 10_000,
        expected: { exitCodes: [0] },
      },
    ],
  });
  const { root, workspace } = await gitFixture();
  let containment;
  let taskCheckBinding;
  let runtime;
  let runtimeBinding;
  try {
    containment = await createExecutionContainment({
      workspaceRoot: workspace,
      contract,
    });
    taskCheckBinding = await createTaskCheckBinding({
      contract,
      workspaceRoot: workspace,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      executionContainment: containment,
    });
    runtime = await createTransientProfileRuntime({ workspaceRoot: workspace });
    runtimeBinding = runtime.ctx.subprocess.bindExecutionContainment(containment);
    const beforeMutation = await indexFacts(workspace);
    const mutation = await runBash(
      runtime.ctx,
      workspace,
      "printf 'after\\n' > tracked.txt",
    );
    assert.equal(mutation.exitCode, 0, mutation.stderr.text);

    const result = await runTaskCheck(taskCheckBinding, {
      contract,
      workspaceRoot: workspace,
    });
    assert.equal(result.status, "green");
    assert.equal(result.commands.length, 2);
    assert.ok(result.commands.every((command) => command.exitCode === 0));
    assert.deepEqual(result.scope.preCommands.changedPaths, ["tracked.txt"]);
    assert.deepEqual(result.scope.postCommands.changedPaths, ["tracked.txt"]);
    assert.deepEqual(await indexFacts(workspace), beforeMutation);
  } finally {
    runtimeBinding?.dispose();
    if (runtime !== undefined) await runtime.dispose();
    if (taskCheckBinding !== undefined) disposeTaskCheckBinding(taskCheckBinding);
    if (containment !== undefined) disposeExecutionContainment(containment);
    await rm(root, { recursive: true, force: true });
  }
});

test("contract-declared immutable .git is read-only through the model Bash containment seam", async () => {
  const contract = gitContract();
  const { root, workspace } = await gitFixture();
  let containment;
  let runtime;
  let runtimeBinding;
  try {
    containment = await createExecutionContainment({
      workspaceRoot: workspace,
      contract,
    });
    runtime = await createTransientProfileRuntime({ workspaceRoot: workspace });
    runtimeBinding = runtime.ctx.subprocess.bindExecutionContainment(containment);

    const sourceMutation = await runBash(
      runtime.ctx,
      workspace,
      "printf 'after\\n' > tracked.txt",
    );
    assert.equal(sourceMutation.exitCode, 0, sourceMutation.stderr.text);

    const beforeInspection = await indexFacts(workspace);
    const beforeGitTree = await captureWorkspaceSnapshot(join(workspace, ".git"));
    assert.equal(beforeGitTree.ok, true);
    for (const command of [
      "git rev-parse HEAD",
      "git status --short",
      "git status --porcelain",
      "git diff --stat",
      "git diff --check",
      "git diff",
      "git ls-files",
    ]) {
      const result = await runBash(runtime.ctx, workspace, command);
      assert.equal(result.exitCode, 0, `${command}: ${result.stderr.text}`);
      assert.deepEqual(
        await indexFacts(workspace),
        beforeInspection,
        `${command} changed .git/index`,
      );
    }

    const indexWrite = await runBash(
      runtime.ctx,
      workspace,
      "git add tracked.txt",
    );
    assert.notEqual(indexWrite.exitCode, 0);
    assert.equal(indexWrite.sandbox?.denied, true);
    assert.match(indexWrite.stderr.text, /read-only file system/iu);
    assert.deepEqual(await indexFacts(workspace), beforeInspection);

    const updateIndex = await runBash(
      runtime.ctx,
      workspace,
      "git update-index --assume-unchanged tracked.txt",
    );
    assert.notEqual(updateIndex.exitCode, 0);
    assert.equal(updateIndex.sandbox?.denied, true);
    assert.match(updateIndex.stderr.text, /read-only file system/iu);
    assert.deepEqual(await indexFacts(workspace), beforeInspection);
    const afterGitTree = await captureWorkspaceSnapshot(join(workspace, ".git"));
    assert.equal(afterGitTree.ok, true);
    assert.equal(afterGitTree.snapshotSha256, beforeGitTree.snapshotSha256);
    await assert.rejects(
      lstat(join(workspace, ".git", "index.lock")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    runtimeBinding?.dispose();
    if (runtime !== undefined) await runtime.dispose();
    if (containment !== undefined) disposeExecutionContainment(containment);
    await rm(root, { recursive: true, force: true });
  }
});

test("host-side Git metadata mutation remains independently authoritative RED", async () => {
  const contract = gitContract();
  const { root, workspace } = await gitFixture();
  let containment;
  let taskCheckBinding;
  let runtime;
  let runtimeBinding;
  try {
    containment = await createExecutionContainment({
      workspaceRoot: workspace,
      contract,
    });
    taskCheckBinding = await createTaskCheckBinding({
      contract,
      workspaceRoot: workspace,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      executionContainment: containment,
    });
    runtime = await createTransientProfileRuntime({ workspaceRoot: workspace });
    runtimeBinding = runtime.ctx.subprocess.bindExecutionContainment(containment);
    const beforeIndexWrite = await indexFacts(workspace);
    await writeFile(join(workspace, "tracked.txt"), "host-side mutation\n", "utf8");
    await execFileAsync("git", ["-C", workspace, "add", "tracked.txt"]);
    const afterIndexWrite = await indexFacts(workspace);
    assert.notDeepEqual(afterIndexWrite, beforeIndexWrite);
    assert.notEqual(afterIndexWrite.sha256, beforeIndexWrite.sha256);

    const result = await runTaskCheck(taskCheckBinding, {
      contract,
      workspaceRoot: workspace,
    });
    assert.equal(result.status, "red");
    assert.ok(result.scope.preCommands.changedPaths.includes(".git/index"));
    assert.ok(
      result.scope.findings.some(
        (finding) =>
          finding.code === "outside-mutable-authority" &&
          finding.path === ".git/index",
      ),
    );
    assert.ok(
      result.immutable.findings.some(
        (finding) =>
          finding.code === "immutable-state-changed" && finding.path === ".git",
      ),
    );
  } finally {
    runtimeBinding?.dispose();
    if (runtime !== undefined) await runtime.dispose();
    if (taskCheckBinding !== undefined) disposeTaskCheckBinding(taskCheckBinding);
    if (containment !== undefined) disposeExecutionContainment(containment);
    await rm(root, { recursive: true, force: true });
  }
});
