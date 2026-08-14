import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  containmentDisposition,
  createExecutionContainment,
  disposeExecutionContainment,
} from "@dsh-dsworker/execution-containment";
import {
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

const PRIVATE_ZIG_ENVIRONMENT = Object.freeze({
  ZIG_GLOBAL_CACHE_DIR: "/tmp/zig-cache/global",
  ZIG_LOCAL_CACHE_DIR: "/tmp/zig-cache/local",
});

async function runModelBash(ctx, workspaceRoot, command, timeoutMs = 120_000) {
  return ctx.shell.run(
    ctx.shell.resolve({
      command,
      workdir: workspaceRoot,
      timeoutMs,
      sandboxPolicy: { mode: "workspace-write", workspaceRoot },
    }),
  );
}

async function writeZigFixture(workspace) {
  await mkdir(join(workspace, "src"));
  await writeFile(
    join(workspace, "small.zig"),
    "const std = @import(\"std\");\ntest \"small\" { try std.testing.expectEqual(@as(u8, 2), 1 + 1); }\n",
    "utf8",
  );
  await writeFile(join(workspace, "src", "main.zig"), "pub fn main() void {}\n", "utf8");
  await writeFile(
    join(workspace, "build.zig"),
    "const std = @import(\"std\");\npub fn build(b: *std.Build) void {\n    const exe = b.addExecutable(.{ .name = \"fixture\", .root_module = b.createModule(.{ .root_source_file = b.path(\"src/main.zig\"), .target = b.graph.host }) });\n    b.default_step.dependOn(&exe.step);\n}\n",
    "utf8",
  );
}

function sourceContract() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "model-bash-private-zig-cache",
      objective: "Permit one source edit while keeping generated paths outside authority.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: [{ path: "src/task.zig", kind: "file" }],
        immutable: [],
      },
      commands: {
        semantic: [
          {
            id: "zig-test-task",
            executable: "zig",
            argv: ["test", "src/task.zig"],
            cwd: { kind: "workspace-root" },
            environment: PRIVATE_ZIG_ENVIRONMENT,
            timeoutMs: 120_000,
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

function explicitCacheCommandContract() {
  const command = (id, argv) => ({
    id,
    executable: "zig",
    argv,
    cwd: { kind: "workspace-root" },
    environment: PRIVATE_ZIG_ENVIRONMENT,
    timeoutMs: 120_000,
    expected: { exitCodes: [0] },
  });
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "task-check-explicit-private-zig-cache",
      objective: "Run structural Zig checks without workspace cache output.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: [{ path: "small.zig", kind: "file" }],
        immutable: [],
      },
      commands: {
        semantic: [command("zig-test", ["test", "small.zig"])],
        validation: [
          command("zig-build", ["build"]),
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

async function writeTaskSource(workspace) {
  await mkdir(join(workspace, "src"));
  await writeFile(
    join(workspace, "src", "task.zig"),
    "const std = @import(\"std\");\ntest \"task\" { try std.testing.expectEqual(@as(u8, 1), 1); }\n",
    "utf8",
  );
}

test("ordinary Zig test and build use private caches through the real model Bash seam", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-zig-cache-model-bash.");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeZigFixture(workspace);
  let containment;
  let runtime;
  let runtimeBinding;
  try {
    containment = await createExecutionContainment({ workspaceRoot: workspace });
    runtime = await createTransientProfileRuntime({ workspaceRoot: workspace });
    runtimeBinding = runtime.ctx.subprocess.bindExecutionContainment(containment);

    const environment = await runModelBash(
      runtime.ctx,
      workspace,
      "node -e 'const f=require(\"node:fs\");process.stdout.write(JSON.stringify({git:process.env.GIT_OPTIONAL_LOCKS??null,global:process.env.ZIG_GLOBAL_CACHE_DIR??null,local:process.env.ZIG_LOCAL_CACHE_DIR??null,globalExists:f.existsSync(\"/tmp/zig-cache/global\"),localExists:f.existsSync(\"/tmp/zig-cache/local\")}))'",
    );
    assert.equal(environment.exitCode, 0, environment.stderr.text);
    assert.deepEqual(JSON.parse(environment.stdout.text), {
      git: "0",
      global: PRIVATE_ZIG_ENVIRONMENT.ZIG_GLOBAL_CACHE_DIR,
      local: PRIVATE_ZIG_ENVIRONMENT.ZIG_LOCAL_CACHE_DIR,
      globalExists: false,
      localExists: false,
    });

    const zigTest = await runModelBash(
      runtime.ctx,
      workspace,
      "zig test small.zig && test -d /tmp/zig-cache/global",
    );
    assert.equal(zigTest.exitCode, 0, zigTest.stderr.text);
    assert.match(zigTest.stderr.text, /All 1 tests passed/u);
    assert.equal(existsSync(join(workspace, ".zig-cache")), false);
    assert.equal(existsSync(join(workspace, "zig-out")), false);

    const zigBuild = await runModelBash(
      runtime.ctx,
      workspace,
      "zig build && test -d /tmp/zig-cache/global && test -d /tmp/zig-cache/local",
    );
    assert.equal(zigBuild.exitCode, 0, zigBuild.stderr.text);
    assert.equal(existsSync(join(workspace, ".zig-cache")), false);
    assert.equal(existsSync(join(workspace, "zig-out")), false);
    assert.equal(containmentDisposition(containment).backend, "bubblewrap");
  } finally {
    runtimeBinding?.dispose();
    if (runtime !== undefined) await runtime.dispose();
    if (containment !== undefined) disposeExecutionContainment(containment);
    await rm(root, { recursive: true, force: true });
  }
});

test("TaskCheck command-level private Zig cache environment is already workspace-neutral", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-zig-cache-task-check.");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeZigFixture(workspace);
  const contract = explicitCacheCommandContract();
  let containment;
  let taskCheckBinding;
  try {
    containment = await createExecutionContainment({ workspaceRoot: workspace, contract });
    taskCheckBinding = await createTaskCheckBinding({
      contract,
      workspaceRoot: workspace,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      executionContainment: containment,
    });
    const result = await runTaskCheck(taskCheckBinding, { contract, workspaceRoot: workspace });
    assert.equal(result.status, "green");
    assert.equal(result.commands.length, 2);
    assert.ok(result.commands.every((command) => command.exitCode === 0));
    assert.equal(existsSync(join(workspace, ".zig-cache")), false);
    assert.equal(existsSync(join(workspace, "zig-out")), false);
  } finally {
    if (taskCheckBinding !== undefined) disposeTaskCheckBinding(taskCheckBinding);
    if (containment !== undefined) disposeExecutionContainment(containment);
    await rm(root, { recursive: true, force: true });
  }
});

test("legitimate source edit plus model Bash Zig test remains authoritative GREEN", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-zig-cache-green.");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeTaskSource(workspace);
  const contract = sourceContract();
  let containment;
  let taskCheckBinding;
  let runtime;
  let runtimeBinding;
  try {
    containment = await createExecutionContainment({ workspaceRoot: workspace, contract });
    taskCheckBinding = await createTaskCheckBinding({
      contract,
      workspaceRoot: workspace,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      executionContainment: containment,
    });
    runtime = await createTransientProfileRuntime({ workspaceRoot: workspace });
    runtimeBinding = runtime.ctx.subprocess.bindExecutionContainment(containment);
    const modelBash = await runModelBash(
      runtime.ctx,
      workspace,
      "printf '\\n// legitimate model edit\\n' >> src/task.zig; zig test src/task.zig",
    );
    assert.equal(modelBash.exitCode, 0, modelBash.stderr.text);
    assert.equal(existsSync(join(workspace, ".zig-cache")), false);

    const result = await runTaskCheck(taskCheckBinding, { contract, workspaceRoot: workspace });
    assert.equal(result.status, "green");
    assert.deepEqual(result.scope.preCommands.changedPaths, ["src/task.zig"]);
    assert.deepEqual(result.scope.postCommands.changedPaths, ["src/task.zig"]);
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0].exitCode, 0);
    assert.equal(existsSync(join(workspace, ".zig-cache")), false);
  } finally {
    runtimeBinding?.dispose();
    if (runtime !== undefined) await runtime.dispose();
    if (taskCheckBinding !== undefined) disposeTaskCheckBinding(taskCheckBinding);
    if (containment !== undefined) disposeExecutionContainment(containment);
    await rm(root, { recursive: true, force: true });
  }
});

test("private Zig cache normalization does not hide unrelated workspace writes", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-zig-cache-red.");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeTaskSource(workspace);
  const contract = sourceContract();
  let containment;
  let taskCheckBinding;
  let runtime;
  let runtimeBinding;
  try {
    containment = await createExecutionContainment({ workspaceRoot: workspace, contract });
    taskCheckBinding = await createTaskCheckBinding({
      contract,
      workspaceRoot: workspace,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      executionContainment: containment,
    });
    runtime = await createTransientProfileRuntime({ workspaceRoot: workspace });
    runtimeBinding = runtime.ctx.subprocess.bindExecutionContainment(containment);
    const modelBash = await runModelBash(
      runtime.ctx,
      workspace,
      "printf 'unauthorized\\n' > unrelated.txt; zig test src/task.zig",
    );
    assert.equal(modelBash.exitCode, 0, modelBash.stderr.text);
    assert.equal(existsSync(join(workspace, ".zig-cache")), false);

    const result = await runTaskCheck(taskCheckBinding, { contract, workspaceRoot: workspace });
    assert.equal(result.status, "red");
    assert.ok(result.scope.preCommands.changedPaths.includes("unrelated.txt"));
    assert.ok(
      result.scope.findings.some(
        (finding) =>
          finding.code === "outside-mutable-authority" &&
          finding.path === "unrelated.txt",
      ),
    );
    assert.equal(
      result.scope.findings.some((finding) => finding.path.startsWith(".zig-cache")),
      false,
    );
  } finally {
    runtimeBinding?.dispose();
    if (runtime !== undefined) await runtime.dispose();
    if (taskCheckBinding !== undefined) disposeTaskCheckBinding(taskCheckBinding);
    if (containment !== undefined) disposeExecutionContainment(containment);
    await rm(root, { recursive: true, force: true });
  }
});
