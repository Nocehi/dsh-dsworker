# PathAuthority v1

`@dsh-dsworker/path-authority` compiles the exact immutable object returned by
`parseTaskContract()` into a pure, immutable lexical decision engine. It is a
host library: it has no DSH or Cordis dependency, Loader row, model tool,
system-prompt section, durable context, session event, or side effect.

```text
genuine immutable TaskContract
             │ exact object identity
             ▼
   compilePathAuthority(contract)
             │
             ▼
 immutable lexical PathAuthority
       │                  │
       ├─ decide(path)    └─ decideRename(source, destination)
       │
       ▼
 allow | deny | unsupported
```

## Input authority and identity

The compiler accepts only a genuine TaskContract branded by the same installed
`@dsh-dsworker/task-contract` module. Source JSON, structural lookalikes,
`structuredClone()` results, reconstructed copies, and unsupported versions are
rejected with typed exceptions. The compiler does not parse task source and
does not independently normalize its rule entries.

The compiled policy retains:

- `policy.contract === contract`;
- the authoritative `contractSha256` without computing a competing authority
  digest;
- `policy.rules.mutable === contract.authority.paths.mutable` and the same
  relation for immutable rules;
- a frozen identity record containing contract version, task id, and digest;
- `symlinkPolicy: "unsupported"` exactly as declared by TaskContract v1.

Compiling the same TaskContract object again returns the same policy object.
Every public wrapper, rule collection, rule entry, decision, match record, and
debug collection is frozen. No mutable `Map` or `Set` is exposed.

`policy.describe()` is a deterministic debug view, not a task authority and not
a new digest. `contractSha256` remains the sole task-authority identity.

## Operation vocabulary

`policy.decide()` accepts a closed request:

```js
policy.decide({
  operation: "edit-file",
  path: "src/file.js",
  requiresSymlinkResolution: false, // optional, defaults false
});
```

The bounded operations are:

| Target | Operations |
|---|---|
| File | `create-file`, `replace-file`, `edit-file`, `remove-file` |
| Directory | `create-directory`, `remove-directory` |

`rename-source` and `rename-destination` are not individually authorizable;
they return `unsupported / rename-requires-atomic-helper`. Callers must use the
atomic policy helper described below. Unknown operation strings return
`unsupported / unknown-operation`.

chmod, chown, xattrs, hard links, symlinks, device paths, mounts, Git operations,
network effects, subprocess behavior, and shell commands are outside this
vocabulary. The package never executes an operation.

## Decision taxonomy

Every single-path result is frozen and has this stable shape:

```js
{
  decision: "allow" | "deny" | "unsupported",
  code: "machine-readable-code",
  operation: "edit-file",
  requestedPath: "./src//file.js",
  normalizedPath: "src/file.js" | null,
  matchedAuthority: {
    mode: "mutable" | "immutable",
    relation: "exact" | "descendant",
    path: "src",
    kind: "file" | "directory",
    entry: contract.authority.paths.mutable[0]
  } | null,
  pathError: { category, code, path } | null,
  contractSha256,
  boundary: "lexical-only",
  symlinkPolicy: "unsupported",
  requiresFilesystemBinding: boolean,
  executionAuthorized: false
}
```

`allow` means only that the normalized lexical target and structured operation
fit mutable authority. It always sets `requiresFilesystemBinding: true` and
never sets execution authorization.

`deny` means the package can prove one of these from contract semantics alone:

- the path is lexically invalid;
- it matches an immutable file or immutable directory subtree;
- it lies outside every mutable rule;
- the operation target kind contradicts an exact mutable file/directory rule.

`unsupported` means the request is outside the proven operation model, a known
symlink-dependent decision was requested, or a rename has structural semantics
that the contract alone cannot prove.

Non-string paths, malformed request objects, accessors, unknown request fields,
and other programmer/API misuse throw `PathAuthorityApiError`. A string that is
empty, absolute, traversal-bearing, drive/UNC rooted, or control-bearing is an
ordinary fail-closed `deny / invalid-path` decision with the underlying
TaskContract path error code. Unsupported TaskContract versions throw
`PathAuthorityUnsupportedError`.

## File and directory semantics

Path normalization is delegated to TaskContract's public lexical helper:

- slash and backslash inputs are equivalent separators;
- repeated separators and `.` segments collapse;
- `..`, absolute paths, Windows drive/UNC forms, empty paths, and control
  characters are rejected;
- Unicode remains literal and case-sensitive;
- no cwd, filesystem, locale, environment, expansion, or normalization form is
  consulted.

A mutable file authorizes the exact lexical file for the four file operations.
It does not authorize a sibling, child, or parent directory operation. An
immutable file denies its exact lexical name.

A mutable directory authorizes the directory itself for the two directory
operations and its descendants for file or directory operations. Segment
boundaries are exact: `src` does not authorize `src-other`. An immutable
directory denies itself and descendants.

TaskContract v1 rejects mutable/immutable overlap. Consequently v1 cannot
express “mutable directory with an immutable exception beneath it.” This is a
future contract-language decision; PathAuthority does not invent precedence to
simulate it.

For parent and structural effects, the pure compiler is conservative:

- creating, replacing, editing, or removing an exact mutable file is a lexical
  allow candidate;
- creating or removing a directory is a candidate only when the target itself
  is covered by mutable directory authority;
- moving a directory is checked as a subtree operation on both ends;
- directory replacement is unsupported;
- there is no generic “replace-directory” operation.

A mutable directory rule authoritatively covers its declared lexical subtree,
but this package cannot prove what currently exists there, whether a target is
the expected object kind, or whether mounts or links change the actual effect.

## Rename semantics

Rename is always evaluated as two authority questions:

```js
policy.decideRename({
  kind: "file" | "directory",
  sourcePath: "old/path",
  destinationPath: "new/path",
  destinationMode: "create" | "replace",
  requiresSymlinkResolution: false
});
```

The frozen result contains complete `source` and `destination` decisions. File
rename maps to source `remove-file` plus destination `create-file` or
`replace-file`. Directory rename maps to source `remove-directory` plus
destination `create-directory`.

The pair is lexically allowed only if both questions allow. An immutable or
out-of-scope source cannot be rescued by a mutable destination. Denial takes
precedence over unsupported semantics. Same-path renames, directory moves
between ancestor/descendant paths, symlink-dependent pairs, and directory
replacement are unsupported. No rename is performed and destination existence
is not inspected.

## Symlinks and execution authority

TaskContract v1 states `symlinkPolicy: "unsupported"`; this package preserves
that value exactly. A pure lexical function cannot know whether any path segment
or leaf traverses a symlink. When a caller already knows resolution is needed,
`requiresSymlinkResolution: true` yields `unsupported` for an otherwise mutable
path.

The invariant is literal:

```text
lexical allow
!=
safe execution authorization
```

`@dsh-dsworker/plugin-path-guard` now supplies the first adapter: it binds the
runner-supplied workspace, performs filesystem-aware proof, and lets rc.6
`tools.guard()` preserve only a proven `edit`/`write` call. That behavior remains
outside this pure package. The strict worker route must also run inside outer OS
containment, which is not implemented.

## Why Bash is outside this package

A structured path argument identifies a bounded lexical target. Arbitrary Bash
text can create, remove, rename, link, mount, or mutate paths that cannot be
derived safely from a command string without implementing shell semantics and
tracking subprocess effects. PathAuthority therefore makes no Bash decision.
Bash-side write policing, command execution, and OS containment remain separate
future boundaries.

## Deliberate non-capabilities

This package does not:

- parse another task representation or compute another authority digest;
- mount a Cordis plugin, DSH Loader row, tool, prompt, context, or session event;
- read the filesystem, resolve symlinks, inspect mounts, or bind workspace root;
- authorize Bash, subprocess, network, Git, metadata, or device effects;
- execute commands or filesystem operations;
- integrate rc.6 `tools.guard()`;
- implement task checking, evidence, retries, PASS/FAIL, or containment.

The implemented thin rc.6 adapter is documented in `docs/path-guard.md`. It
receives this compiled policy through the genuine TaskContract, performs
filesystem binding, and never parses the original task input.
