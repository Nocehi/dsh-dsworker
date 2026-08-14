# GREEN-only workspace delta

`@dsh-dsworker/workspace-delta` is a host-only handoff between one completed
worker run and an independently reviewed promotion step. It is not evidence
persistence and is not a completion predicate.

## Lifecycle

Before an Agent exists, `createWorkspaceDeltaBinding()` captures bounded
snapshots of both the runner-supplied source tree and the freshly materialized
worker tree. Their sorted path/type/mode/content projections must match. The
binding retains the exact genuine `TaskContract`, `contractSha256`, roots, and
source content-tree identity.

After a committed authoritative GREEN and a normally completed rc.6 turn, but
before any worker resource is disposed, `exportWorkspaceDelta()`:

1. proves that the source tree has not changed since binding;
2. snapshots the final worker tree;
3. reuses `compareWorkspaceSnapshots()` against the exact TaskContract;
4. rejects every change outside mutable authority;
5. exports sorted file create/modify/delete entries with before/after SHA-256;
6. emits exact after bytes as base64 plus a deterministic UTF-8 unified patch.

The binding is single-use and deeply immutable. It creates no Loader row,
prompt section, tool schema, durable context, session event, provider input, or
credential access.

WorkspaceDelta deliberately remains a **baseline -> final** artifact. It does
not claim that every promoted byte was authored by the model trajectory.
`TaskCheckResult.effectAttribution` records the existing checkpoint boundaries
separately as baseline -> preCommands (model-phase surviving effects),
preCommands -> postCommands (authoritative-command effects), and baseline ->
postCommands (final effects). This host-only evidence does not change the GREEN
predicate or the model-facing `task_check` projection. See
[task-check-effect-attribution.md](task-check-effect-attribution.md) for the
exact semantics and limits of that evidence.

## Promotable subset

The first handoff deliberately supports ordinary single-link UTF-8 files with
portable ASCII patch paths. Directory changes, type changes, mode changes,
binary files, symlinks, hard links, special nodes, and snapshot races fail
closed. `.git`, `.zig-cache`, and `zig-out` are never promotable even if a
future contract were to list them as mutable.

The exact artifact contains the sorted operations, content hashes, modes, and
base64 after bytes. The unified patch is a review projection of the same bytes;
its own SHA-256 and byte size are retained. Tests apply the patch to a fresh
copy and prove create/modify/delete reproduction.

## WorkerResult rule

Only a final `green / authoritative-green` WorkerResult may contain a genuine
`WorkspaceDelta`. RED, ABORTED, malformed or missing terminal observations,
delta export failure, containment/runtime failure, and any cleanup failure
return `delta: null`. A candidate produced before cleanup is discarded if a
later disposer fails.

Promotion is intentionally outside WorkerKernel. A trusted supervisor must
still prove the original checkout's frozen base, clean state, mutable-path
subset, before hashes, and absence of cache/generated artifacts before applying
the exact patch. The supervisor must not edit or improve the worker patch.
