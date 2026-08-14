import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  TaskCheckLocalConfigurationError,
  createTaskCheckBinding,
  disposeTaskCheckBinding,
  runTaskCheck,
} from "@dsh-dsworker/task-check-local";
import { isTaskCheckResult } from "@dsh-dsworker/task-check-core";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";
import {
  TASK_CHECK_FIXTURE_ROOT,
  TEST_BASE_ENVIRONMENT,
  loadPythonArgvLexerContract,
  materializePythonArgvLexer,
} from "../helpers/task-check-fixtures.mjs";

function structuralCommand({
  id = "check",
  executable = "true",
  argv = [],
  environment = {},
  timeoutMs = 1_000,
  exitCodes = [0],
  cwd = { kind: "workspace-root" },
} = {}) {
  return {
    id,
    executable,
    argv,
    cwd,
    environment,
    timeoutMs,
    expected: { exitCodes },
  };
}

function localContract({
  taskId = "local-check",
  mutable = [{ path: "main.txt", kind: "file" }],
  immutable = [],
  semantic = [structuralCommand({ id: "semantic" })],
  validation = [],
  finish = [],
} = {}) {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId,
      objective: "Exercise deterministic host-side task checking.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: { mutable, immutable },
      commands: { semantic, validation, finish },
      retry: { mode: "none", maxAttempts: 1 },
      terminal: {
        success: "all-authoritative-commands-pass",
        failure: "fail-closed",
      },
    },
  });
}

async function createBinding(root, contract, options = {}) {
  return createTaskCheckBinding({
    contract,
    workspaceRoot: root,
    baseEnvironment: {
      ...TEST_BASE_ENVIRONMENT,
      ...(options.baseEnvironment ?? {}),
    },
    snapshotLimits: options.snapshotLimits,
    maxOutputBytes: options.maxOutputBytes,
    terminationGraceMs: options.terminationGraceMs ?? 50,
  });
}

async function runAndDispose(binding, contract, root, signal) {
  try {
    return await runTaskCheck(binding, {
      contract,
      workspaceRoot: root,
      signal,
    });
  } finally {
    disposeTaskCheckBinding(binding);
  }
}

test("python-argv-lexer reaches real deterministic GREEN through all phases", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-task-check-green.");
  try {
    const contract = await loadPythonArgvLexerContract();
    await materializePythonArgvLexer(root, "initial");
    const binding = await createBinding(root, contract);
    assert.equal(binding.contract, contract);
    assert.equal(
      binding.contractSha256,
      "0a2105c759dd690ac86403838029a75f848f71410bafe5e8cbf7930da7e835b6",
    );
    assert.equal(binding.baseline.ok, true);
    await copyFile(
      join(TASK_CHECK_FIXTURE_ROOT, "lexer.green.py"),
      join(root, "lexer.py"),
    );
    const result = await runTaskCheck(binding, {
      contract,
      workspaceRoot: root,
    });
    assert.equal(isTaskCheckResult(result), true);
    assert.equal(result.status, "green");
    assert.equal(result.contract, contract);
    assert.equal(result.contractSha256, contract.contractSha256);
    assert.deepEqual(
      result.commands.map((command) => [command.phase, command.commandId, command.passed]),
      [
        ["semantic", "semantic-focused-test", true],
        ["validation", "validation-focused-test", true],
        ["finish", "finish-python-compile", true],
      ],
    );
    assert.deepEqual(result.scope.postCommands.changedPaths, ["lexer.py"]);
    assert.equal(result.scope.ok, true);
    assert.equal(result.immutable.ok, true);
    assert.equal(result.commands.every((command) => command.stdoutExcerpt === null), true);
    assert.equal(result.commands.every((command) => command.stderrExcerpt === null), true);
    assert.equal((await readdir(root)).includes("__pycache__"), false);
    assert.throws(() => result.commands.push({}), TypeError);
    await assert.rejects(
      () => runTaskCheck(binding, { contract, workspaceRoot: root }),
      (error) =>
        error instanceof TaskCheckLocalConfigurationError &&
        error.code === "task-check-already-started",
    );
    disposeTaskCheckBinding(binding);

    const rebound = await createBinding(root, contract);
    disposeTaskCheckBinding(rebound);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic, validation, finish, exit-set, spawn, timeout, and output failures are typed", async (t) => {
  await t.test("semantic failure", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-semantic.");
    try {
      const contract = await loadPythonArgvLexerContract();
      await materializePythonArgvLexer(root, "initial");
      const result = await runAndDispose(
        await createBinding(root, contract),
        contract,
        root,
      );
      assert.equal(result.status, "red");
      assert.equal(result.commands[0].phase, "semantic");
      assert.equal(result.commands[0].passed, false);
      assert.equal(result.commands[0].exitCode, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("independent validation failure and phase ordering", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-validation.");
    try {
      const contract = localContract({
        taskId: "validation-red",
        semantic: [structuralCommand({ id: "semantic" })],
        validation: [
          structuralCommand({
            id: "validation",
            executable: "node",
            argv: ["-e", "process.exit(9)"],
          }),
        ],
        finish: [structuralCommand({ id: "finish" })],
      });
      const result = await runAndDispose(
        await createBinding(root, contract),
        contract,
        root,
      );
      assert.equal(result.status, "red");
      assert.deepEqual(
        result.commands.map((command) => command.phase),
        ["semantic", "validation", "finish"],
      );
      assert.equal(result.commands[0].passed, true);
      assert.equal(result.commands[1].exitCode, 9);
      assert.equal(result.commands[1].passed, false);
      assert.equal(result.commands[2].passed, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("finish syntax failure", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-finish.");
    try {
      await writeFile(join(root, "bad.py"), "def broken(:\n", "utf8");
      const contract = localContract({
        taskId: "finish-red",
        mutable: [{ path: "bad.py", kind: "file" }],
        finish: [
          structuralCommand({
            id: "finish",
            executable: "python3",
            argv: [
              "-c",
              "from pathlib import Path; compile(Path('bad.py').read_text(encoding='utf-8'), 'bad.py', 'exec')",
            ],
          }),
        ],
      });
      const result = await runAndDispose(
        await createBinding(root, contract),
        contract,
        root,
      );
      assert.equal(result.status, "red");
      assert.equal(result.commands.at(-1).phase, "finish");
      assert.equal(result.commands.at(-1).passed, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("unexpected and explicitly expected exit codes", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-exit.");
    try {
      const redContract = localContract({
        taskId: "unexpected-exit",
        semantic: [
          structuralCommand({
            id: "semantic",
            executable: "node",
            argv: ["-e", "process.exit(7)"],
          }),
        ],
      });
      const red = await runAndDispose(
        await createBinding(root, redContract),
        redContract,
        root,
      );
      assert.equal(red.status, "red");
      assert.ok(red.failures.some((failure) => failure.code === "unexpected-exit-code"));

      const greenContract = localContract({
        taskId: "expected-exit",
        semantic: [
          structuralCommand({
            id: "semantic",
            executable: "node",
            argv: ["-e", "process.exit(7)"],
            exitCodes: [7],
          }),
        ],
      });
      const green = await runAndDispose(
        await createBinding(root, greenContract),
        greenContract,
        root,
      );
      assert.equal(green.status, "green");
      assert.equal(green.commands[0].passed, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("spawn failure", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-spawn.");
    try {
      const contract = localContract({
        taskId: "spawn-red",
        semantic: [
          structuralCommand({
            id: "semantic",
            executable: "definitely-not-a-real-dsh-dsworker-command",
          }),
        ],
      });
      const result = await runAndDispose(
        await createBinding(root, contract),
        contract,
        root,
      );
      assert.equal(result.status, "red");
      assert.equal(result.commands[0].spawnError, "ENOENT");
      assert.ok(result.failures.some((failure) => failure.code === "command-spawn-failure"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("timeout terminates execution", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-timeout.");
    try {
      const contract = localContract({
        taskId: "timeout-red",
        semantic: [
          structuralCommand({
            id: "semantic",
            executable: "node",
            argv: ["-e", "setTimeout(() => {}, 5000)"],
            timeoutMs: 30,
          }),
        ],
      });
      const started = Date.now();
      const result = await runAndDispose(
        await createBinding(root, contract),
        contract,
        root,
      );
      assert.equal(result.status, "red");
      assert.equal(result.commands[0].timedOut, true);
      assert.ok(Date.now() - started < 2_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("bounded output fails closed without retaining text", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-output.");
    try {
      const contract = localContract({
        taskId: "output-red",
        semantic: [
          structuralCommand({
            id: "semantic",
            executable: "node",
            argv: ["-e", "process.stdout.write('x'.repeat(4096))"],
          }),
        ],
      });
      const result = await runAndDispose(
        await createBinding(root, contract, { maxOutputBytes: 64 }),
        contract,
        root,
      );
      assert.equal(result.status, "red");
      assert.equal(result.commands[0].outputLimitExceeded, true);
      assert.equal(result.commands[0].stdoutBytes, 64);
      assert.equal(result.commands[0].stdoutExcerpt, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("AbortSignal yields ABORTED and leaves no continuing fixture mutation", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-task-check-cancel.");
  try {
    const contract = localContract({
      taskId: "cancelled",
      semantic: [
        structuralCommand({
          id: "semantic",
          executable: "node",
          argv: [
            "-e",
            "const c=require('node:child_process');c.spawn('bash',['-c','sleep 0.25; printf late > late.txt'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)",
          ],
          timeoutMs: 10_000,
        }),
      ],
    });
    const controller = new AbortController();
    const binding = await createBinding(root, contract);
    const running = runTaskCheck(binding, {
      contract,
      workspaceRoot: root,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort("test-cancel"), 30);
    const result = await running;
    disposeTaskCheckBinding(binding);
    assert.equal(result.status, "aborted");
    assert.equal(result.commands[0].aborted, true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 450));
    assert.equal((await readdir(root)).includes("late.txt"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("argv and sanitized environment arrive structurally without shell parsing", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-task-check-argv.");
  try {
    const expected = ["", "two words", "\"quoted\"", "back\\slash", "廣東話"];
    const script =
      "const want=" +
      JSON.stringify(expected) +
      ";const got=process.argv.slice(1);" +
      "if(JSON.stringify(got)!==JSON.stringify(want))process.exit(41);" +
      "if(process.env.DSH_TEST_API_KEY!==undefined)process.exit(42);";
    const contract = localContract({
      taskId: "argv-preserved",
      semantic: [
        structuralCommand({
          id: "semantic",
          executable: "node",
          argv: ["-e", script, ...expected],
          environment: { TASK_CHECK_LITERAL: "space quote \" slash \\ unicode 廣" },
        }),
      ],
    });
    const result = await runAndDispose(
      await createBinding(root, contract, {
        baseEnvironment: {
          DSH_TEST_API_KEY: "fixture-only-not-a-credential",
        },
      }),
      contract,
      root,
    );
    assert.equal(result.status, "green");
    assert.equal(result.commands[0].exitCode, 0);
    assert.equal(result.commands[0].passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scope and immutable post-state failures are deterministic and model-free", async (t) => {
  await t.test("immutable modified and deleted", async () => {
    for (const mode of ["modified", "deleted"]) {
      const root = await mkdtemp("/tmp/dsh-dsworker-task-check-immutable-" + mode + ".");
      try {
        const contract = await loadPythonArgvLexerContract();
        await materializePythonArgvLexer(root, "initial");
        const binding = await createBinding(root, contract);
        if (mode === "modified") {
          await writeFile(join(root, "test_lexer.py"), "changed\n", "utf8");
        } else {
          await unlink(join(root, "test_lexer.py"));
        }
        const result = await runAndDispose(binding, contract, root);
        assert.equal(result.status, "red");
        assert.equal(result.commands.length, 0);
        assert.equal(result.immutable.preCommands.ok, false);
        assert.ok(
          result.failures.some((failure) => failure.category === "immutable"),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  await t.test("unrelated created and unrelated modified before commands", async () => {
    for (const mode of ["created", "modified"]) {
      const root = await mkdtemp("/tmp/dsh-dsworker-task-check-outside-" + mode + ".");
      try {
        await writeFile(join(root, "main.txt"), "main\n", "utf8");
        if (mode === "modified") await writeFile(join(root, "notes.txt"), "old\n", "utf8");
        const contract = localContract();
        const binding = await createBinding(root, contract);
        if (mode === "created") {
          await writeFile(join(root, "foo.py"), "outside\n", "utf8");
        } else {
          await writeFile(join(root, "notes.txt"), "new\n", "utf8");
        }
        const result = await runAndDispose(binding, contract, root);
        assert.equal(result.status, "red");
        assert.equal(result.commands.length, 0);
        assert.equal(result.scope.preCommands.ok, false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  await t.test("authoritative command creates unauthorized artifact", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-command-side-effect.");
    try {
      await writeFile(join(root, "main.txt"), "main\n", "utf8");
      const contract = localContract({
        taskId: "command-side-effect",
        semantic: [
          structuralCommand({
            id: "semantic",
            executable: "node",
            argv: [
              "-e",
              "require('node:fs').writeFileSync('foo.py', 'unauthorized\\n')",
            ],
          }),
        ],
      });
      const result = await runAndDispose(
        await createBinding(root, contract),
        contract,
        root,
      );
      assert.equal(result.commands[0].passed, true);
      assert.equal(result.status, "red");
      assert.ok(result.scope.postCommands.changedPaths.includes("foo.py"));
      assert.ok(
        result.failures.some(
          (failure) =>
            failure.category === "scope" &&
            failure.path === "foo.py",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("symlink and baseline/post snapshot limits become terminal RED", async (t) => {
  await t.test("unsupported symlink baseline", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-symlink.");
    try {
      await writeFile(join(root, "main.txt"), "main\n", "utf8");
      await symlink("main.txt", join(root, "alias"));
      const contract = localContract();
      const result = await runAndDispose(
        await createBinding(root, contract),
        contract,
        root,
      );
      assert.equal(result.status, "red");
      assert.equal(result.baseline.code, "symlink-unsupported");
      assert.equal(result.commands.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("baseline entry bound", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-baseline-bound.");
    try {
      await writeFile(join(root, "one"), "1", "utf8");
      await writeFile(join(root, "two"), "2", "utf8");
      const contract = localContract({
        taskId: "baseline-bound",
        mutable: [{ path: "one", kind: "file" }],
      });
      const result = await runAndDispose(
        await createBinding(root, contract, {
          snapshotLimits: { maxEntries: 1, maxFileBytes: 1024 },
        }),
        contract,
        root,
      );
      assert.equal(result.status, "red");
      assert.equal(result.baseline.code, "entry-limit-exceeded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("post-command entry bound", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-post-bound.");
    try {
      const contract = localContract({
        taskId: "post-bound",
        mutable: [{ path: "out", kind: "directory" }],
        semantic: [
          structuralCommand({
            id: "semantic",
            executable: "node",
            argv: [
              "-e",
              "const f=require('node:fs');f.mkdirSync('out');f.writeFileSync('out/a','a');f.writeFileSync('out/b','b')",
            ],
          }),
        ],
      });
      const result = await runAndDispose(
        await createBinding(root, contract, {
          snapshotLimits: { maxEntries: 2, maxFileBytes: 1024 },
        }),
        contract,
        root,
      );
      assert.equal(result.commands[0].passed, true);
      assert.equal(result.status, "red");
      assert.equal(result.postCommands.code, "entry-limit-exceeded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("binding identity, workspace identity, conflicting initialization, and disposal fail closed", async () => {
  const firstRoot = await mkdtemp("/tmp/dsh-dsworker-task-check-binding-a.");
  const secondRoot = await mkdtemp("/tmp/dsh-dsworker-task-check-binding-b.");
  try {
    const contract = localContract({ taskId: "binding-one" });
    const otherContract = localContract({ taskId: "binding-two" });
    await assert.rejects(
      () =>
        createTaskCheckBinding({
          contract: structuredClone(contract),
          workspaceRoot: firstRoot,
          baseEnvironment: TEST_BASE_ENVIRONMENT,
        }),
      (error) =>
        error instanceof TaskCheckLocalConfigurationError &&
        error.code === "unparsed-task-contract",
    );

    const binding = await createBinding(firstRoot, contract);
    await assert.rejects(
      () => createBinding(firstRoot, contract),
      (error) =>
        error instanceof TaskCheckLocalConfigurationError &&
        error.code === "workspace-already-bound",
    );
    const wrongContractResult = await runTaskCheck(binding, {
      contract: otherContract,
      workspaceRoot: firstRoot,
    });
    assert.equal(wrongContractResult.status, "red");
    assert.ok(
      wrongContractResult.failures.some(
        (failure) => failure.code === "task-contract-identity-mismatch",
      ),
    );
    disposeTaskCheckBinding(binding);

    const workspaceBinding = await createBinding(firstRoot, contract);
    const wrongWorkspaceResult = await runTaskCheck(workspaceBinding, {
      contract,
      workspaceRoot: secondRoot,
    });
    assert.equal(wrongWorkspaceResult.status, "red");
    assert.ok(
      wrongWorkspaceResult.failures.some(
        (failure) => failure.code === "workspace-binding-mismatch",
      ),
    );
    disposeTaskCheckBinding(workspaceBinding);
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});
