# TaskContract v1

`@dsh-dsworker/task-contract` owns one thing: turning an untrusted plain object
into one validated, normalized, hashed, deeply immutable authority object.

```text
                    immutable TaskContract
                             │
              ┌──────────────┼───────────────┐
              ▼              ▼               ▼
     future tools.guard  future task_check  future evidence
              │              │               │
              └──────────────┴───────────────┘
                       same authority
```

Future guards, checkers, evidence builders, and runners must receive this exact
parsed object. They must not re-read the source JSON, split command strings, or
maintain a parallel interpretation of path or retry semantics.

## Closed schema

The input root permits only `authority` and optional `metadata`:

```json
{
  "authority": {
    "version": "dsh-dsworker/task-contract/v1",
    "taskId": "task-id",
    "objective": "Exact objective text",
    "workspace": {
      "root": "runner-supplied",
      "commandCwdPolicy": "workspace-relative-only",
      "symlinkPolicy": "unsupported"
    },
    "paths": {
      "mutable": [{ "path": "src/file", "kind": "file" }],
      "immutable": [
        {
          "path": "tests/authority.test",
          "kind": "file",
          "sha256": "64 lowercase hexadecimal characters"
        }
      ]
    },
    "commands": {
      "semantic": ["Command objects"],
      "validation": ["Command objects"],
      "finish": ["Command objects"]
    },
    "retry": { "mode": "none", "maxAttempts": 1 },
    "terminal": {
      "success": "all-authoritative-commands-pass",
      "failure": "fail-closed"
    }
  },
  "metadata": {}
}
```

Every authority object and command object is closed: an unknown field is an
error. `metadata` is an optional plain JSON object with open, non-secret-shaped
keys. It is cloned, sorted, and frozen but excluded from identity.

## Authority meanings

| Field | Authority meaning |
|---|---|
| `version` | Selects this exact schema and semantic vocabulary. v1 is the only supported value. |
| `taskId` | Stable task/objective identifier, 1–128 characters from ASCII letters, digits, `.`, `_`, and `-`. |
| `objective` | Exact human task wording. CRLF and CR become LF; no other trimming or prose rewriting occurs. |
| `workspace.root` | The actual absolute workspace is bound later by a runner and is not part of the contract. |
| `workspace.commandCwdPolicy` | Every command cwd is the workspace root or a contract-relative directory beneath it. |
| `workspace.symlinkPolicy` | `unsupported`: v1 makes no filesystem-dependent symlink decision. |
| `paths.mutable` | The only paths the contract authorizes to change. An unlisted path is not mutable authority. |
| `paths.immutable` | Paths that must not change. A file may also carry its required initial SHA-256. |
| `commands.semantic` | Ordered authoritative task-behavior checks; at least one is required. |
| `commands.validation` | Ordered authoritative validation checks. The array may be empty. |
| `commands.finish` | Ordered final checks such as syntax/compile validation. The array may be empty. |
| `retry` | Exactly one attempt with no hidden retry. This package records the rule but executes nothing. |
| `terminal` | Declares the future success predicate: all authoritative commands meet their expected exits; every other result is fail-closed. This package does not evaluate it. |

`metadata` may carry labels, donor provenance, display text, or an external
revision. It is explicitly non-authoritative. Changing only metadata cannot
change canonical authority bytes or `contractSha256`. Credential-shaped
metadata keys are rejected rather than redacted or persisted.

## Canonicalization and digest

`parseTaskContract()` expands the authority into one normalized representation.
`canonicalTaskContract()` then emits compact JSON with:

- recursively sorted object keys using ECMAScript code-unit order, never locale;
- no insignificant whitespace and no terminal newline;
- mutable and immutable path sets sorted by normalized path and kind;
- environment keys sorted;
- expected exit-code sets sorted numerically;
- command phase order fixed as semantic, validation, finish;
- command list order and `argv` element order preserved because both are semantic;
- objective CRLF/CR normalized to LF;
- no host cwd, clock, randomness, platform `EOL`, metadata, or digest field.

`contractSha256` is lowercase SHA-256 over the UTF-8 bytes of that canonical
authority JSON. An explicit value and an omitted default are not conflated in
v1: required authority fields must be present. Equivalent separator spellings,
path-set order, environment insertion order, exit-code order, object insertion
order, and objective newline conventions normalize to the same identity.

The canonical API accepts only an object previously returned by
`parseTaskContract()`. A structural lookalike is rejected so a consumer cannot
hash an unvalidated authority shape by accident.

## Path model

Contract paths use a platform-independent lexical grammar:

- `/` and `\` are input separators and normalize to `/`;
- repeated separators and `.` segments collapse;
- a path must identify at least one segment;
- Unix roots, UNC roots, Windows drive-qualified or drive-relative paths, every
  `..` segment, NUL, DEL, and other control characters are rejected;
- normalization never reads host cwd or the filesystem;
- `kind: file` names exactly one lexical file path;
- `kind: directory` covers that directory and descendants for later policy;
- duplicate normalized paths are rejected;
- any mutable/immutable overlap is contradictory and rejected;
- a declared file cannot lexically contain another declared path;
- immutable directories may contain more specific immutable digest anchors.

Unicode is preserved byte-for-byte after JSON decoding; no Unicode
normalization or case folding occurs. `~`, glob characters, and percent escapes
are literal filename characters, not expansion syntax.

This is lexical authority, not proof of a real filesystem object. Symlink
resolution is deliberately unknown. A future guard must bind the
runner-supplied root, fail closed on unsupported symlink cases, and still run
inside outer OS containment.

## Command model

Each command has this closed shape:

```json
{
  "id": "unique-command-id",
  "executable": "python3",
  "argv": ["-m", "unittest", "-v", "test_file.py"],
  "cwd": { "kind": "workspace-root" },
  "environment": { "PYTHONDONTWRITEBYTECODE": "1" },
  "timeoutMs": 60000,
  "expected": { "exitCodes": [0] }
}
```

`cwd` is either `{ "kind": "workspace-root" }` or
`{ "kind": "workspace-relative", "path": "subdir" }`. Absolute and traversal
cwd values are unsupported. An executable is a non-empty program name or
workspace-relative path; absolute and traversal executable paths are rejected.

`argv` is never a shell string. Empty arguments, whitespace, quotes,
backslashes, newlines, and Unicode are preserved as literal argument content;
only non-strings and NUL are rejected. The package performs no interpolation,
splitting, quoting, globbing, or environment expansion.

`environment` is the exact authoritative override map for that command. Keys
use portable `[A-Za-z_][A-Za-z0-9_]*` names; values are literal NUL/DEL-free
strings. Prototype-sensitive and credential-shaped keys are rejected; provider
credentials remain outside task authority. Ambient/sanitized base environment
selection belongs to the runner binding and must be recorded separately—it is
not silently claimed by this contract.

Timeouts are required safe integers from 1 through 3,600,000 milliseconds.
Expected exit codes are a non-empty unique set of integers from 0 through 255.
The package records these values but never spawns a process.

## Error taxonomy

All failures derive from `TaskContractError` and expose stable `category`,
`code`, and JSONPath-like `path` properties:

| Class | Category | Meaning |
|---|---|---|
| `TaskContractParseError` | `parse` | Wrong JSON/plain-object shape, missing/unknown field, malformed argv, or non-canonical metadata. |
| `TaskContractSemanticError` | `semantic` | Blank objective, invalid or duplicate path, path conflict, invalid digest/environment/timeout/exit semantics, or duplicate command identity. |
| `TaskContractUnsupportedError` | `unsupported` | Unknown version or a workspace, path-kind, cwd, retry, or terminal feature v1 does not define. |

The parser does not coerce a rejected value into authority.

## Immutability

Parsing clones every retained input value, calculates identity, recursively
freezes authority, path collections, commands, argv arrays, environment maps,
expected exits, metadata, and the root object, then marks that exact object as a
parsed `TaskContract`. ECMAScript module consumers receive loud `TypeError`
failures when attempting mutation. Mutating the caller's original input after
parsing cannot mutate the contract.

## Donor mapping

`tests/fixtures/task-contract/python-argv-lexer.input.json` manually preserves
the minimum semantics from the read-only external donor corpus, task
`python-argv-lexer`:

- the exact objective;
- mutable file `lexer.py`;
- immutable authority file `test_lexer.py`, SHA-256
  `1e731f05e4aa54af2b39e44d29395094eb8737d3a607b5d4563f1bc0bd64015d`;
- the semantic and validation unittest invocations as `python3` plus argv, with
  `PYTHONDONTWRITEBYTECODE=1` as an environment override;
- the finish compile expression as one literal `-c` argv element;
- expected exit `0`, a 60-second dsh-dsworker bound, and explicit no-retry.

The fixture contains no donor source file and imports no ds-worker code. Its
canonical authority SHA-256 is pinned in a separate golden file.

## Deliberate non-capabilities

`task-contract`:

- does not execute commands;
- does not expose a model tool, system section, tool schema, or durable context;
- does not enforce filesystem policy;
- does not provide OS containment;
- does not resolve symlinks;
- does not decide PASS/FAIL for a run;
- does not append session events or evidence;
- does not select a provider/model or inspect credentials;
- does not implement retries.

Future guards, checkers, evidence, and runners must consume the same immutable
object and `contractSha256`, not parse another parallel task representation.
