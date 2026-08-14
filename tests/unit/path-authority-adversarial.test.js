import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PathAuthorityApiError,
  compilePathAuthority,
} from "@dsh-dsworker/path-authority";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";

function authorityInput() {
  return {
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "path-authority-adversarial",
      objective: "Exercise deterministic lexical path decisions.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: [
          { path: "scope", kind: "directory" },
          { path: "單一.txt", kind: "file" },
        ],
        immutable: [{ path: "locked", kind: "directory" }],
      },
      commands: {
        semantic: [
          {
            id: "not-executed",
            executable: "true",
            argv: ["literal space", "'quote'", "back\\slash", "粵語"],
            cwd: { kind: "workspace-root" },
            environment: { ALPHA: "1", ZETA: "2" },
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
  };
}

function deterministicGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

function shuffledObjectKeys(value, next) {
  if (Array.isArray(value)) return value.map((entry) => shuffledObjectKeys(entry, next));
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value);
  for (let index = keys.length - 1; index > 0; index -= 1) {
    const swap = next() % (index + 1);
    [keys[index], keys[swap]] = [keys[swap], keys[index]];
  }
  const output = {};
  for (const key of keys) output[key] = shuffledObjectKeys(value[key], next);
  return output;
}

test("64 generated lexical prefixes never confuse a sibling with a descendant", () => {
  const policy = compilePathAuthority(parseTaskContract(authorityInput()));
  const next = deterministicGenerator(0x5eed);
  const suffixAlphabet = ["-", "_", ".", "x", "資料", "🧪"];
  for (let index = 0; index < 64; index += 1) {
    const suffix = suffixAlphabet[next() % suffixAlphabet.length];
    const sibling = `scope${suffix}${next().toString(16)}/file.txt`;
    const result = policy.decide({ operation: "edit-file", path: sibling });
    assert.equal(result.decision, "deny", sibling);
    assert.equal(result.code, "outside-mutable-authority");
  }
});

test("generated separator variants and deep Unicode paths normalize deterministically", () => {
  const policy = compilePathAuthority(parseTaskContract(authorityInput()));
  const variants = [
    "scope/a/b.txt",
    "./scope//a///b.txt",
    "scope\\a\\b.txt",
    "scope/./a/./b.txt",
  ];
  const results = variants.map((path) =>
    policy.decide({ operation: "replace-file", path }),
  );
  assert.ok(results.every((result) => result.decision === "allow"));
  assert.ok(results.every((result) => result.normalizedPath === "scope/a/b.txt"));

  const deep = `scope/${Array.from({ length: 256 }, (_, index) => `層${index}`).join("/")}/🧪.txt`;
  const first = policy.decide({ operation: "create-file", path: deep });
  const second = policy.decide({ operation: "create-file", path: deep });
  assert.deepEqual(second, first);
  assert.equal(first.decision, "allow");
  assert.equal(first.normalizedPath, deep);

  const exactUnicode = policy.decide({ operation: "remove-file", path: "單一.txt" });
  assert.equal(exactUnicode.decision, "allow");
  assert.equal(exactUnicode.code, "mutable-file-exact");
});

test("empty, traversal, roots, drives, UNC, and every ASCII control fail closed", () => {
  const policy = compilePathAuthority(parseTaskContract(authorityInput()));
  const invalid = [
    "",
    ".",
    "./",
    "..",
    "../scope",
    "scope/../outside",
    "/scope/file",
    "C:/scope/file",
    "C:scope/file",
    "\\\\server\\share",
  ];
  for (let codePoint = 0; codePoint <= 31; codePoint += 1) {
    invalid.push(`scope/a${String.fromCharCode(codePoint)}b`);
  }
  invalid.push(`scope/a${String.fromCharCode(127)}b`);
  for (const path of invalid) {
    const result = policy.decide({ operation: "edit-file", path });
    assert.equal(result.decision, "deny", JSON.stringify(path));
    assert.equal(result.code, "invalid-path");
    assert.equal(result.executionAuthorized, false);
  }
});

test("48 object-key permutations compile to one deterministic debug representation", () => {
  const baselineContract = parseTaskContract(authorityInput());
  const baseline = compilePathAuthority(baselineContract);
  const expected = JSON.stringify(baseline.describe());
  for (let seed = 1; seed <= 48; seed += 1) {
    const candidateContract = parseTaskContract(
      shuffledObjectKeys(authorityInput(), deterministicGenerator(seed)),
    );
    const candidate = compilePathAuthority(candidateContract);
    assert.equal(candidate.contractSha256, baseline.contractSha256);
    assert.equal(JSON.stringify(candidate.describe()), expected);
    assert.deepEqual(
      candidate.decide({ operation: "edit-file", path: "scope/a.txt" }),
      baseline.decide({ operation: "edit-file", path: "scope/a.txt" }),
    );
  }
  assert.equal(baseline.describe(), baseline.describe());
  assert.equal(Object.hasOwn(baseline.describe(), "policySha256"), false);
});

test("caller request mutation and source-input mutation cannot change compiled policy", () => {
  const input = authorityInput();
  const contract = parseTaskContract(input);
  const policy = compilePathAuthority(contract);
  const request = { operation: "edit-file", path: "scope/file.txt" };
  const result = policy.decide(request);

  request.operation = "remove-directory";
  request.path = "locked";
  input.authority.paths.mutable[0].path = "outside";
  input.authority.paths.mutable.push({ path: "escape", kind: "directory" });

  assert.equal(result.decision, "allow");
  assert.equal(result.operation, "edit-file");
  assert.equal(result.requestedPath, "scope/file.txt");
  assert.equal(policy.rules.mutable[0].path, "scope");
  assert.equal(
    policy.decide({ operation: "edit-file", path: "escape/file" }).decision,
    "deny",
  );
});

test("request accessors, symbol keys, non-data properties, and mutable result attacks fail", () => {
  const policy = compilePathAuthority(parseTaskContract(authorityInput()));
  let getterRuns = 0;
  const accessor = { operation: "edit-file" };
  Object.defineProperty(accessor, "path", {
    enumerable: true,
    get() {
      getterRuns += 1;
      return "scope/file";
    },
  });
  assert.throws(() => policy.decide(accessor), PathAuthorityApiError);
  assert.equal(getterRuns, 0, "API validation must not invoke caller accessors");

  const symbolRequest = { operation: "edit-file", path: "scope/file" };
  symbolRequest[Symbol("hidden")] = true;
  assert.throws(() => policy.decide(symbolRequest), PathAuthorityApiError);

  const nonEnumerable = { operation: "edit-file", path: "scope/file" };
  Object.defineProperty(nonEnumerable, "hidden", { value: true });
  assert.throws(() => policy.decide(nonEnumerable), PathAuthorityApiError);

  const decision = policy.decide({ operation: "edit-file", path: "scope/file" });
  const rename = policy.decideRename({
    kind: "file",
    sourcePath: "scope/from",
    destinationPath: "scope/to",
    destinationMode: "create",
  });
  for (const mutate of [
    () => decision.pathError = { code: "forged" },
    () => decision.matchedAuthority.entry.path = "escape",
    () => rename.source.decision = "deny",
    () => rename.destination.normalizedPath = "locked",
  ]) {
    assert.throws(mutate, TypeError);
  }
});
