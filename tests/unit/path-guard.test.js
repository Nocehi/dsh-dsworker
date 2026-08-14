import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";
import { compilePathAuthority } from "@dsh-dsworker/path-authority";
import {
  PathGuardConfigurationError,
  PathGuardRuntime,
  adapterDenialRecord,
  classifyLeanTool,
  compileGuardBinding,
  createGuardBinding,
  evaluateMutationIntent,
  extractMutationIntent,
  guardDenialMessage,
  isGuardBinding,
  monotonicGuardOutcome,
} from "@dsh-dsworker/plugin-path-guard";

const DONOR_PATH = join(
  process.cwd(),
  "tests",
  "fixtures",
  "task-contract",
  "python-argv-lexer.input.json",
);

function minimalContract(paths = {}) {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId: "path-guard-unit",
      objective: "Exercise host-side structured mutation authority.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: {
        mutable: paths.mutable ?? [{ path: "lexer.py", kind: "file" }],
        immutable: paths.immutable ?? [
          { path: "test_lexer.py", kind: "file" },
        ],
      },
      commands: {
        semantic: [
          {
            id: "not-executed",
            executable: "python",
            argv: ["-m", "pytest", "-q", "test_lexer.py"],
            cwd: { kind: "workspace-root" },
            environment: { PYTHONDONTWRITEBYTECODE: "1" },
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
  });
}

function execution(name, args, callId = "call-unit-1") {
  return { name, arguments: args, callId };
}

function fakeFs(targetType = "file") {
  const calls = [];
  return {
    calls,
    async lstat(path) {
      calls.push(["lstat", path]);
      if (path === "/tmp/path-guard-unit") return { type: "directory" };
      return { type: targetType };
    },
    async resolve(path, options) {
      calls.push(["resolve", path, options?.cwd ?? null]);
      return { targetKey: `${options?.cwd ?? ""}/${path}`, displayPath: path };
    },
    contains() {
      calls.push(["contains"]);
      return true;
    },
  };
}

test("tool mapping is exact and never retains edit/write content", () => {
  assert.deepEqual(classifyLeanTool("read"), {
    classification: "read-only",
    code: "read-only-tool",
    toolName: "read",
  });
  assert.equal(classifyLeanTool("glob").classification, "read-only");
  assert.equal(classifyLeanTool("grep").classification, "read-only");
  assert.deepEqual(classifyLeanTool("bash"), {
    classification: "outside-path-guard",
    code: "bash-outside-path-guard",
    toolName: "bash",
  });
  assert.equal(classifyLeanTool("edit").classification, "structured-mutation");
  assert.equal(classifyLeanTool("write").classification, "structured-mutation");
  assert.equal(classifyLeanTool("rename").classification, "uncovered");

  const edit = extractMutationIntent(
    execution("edit", {
      file_path: "lexer.py",
      old_string: "private-before",
      new_string: "private-after",
      replace_all: false,
      authorization: "synthetic-secret-shaped-sentinel",
      api_key: "synthetic-api-key-sentinel",
    }),
  );
  assert.deepEqual(edit, {
    status: "mapped",
    operation: "edit-file",
    requestedPath: "lexer.py",
    toolName: "edit",
    toolCallId: "call-unit-1",
  });
  assert.equal(JSON.stringify(edit).includes("private-before"), false);
  assert.equal(JSON.stringify(edit).includes("private-after"), false);
  assert.equal(JSON.stringify(edit).includes("synthetic-secret-shaped-sentinel"), false);
  assert.equal(JSON.stringify(edit).includes("synthetic-api-key-sentinel"), false);

  assert.equal(
    extractMutationIntent(execution("write", { content: "not retained" })).code,
    "malformed-file-path",
  );
  assert.equal(
    extractMutationIntent(execution("rename", { file_path: "lexer.py" })).code,
    "unknown-mutation-tool",
  );
  assert.equal(
    extractMutationIntent({ name: "write", arguments: null, callId: "bad" }).code,
    "malformed-tool-arguments",
  );
});

test("binding accepts only a genuine contract and exact compiled policy identity", () => {
  const contract = minimalContract();
  const policy = compilePathAuthority(contract);
  const binding = createGuardBinding({
    contract,
    policy,
    workspaceRoot: "/tmp/path-guard-unit",
  });
  assert.equal(isGuardBinding(binding), true);
  assert.equal(binding.contract, contract);
  assert.equal(binding.policy, policy);
  assert.equal(binding.contractSha256, contract.contractSha256);
  assert.equal(Object.isFrozen(binding), true);
  assert.throws(() => {
    binding.workspaceRoot = "/tmp/forged";
  }, TypeError);

  assert.throws(
    () =>
      createGuardBinding({
        contract: structuredClone(contract),
        policy,
        workspaceRoot: "/tmp/path-guard-unit",
      }),
    PathGuardConfigurationError,
  );
  const otherContract = parseTaskContract({
    ...JSON.parse(JSON.stringify({ authority: contract.authority })),
    authority: { ...contract.authority, taskId: "other-contract" },
  });
  assert.throws(
    () =>
      createGuardBinding({
        contract,
        policy: compilePathAuthority(otherContract),
        workspaceRoot: "/tmp/path-guard-unit",
      }),
    (error) =>
      error instanceof PathGuardConfigurationError &&
      error.code === "task-contract-policy-identity-mismatch",
  );
});

test("runtime binding requires exact live AgentRegistry identity", () => {
  const contract = minimalContract();
  const lookalike = {
    id: "agent-one",
    session: { header: { cwd: "/tmp/path-guard-unit" } },
  };
  const runtime = new PathGuardRuntime(fakeFs(), {
    get() {
      return undefined;
    },
  });
  assert.throws(
    () => runtime.bind(lookalike, contract),
    (error) =>
      error instanceof PathGuardConfigurationError &&
      error.code === "unregistered-agent",
  );

  const exactRuntime = new PathGuardRuntime(fakeFs(), {
    get(id) {
      return id === lookalike.id ? lookalike : undefined;
    },
  });
  const binding = exactRuntime.bind(lookalike, contract);
  assert.equal(binding.contract, contract);
  assert.equal(binding.workspaceRoot, "/tmp/path-guard-unit");
  binding.dispose();
  runtime.dispose();
  exactRuntime.dispose();
});

test("lexical denial short-circuits filesystem proof and permit requires both layers", async () => {
  const binding = compileGuardBinding(minimalContract(), "/tmp/path-guard-unit");
  const fs = fakeFs();
  const denied = await evaluateMutationIntent(
    fs,
    binding,
    extractMutationIntent(
      execution("write", { file_path: "unrelated.py", content: "x" }),
    ),
  );
  assert.equal(denied.finalGuardDecision, "deny");
  assert.equal(denied.denialCategory, "policy-deny");
  assert.equal(denied.denialCode, "outside-mutable-authority");
  assert.deepEqual(fs.calls, []);

  const permitted = await evaluateMutationIntent(
    fs,
    binding,
    extractMutationIntent(
      execution("edit", {
        file_path: "lexer.py",
        old_string: "a",
        new_string: "b",
      }),
    ),
  );
  assert.equal(permitted.finalGuardDecision, "permit");
  assert.equal(permitted.operation, "edit-file");
  assert.equal(permitted.contractSha256, binding.contractSha256);
  assert.equal(permitted.filesystemBindingResult.decision, "allow");
  assert.equal(Object.isFrozen(permitted), true);
  assert.equal(Object.isFrozen(permitted.filesystemBindingResult), true);
  assert.throws(() => {
    permitted.filesystemBindingResult.code = "forged";
  }, TypeError);
});

test("allow without a filesystem seam, unsupported symlink proof, and adapter errors deny", async () => {
  const binding = compileGuardBinding(minimalContract(), "/tmp/path-guard-unit");
  const intent = extractMutationIntent(
    execution("write", { file_path: "lexer.py", content: "x" }),
  );
  const noFs = await evaluateMutationIntent(null, binding, intent);
  assert.equal(noFs.finalGuardDecision, "deny");
  assert.equal(noFs.denialCode, "filesystem-proof-unavailable");

  const symlinkFs = fakeFs("symlink");
  const symlink = await evaluateMutationIntent(symlinkFs, binding, intent);
  assert.equal(symlink.finalGuardDecision, "deny");
  assert.equal(symlink.denialCategory, "unsupported-filesystem-authority");
  assert.equal(symlink.denialCode, "target-symlink");

  const malformed = await evaluateMutationIntent(
    fakeFs(),
    binding,
    extractMutationIntent(execution("write", { file_path: "" })),
  );
  assert.equal(malformed.finalGuardDecision, "deny");
  assert.equal(malformed.denialCategory, "adapter-input");
  assert.equal(malformed.denialCode, "malformed-file-path");
  const forged = await evaluateMutationIntent(fakeFs(), binding, {
    status: "mapped",
    operation: "remove-file",
    requestedPath: "lexer.py",
    toolName: "write",
    toolCallId: "forged",
  });
  assert.equal(forged.finalGuardDecision, "deny");
  assert.equal(forged.denialCode, "invalid-mutation-intent");

  const missing = adapterDenialRecord({
    toolName: "write",
    toolCallId: "call-missing",
    denialCode: "missing-pre-execution-proof",
  });
  assert.match(guardDenialMessage(missing), /missing-pre-execution-proof/u);
  assert.match(guardDenialMessage(missing), /contract=unbound/u);
  assert.equal(Object.isFrozen(missing), true);
});

test("monotonic join propagates PathAuthority deny and unsupported without override", () => {
  for (const lexical of ["allow", "deny", "unsupported"]) {
    for (const filesystem of ["allow", "deny", "unsupported"]) {
      assert.equal(
        monotonicGuardOutcome(lexical, filesystem),
        lexical === "allow" && filesystem === "allow" ? "permit" : "deny",
        `${lexical} + ${filesystem}`,
      );
    }
  }
});

test("python-argv-lexer donor authority is retained exactly", async () => {
  const donor = parseTaskContract(JSON.parse(await readFile(DONOR_PATH, "utf8")));
  const binding = compileGuardBinding(donor, "/tmp/path-guard-unit");
  assert.equal(
    binding.contractSha256,
    "0a2105c759dd690ac86403838029a75f848f71410bafe5e8cbf7930da7e835b6",
  );
  const fs = fakeFs();
  const lexer = await evaluateMutationIntent(
    fs,
    binding,
    extractMutationIntent(
      execution("edit", {
        file_path: "lexer.py",
        old_string: "a",
        new_string: "b",
      }),
    ),
  );
  const testAuthority = await evaluateMutationIntent(
    fs,
    binding,
    extractMutationIntent(
      execution("edit", {
        file_path: "test_lexer.py",
        old_string: "a",
        new_string: "b",
      }),
    ),
  );
  const other = await evaluateMutationIntent(
    fs,
    binding,
    extractMutationIntent(
      execution("write", { file_path: "other.py", content: "x" }),
    ),
  );
  assert.equal(lexer.finalGuardDecision, "permit");
  assert.equal(testAuthority.denialCode, "immutable-file-exact");
  assert.equal(other.denialCode, "outside-mutable-authority");
  assert.ok(
    [lexer, testAuthority, other].every(
      (record) => record.contractSha256 === donor.contractSha256,
    ),
  );
});
