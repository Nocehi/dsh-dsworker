import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  ExecutionContainmentApiError,
  ExecutionContainmentExecutionError,
  ExecutionContainmentUnavailableError,
  assertExecutionContainmentWorkspace,
  containmentDisposition,
  createExecutionContainment,
  disposeExecutionContainment,
  isExecutionContainment,
  prepareContainedExecution,
} from "@dsh-dsworker/execution-containment";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";

async function fixture(prefix = "unit") {
  return mkdtemp(`/tmp/dsh-dsworker-containment-${prefix}.`);
}

function immutableGitContract() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "containment-immutable-git",
      objective: "Keep exact Git metadata immutable during subprocess execution.",
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

function argvTripleIndex(argv, first, second, third) {
  for (let index = 0; index < argv.length - 2; index += 1) {
    if (
      argv[index] === first &&
      argv[index + 1] === second &&
      argv[index + 2] === third
    ) {
      return index;
    }
  }
  return -1;
}

test("genuine containment compiles an immutable deterministic Linux boundary", async () => {
  const root = await fixture("identity");
  try {
    const containment = await createExecutionContainment({ workspaceRoot: root });
    assert.equal(isExecutionContainment(containment), true);
    assert.equal(isExecutionContainment(structuredClone(containment)), false);
    assert.equal(Object.isFrozen(containment), true);
    assert.equal(assertExecutionContainmentWorkspace(containment, root), true);

    const disposition = containmentDisposition(containment);
    assert.equal(disposition.status, "ready");
    assert.equal(disposition.backend, "bubblewrap");
    assert.equal(disposition.platform, "linux");
    assert.match(disposition.backendVersion, /^\d+(?:\.\d+)+$/u);
    assert.equal(disposition.boundaries.network, "private-network-namespace-no-host-network");
    assert.equal(disposition.boundaries.processes, "private-pid-namespace-managed-wrapper-tree");
    assert.equal(Object.isFrozen(disposition), true);
    assert.equal(Object.isFrozen(disposition.boundaries), true);
    assert.throws(() => {
      disposition.boundaries.network = "host";
    }, TypeError);

    const prepared = prepareContainedExecution(containment, {
      argv: ["true"],
      cwd: root,
      environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    assert.equal(prepared.argv[0], "/usr/bin/bwrap");
    assert.ok(prepared.argv.includes("--unshare-net"));
    assert.ok(prepared.argv.includes("--unshare-pid"));
    assert.ok(prepared.argv.includes("--unshare-cgroup"));
    assert.ok(prepared.argv.includes("--cap-drop"));
    assert.ok(prepared.argv.includes("--clearenv"));
    assert.ok(prepared.argv.includes("/opt/dsh-tools/rg"));
    assert.deepEqual(disposition.boundaries.packagedToolExecutables, [
      "/opt/dsh-tools/rg",
    ]);
    assert.equal(prepared.sandboxCwd, root);
    assert.deepEqual(prepared.environment, {});
    assert.equal(Object.isFrozen(prepared.argv), true);

    disposeExecutionContainment(containment);
    disposeExecutionContainment(containment);
    assert.equal(containmentDisposition(containment).status, "disposed");
    assert.throws(
      () =>
        prepareContainedExecution(containment, {
          argv: ["true"],
          cwd: root,
          environment: {},
        }),
      (error) =>
        error instanceof ExecutionContainmentExecutionError &&
        error.code === "containment-disposed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment is explicit, credential-shaped values are absent, and argv is structural", async () => {
  const root = await fixture("environment");
  const secret = "fixture-secret-value-never-serialize";
  try {
    const containment = await createExecutionContainment({ workspaceRoot: root });
    const argv = ["node", "-e", "process.exit(0)", "", "two words", "\\", "廣東話"];
    const prepared = prepareContainedExecution(containment, {
      argv,
      cwd: root,
      environment: {
        PATH: "/usr/bin:/bin",
        GIT_OPTIONAL_LOCKS: "1",
        ZIG_GLOBAL_CACHE_DIR: "/workspace/.zig-cache/global",
        ZIG_LOCAL_CACHE_DIR: "/workspace/.zig-cache/local",
        DSH_TEST_API_KEY: secret,
        LITERAL: "space quote \" slash \\ unicode 廣",
      },
    });
    assert.deepEqual(prepared.strippedCredentialKeys, ["DSH_TEST_API_KEY"]);
    assert.doesNotMatch(JSON.stringify(prepared), new RegExp(secret, "u"));
    assert.doesNotMatch(JSON.stringify(containmentDisposition(containment)), new RegExp(secret, "u"));
    assert.ok(prepared.argv.includes(""));
    assert.ok(prepared.argv.includes("two words"));
    assert.ok(prepared.argv.includes("廣東話"));
    const optionalLocks = [];
    for (let index = 0; index < prepared.argv.length - 2; index += 1) {
      if (
        prepared.argv[index] === "--setenv" &&
        prepared.argv[index + 1] === "GIT_OPTIONAL_LOCKS"
      ) {
        optionalLocks.push(prepared.argv[index + 2]);
      }
    }
    assert.deepEqual(optionalLocks, ["0"]);
    const forcedEnvironment = Object.fromEntries(
      prepared.argv.flatMap((entry, index, argv) =>
        entry === "--setenv" &&
        ["ZIG_GLOBAL_CACHE_DIR", "ZIG_LOCAL_CACHE_DIR"].includes(argv[index + 1])
          ? [[argv[index + 1], argv[index + 2]]]
          : [],
      ),
    );
    assert.deepEqual(forcedEnvironment, {
      ZIG_GLOBAL_CACHE_DIR: "/tmp/zig-cache/global",
      ZIG_LOCAL_CACHE_DIR: "/tmp/zig-cache/local",
    });
    assert.equal(containmentDisposition(containment).strippedCredentialKeys[0], "DSH_TEST_API_KEY");
    disposeExecutionContainment(containment);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("immutable .git overlay follows each workspace RW bind and retains contract identity", async () => {
  const root = await fixture("immutable-git");
  await mkdir(join(root, ".git"));
  const contract = immutableGitContract();
  try {
    const containment = await createExecutionContainment({
      workspaceRoot: root,
      contract,
    });
    const prepared = prepareContainedExecution(containment, {
      argv: ["true"],
      cwd: root,
      environment: {},
    });
    const nativeBind = argvTripleIndex(prepared.argv, "--bind", root, root);
    const nativeOverlay = argvTripleIndex(
      prepared.argv,
      "--ro-bind",
      join(root, ".git"),
      join(root, ".git"),
    );
    const aliasBind = argvTripleIndex(
      prepared.argv,
      "--bind",
      root,
      "/workspace",
    );
    const aliasOverlay = argvTripleIndex(
      prepared.argv,
      "--ro-bind",
      join(root, ".git"),
      "/workspace/.git",
    );
    assert.ok(nativeBind >= 0);
    assert.ok(nativeOverlay > nativeBind);
    assert.ok(aliasBind > nativeOverlay);
    assert.ok(aliasOverlay > aliasBind);

    const disposition = containmentDisposition(containment);
    assert.deepEqual(disposition.boundaries.immutableGit, {
      status: "read-only",
      contractSha256: contract.contractSha256,
      path: ".git",
      kind: "directory",
      mountTargets: ["workspace-native/.git", "/workspace/.git"],
    });
    assert.equal(Object.isFrozen(disposition.boundaries.immutableGit), true);
    disposeExecutionContainment(containment);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("declared but absent .git stays absent and a TaskContract lookalike is rejected", async () => {
  const root = await fixture("immutable-git-absent");
  const contract = immutableGitContract();
  try {
    await assert.rejects(
      createExecutionContainment({
        workspaceRoot: root,
        contract: structuredClone(contract),
      }),
      (error) =>
        error instanceof ExecutionContainmentApiError &&
        error.code === "unparsed-task-contract",
    );
    const containment = await createExecutionContainment({
      workspaceRoot: root,
      contract,
    });
    assert.equal(existsSync(join(root, ".git")), false);
    assert.deepEqual(containmentDisposition(containment).boundaries.immutableGit, {
      status: "declared-absent",
      contractSha256: contract.contractSha256,
      path: null,
      kind: "directory",
      mountTargets: [],
    });
    disposeExecutionContainment(containment);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("contract-declared immutable .git symlink fails containment setup closed", async () => {
  const root = await fixture("immutable-git-symlink");
  const contract = immutableGitContract();
  try {
    await symlink("missing-git-target", join(root, ".git"));
    await assert.rejects(
      createExecutionContainment({ workspaceRoot: root, contract }),
      (error) =>
        error instanceof ExecutionContainmentUnavailableError &&
        error.code === "immutable-git-unsupported-node",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace and execution requests fail closed without structural lookalikes", async () => {
  const first = await fixture("first");
  const second = await fixture("second");
  try {
    const containment = await createExecutionContainment({ workspaceRoot: first });
    assert.throws(
      () => assertExecutionContainmentWorkspace(containment, second),
      (error) =>
        error instanceof ExecutionContainmentApiError &&
        error.code === "containment-workspace-mismatch",
    );
    assert.throws(
      () =>
        prepareContainedExecution(structuredClone(containment), {
          argv: ["true"],
          cwd: first,
          environment: {},
        }),
      (error) =>
        error instanceof ExecutionContainmentApiError &&
        error.code === "invalid-containment",
    );
    for (const cwd of [second, "/", join(first, "..")]) {
      assert.throws(
        () =>
          prepareContainedExecution(containment, {
            argv: ["true"],
            cwd,
            environment: {},
          }),
        (error) =>
          error instanceof ExecutionContainmentExecutionError &&
          error.code === "cwd-outside-workspace",
      );
    }
    assert.throws(
      () =>
        prepareContainedExecution(containment, {
          argv: ["/home/example-user/tool"],
          cwd: first,
          environment: {},
        }),
      (error) =>
        error instanceof ExecutionContainmentExecutionError &&
        error.code === "absolute-executable-outside-execution-world",
    );
    disposeExecutionContainment(containment);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("Linux v1 refuses a non-disposable workspace instead of weakening containment", async () => {
  await assert.rejects(
    () => createExecutionContainment({ workspaceRoot: "/home/example-user" }),
    (error) =>
      error instanceof ExecutionContainmentUnavailableError &&
      error.code === "workspace-not-disposable-tmp",
  );
});
