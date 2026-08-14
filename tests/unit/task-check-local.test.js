import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  captureWorkspaceSnapshot,
  compareWorkspaceSnapshots,
  sanitizeBaseEnvironment,
  verifyImmutableAuthority,
} from "@dsh-dsworker/task-check-local";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";

function command() {
  return {
    id: "semantic",
    executable: "true",
    argv: [],
    cwd: { kind: "workspace-root" },
    environment: {},
    timeoutMs: 1_000,
    expected: { exitCodes: [0] },
  };
}

function contractWithPaths(mutable, immutable = []) {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "snapshot-unit",
      objective: "Classify local post-state without model judgment.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: { mutable, immutable },
      commands: { semantic: [command()], validation: [], finish: [] },
      retry: { mode: "none", maxAttempts: 1 },
      terminal: {
        success: "all-authoritative-commands-pass",
        failure: "fail-closed",
      },
    },
  });
}

test("snapshots are deterministic, content-free, bounded, and deeply immutable", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-snapshot-unit.");
  try {
    await mkdir(join(root, "src", "深"), { recursive: true });
    await writeFile(join(root, "src", "深", "file.txt"), "value\n", "utf8");
    const first = await captureWorkspaceSnapshot(root);
    const second = await captureWorkspaceSnapshot(root);
    assert.equal(first.ok, true);
    assert.equal(first.snapshotSha256, second.snapshotSha256);
    assert.deepEqual(first.entries, second.entries);
    assert.equal(first.entries.some((entry) => Object.hasOwn(entry, "content")), false);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.entries), true);
    assert.throws(() => first.entries.push({}), TypeError);

    const bounded = await captureWorkspaceSnapshot(root, {
      maxEntries: 1,
      maxFileBytes: 1024,
    });
    assert.equal(bounded.ok, false);
    assert.equal(bounded.code, "entry-limit-exceeded");
    assert.deepEqual(bounded.entries, []);
    assert.equal(bounded.snapshotSha256, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scope comparison detects create, delete, content, metadata, and outside changes", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-scope-unit.");
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "exact.txt"), "old\n", "utf8");
    await writeFile(join(root, "delete.txt"), "remove\n", "utf8");
    await writeFile(join(root, "src", "old.txt"), "old\n", "utf8");
    const contract = contractWithPaths([
      { path: "exact.txt", kind: "file" },
      { path: "delete.txt", kind: "file" },
      { path: "src", kind: "directory" },
    ]);
    const baseline = await captureWorkspaceSnapshot(root);
    await writeFile(join(root, "exact.txt"), "new\n", "utf8");
    await unlink(join(root, "delete.txt"));
    await writeFile(join(root, "src", "new.txt"), "created\n", "utf8");
    const allowedPost = await captureWorkspaceSnapshot(root);
    const allowed = compareWorkspaceSnapshots(contract, baseline, allowedPost);
    assert.equal(allowed.ok, true);
    assert.deepEqual(allowed.changedPaths, [
      "delete.txt",
      "exact.txt",
      "src/new.txt",
    ]);

    await writeFile(join(root, "foo.py"), "outside\n", "utf8");
    const outsidePost = await captureWorkspaceSnapshot(root);
    const outside = compareWorkspaceSnapshots(contract, baseline, outsidePost);
    assert.equal(outside.ok, false);
    assert.ok(
      outside.findings.some(
        (finding) =>
          finding.path === "foo.py" &&
          finding.code === "outside-mutable-authority",
      ),
    );

    await chmod(join(root, "exact.txt"), 0o600);
    const metadataPost = await captureWorkspaceSnapshot(root);
    const metadata = compareWorkspaceSnapshots(contract, baseline, metadataPost);
    assert.ok(
      metadata.findings.some(
        (finding) =>
          finding.path === "exact.txt" &&
          finding.code === "file-metadata-change-unsupported",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("immutable files use baseline identity and pinned digest independently", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-immutable-unit.");
  try {
    await writeFile(join(root, "mutable.txt"), "old\n", "utf8");
    await writeFile(join(root, "authority.txt"), "authority\n", "utf8");
    const initial = await captureWorkspaceSnapshot(root);
    const digest = initial.entries.find((entry) => entry.path === "authority.txt").sha256;
    const contract = contractWithPaths(
      [{ path: "mutable.txt", kind: "file" }],
      [{ path: "authority.txt", kind: "file", sha256: digest }],
    );
    const baselineCheck = verifyImmutableAuthority(contract, initial, initial);
    assert.equal(baselineCheck.ok, true);

    await writeFile(join(root, "authority.txt"), "changed\n", "utf8");
    const changed = await captureWorkspaceSnapshot(root);
    const result = verifyImmutableAuthority(contract, initial, changed);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.code === "immutable-digest-mismatch"));
    assert.ok(result.findings.some((finding) => finding.code === "immutable-state-changed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlinks and unrepresentable separator names fail closed without traversal", async () => {
  const root = await mkdtemp("/tmp/dsh-dsworker-snapshot-adversarial.");
  try {
    await writeFile(join(root, "target"), "value\n", "utf8");
    await symlink("target", join(root, "link"));
    const symlinked = await captureWorkspaceSnapshot(root);
    assert.equal(symlinked.ok, false);
    assert.equal(symlinked.code, "symlink-unsupported");
    assert.equal(symlinked.failure.path, "link");

    await unlink(join(root, "link"));
    await writeFile(join(root, "name\\with-backslash"), "value\n", "utf8");
    const ambiguous = await captureWorkspaceSnapshot(root);
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.code, "unrepresentable-path-name");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("base environment is runner-owned and credential-shaped entries are stripped", () => {
  const sanitized = sanitizeBaseEnvironment({
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    DSH_TEST_API_KEY: "fixture-only-not-a-credential",
  });
  assert.deepEqual(sanitized.environment, {
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
  });
  assert.deepEqual(sanitized.policy.strippedCredentialKeys, ["DSH_TEST_API_KEY"]);
  assert.equal(sanitized.policy.inheritsProcessEnvironment, false);
  assert.doesNotMatch(
    JSON.stringify(sanitized),
    /fixture-only-not-a-credential/u,
  );
  assert.throws(() => {
    sanitized.environment.NEW = "value";
  }, TypeError);
});
