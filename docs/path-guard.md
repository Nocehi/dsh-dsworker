# rc.6 structured path guard

`@dsh-dsworker/plugin-path-guard` is the first enforcement adapter between the
immutable dsh-dsworker task authority and the local DeepSeek Harness
`0.1.0-rc.6` tool pipeline. It is intentionally narrow: only the structured
filesystem mutation tools `edit` and `write` are governed.

The core rule is:

```text
lexical allow
+ filesystem proof
= permission for this structured tool mutation to proceed
```

But:

```text
structured-tool permission
!=
complete process/OS containment
```

## Exact local rc.6 hook

The installed rc.6 `ToolRuntime` exposes:

```ts
type ToolGuard =
  (execution: Readonly<ToolExecution>) => string | undefined

ctx.tools.guard(guard): () => void
```

The guard is synchronous. Returning a string is a final denial; returning
`undefined` merely preserves the current permission state. A global guard runs
before scoped guard layers. No guard can force-allow a call another guard
denied. The returned disposer unregisters the guard with normal Cordis lifetime
ownership.

For one execution, rc.6 performs:

```text
argument snapshot + tool validation
  -> tools/pre-execute waterfall
  -> approval resolution for an `ask`
  -> monotonic tools.guard()
  -> tools/execute wrappers
  -> tool body
  -> tools/post-execute
  -> tools/result
```

Consequently, an ordinary `tools/pre-execute` approval request is resolved
before this guard. The adapter does not change that ordering or introduce a
second approval mechanism. An explicit filesystem escalation requested inside
the current rc.6 `write`/`edit` body occurs later still, in the tool's own
`FsSandboxController`, but only after this path guard has permitted dispatch.

Guard denial is materialized by rc.6 as an `isError` tool result with
`Error: <reason>` content and `result.error.message`. The hook has no structured
error-info return arm. This package therefore exposes an immutable host-side
decision callback; it appends no DSH session event.

## Why proof is split across two hooks

Local rc.6 `ctx.fs.resolve()` and `ctx.fs.lstat()` are asynchronous because the
filesystem seam also admits remote providers. `tools.guard()` is synchronous.
Doing I/O inside the guard is therefore impossible without bypassing the
service abstraction or blocking the process.

The plugin uses the narrow composition that rc.6 permits:

1. a prepended async `tools/pre-execute` listener classifies a known structured
   mutation, computes a read-only proof through `ctx.fs`, and stores it in a
   private `WeakMap` keyed by the exact frozen `ToolExecution` object;
2. the listener always delegates to `next()` and never authorizes, denies,
   rewrites arguments, or changes approval;
3. after the full pre-execute/approval stage, the synchronous monotonic guard
   consumes the result for that exact execution;
4. a missing proof, resolver error, unbound agent, malformed intent, lexical
   deny/unsupported, or filesystem deny/unsupported becomes a guard denial.

This preserves the rc.6 ordering and keeps the final authority decision in
`tools.guard()`. The proof cache is execution-local and cleared on consumption
or plugin disposal.

## Authority binding

The mounted plugin provides `ctx.pathGuard`. A host runner binds an exact live
Agent:

```js
const binding = ctx.pathGuard.bind(agent, parsedTaskContract, {
  onDecision(record) { /* optional host-only observer */ },
})
```

`bind` accepts only the genuine object returned by `parseTaskContract()`. It
requires `ctx.agents.get(agent.id) === agent`, calls
`compilePathAuthority(contract)`, verifies exact contract/policy identity, and
pins `agent.session.header.cwd` as the runner-supplied workspace root. Thus a
structural Agent lookalike cannot acquire authority. The binding, compiled
policy, digest, and workspace root are immutable. A second active binding for
the same Agent is rejected; disposal removes the binding.

The static headless-dev profile mounts the policy service but has no task. This
is deliberate: an unbound agent may still use read-only and Bash tools, but
structured `edit`/`write` fail closed until a host runner, including the
provider-agnostic worker kernel, supplies the exact TaskContract. TaskContract
and PathAuthority remain host libraries, not Loader rows.

## Tool mapping

The mapping is pinned to the reviewed lean-coding surface:

| Tool | Classification | Path-guard behavior |
|---|---|---|
| `read` | read-only | unchanged; mutation policy does not imply confidentiality |
| `glob` | read-only discovery | unchanged; rc.6 implements it through fixed ripgrep subprocess argv |
| `grep` | read-only discovery | unchanged; same limitation |
| `edit` | structured mutation | `file_path` maps to `edit-file`; existing regular file required |
| `write` | structured mutation | filesystem state selects `create-file` or `replace-file` |
| `bash` | outside this guard | unchanged; arbitrary process effects remain possible |

The mapper reads only `name`, `callId`, and `arguments.file_path`. It never
retains file content, `old_string`, `new_string`, or unrelated arguments.
Malformed/ambiguous known mutation calls fail closed. An unknown tool is not
silently classified as a supported mutation; the production profile separately
pins the complete six-tool surface.

Local rc.6 validates tool arguments before policy, and the execution argument
snapshot is lossless-JSON detached and deeply frozen. At guard time `file_path`
is still the original structured argument: `dsh-tool-fs` resolves it only in the
body after guards.

## Workspace and symlink proof

PathAuthority first applies the TaskContract lexical semantics. A lexical deny
or unsupported result never touches the filesystem. Only a lexical allow is
eligible for proof.

The filesystem proof then:

1. requires an existing, non-symlink directory at the bound workspace root;
2. resolves a canonical root target through `ctx.fs.resolve`;
3. walks every normalized relative prefix with `ctx.fs.lstat`, rejecting any
   symlink entry and any non-directory parent;
4. requires an existing regular file for `edit`;
5. permits `write` to classify an existing regular file as `replace-file`;
6. permits a missing final target as `create-file` only when every parent
   already exists as a non-symlink directory;
7. resolves the final target and requires `ctx.fs.contains(root, target)`.

The proof performs no writes and reads no file contents. It deliberately denies
a missing parent even though rc.6 local `writeText` creates parent directories
recursively: implicit creation would affect additional paths not represented by
the file-only mutation intent.

The installed local provider resolves existing targets to realpath identity and
missing targets through the nearest realpathed ancestor. Its `lstat` reports the
final path entry without following it. The sandbox provider re-canonicalizes
immediately before its own write and checks containment, but it intentionally
allows contained symlink aliases. TaskContract v1 instead declares
`symlinkPolicy: unsupported`, so this plugin rejects every symlink in the
workspace-relative path chain, including a final symlink and a parent link whose
target remains inside the workspace.

No in-process path check eliminates filesystem races. The rc.6 sandbox itself
documents residual TOCTOU, and this plugin has a wider interval between proof
and dispatch because guard proof must precede the body. A strict worker route
therefore still requires outer OS containment; the worker kernel now supplies
that separate boundary through `execution-containment`.

## Decision and denial taxonomy

The optional host callback receives a deeply frozen record containing only:

- `contractSha256`, tool name/call id and requested path;
- normalized contract path and selected file operation;
- lexical decision/code;
- a metadata-only filesystem result (decision/code, target kind, checked
  relative prefixes and bound root);
- final `permit`/`deny`, denial category, and denial code.

It contains no objective, file contents, command text, environment, credential,
or provider data. Callback exceptions are contained and cannot affect policy.

Denial categories distinguish:

- `policy-deny` / `unsupported-authority` from PathAuthority;
- `filesystem-deny` / `unsupported-filesystem-authority` from binding proof;
- `adapter-input`, `adapter-configuration`, and `adapter-error`.

All categories deny the mutation. There is no override, force, unsafe, or
ignore-policy switch.

## Monotonicity and zero-token behavior

The invariant is:

```text
PathAuthority deny or unsupported        -> deny
PathAuthority allow + absent proof       -> deny
PathAuthority allow + denied proof       -> deny
PathAuthority allow + successful proof   -> preserve permission
```

The plugin registers no model tool, prompt section, prompt context, LLM hook, or
session event. Composition tests compare it enabled/disabled and pin a zero-byte
delta for system prompt, tool schemas, and initial durable context. Fake-adapter
integration compares complete adapter-visible requests, request count, tool
trajectory, and final answer with the guard mounted and bound; all are identical
for a conversation that uses only an unrelated read-neutral synthetic tool.

## Explicit gaps

- This plugin still does not parse or authorize Bash. When used through the
  strict worker kernel, the separate execution-containment provider prevents
  Bash from reaching host filesystem/network/process state, and TaskCheck
  decides whether resulting workspace mutations are authorized. Other
  deployments must supply their own execution boundary.
- Read, glob, and grep are not confidentiality guards.
- chmod, chown, xattrs, links, devices, mounts, Git semantics, rename, directory
  operations, and arbitrary new tools are not authorized here.
- The plugin does not execute TaskContract commands, conclude a turn, decide
  task PASS/FAIL, assemble evidence, retry, route models, or contain processes.
- DSH filesystem sandboxing remains trusted in-process policy, not a kernel
  boundary.

The model-facing `task_check` and strict worker lifecycle are implemented in
separate packages. PathGuard remains deliberately limited to structured
mutation authority even now that the worker has an outer process boundary.
