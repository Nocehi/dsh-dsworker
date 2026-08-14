# Deterministic task checking

The v1 step 4 checker consists of two host-only libraries:

- @dsh-dsworker/task-check-core owns immutable terminal states and the sole
  GREEN predicate.
- @dsh-dsworker/task-check-local owns a local baseline, bounded filesystem
  snapshots, structurally exact contained argv execution, timeout/cancellation, and
  before/after authority checks.

Neither package is a Cordis plugin, Loader row, model tool, system-prompt
section, durable-context producer, or session-event producer.

> model says "done"
> !=
> task is authoritative GREEN

And the complete predicate is:

> authoritative GREEN
> =
> post-state authority
> AND immutable authority
> AND semantic checks
> AND validation checks
> AND finish checks

Baseline validity, both bounded snapshots, lack of cancellation, complete
command coverage, and intact checker infrastructure are additionally mandatory.
There is no mostly-green state and no model judgment.

## Authority and baseline lifecycle

createTaskCheckBinding accepts only the exact branded, deeply frozen object
returned by parseTaskContract. It retains the exact object and
contractSha256, compiles the existing PathAuthority, pins a runner-supplied
absolute workspace root, sanitizes an explicit runner base environment, and
captures the baseline immediately.

The returned binding is frozen. Its private baseline contains metadata and
hashes but no file contents. A workspace can have only one active binding.
The binding is single-use: a second run is rejected, and a second baseline on
the same workspace is rejected until disposal. A check request naming a
different genuine TaskContract object or a different workspace returns
terminal RED with a typed binding failure. Source JSON, structural lookalikes,
and reconstructed contracts are rejected before binding.

workspaceIdentity is a host/debug identity, not task authority. It is SHA-256
over the bound absolute path and the root realpath/device/inode facts available
at binding. contractSha256 remains the only task-authority identity.

The runner must create the binding before any tested mutation. A final tree
alone cannot prove which paths changed.

## Snapshot model

The reference local snapshot provider works in non-Git directories and has no
ignore rules. It traverses names in ECMAScript code-unit order and records:

| Node | Retained identity |
|---|---|
| regular file | relative path, type, mode, uid/gid, byte size, mtime/ctime, SHA-256 |
| directory | relative path, type, mode, uid/gid |
| symlink | never traversed; snapshot fails closed |
| hard-linked file | unsupported; snapshot fails closed |
| special node | unsupported; snapshot fails closed |
| nested mount/device boundary | unsupported; snapshot fails closed |

File bytes are streamed into SHA-256 and are never put into the snapshot or
terminal result. The local implementation opens regular files with O_NOFOLLOW
where the platform exposes it, compares lstat/open identities, and verifies
file and directory identities around reads. These checks reduce races but are
not kernel containment.

Default complete-snapshot bounds are 10,000 entries and 268,435,456 total file
bytes hashed. Both are runner-configurable positive integers. Exceeding either
returns a typed failed snapshot with no partial entry set and no partial
snapshot digest. Snapshot SHA-256 covers the deterministic ordered metadata
array; it is a state/debug digest, never a competing authority digest.

Non-UTF-8, backslash-bearing, and control-character path names are unsupported
on the local POSIX provider because TaskContract uses Unicode strings and
backslash as a lexical separator. Failing closed prevents one physical name
from being reinterpreted as a different authority path.

## Scope and immutable verification

Every baseline-to-checkpoint delta is classified as created, deleted, changed,
or type-changed. File operations reuse the existing PathAuthority vocabulary:
create-file, replace-file, and remove-file. Directory create/delete operations
reuse create-directory and remove-directory. The checker does not duplicate
TaskContract normalization or mutable-path matching.

A file ownership/mode change and a directory ownership/mode change are
unsupported even below
a mutable rule because TaskContract v1 grants structured content/path
mutation, not chmod authority. Everything outside mutable authority is RED.
This catches direct host writes and Bash side effects that plugin-path-guard
cannot intercept.

Every immutable declaration is independently checked at baseline, immediately
before commands, and after commands. A pinned immutable file SHA-256 must match
at all three points. Without a pinned digest, the complete baseline node
identity is the required run identity. An immutable directory comparison
covers the declared directory and its complete lexical subtree.

The checker never trusts another component's changed-path report.

## Command execution

Commands are consumed directly from the exact frozen TaskContract arrays in
this order:

    semantic
    validation
    finish

List order within each phase is preserved. The executor requires the exact
command object retained by TaskContract. It preserves the executable and argv
as a structural payload to the fixed bubblewrap wrapper, then calls Node
`child_process.spawn` on that wrapper:

- shell is false;
- argv is never joined, split, quoted, interpolated, or glob-expanded;
- cwd is the workspace root or the exact workspace-relative directory in the
  contract;
- a relative executable containing a slash is resolved from the workspace
  root; a bare executable is looked up through the runner base PATH;
- command environment entries are literal overrides layered on the sanitized
  runner base;
- expected exit codes come only from the command's expected.exitCodes set;
- no command is retried.

Before each spawn, the local checker re-proves that the command cwd is a chain
of real directories beneath the canonical workspace. Workspace-relative
executables must be real regular files and may not cross a symlink.

The installed rc.6 closure exposes a reusable managed subprocess service with
direct argv, explicit cwd/stdio, a scrubbed ambient base, AbortSignal-driven
tree termination, and bounded collection. It is a Cordis service. TaskCheckLocal
must remain usable outside Cordis, so it does not inject that service. Instead,
the runner supplies the same genuine `execution-containment` controller used by
rc.6 `ctx.subprocess`; TaskCheckLocal converts the exact command vector into the
same fixed bubblewrap profile, then uses its existing Node process/output
lifecycle. If no controller is supplied to the standalone host API, binding
creates and owns one; uncontained fallback does not exist.

## Environment policy

The local checker never spreads process.env. The runner must supply a plain
baseEnvironment and must include PATH when bare executable lookup is needed.
Keys are sorted and values are cloned. Credential-shaped keys are removed
before execution; only their key names appear in the binding's policy summary.
No removed value is retained or serialized.

The command's TaskContract environment map is then applied as the exact
authoritative override. TaskContract already rejects credential-shaped
override keys. The containment launch uses a fixed absolute bwrap executable,
clears the child environment, and passes only the sorted sanitized map through
`--setenv`. The runner owns executable availability and the contents of its
base PATH; that fact is not silently promoted into TaskContract authority.

## Timeout, cancellation, and process cleanup

Each TaskContract timeout starts after spawn and triggers TERM followed by KILL
after a bounded grace. An external AbortSignal uses the same cleanup path but
produces ABORTED rather than timeout RED. The fixed bubblewrap wrapper starts in
a new host process group; cleanup targets that group. Inside it, a private PID
namespace plus bubblewrap's namespace-init lifecycle prevents a session-escaped
descendant from surviving wrapper teardown. A surviving observable process group
is detected, killed, and makes the command RED. Spawn failure, containment
runner failure, signal termination, unexpected exit, timeout, output-limit
termination, and a remaining process group have distinct codes.

This Linux v1 behavior has no weak non-Linux fallback. It still does not supply
memory, CPU, process-count, or disk quotas.

## Output retention and command outcome

The default combined stdout/stderr observation bound is 16 MiB. Each stream is
hashed incrementally and counted while under the bound. No stdout/stderr text
excerpt is retained. Normal completion therefore yields a full-stream byte
count and SHA-256 without persistent output. Crossing the bound terminates the
command, marks outputLimitExceeded, and makes the result RED; its counts and
digests then cover only the bounded observed prefix.

Each frozen command result contains:

- phase, command id, executable, and SHA-256 of the exact JSON argv vector
  including argv[0];
- resolved cwd and start/completion timestamps;
- exit code, signal, timeout, cancellation, spawn, output-limit, and
  process-tree facts;
- stdout/stderr byte counts and SHA-256;
- expected exit codes and a derived passed boolean.

It contains no reconstructed shell command, environment values, output text,
file contents, provider data, or credential data.

## Deterministic check order

One run uses this fixed sequence:

    already-captured baseline
      -> pre-command complete snapshot
      -> pre-command scope and immutable verification
      -> semantic commands in order
      -> validation commands in order
      -> finish commands in order
      -> post-command complete snapshot
      -> post-command scope and immutable verification
      -> task-check-core terminal predicate

Commands are not started when baseline or pre-command authority is invalid.
Ordinary nonzero exits do not reorder or hide later phases. External
cancellation stops the remaining command list and yields ABORTED. A command
that creates an unauthorized artifact can pass its own exit contract and the
overall run is still RED at the second snapshot.

## Typed terminal result

task-check-core returns exactly green, red, or aborted:

- green means both snapshots are valid, pre/post scope is authorized, all
  immutable checkpoints hold, every authoritative command is present in exact
  order and passes, no cancellation occurred, and checker infrastructure is
  intact;
- aborted means explicit caller cancellation was observed;
- red means every other completed fail-closed result, including timeout,
  command failure, unsupported filesystem state, authority mismatch, or
  unauthorized mutation.

The result, nested snapshots, findings, command records, arrays, and predicate
facts are deeply frozen. The core derives passed and GREEN rather than trusting
caller-supplied success booleans.

## Bash and security boundary

plugin-path-guard still does not interpret Bash. In the strict worker,
execution-containment limits Bash to the disposable workspace, while the
independent final snapshot still determines whether a surviving workspace
change was authorized. A disposable Bash write to `foo.py`, for example,
remains RED even though it stayed inside the OS sandbox.

This checker is not Bash policy, a shell parser, a filesystem guard, evidence
sidecar persistence, a model tool, approval, or OS containment. The outer
containment layer is separate; symlinks, hard links, nested mounts, special
nodes, and concurrent mutation in the workspace continue to fail closed in the
snapshot/checker boundary.

## Model-facing adapter

The separately authorized next seam is now implemented by
`@dsh-dsworker/plugin-task-check`. It binds this package's pre-existing local
baseline to the same live Agent and genuine TaskContract, calls runTaskCheck
once, returns only a bounded structured projection, and invokes the local rc.6
`ToolRunContext.concludeTurn()` only for exact GREEN. RED and ABORTED do not
conclude and cannot be retried through the same binding. See
`docs/task-check-tool.md` for the rc.6 hook, same-batch terminal guard, geometry,
and runner terminal boundary.
