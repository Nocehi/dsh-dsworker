# Deterministic worker kernel

`@dsh-dsworker/worker-kernel` owns the final host lifecycle for one run:

```text
genuine immutable TaskContract
          |
          v
copy source into /tmp workspace -> create contract-bound containment -> capture baseline
          |
          v
create one rc.6 Agent -> bind contained subprocess + PathGuard + task_check
          |
          v
submit authority.objective exactly once
          |
          v
one host terminal observation -> GREEN | RED | ABORTED
          |
          v
GREEN only: export exact workspace delta while the workspace still exists
          |
          v
dispose bindings, Agent, runtime, baseline, workspace
```

It is a host library, not a Cordis plugin, prompt section, context producer, or
model tool. It adds no system text, tool schema, or durable context.

## Host API

```js
const result = await runWorker({
  contract,                 // exact parseTaskContract() object
  sourceWorkspaceRoot,      // absolute source directory, copied read-only
  baseEnvironment,          // explicit task-command base environment
  sessionId,                // caller-owned rc.6 session identity
  signal,                   // optional AbortSignal
  runtimeFactory,           // ({ workspaceRoot, contractSha256 }) => { ctx, dispose }
});
```

The runtime context must expose the existing rc.6 services `agents`,
`agentDefaultModel`, `agentPresets`, `subprocess`, `pathGuard`, and
`taskCheckTool`. Its `subprocess` provider must expose the local
`bindExecutionContainment()` seam. The kernel reads
`agentDefaultModel.currentSelection()` and passes that detached selection
through `installModelSelection()`. It has no provider, model, thinking, or
reasoning defaults and accepts no such runner options.

`runtimeFactory` is called only after the disposable workspace and baseline
exist. It receives the workspace path and contract digest, not a second task
description. A factory that throws must unwind resources it created before it
returned; once `{ ctx, dispose }` is returned, the kernel owns its disposer.

The model-facing user message is exactly `contract.authority.objective`.
There is no runner-authored prefix, completion hint, path restatement, or second
task prompt. The already bound `task_check` schema carries the completion
protocol.

## Exact rc.6 terminal seam

Local rc.6 `ToolRuntime.finishScheduledExecution()` freezes the final tool
result and synchronously emits `tools/result`. Only after that emit returns does
AgentLoop append durable `tool/result`, inspect `concludesTurn`, refill the tool
scheduler, or enter another model step.

`plugin-task-check` therefore exposes an optional host-only
`onTerminalObservation` binding callback. It retains the genuine
`TaskCheckResult` until the exact final rc.6 commit and validates that commit:

- GREEN must remain a successful result with the exact bounded projection and
  `concludesTurn: true`;
- RED must remain the exact successful projection and must not conclude;
- ABORTED must be superseded by rc.6's canonical `ABORTED` or
  `ABORTED_BEFORE_DISPATCH` tool result;
- a malformed invocation, projection mismatch, digest mismatch, or missing host
  verdict is an infrastructure observation, never an authoritative verdict.

The callback is synchronous, host-only, contained, and not appended to session
history. The kernel uses this exact boundary to cancel an Agent immediately
after a committed RED. rc.6 then records `turn/end: aborted` with cause `hook`,
but the worker result remains authoritative RED. This cancellation is a driver
stop mechanism; it does not reinterpret the checker result.

## Terminal mapping

Every accepted run returns one deeply immutable `WorkerResult` with exactly one
status:

- `green`: a validated task-check GREEN commit and a completed rc.6 turn;
- `red`: authoritative RED, missing/malformed observation, lifecycle failure,
  or cleanup failure;
- `aborted`: authoritative task-check ABORTED or explicit caller cancellation
  before a verdict.

The important precedence rule is:

```text
authoritative RED
  + runner's expected hook cancellation
  = worker RED, not worker ABORTED
```

Model text saying “done” is not terminal authority. An idle/completed Agent
without a valid `task_check` observation becomes
`red / missing-terminal-observation`. An invalid `task_check` call becomes
`red / malformed-terminal-observation` and is stopped before another model
request.

The result retains `contractSha256`, session id, workspace identity, the
detached provider/model selection actually read from `agentDefaultModel`, the
genuine bounded TaskCheckResult when one committed, a compact fold of rc.6
consumed-work/turn facts (including request count and argument-free tool-call
topology), a bounded immutable containment disposition, cleanup
states, an exact GREEN-only WorkspaceDelta (otherwise `null`), and typed
infrastructure failure codes. It does not retain environment
values, provider credentials, wire headers, arbitrary thrown messages, command
output text, or file contents.

## Workspace and cleanup

The source directory must be an absolute real directory. It is copied without
dereferencing symlinks into `/tmp/dsh-dsworker-run.XXXXXX/workspace`; the source
is never mutated. `createTaskCheckBinding()` captures the baseline before an
Agent exists. Its existing bounded snapshot rules remain authoritative.

The kernel passes the exact genuine TaskContract into execution containment.
If that authority declares exact `.git` immutable, the contained subprocess
world overlays the staged `.git` read-only while leaving source paths under the
same workspace writable. TaskCheck independently snapshots and verifies `.git`;
the overlay is not a success predicate or a snapshot exclusion.

An authoritative GREEN candidate is exported before cleanup. Cleanup then runs
on every accepted path, in this order:

1. task-check tool binding;
2. path-guard binding;
3. Agent handle;
4. local task-check binding;
5. workspace-delta binding;
6. runtime containment binding;
7. caller runtime handle;
8. execution-containment controller;
9. disposable workspace.

A cleanup failure changes the process outcome to RED, discards any candidate
delta, and is reported by a typed code. There is no automatic retry or
corrective prompt. See `docs/workspace-delta.md`.

## CLI

The repo-local command is:

```bash
npm run worker:run -- \
  --contract /absolute/path/to/task-contract.json \
  --workspace-source /absolute/path/to/source-fixture
```

It creates a transient `DSH_HOME`, materializes the reviewed `headless-dev`
composition, disables request-trace persistence for the run, and delegates
provider/model selection to the composition's existing
`agentDefaultModel` service. It has no provider/model flags. Exit codes are 0
for GREEN, 1 for RED, 2 for ABORTED, and 64 for CLI/API misuse.

The integration suite does not invoke this command against a real configured
route. It substitutes a deterministic scripted adapter while retaining the
real rc.6 Agent/AgentLoop, ToolRuntime, preset, bindings, and terminal ordering.

## Model geometry

The kernel is not a Loader row. Unbound geometry remains six tools and the
existing pinned hashes. Binding adds only the already implemented
`task_check` schema:

```text
unbound system:       1544 bytes
unbound tools:        7005 bytes (6 tools)
bound tools:          7350 bytes (7 tools)
task_check delta:      345 bytes
durable context:         0 bytes
```

## Deliberate exclusions

The kernel now requires the Linux bubblewrap execution boundary for both rc.6
Bash/subprocess and TaskCheck commands. It still does not provide shell parsing,
PTY execution, memory/CPU/process-count/disk quotas, evidence sidecars, provider
routing, OpenRouter, PTC, Web, retries, or a network allowlist. PathGuard still
covers only structured `edit` and `write` calls, and TaskCheck remains the only
authoritative completion predicate.
