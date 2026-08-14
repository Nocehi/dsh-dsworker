import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  TASK_CONTRACT_VERSION,
  TaskContractParseError,
  TaskContractSemanticError,
  TaskContractUnsupportedError,
  canonicalTaskContract,
  canonicalTaskContractBytes,
  isTaskContract,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";
import { REPO_ROOT } from "../../scripts/local-resolution.mjs";

const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "task-contract");

function minimalInput() {
  return {
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "minimal",
      objective: "Make the smallest verified change.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: [{ path: "main.js", kind: "file" }],
        immutable: [],
      },
      commands: {
        semantic: [
          {
            id: "semantic-check",
            executable: "node",
            argv: ["--check", "main.js"],
            cwd: { kind: "workspace-root" },
            environment: {},
            timeoutMs: 30_000,
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

function clone(value) {
  return structuredClone(value);
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).reverse()) {
    output[key] = reverseObjectKeys(value[key]);
  }
  return output;
}

function expectError(action, ErrorClass, category, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof ErrorClass);
    assert.equal(error.category, category);
    assert.equal(error.code, code);
    assert.match(error.path, /^\$/u);
    return true;
  });
}

test("valid minimal contract is normalized, identified, and deeply immutable", () => {
  const input = minimalInput();
  const contract = parseTaskContract(input);

  assert.equal(isTaskContract(contract), true);
  assert.equal(parseTaskContract(contract), contract);
  assert.match(contract.contractSha256, /^[a-f0-9]{64}$/u);
  assert.equal(contract.authority.retry.maxAttempts, 1);
  assert.equal(contract.authority.retry.mode, "none");
  assert.deepEqual(contract.metadata, {});
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.authority.paths.mutable), true);
  assert.equal(Object.isFrozen(contract.authority.commands.semantic[0].argv), true);
  assert.equal(
    Object.isFrozen(contract.authority.commands.semantic[0].environment),
    true,
  );

  assert.throws(() => {
    contract.authority.objective = "mutated";
  }, TypeError);
  assert.throws(() => {
    contract.authority.paths.mutable.push({ path: "extra", kind: "file" });
  }, TypeError);
  assert.throws(() => {
    contract.authority.commands.semantic[0].argv[0] = "--eval";
  }, TypeError);
  assert.throws(() => {
    contract.authority.commands.semantic[0].environment.NEW = "value";
  }, TypeError);

  input.authority.paths.mutable[0].path = "caller-mutated.js";
  input.authority.commands.semantic[0].argv.push("caller-mutation");
  assert.equal(contract.authority.paths.mutable[0].path, "main.js");
  assert.deepEqual(contract.authority.commands.semantic[0].argv, [
    "--check",
    "main.js",
  ]);
});

test("python-argv-lexer donor semantics map without a runtime dependency", async () => {
  const input = JSON.parse(
    await readFile(join(FIXTURE_DIR, "python-argv-lexer.input.json"), "utf8"),
  );
  const contract = parseTaskContract(input);
  const { authority } = contract;

  assert.equal(authority.taskId, "python-argv-lexer");
  assert.match(authority.objective, /quoted spans and explicit empty arguments/u);
  assert.deepEqual(authority.paths.mutable, [{ path: "lexer.py", kind: "file" }]);
  assert.deepEqual(authority.paths.immutable, [
    {
      path: "test_lexer.py",
      kind: "file",
      sha256: "1e731f05e4aa54af2b39e44d29395094eb8737d3a607b5d4563f1bc0bd64015d",
    },
  ]);
  assert.deepEqual(authority.commands.semantic[0], {
    id: "semantic-focused-test",
    executable: "python3",
    argv: ["-m", "unittest", "-v", "test_lexer.py"],
    cwd: { kind: "workspace-root" },
    environment: { PYTHONDONTWRITEBYTECODE: "1" },
    timeoutMs: 60_000,
    expected: { exitCodes: [0] },
  });
  assert.deepEqual(
    authority.commands.validation[0].argv,
    authority.commands.semantic[0].argv,
  );
  assert.deepEqual(authority.commands.validation[0].environment, {
    PYTHONDONTWRITEBYTECODE: "1",
  });
  assert.deepEqual(authority.commands.finish[0].argv, [
    "-c",
    "from pathlib import Path; [compile(Path(p).read_text(encoding='utf-8'), p, 'exec') for p in ('lexer.py', 'test_lexer.py')]",
  ]);
  assert.deepEqual(authority.commands.finish[0].environment, {});
  assert.deepEqual(authority.retry, { mode: "none", maxAttempts: 1 });
});

test("canonical bytes and SHA-256 match golden donor fixtures", async () => {
  const input = JSON.parse(
    await readFile(join(FIXTURE_DIR, "python-argv-lexer.input.json"), "utf8"),
  );
  const contract = parseTaskContract(input);
  const canonical = canonicalTaskContract(contract);
  const goldenCanonical = await readFile(
    join(FIXTURE_DIR, "python-argv-lexer.canonical.json"),
    "utf8",
  );
  const goldenSha256 = await readFile(
    join(FIXTURE_DIR, "python-argv-lexer.sha256"),
    "utf8",
  );

  assert.equal(goldenCanonical, `${canonical}\n`);
  assert.equal(goldenSha256, `${contract.contractSha256}\n`);
  assert.deepEqual(canonicalTaskContractBytes(contract), Buffer.from(canonical, "utf8"));
});

test("object insertion order does not affect canonical bytes or identity", () => {
  const forward = parseTaskContract(minimalInput());
  const reversed = parseTaskContract(reverseObjectKeys(minimalInput()));
  assert.equal(canonicalTaskContract(reversed), canonicalTaskContract(forward));
  assert.equal(reversed.contractSha256, forward.contractSha256);
});

test("metadata is immutable, excluded from identity, and cannot carry secret-shaped keys", () => {
  const left = minimalInput();
  left.metadata = { labels: ["donor", "unit"], source: { revision: 1 } };
  const right = minimalInput();
  right.metadata = { labels: ["different"], note: "non-authoritative" };
  const leftContract = parseTaskContract(left);
  const rightContract = parseTaskContract(right);

  assert.equal(leftContract.contractSha256, rightContract.contractSha256);
  assert.equal(canonicalTaskContract(leftContract), canonicalTaskContract(rightContract));
  assert.deepEqual(leftContract.metadata, {
    labels: ["donor", "unit"],
    source: { revision: 1 },
  });
  assert.throws(() => leftContract.metadata.labels.push("mutated"), TypeError);

  const secretMetadata = minimalInput();
  secretMetadata.metadata = { api_key: "not-a-real-key" };
  expectError(
    () => parseTaskContract(secretMetadata),
    TaskContractParseError,
    "parse",
    "secret-shaped-metadata-key",
  );

  const primitiveMetadata = minimalInput();
  primitiveMetadata.metadata = "display label";
  expectError(
    () => parseTaskContract(primitiveMetadata),
    TaskContractParseError,
    "parse",
    "invalid-object",
  );
});

test("unknown versions and unsupported retry semantics are typed", () => {
  const unknownVersion = minimalInput();
  unknownVersion.authority.version = "dsh-dsworker/task-contract/v2";
  expectError(
    () => parseTaskContract(unknownVersion),
    TaskContractUnsupportedError,
    "unsupported",
    "unsupported-version",
  );

  const retry = minimalInput();
  retry.authority.retry = { mode: "on-failure", maxAttempts: 2 };
  expectError(
    () => parseTaskContract(retry),
    TaskContractUnsupportedError,
    "unsupported",
    "unsupported-retry-policy",
  );
});

test("unknown authoritative fields and missing objective fail schema parsing", () => {
  const unknown = minimalInput();
  unknown.authority.hiddenPolicy = true;
  expectError(
    () => parseTaskContract(unknown),
    TaskContractParseError,
    "parse",
    "unknown-field",
  );

  const missing = minimalInput();
  delete missing.authority.objective;
  expectError(
    () => parseTaskContract(missing),
    TaskContractParseError,
    "parse",
    "missing-field",
  );

  const blank = minimalInput();
  blank.authority.objective = " \r\n\t ";
  expectError(
    () => parseTaskContract(blank),
    TaskContractSemanticError,
    "semantic",
    "missing-objective",
  );
});

test("duplicate, traversal, and contradictory paths fail closed", () => {
  const duplicate = minimalInput();
  duplicate.authority.paths.mutable = [
    { path: "./src//file.js", kind: "file" },
    { path: "src\\file.js", kind: "file" },
  ];
  expectError(
    () => parseTaskContract(duplicate),
    TaskContractSemanticError,
    "semantic",
    "duplicate-path",
  );

  const traversal = minimalInput();
  traversal.authority.paths.mutable = [{ path: "src/../outside", kind: "file" }];
  expectError(
    () => parseTaskContract(traversal),
    TaskContractSemanticError,
    "semantic",
    "path-traversal",
  );

  const conflict = minimalInput();
  conflict.authority.paths.mutable = [{ path: "src", kind: "directory" }];
  conflict.authority.paths.immutable = [{ path: "src/authority.json", kind: "file" }];
  expectError(
    () => parseTaskContract(conflict),
    TaskContractSemanticError,
    "semantic",
    "path-authority-conflict",
  );
});

test("malformed argv, timeout, and environment fields are rejected", () => {
  const executable = minimalInput();
  executable.authority.commands.semantic[0].executable = "   ";
  expectError(
    () => parseTaskContract(executable),
    TaskContractSemanticError,
    "semantic",
    "empty-executable",
  );

  const malformedArgv = minimalInput();
  malformedArgv.authority.commands.semantic[0].argv = "--check main.js";
  expectError(
    () => parseTaskContract(malformedArgv),
    TaskContractParseError,
    "parse",
    "malformed-argv",
  );

  const timeout = minimalInput();
  timeout.authority.commands.semantic[0].timeoutMs = 0;
  expectError(
    () => parseTaskContract(timeout),
    TaskContractSemanticError,
    "semantic",
    "invalid-timeout",
  );

  const environment = minimalInput();
  environment.authority.commands.semantic[0].environment = { "INVALID-NAME": "1" };
  expectError(
    () => parseTaskContract(environment),
    TaskContractSemanticError,
    "semantic",
    "invalid-environment-key",
  );

  const environmentValue = minimalInput();
  environmentValue.authority.commands.semantic[0].environment = { VALID: 1 };
  expectError(
    () => parseTaskContract(environmentValue),
    TaskContractParseError,
    "parse",
    "invalid-string",
  );

  const credentialEnvironment = minimalInput();
  credentialEnvironment.authority.commands.semantic[0].environment = {
    PROVIDER_API_KEY: "not-a-real-key",
  };
  expectError(
    () => parseTaskContract(credentialEnvironment),
    TaskContractSemanticError,
    "semantic",
    "credential-environment-key",
  );
});

test("invalid immutable digests, duplicate command ids, and non-canonical metadata fail", () => {
  const digest = minimalInput();
  digest.authority.paths.immutable = [
    { path: "test.js", kind: "file", sha256: "ABC" },
  ];
  expectError(
    () => parseTaskContract(digest),
    TaskContractSemanticError,
    "semantic",
    "invalid-sha256",
  );

  const duplicateCommand = minimalInput();
  duplicateCommand.authority.commands.validation = [
    clone(duplicateCommand.authority.commands.semantic[0]),
  ];
  expectError(
    () => parseTaskContract(duplicateCommand),
    TaskContractSemanticError,
    "semantic",
    "duplicate-command-id",
  );

  const nonFinite = minimalInput();
  nonFinite.metadata = { measurement: Number.POSITIVE_INFINITY };
  expectError(
    () => parseTaskContract(nonFinite),
    TaskContractParseError,
    "parse",
    "non-canonical-metadata-number",
  );

  const cyclic = minimalInput();
  cyclic.metadata = {};
  cyclic.metadata.self = cyclic.metadata;
  expectError(
    () => parseTaskContract(cyclic),
    TaskContractParseError,
    "parse",
    "cyclic-metadata",
  );

  const accessor = minimalInput();
  accessor.metadata = {};
  Object.defineProperty(accessor.metadata, "dynamic", {
    enumerable: true,
    get() {
      throw new Error("must not be invoked");
    },
  });
  expectError(
    () => parseTaskContract(accessor),
    TaskContractParseError,
    "parse",
    "non-json-object-property",
  );

  const sparseArgv = minimalInput();
  sparseArgv.authority.commands.semantic[0].argv = new Array(1);
  expectError(
    () => parseTaskContract(sparseArgv),
    TaskContractParseError,
    "parse",
    "sparse-or-accessor-array",
  );
});

test("canonicalization refuses unparsed lookalike objects", () => {
  const parsed = parseTaskContract(minimalInput());
  const lookalike = clone(parsed);
  expectError(
    () => canonicalTaskContract(lookalike),
    TaskContractParseError,
    "parse",
    "unparsed-contract",
  );
});
