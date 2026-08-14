import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";
import {
  compileGuardBinding,
  evaluateMutationIntent,
  extractMutationIntent,
} from "@dsh-dsworker/plugin-path-guard";

function contract() {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "path-guard-adversarial",
      objective: "Exercise separator, prefix, Unicode, and depth boundaries.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: [
          { path: "src", kind: "directory" },
          { path: "unicode/雪/檔案.py", kind: "file" },
        ],
        immutable: [{ path: "locked", kind: "directory" }],
      },
      commands: {
        semantic: [
          {
            id: "not-executed",
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

function treeFs(existingPaths) {
  const existing = new Map(existingPaths);
  return {
    async lstat(path, options) {
      if (path === "/tmp/adversarial-root") return { type: "directory" };
      const relative = options?.cwd === "/tmp/adversarial-root" ? path : null;
      return relative === null ? undefined : existing.get(relative);
    },
    async resolve(path, options) {
      return {
        targetKey:
          path === "/tmp/adversarial-root"
            ? path
            : `${options?.cwd}/${path}`,
        displayPath: path,
      };
    },
    contains(parent, child) {
      return child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`);
    },
  };
}

async function decide(binding, fs, path) {
  return evaluateMutationIntent(
    fs,
    binding,
    extractMutationIntent({
      name: "write",
      callId: `call:${path}`,
      arguments: { file_path: path, content: "not retained" },
    }),
  );
}

test("deterministic path variants preserve TaskContract normalization", async () => {
  const binding = compileGuardBinding(contract(), "/tmp/adversarial-root");
  const fs = treeFs([
    ["src", { type: "directory" }],
    ["src/deep", { type: "directory" }],
    ["src/deep/file.js", { type: "file" }],
    ["unicode", { type: "directory" }],
    ["unicode/雪", { type: "directory" }],
    ["unicode/雪/檔案.py", { type: "file" }],
  ]);
  for (const path of [
    "src/deep/file.js",
    "src//deep/./file.js",
    "src\\deep\\file.js",
  ]) {
    const result = await decide(binding, fs, path);
    assert.equal(result.finalGuardDecision, "permit", path);
    assert.equal(result.normalizedContractPath, "src/deep/file.js");
  }
  assert.equal(
    (await decide(binding, fs, "unicode/雪/檔案.py")).finalGuardDecision,
    "permit",
  );
});

test("prefix, traversal, absolute, controls, and missing parents fail closed", async () => {
  const binding = compileGuardBinding(contract(), "/tmp/adversarial-root");
  const fs = treeFs([["src", { type: "directory" }]]);
  const cases = [
    ["src-other/file.js", "outside-mutable-authority"],
    ["src/../locked/file.js", "invalid-path"],
    ["/tmp/escape.js", "invalid-path"],
    ["C:\\escape.js", "invalid-path"],
    ["\\\\server\\share\\escape.js", "invalid-path"],
    ["src/\u0000bad.js", "invalid-path"],
    ["src/missing/deep/file.js", "implicit-parent-creation-unproven"],
  ];
  for (const [path, code] of cases) {
    const result = await decide(binding, fs, path);
    assert.equal(result.finalGuardDecision, "deny", path);
    assert.equal(result.denialCode, code, path);
  }
});

test("deep inputs and caller mutation cannot change a prepared result", async () => {
  const depth = Array.from({ length: 64 }, (_, index) => `d${index}`);
  const path = `src/${depth.join("/")}/file.js`;
  const entries = [["src", { type: "directory" }]];
  for (let index = 0; index < depth.length; index += 1) {
    entries.push([
      `src/${depth.slice(0, index + 1).join("/")}`,
      { type: "directory" },
    ]);
  }
  entries.push([path, { type: "file" }]);
  const fs = treeFs(entries);
  const binding = compileGuardBinding(contract(), "/tmp/adversarial-root");
  const args = { file_path: path, content: "one" };
  const intent = extractMutationIntent({
    name: "write",
    callId: "deep-call",
    arguments: args,
  });
  args.file_path = "locked/forged";
  args.content = "two";
  const result = await evaluateMutationIntent(fs, binding, intent);
  assert.equal(result.finalGuardDecision, "permit");
  assert.equal(result.requestedPath, path);
  assert.equal(result.filesystemBindingResult.checkedPrefixes.length, 66);
  assert.throws(() => {
    result.filesystemBindingResult.checkedPrefixes.push("forged");
  }, TypeError);
});
