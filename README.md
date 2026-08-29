# dsh-dsworker

`dsh-dsworker` is a provider-agnostic deterministic worker harness built on
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The model proposes changes. The host owns an immutable task contract, mutation
authority, process containment, and independent completion checks. Only an
authoritative GREEN run can return a promotable workspace delta.

```text
host TaskContract
       |
       v
DeepSeek Harness agent
       |
       +-- structured writes -> PathAuthority + PathGuard
       +-- subprocesses      -> Linux bubblewrap containment
       |
       v
independent TaskCheck
       |
       +-- RED / ABORTED -> no promotable delta
       `-- GREEN         -> exact WorkspaceDelta -> host review / promotion
```

The roles are deliberately separate:

- **dsh-dsworker** is the active deterministic worker harness in this
  repository.
- **DeepSeek Harness** is the external agent/runtime substrate, pinned here to
  `@deepseek-ai/dsh@0.1.1-rc.2`.
- **Zigsh** is a production dogfood target. It is not a Bash replacement,
  `ctx.shell` implementation, or subprocess backend in this project.

## What is implemented

- a canonical, deeply immutable `TaskContract` shared by every authority
  consumer;
- pure lexical `PathAuthority` plus a DSH-bound guard for structured `edit` and
  `write` calls;
- Linux bubblewrap containment shared by model-controlled Bash and
  authoritative TaskCheck commands;
- deterministic baseline/final snapshots and structural command execution;
- one model-facing, single-use `task_check` tool: exact GREEN alone concludes
  the turn;
- a provider/model-agnostic WorkerKernel with exactly one terminal
  GREEN/RED/ABORTED result and no automatic retry;
- an exact GREEN-only WorkspaceDelta, exported before deterministic cleanup;
- a zero-model-input request observer and snapshot-pinned prompt/tool geometry;
- one lean coding composition with `bash`, `edit`, `glob`, `grep`, `read`, and
  `write`, plus `task_check` only after host binding.

The WorkerKernel does not choose a provider, model, reasoning mode, or
credential source. Those remain external DeepSeek Harness configuration seams.
The provider-free test suite uses deterministic scripted adapters and performs
no model request or credential resolution.

## Requirements

- Linux;
- Node.js 22 or newer and npm (the current release was exercised with Node
  26.4.0 and npm 12.0.1);
- `/usr/bin/bwrap` from bubblewrap, with usable user, PID, network, IPC, UTS,
  and cgroup namespaces;
- Zig 0.16.0 for the Zig-cache containment regressions;
- the public npm registry for initial dependency installation.

DeepSeek Harness is installed as an ordinary project dependency. Its source is
not vendored, and no global npm installation is required.

## Provider-free quick start

```bash
git clone https://github.com/Nocehi/dsh-dsworker.git
cd dsh-dsworker
npm ci
npm run check
```

`npm ci` installs the exact root dependency
`@deepseek-ai/dsh@0.1.1-rc.2` and its external closure, then links the local npm
workspaces. `npm run check` runs syntax validation and the complete unit,
composition, fake-adapter, pinned-DSH lifecycle, containment, Git, and Zig-cache
suite. The bubblewrap tests fail closed if the required namespace boundary is
unavailable; they are not silently skipped.

Normal resolution starts at this project's `node_modules`. For a reviewed
local development installation only, `DSH_NODE_MODULES` may point to a
different existing `node_modules` directory. The resolver still requires the
exact version declared by root `devDependencies["@deepseek-ai/dsh"]` (currently
`0.1.1-rc.2`) and gives an actionable error when absent or mismatched. There is
no machine-specific fallback path.

To inspect the composition without starting an agent or calling a provider:

```bash
./scripts/transient-dev --dump-config
./scripts/transient-dev --keep --dump-default-config
```

The script creates a transient `/tmp/dsh-dsworker-dev.XXXXXX` home, materializes
only the reviewed profile/preset, validates the composition, and launches the
pinned DSH dump surface with a clean environment. It never writes the user's
persistent `~/.dsh`; the default removes its temporary home.

The explicit worker CLI is documented in
[docs/worker-kernel.md](docs/worker-kernel.md). Invoking that CLI is not part of
the provider-free quick start: it uses whatever provider/model selection the
caller has deliberately configured in DeepSeek Harness.

## Authority and security boundary

The central invariant is:

```text
model says "done" != authoritative GREEN

authoritative GREEN =
  allowed final workspace state
  AND immutable authority intact
  AND semantic commands pass
  AND validation commands pass
  AND finish commands pass
```

Notable boundaries:

- PathGuard remains a fail-closed authority layer for structured mutations;
  containment does not replace it.
- TaskCheck independently detects surviving unauthorized changes, including
  Bash effects; prevention does not replace completion authority.
- Contract-declared immutable `.git` is overlaid read-only inside contained
  processes, while TaskCheck still snapshots and verifies it.
- `GIT_OPTIONAL_LOCKS=0` prevents optional read-only Git stat-cache refreshes.
- runner-owned `ZIG_GLOBAL_CACHE_DIR` and `ZIG_LOCAL_CACHE_DIR` route ordinary
  compiler caches to sandbox-private `/tmp`.
- A fixture may pre-create an empty `.zig-cache/tmp` when Zig's
  `std.testing.tmpDir` semantics require a testing scratch root. Any residual
  child remains a TaskCheck scope failure; compiler cache objects are not
  ignored.
- Contained commands have private network, PID, IPC, UTS, cgroup, home, and tmp
  namespaces; runtime roots are read-only and capabilities are dropped.
- Explicit shell syntax can override an environment variable after Bash has
  started. No shell parser is claimed; TaskCheck remains the backstop for
  resulting workspace writes.
- The project does not claim protection against a kernel or bubblewrap
  compromise. PTY execution and deterministic CPU/memory/process-count/disk
  quotas remain unsupported or fail closed.
- The Web Host loopback API is not an authenticated remote-worker protocol.

See [execution-containment.md](docs/execution-containment.md),
[task-contract.md](docs/task-contract.md),
[path-authority.md](docs/path-authority.md),
[path-guard.md](docs/path-guard.md), and
[task-check.md](docs/task-check.md) for the exact contracts.

## Packages

- `@dsh-dsworker/task-contract`: closed parsing, canonical identity, and deep
  immutability for host task authority.
- `@dsh-dsworker/path-authority`: pure deterministic structured-path policy.
- `@dsh-dsworker/plugin-path-guard`: DSH-bound pre-execution/filesystem binding
  for structured mutation tools.
- `@dsh-dsworker/execution-containment`: fail-closed Linux bubblewrap process
  backend shared by Bash and TaskCheck.
- `@dsh-dsworker/task-check-core`: pure GREEN/RED/ABORTED predicate.
- `@dsh-dsworker/task-check-local`: bounded snapshots and exact structural
  command executor.
- `@dsh-dsworker/plugin-task-check`: single-use DSH-bound `task_check` adapter
  and authoritative terminal observation.
- `@dsh-dsworker/worker-kernel`: one-contract/one-run host lifecycle.
- `@dsh-dsworker/workspace-delta`: immutable, exact, GREEN-only handoff.
- `@dsh-dsworker/plugin-request-trace`: zero-model-input request/topology
  observer.
- `@dsh-dsworker/bundle-core`: lean out-of-tree DSH composition overlay.

The pinned model-facing geometry is:

```text
system:          1544 bytes
unbound tools:   7005 bytes / 6
bound tools:     7350 bytes / 7
task_check:      +345 bytes
durable context: 0 bytes
```

## Production dogfood

Three bounded Zigsh production tasks reached authoritative GREEN and were
promoted only after independent WorkspaceDelta review:

| Task | Requests / tool calls | Promoted path |
| --- | ---: | --- |
| null `child.id` cleanup | 15 / 21 | `src/pipeline.zig` |
| lexer failure atomicity | 15 / 21 | `src/lex.zig` |
| EOF suffix after recoverable OOM | 35 / 44 | `src/stream.zig` |

Candidate 3's first trajectory was authoritative RED before commands because
model-side Zig inspection created 49 unauthorized `.zig-cache/**` nodes. A
provider-free correction routed ordinary compiler caches to private `/tmp`.
The controlled rerun then reached all six authoritative commands, passed its
independent oracle, returned GREEN, and promoted only `src/stream.zig`. These
are production observations, not a benchmark or provider-quality conclusion.
Exact hashes and evidence boundaries are in
[docs/production-dogfood.md](docs/production-dogfood.md).

## Development status and deferred work

This initial release intentionally defers OpenRouter routing, PTC/Code mode,
orchestration, Web/UI, persistent RunManifest evidence, Zigsh as an execution
backend, retries, and repair generations. They must reuse the same TaskContract
and deterministic completion spine rather than fork policy.

A minimal public CI workflow is also deferred: reproducing the exact Zig 0.16,
bubblewrap, namespace, and pinned-DSH integration boundary in a hosted runner
needs a separately validated setup. The local provider-free gate is complete
and does not hide required integration tests.

## License and provenance

This repository is MIT licensed. It is an independent project, not official
DeepSeek software. DeepSeek Harness is an external dependency with its own
copyright and license; no upstream source is vendored here. See
[NOTICE.md](NOTICE.md).
