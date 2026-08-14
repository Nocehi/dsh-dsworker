import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TASK_CONTRACT_VERSION,
  TaskContractError,
  canonicalTaskContract,
  normalizeContractPath,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";

function inputWithCommand(command = {}) {
  return {
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "generated-cases",
      objective: "Exercise deterministic adversarial cases.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: [{ path: "src/main.js", kind: "file" }],
        immutable: [{ path: "tests", kind: "directory" }],
      },
      commands: {
        semantic: [
          {
            id: "generated-command",
            executable: "runner",
            argv: [],
            cwd: { kind: "workspace-root" },
            environment: {},
            timeoutMs: 123_456,
            expected: { exitCodes: [0] },
            ...command,
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

test("deterministic path normalization accepts equivalent separator spellings", () => {
  const cases = [
    ["./src//lexer.py", "src/lexer.py"],
    ["src\\nested\\file.py", "src/nested/file.py"],
    ["a/./b/", "a/b"],
    ["資料/測試.py", "資料/測試.py"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeContractPath(input), expected);
  }
});

test("deterministic path adversaries reject roots, traversal, and ambiguity", () => {
  const invalid = [
    "",
    ".",
    "./",
    "../outside",
    "a/../outside",
    "/etc/passwd",
    "C:\\temp\\file",
    "C:relative",
    "\\\\server\\share",
    "a\u0000b",
  ];
  for (const path of invalid) {
    assert.throws(() => normalizeContractPath(path), TaskContractError, path);
  }
});

test("48 deterministic object-key permutations retain canonical bytes and digest", () => {
  const baseline = parseTaskContract(inputWithCommand({
    environment: { ZETA: "last", ALPHA: "first", MIDDLE: "middle" },
    expected: { exitCodes: [7, 0, 2] },
  }));
  for (let seed = 1; seed <= 48; seed += 1) {
    const candidate = parseTaskContract(
      shuffledObjectKeys(inputWithCommand({
        environment: { MIDDLE: "middle", ZETA: "last", ALPHA: "first" },
        expected: { exitCodes: [2, 7, 0] },
      }), deterministicGenerator(seed)),
    );
    assert.equal(canonicalTaskContract(candidate), canonicalTaskContract(baseline));
    assert.equal(candidate.contractSha256, baseline.contractSha256);
  }
});

test("path-set order and objective newline convention normalize semantically", () => {
  const left = inputWithCommand();
  left.authority.objective = "First line\r\nSecond line\rThird line";
  left.authority.paths.mutable = [
    { path: "src/z.js", kind: "file" },
    { path: "./src//a.js", kind: "file" },
  ];
  left.authority.paths.immutable = [
    { path: "tests/z.test.js", kind: "file" },
    { path: "tests\\a.test.js", kind: "file" },
  ];
  const right = inputWithCommand();
  right.authority.objective = "First line\nSecond line\nThird line";
  right.authority.paths.mutable = [
    { path: "src/a.js", kind: "file" },
    { path: "src/z.js", kind: "file" },
  ];
  right.authority.paths.immutable = [
    { path: "tests/a.test.js", kind: "file" },
    { path: "tests/z.test.js", kind: "file" },
  ];
  const leftContract = parseTaskContract(left);
  const rightContract = parseTaskContract(right);
  assert.equal(leftContract.contractSha256, rightContract.contractSha256);
  assert.equal(canonicalTaskContract(leftContract), canonicalTaskContract(rightContract));
});

test("argv values preserve empty, whitespace, quotes, slashes, newlines, and Unicode", () => {
  const argv = [
    "",
    " ",
    "two words",
    "\"quoted\"",
    "back\\slash",
    "line\nbreak",
    "粵語",
    "🧪",
  ];
  const contract = parseTaskContract(inputWithCommand({ argv }));
  assert.deepEqual(contract.authority.commands.semantic[0].argv, argv);
});

test("environment insertion order is canonical across deterministic rotations", () => {
  const entries = [
    ["ALPHA", "1"],
    ["BETA", "two words"],
    ["GAMMA", "\\quoted\""],
    ["UNICODE", "測試"],
  ];
  const baseline = parseTaskContract(
    inputWithCommand({ environment: Object.fromEntries(entries) }),
  );
  for (let offset = 0; offset < entries.length * 6; offset += 1) {
    const rotated = entries.map((_, index) => entries[(index + offset) % entries.length]);
    const candidate = parseTaskContract(
      inputWithCommand({ environment: Object.fromEntries(rotated) }),
    );
    assert.equal(candidate.contractSha256, baseline.contractSha256);
  }
});

test("representative nested mutation attempts all fail loudly", () => {
  const input = inputWithCommand({ environment: { FIXED: "yes" }, argv: ["a", "b"] });
  input.metadata = { nested: { list: [1, 2, 3] } };
  const contract = parseTaskContract(input);
  const mutations = [
    () => contract.authority.paths.mutable.splice(0, 1),
    () => contract.authority.paths.mutable[0].path = "elsewhere",
    () => contract.authority.commands.semantic.push({}),
    () => contract.authority.commands.semantic[0].argv.push("c"),
    () => contract.authority.commands.semantic[0].environment.FIXED = "no",
    () => contract.authority.commands.semantic[0].expected.exitCodes.push(1),
    () => contract.metadata.nested.list.pop(),
  ];
  for (const mutate of mutations) assert.throws(mutate, TypeError);
});
