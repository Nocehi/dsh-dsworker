import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  captureWorkspaceSnapshot,
  compareWorkspaceSnapshots,
  sanitizeBaseEnvironment,
} from "@dsh-dsworker/task-check-local";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";

function directoryContract() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "generated-paths",
      objective: "Exercise deterministic generated workspace paths.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: [{ path: "mutable", kind: "directory" }],
        immutable: [],
      },
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

test("generated deep and Unicode changes retain deterministic ordering and authority", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-task-check-generated.");
  try {
    const contract = directoryContract();
    await mkdir(join(root, "mutable"), { recursive: true });
    const baseline = await captureWorkspaceSnapshot(root);
    const names = Array.from({ length: 32 }, (_, index) =>
      index % 2 === 0
        ? "deep/" + String(index).padStart(2, "0") + "/檔案.txt"
        : "flat-" + String(index).padStart(2, "0") + ".txt"
    );
    for (const name of [...names].reverse()) {
      const absolute = join(root, "mutable", ...name.split("/"));
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, name + "\n", "utf8");
    }
    const first = await captureWorkspaceSnapshot(root);
    const second = await captureWorkspaceSnapshot(root);
    assert.equal(first.snapshotSha256, second.snapshotSha256);
    const comparison = compareWorkspaceSnapshots(contract, baseline, first);
    assert.equal(comparison.ok, true);
    assert.deepEqual(
      comparison.changedPaths,
      [...comparison.changedPaths].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hard links, control names, and byte bounds fail without partial authority", async (t) => {
  await t.test("hard link", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-hardlink.");
    try {
      await writeFile(join(root, "one"), "same\n", "utf8");
      await link(join(root, "one"), join(root, "two"));
      const snapshot = await captureWorkspaceSnapshot(root);
      assert.equal(snapshot.ok, false);
      assert.equal(snapshot.code, "hardlink-unsupported");
      assert.deepEqual(snapshot.entries, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("control path", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-control.");
    try {
      await writeFile(join(root, "line\nbreak"), "value\n", "utf8");
      const snapshot = await captureWorkspaceSnapshot(root);
      assert.equal(snapshot.ok, false);
      assert.equal(snapshot.code, "unrepresentable-path-name");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("file bytes", async () => {
    const root = await mkdtemp("/tmp/dsh-dsworker-task-check-bytes.");
    try {
      await writeFile(join(root, "large"), "x".repeat(257), "utf8");
      const snapshot = await captureWorkspaceSnapshot(root, {
        maxEntries: 10,
        maxFileBytes: 256,
      });
      assert.equal(snapshot.ok, false);
      assert.equal(snapshot.code, "file-byte-limit-exceeded");
      assert.deepEqual(snapshot.entries, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("directory create/delete and caller ordering cannot perturb decisions", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-task-check-directory.");
  try {
    const contract = directoryContract();
    await mkdir(join(root, "mutable", "remove-me"), { recursive: true });
    await writeFile(join(root, "mutable", "remove-me", "file"), "value\n", "utf8");
    const baseline = await captureWorkspaceSnapshot(root);
    await rm(join(root, "mutable", "remove-me"), { recursive: true });
    await mkdir(join(root, "mutable", "create-me"));
    const post = await captureWorkspaceSnapshot(root);
    const result = compareWorkspaceSnapshots(contract, baseline, post);
    assert.equal(result.ok, true);
    assert.deepEqual(result.changedPaths, [
      "mutable/create-me",
      "mutable/remove-me",
      "mutable/remove-me/file",
    ]);

    const forward = sanitizeBaseEnvironment({
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      SAFE_VALUE: "one",
    });
    const reverse = sanitizeBaseEnvironment({
      SAFE_VALUE: "one",
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    });
    assert.deepEqual(forward, reverse);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
