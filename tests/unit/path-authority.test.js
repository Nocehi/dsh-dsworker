import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  PATH_AUTHORITY_POLICY_VERSION,
  PathAuthorityApiError,
  PathAuthorityUnsupportedError,
  STRUCTURED_MUTATION_OPERATIONS,
  compilePathAuthority,
  isCompiledPathAuthority,
} from "@dsh-dsworker/path-authority";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";
import { REPO_ROOT } from "../../scripts/local-resolution.mjs";

const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "task-contract");

function contractInput() {
  return {
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "path-authority-unit",
      objective: "Compile structured filesystem mutation authority.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: [
          { path: "lexer.py", kind: "file" },
          { path: "move/from.txt", kind: "file" },
          { path: "move/to.txt", kind: "file" },
          { path: "src", kind: "directory" },
          { path: "tree-a", kind: "directory" },
          { path: "tree-b", kind: "directory" },
          { path: "資料", kind: "directory" },
        ],
        immutable: [
          { path: "locked", kind: "directory" },
          { path: "test_lexer.py", kind: "file" },
        ],
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
  };
}

function expectApiError(action, ErrorClass, category, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof ErrorClass);
    assert.equal(error.category, category);
    assert.equal(error.code, code);
    assert.match(error.path, /^\$/u);
    return true;
  });
}

test("compiler accepts only genuine TaskContract identity and retains exact authority", () => {
  const input = contractInput();
  const contract = parseTaskContract(input);
  const policy = compilePathAuthority(contract);

  assert.equal(isCompiledPathAuthority(policy), true);
  assert.equal(policy.policyVersion, PATH_AUTHORITY_POLICY_VERSION);
  assert.equal(policy.contract, contract);
  assert.equal(policy.contractSha256, contract.contractSha256);
  assert.equal(policy.identity.contractSha256, contract.contractSha256);
  assert.equal(policy.identity.contractVersion, TASK_CONTRACT_VERSION);
  assert.equal(policy.rules.mutable, contract.authority.paths.mutable);
  assert.equal(policy.rules.immutable, contract.authority.paths.immutable);
  assert.equal(compilePathAuthority(contract), policy, "same authority compiles once");

  expectApiError(
    () => compilePathAuthority(input),
    PathAuthorityApiError,
    "api",
    "unparsed-task-contract",
  );
  expectApiError(
    () => compilePathAuthority(structuredClone(contract)),
    PathAuthorityApiError,
    "api",
    "unparsed-task-contract",
  );
  const unsupported = contractInput();
  unsupported.authority.version = "dsh-dsworker/task-contract/v2";
  expectApiError(
    () => compilePathAuthority(unsupported),
    PathAuthorityUnsupportedError,
    "unsupported",
    "unsupported-task-contract-version",
  );
});

test("compiled policy, public rules, debug view, and decisions are deeply immutable", () => {
  const policy = compilePathAuthority(parseTaskContract(contractInput()));
  const decision = policy.decide({ operation: "edit-file", path: "lexer.py" });
  const debug = policy.describe();

  for (const value of [
    policy,
    policy.identity,
    policy.rules,
    policy.rules.mutable,
    policy.rules.mutable[0],
    debug,
    debug.operations,
    debug.operations.rename.kinds,
    decision,
    decision.matchedAuthority,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  const mutations = [
    () => policy.rules.mutable.push({ path: "escape", kind: "file" }),
    () => policy.rules.mutable[0].path = "escape",
    () => policy.identity.contractSha256 = "0".repeat(64),
    () => policy.contract = null,
    () => debug.operations.rename.kinds.push("symlink"),
    () => decision.decision = "deny",
    () => decision.matchedAuthority.path = "escape",
  ];
  for (const mutate of mutations) assert.throws(mutate, TypeError);
});

test("exact mutable file operations allow only the exact lexical file", () => {
  const policy = compilePathAuthority(parseTaskContract(contractInput()));
  for (const operation of [
    "create-file",
    "replace-file",
    "edit-file",
    "remove-file",
  ]) {
    const result = policy.decide({ operation, path: "lexer.py" });
    assert.equal(result.decision, "allow");
    assert.equal(result.code, "mutable-file-exact");
    assert.equal(result.normalizedPath, "lexer.py");
    assert.equal(result.matchedAuthority.entry, policy.rules.mutable[0]);
    assert.equal(result.requiresFilesystemBinding, true);
    assert.equal(result.executionAuthorized, false);
  }
  assert.deepEqual(
    policy.decide({ operation: "edit-file", path: "lexer.py.bak" }),
    {
      decision: "deny",
      code: "outside-mutable-authority",
      operation: "edit-file",
      requestedPath: "lexer.py.bak",
      normalizedPath: "lexer.py.bak",
      matchedAuthority: null,
      pathError: null,
      contractSha256: policy.contractSha256,
      boundary: "lexical-only",
      symlinkPolicy: "unsupported",
      requiresFilesystemBinding: false,
      executionAuthorized: false,
    },
  );
});

test("immutable exact files and directories deny before mutable consideration", () => {
  const policy = compilePathAuthority(parseTaskContract(contractInput()));
  const file = policy.decide({ operation: "replace-file", path: "test_lexer.py" });
  assert.equal(file.decision, "deny");
  assert.equal(file.code, "immutable-file-exact");
  assert.equal(file.matchedAuthority.mode, "immutable");

  const directory = policy.decide({
    operation: "remove-directory",
    path: "locked",
  });
  assert.equal(directory.decision, "deny");
  assert.equal(directory.code, "immutable-directory-self");

  const descendant = policy.decide({
    operation: "remove-file",
    path: "locked/nested/value.txt",
  });
  assert.equal(descendant.decision, "deny");
  assert.equal(descendant.code, "immutable-directory-descendant");
});

test("mutable directories authorize self and descendants without prefix confusion", () => {
  const policy = compilePathAuthority(parseTaskContract(contractInput()));
  const self = policy.decide({
    operation: "create-directory",
    path: "src",
  });
  assert.equal(self.decision, "allow");
  assert.equal(self.code, "mutable-directory-self");
  const removeSelf = policy.decide({
    operation: "remove-directory",
    path: "src",
  });
  assert.equal(removeSelf.decision, "allow");
  assert.equal(removeSelf.code, "mutable-directory-self");

  for (const request of [
    { operation: "create-file", path: "src/new.txt" },
    { operation: "replace-file", path: "src/deep/file.txt" },
    { operation: "edit-file", path: "src/deep/file.txt" },
    { operation: "remove-file", path: "src/deep/file.txt" },
    { operation: "create-directory", path: "src/deep" },
    { operation: "remove-directory", path: "src/deep" },
  ]) {
    const result = policy.decide(request);
    assert.equal(result.decision, "allow", JSON.stringify(request));
    assert.equal(result.code, "mutable-directory-descendant");
  }

  for (const path of ["src-other/file", "src_other/file", "source/file"] ) {
    const result = policy.decide({ operation: "edit-file", path });
    assert.equal(result.decision, "deny", path);
    assert.equal(result.code, "outside-mutable-authority");
  }
});

test("operation target kinds and unsupported operation classes fail closed", () => {
  const policy = compilePathAuthority(parseTaskContract(contractInput()));
  for (const request of [
    { operation: "edit-file", path: "src" },
    { operation: "remove-directory", path: "lexer.py" },
  ]) {
    const result = policy.decide(request);
    assert.equal(result.decision, "deny");
    assert.equal(result.code, "authority-kind-mismatch");
  }
  for (const operation of [
    "replace-directory",
    "chmod",
    "create-symlink",
    "hard-link",
    "git-operation",
    "bash",
  ]) {
    const result = policy.decide({ operation, path: "src/file.txt" });
    assert.equal(result.decision, "unsupported", operation);
    assert.equal(result.code, "unknown-operation");
    assert.equal(result.executionAuthorized, false);
  }
  for (const operation of ["rename-source", "rename-destination"]) {
    const result = policy.decide({ operation, path: "src/file.txt" });
    assert.equal(result.decision, "unsupported");
    assert.equal(result.code, "rename-requires-atomic-helper");
  }
  assert.deepEqual(
    STRUCTURED_MUTATION_OPERATIONS,
    [
      "create-file",
      "replace-file",
      "edit-file",
      "remove-file",
      "create-directory",
      "remove-directory",
    ],
  );
});

test("normalization is delegated to TaskContract lexical semantics", () => {
  const policy = compilePathAuthority(parseTaskContract(contractInput()));
  for (const path of [
    "./src//nested///file.txt",
    "src\\nested\\file.txt",
    "src/./nested/file.txt",
  ]) {
    const result = policy.decide({ operation: "edit-file", path });
    assert.equal(result.decision, "allow", path);
    assert.equal(result.normalizedPath, "src/nested/file.txt");
  }
  const unicode = policy.decide({ operation: "create-file", path: "資料/測試🧪.txt" });
  assert.equal(unicode.decision, "allow");
  assert.equal(unicode.normalizedPath, "資料/測試🧪.txt");

  const invalid = [
    ["", "invalid-path"],
    [".", "empty-path"],
    ["../outside", "path-traversal"],
    ["src/../outside", "path-traversal"],
    ["/etc/passwd", "absolute-path"],
    ["C:\\temp\\file", "absolute-path"],
    ["C:relative", "absolute-path"],
    ["\\\\server\\share", "absolute-path"],
    ["src/line\nfeed", "invalid-path"],
  ];
  for (const [path, errorCode] of invalid) {
    const result = policy.decide({ operation: "edit-file", path });
    assert.equal(result.decision, "deny", JSON.stringify(path));
    assert.equal(result.code, "invalid-path");
    assert.equal(result.normalizedPath, null);
    assert.equal(result.pathError.code, errorCode);
  }
});

test("known symlink-dependent paths are unsupported and every lexical allow needs binding", () => {
  const policy = compilePathAuthority(parseTaskContract(contractInput()));
  assert.equal(policy.symlinkPolicy, "unsupported");
  const lexical = policy.decide({ operation: "edit-file", path: "src/file" });
  assert.equal(lexical.decision, "allow");
  assert.equal(lexical.requiresFilesystemBinding, true);
  assert.equal(lexical.executionAuthorized, false);

  const symlink = policy.decide({
    operation: "edit-file",
    path: "src/file",
    requiresSymlinkResolution: true,
  });
  assert.equal(symlink.decision, "unsupported");
  assert.equal(symlink.code, "symlink-resolution-required");
  assert.equal(symlink.requiresFilesystemBinding, true);

  const immutable = policy.decide({
    operation: "edit-file",
    path: "test_lexer.py",
    requiresSymlinkResolution: true,
  });
  assert.equal(immutable.decision, "deny");
  assert.equal(immutable.code, "immutable-file-exact");
});

test("rename atomically requires mutable source removal and destination authority", () => {
  const policy = compilePathAuthority(parseTaskContract(contractInput()));
  for (const destinationMode of ["create", "replace"]) {
    const result = policy.decideRename({
      kind: "file",
      sourcePath: "move/from.txt",
      destinationPath: "move/to.txt",
      destinationMode,
    });
    assert.equal(result.decision, "allow");
    assert.equal(result.code, "rename-file-lexically-authorized");
    assert.equal(result.source.decision, "allow");
    assert.equal(result.destination.decision, "allow");
    assert.equal(result.executionAuthorized, false);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.source), true);
    assert.equal(Object.isFrozen(result.destination), true);
  }

  const cases = [
    {
      sourcePath: "test_lexer.py",
      destinationPath: "move/to.txt",
      code: "rename-source-denied",
    },
    {
      sourcePath: "outside.txt",
      destinationPath: "move/to.txt",
      code: "rename-source-denied",
    },
    {
      sourcePath: "move/from.txt",
      destinationPath: "test_lexer.py",
      code: "rename-destination-denied",
    },
    {
      sourcePath: "move/from.txt",
      destinationPath: "outside.txt",
      code: "rename-destination-denied",
    },
  ];
  for (const item of cases) {
    const result = policy.decideRename({
      kind: "file",
      sourcePath: item.sourcePath,
      destinationPath: item.destinationPath,
      destinationMode: "create",
    });
    assert.equal(result.decision, "deny", JSON.stringify(item));
    assert.equal(result.code, item.code);
  }
});

test("directory rename is conservative about overlap and replacement", () => {
  const policy = compilePathAuthority(parseTaskContract(contractInput()));
  const disjoint = policy.decideRename({
    kind: "directory",
    sourcePath: "tree-a/subtree",
    destinationPath: "tree-b/subtree",
    destinationMode: "create",
  });
  assert.equal(disjoint.decision, "allow");
  assert.equal(disjoint.code, "rename-directory-lexically-authorized");

  const overlap = policy.decideRename({
    kind: "directory",
    sourcePath: "tree-a",
    destinationPath: "tree-a/nested",
    destinationMode: "create",
  });
  assert.equal(overlap.decision, "unsupported");
  assert.equal(overlap.code, "rename-overlapping-trees");

  const replacement = policy.decideRename({
    kind: "directory",
    sourcePath: "tree-a",
    destinationPath: "tree-b",
    destinationMode: "replace",
  });
  assert.equal(replacement.source.decision, "allow");
  assert.equal(replacement.destination.decision, "allow");
  assert.equal(replacement.decision, "unsupported");
  assert.equal(replacement.code, "directory-replacement-unproven");

  const identical = policy.decideRename({
    kind: "file",
    sourcePath: "move/from.txt",
    destinationPath: "move/./from.txt",
    destinationMode: "replace",
  });
  assert.equal(identical.decision, "unsupported");
  assert.equal(identical.code, "rename-identical-path");
});

test("rename propagates invalid, unsupported, and symlink-dependent semantics", () => {
  const policy = compilePathAuthority(parseTaskContract(contractInput()));
  const invalid = policy.decideRename({
    kind: "file",
    sourcePath: "../escape",
    destinationPath: "move/to.txt",
    destinationMode: "create",
  });
  assert.equal(invalid.decision, "deny");
  assert.equal(invalid.code, "rename-source-denied");
  assert.equal(invalid.source.code, "invalid-path");

  const unknownKind = policy.decideRename({
    kind: "symlink",
    sourcePath: "move/from.txt",
    destinationPath: "move/to.txt",
    destinationMode: "create",
  });
  assert.equal(unknownKind.decision, "unsupported");
  assert.equal(unknownKind.code, "unsupported-rename-kind");

  const unknownMode = policy.decideRename({
    kind: "file",
    sourcePath: "move/from.txt",
    destinationPath: "move/to.txt",
    destinationMode: "merge",
  });
  assert.equal(unknownMode.decision, "unsupported");
  assert.equal(unknownMode.code, "unsupported-rename-destination-mode");

  const symlink = policy.decideRename({
    kind: "file",
    sourcePath: "move/from.txt",
    destinationPath: "move/to.txt",
    destinationMode: "create",
    requiresSymlinkResolution: true,
  });
  assert.equal(symlink.decision, "unsupported");
  assert.equal(symlink.code, "rename-path-unsupported");
  assert.equal(symlink.source.code, "symlink-resolution-required");
  assert.equal(symlink.destination.code, "symlink-resolution-required");
});

test("API misuse throws typed errors while ordinary lexical rejection returns decisions", () => {
  const policy = compilePathAuthority(parseTaskContract(contractInput()));
  for (const action of [
    () => policy.decide(null),
    () => policy.decide({ operation: "edit-file" }),
    () => policy.decide({ operation: 1, path: "lexer.py" }),
    () => policy.decide({ operation: "edit-file", path: 1 }),
    () => policy.decide({ operation: "edit-file", path: "lexer.py", extra: true }),
    () => policy.decide({
      operation: "edit-file",
      path: "lexer.py",
      requiresSymlinkResolution: "yes",
    }),
  ]) {
    assert.throws(action, PathAuthorityApiError);
  }
  const ordinary = policy.decide({ operation: "edit-file", path: "../escape" });
  assert.equal(ordinary.decision, "deny");
  assert.equal(ordinary.code, "invalid-path");
});

test("python-argv-lexer donor policy remains tied to the golden TaskContract digest", async () => {
  const input = JSON.parse(
    await readFile(join(FIXTURE_DIR, "python-argv-lexer.input.json"), "utf8"),
  );
  const expectedDigest = (
    await readFile(join(FIXTURE_DIR, "python-argv-lexer.sha256"), "utf8")
  ).trimEnd();
  const contract = parseTaskContract(input);
  const policy = compilePathAuthority(contract);

  assert.equal(
    expectedDigest,
    "0a2105c759dd690ac86403838029a75f848f71410bafe5e8cbf7930da7e835b6",
  );
  assert.equal(contract.contractSha256, expectedDigest);
  assert.equal(policy.contractSha256, expectedDigest);
  assert.equal(policy.contract, contract);
  assert.equal(
    policy.decide({ operation: "edit-file", path: "lexer.py" }).decision,
    "allow",
  );
  assert.deepEqual(
    [
      policy.decide({ operation: "replace-file", path: "test_lexer.py" }).decision,
      policy.decide({ operation: "create-file", path: "anything-else" }).decision,
    ],
    ["deny", "deny"],
  );
});
