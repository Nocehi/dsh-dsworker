# Model-facing authoritative task check

`@dsh-dsworker/plugin-task-check` is the thin rc.6 adapter over the existing
host-only checker. It adds no checker semantics and does not create a second
task representation:

```text
exact parsed TaskContract
          +
pre-mutation TaskCheckBinding
          +
exact live rc.6 Agent/workspace
          |
          v
agent-scoped task_check
          |
          v
runTaskCheck(binding) exactly once
          |
          +-- GREEN   -> bounded result + concludeTurn()
          |
          +-- RED     -> bounded result, no concludeTurn()
          |
          `-- ABORTED -> no concludeTurn(); rc.6 cancellation owns final error
```

This package does not own the worker lifecycle. Nothing in it parses source
contract JSON, captures a baseline, enforces Bash, chooses a provider, persists
evidence, or decides GREEN.

## Exact local rc.6 seam

The implementation target is the installed `@deepseek-ai/dsh-tools`
`0.1.0-rc.6` contract:

- `agent.ctx.tools.register(definition)` registers one tool only in that agent
  scope and returns its disposer;
- an omitted `isConcurrencySafe` makes the tool exclusive in the AgentLoop
  scheduler;
- the tool body receives `ToolRunContext`, including the caller-owned
  `AbortSignal` and no-argument `concludeTurn()`;
- `concludeTurn()` marks the execution internally; rc.6 emits
  `concludesTurn: true` only on the final successful `ToolExecutionResult`;
- AgentLoop commits the complete tool-call batch, then stops before another
  model step when any committed successful result concludes the turn.

That last point means `concludeTurn()` alone does not skip later calls already
present in the same assistant response. The adapter therefore registers an
agent-scoped monotonic guard. A GREEN execution is staged in the tool body and
becomes terminal only when the exact final `tools/result` is successful and
still carries `concludesTurn: true`. From that point, every later same-batch tool
call is denied. A post-policy failure or cancellation clears the pending state
without claiming terminal success.

The empty author-facing parameter map used by rc.6 `defineTool()` is an open
object root. `task_check` instead uses a trusted raw ToolDefinition with this
closed schema and validates the value again in its body:

```json
{"type":"object","properties":{},"required":[],"additionalProperties":false}
```

No timeout metadata is declared on the tool. The authoritative per-command
timeouts remain in TaskContract, and outer cancellation is forwarded through
`exec.signal` to `runTaskCheck()`.

## Binding authority

`ctx.taskCheckTool.bind(agent, contract, taskCheckBinding, options?)` requires
all three identities:

- the exact Agent object currently registered in rc.6 AgentRegistry;
- the exact branded object returned by `parseTaskContract()`;
- the exact branded, pre-existing object returned by
  `createTaskCheckBinding()`.

The check binding must retain the same TaskContract reference and
`contractSha256`. Its normalized absolute workspace root must equal the Agent
session header cwd. Structural lookalikes, reconstructed contracts, a different
workspace, and a second binding for the same agent fail closed.

The adapter does not create or dispose the local check binding. Baseline
lifecycle remains runner-owned. Disposing the adapter binding unregisters the
tool, result observer, and terminal guard; it does not erase or reset a consumed
authoritative check.

The only optional field is `onTerminalObservation`. It is a synchronous,
contained host callback invoked from the exact final `tools/result` emit. Its
branded, deeply immutable observation carries the genuine TaskCheckResult only
when the rc.6 commit matches the expected GREEN/RED/ABORTED form. It carries no
rendered tool content, is never added to model input or session history, and a
throwing callback cannot change the tool result.

## Single-use terminal semantics

The first well-formed direct invocation consumes the adapter attempt before
`runTaskCheck()` starts. The same `ToolRunContext.signal`, exact contract
reference, and exact bound workspace are passed to the checker. There is no
automatic or model-level retry:

- GREEN calls `concludeTurn()` and stages terminal closure;
- RED returns the bounded projection and does not conclude;
- ABORTED does not conclude; because the same caller signal remains aborted,
  rc.6's post-body cancellation rule replaces the would-be successful summary
  with its canonical `ABORTED` tool failure;
- any second call is a typed `TASK_CHECK_ALREADY_USED` tool failure;
- nested Code/PTC dispatch is rejected; this v1 route is native-only;
- adapter/configuration failure is rendered as the fixed
  `TASK_CHECK_ADAPTER_FAILURE` message, without leaking its thrown detail.

RED not concluding is an rc.6 loop fact, not permission to produce another
authoritative verdict. Likewise, rc.6 replacing the local ABORTED verdict with
its canonical tool error does not create another attempt. The optional
host-only `onTerminalObservation` binding callback now carries the exact final
commit fact to `worker-kernel`; it appends no session event. The kernel maps RED
at that synchronous boundary before another Agent step while preserving RED as
the worker outcome.

## Bounded model-visible result

The canonical checker result stays host-side. The tool returns only an
allowlisted projection containing:

- status, `contractSha256`, and workspace identity;
- the nine GREEN predicate booleans;
- baseline/pre/post snapshot status codes;
- scope and immutable checkpoint summaries;
- command id/phase/pass/exit/signal/timeout/cancellation summaries;
- typed failure category/code/checkpoint/phase/id/path fields.

It never returns objective text, TaskContract metadata, argv, environment,
stdout/stderr text, file contents, process error text, provider data, or
credentials. Caps are fixed at 32 command rows, 32 failure rows, 64 changed
paths per checkpoint, and 256 Unicode code points per returned string. Total
and omitted counts preserve the fact that truncation occurred. Secret-shaped
strings in even those allowlisted fields are replaced with `<redacted>`.

## Model geometry

Mounting the plugin service without a binding contributes zero system bytes,
zero tool-schema bytes, and zero durable-context bytes. The shared unbound
`lean-coding` preset remains:

```text
system:          1544 bytes
tool schemas:    7005 bytes
durable context: 0 bytes
tools:           bash edit glob grep read write
```

Binding an agent intentionally changes only its tool plane:

```text
task_check schema:          344 canonical bytes
complete tool-schema delta: 345 bytes
bound tool schemas:         7350 bytes
tools:                      bash edit glob grep read task_check write
```

The bound system digest and durable-context digest remain identical to the
unbound preset. Exact digests are pinned in
`tests/composition/snapshots/task-check.geometry.json`.

## Security boundary

`task_check` is deterministic completion policy, not containment. It does not
make Bash safe, prevent an external process from racing the workspace, enforce
network policy, authenticate a remote client, or turn rc.6 in-process policy
into a kernel boundary. The strict worker composes it with a separate
fail-closed bubblewrap execution boundary; neither package inherits or replaces
the other's authority.
