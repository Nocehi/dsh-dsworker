# dsh-dsworker architecture

## Composition boundary

The authoritative implementation target is the locally installed
`@deepseek-ai/*` `0.1.0-rc.6` closure. `@dsh-dsworker/bundle-core` is applied
after these bundles:

```text
@deepseek-ai/dsh-base
@deepseek-ai/dsh-headless
@dsh-dsworker/bundle-core
```

The base bundle remains the dependency closure for v0. The local overlay
disables mounted behavior instead of claiming that uninstalled package weight
has been removed. This keeps the first proof small and makes every omitted row
assertable in the composed Loader inventory.

The rc.6 product CLI always appends its shipped preset root when an
`agent-presets` row exists. It replaces that row's configured `roots` field.
Therefore the out-of-tree `lean-coding` preset is copied into the transient
`$DSH_HOME/.agent-presets` root rather than pretending a custom root survives
the product overlay. `includeUserRoot` is safe here because `DSH_HOME` is a new
temporary directory; the real `~/.dsh` catalog is unreachable.

## Shared agent plane

`lean-coding/agent.cordis.yml` is a complete rc.6 agent preset. It contains:

- one static persona;
- `dsh-tool-bash` with background jobs disabled;
- `dsh-tool-fs`;
- `dsh-tool-fs-search`;
- an isolated compaction backend and deterministic tool-result pruner.

The host retains the registry/provider/policy seams: agent loop, prompt and
tool registries, local filesystem provider, the contained subprocess provider,
filesystem observation,
sandbox policy, approval, sessions, persistence, token meter and spill. The
preset suppresses runtime-context prose, but that does not disable or strengthen
the underlying policies.

With the attachment backend disabled, rc.6 `dsh-tool-fs` conditionally omits
`read_image`. The pinned native tool set is therefore:

```text
bash edit glob grep read write
```

The preset is surface-independent. Future Web and runner packages should call
`agentPresets.mount(agentCtx, "lean-coding")` from the agent factory's setup
transaction. They should not copy its tool/persona rows into their own bundles.

## Shared task authority plane

`@dsh-dsworker/task-contract` is a host-side library, not a Cordis plugin. The
headless development package can resolve and import it, but no Loader row,
prompt section, context contribution, tool schema, or session event is mounted.

```text
                    immutable TaskContract
                             │
              ┌──────────────┼───────────────┐
              ▼              ▼               ▼
     future tools.guard      task-check     future evidence
              │              │               │
              └──────────────┴───────────────┘
                       same authority
```

The parsed object and its `contractSha256` are the future join point. No branch
may reconstruct task meaning from source JSON or shell strings. See
`docs/task-contract.md` for the closed schema and security limits.

`@dsh-dsworker/path-authority` is the first consumer of that join point. It
accepts only the genuine parsed object, retains its exact reference and frozen
path arrays, and compiles a pure lexical decision engine:

```text
                    immutable TaskContract
                             │
              ┌──────────────┼───────────────┐
              ▼              ▼               ▼
       PathAuthority       TaskCheck       future evidence
              │              │               │
       plugin-path-guard      │               │
              └───────────────┴───────────────┘
                        same authority
```

PathAuthority is not mounted and has no DSH/Cordis dependency. Its `allow`
result is explicitly lexical-only and requires later filesystem binding plus
outer containment; it does not enforce a tool call. See
`docs/path-authority.md`.

`@dsh-dsworker/plugin-path-guard` is the first mounted policy consumer. It
provides a host-only `ctx.pathGuard` service. A runner calls
`pathGuard.bind(agent, taskContract)`; the service compiles the same exact
TaskContract and pins the immutable session-header cwd as its workspace root.
For rc.6 `edit` and `write`, an async `tools/pre-execute` observer prepares a
read-only filesystem proof and the native synchronous `tools.guard()` consumes
that exact execution-keyed result. It contributes no prompt section, tool,
context, session event, or model request field. See `docs/path-guard.md`.

`@dsh-dsworker/task-check-core` and `@dsh-dsworker/task-check-local`
implement the deterministic completion branch without mounting it into DSH:

```text
immutable TaskContract
         │
         ├─ PathAuthority ─ plugin-path-guard
         │
         └─ task-check-core
                  ▲
          task-check-local
       baseline/snapshot/commands
```

The local checker captures its baseline before tested mutation, compares both
pre-command and post-command snapshots against the same TaskContract, executes
the exact frozen semantic/validation/finish command objects without a shell,
and returns one deeply immutable GREEN/RED/ABORTED result. The second snapshot
catches command and Bash side effects outside structured tool guards. Neither
checker package is a Loader row, model tool, prompt/context contributor, or
session event producer. See `docs/task-check.md`.

`@dsh-dsworker/plugin-task-check` is the first deliberately model-visible
authority adapter. The bundle mounts only its host service. The worker kernel
explicitly binds an exact live Agent, the same genuine TaskContract, and a
pre-existing task-check-local baseline; only then does that agent gain one
closed-argument `task_check` schema. The tool calls the existing checker once,
returns an allowlisted bounded summary, and calls rc.6 `concludeTurn()` only for
exact GREEN. An agent-scoped monotonic guard denies later calls already present
in that assistant batch after the GREEN result commits. See
`docs/task-check-tool.md`.

`@dsh-dsworker/worker-kernel` closes the one-run host lifecycle without becoming
a Loader row. It stages a disposable copy and baseline before Agent creation,
creates one genuine execution-containment controller, reads the composition's
existing `agentDefaultModel` selection, mounts the configured default preset,
binds the contained `ctx.subprocess`, PathGuard, and task_check to the same run,
submits only `authority.objective`, folds rc.6 consumed-work facts, and disposes
every owned resource. A synchronous host observation at the final `tools/result`
boundary lets RED cancel the driver before request two without reclassifying the
authoritative RED as ABORTED. Its host-only `@dsh-dsworker/workspace-delta`
binding exports an exact source patch only after authoritative GREEN and before
cleanup; every non-GREEN or cleanup failure returns no promotable delta. See
`docs/worker-kernel.md` and `docs/workspace-delta.md`.

`@dsh-dsworker/execution-containment` is the Linux execution-world seam below
both Bash and TaskCheckLocal:

```text
host AgentLoop/provider
       │
       ├─ structured edit/write ─ PathGuard
       │
       └─ ctx.subprocess ─ bubblewrap controller ─ disposable workspace
                                      ▲
                                      │
                          TaskCheck structural commands
```

It replaces the stock local `ctx.subprocess` Loader row, but preserves the
official rc.6 managed-handle/output lifecycle by subclassing its provider and
wrapping exact spawn vectors. TaskCheckLocal uses the same controller/profile
without becoming a Cordis service. See `docs/execution-containment.md`.

## Request observer

`plugin-request-trace` injects only `llm` and `sessions`. It registers:

- one global, prepended `llm/stream` wrapper;
- `session/event` and `session/disposed` observers;
- one disposal effect that drains its sidecar writer.

It does not call `systemPrompt.section`, `systemPrompt.context`,
`systemPrompt.tools`, `tools.register`, model-selection APIs, or session append.
The integration test captures the actual frozen `GenerateOptions` received by a
real rc.6 `LlmAdapter` twice and compares every enumerable field except
`AbortSignal`. That signal is a host cancellation capability rather than model
input; both runs separately assert its equivalent non-aborted state.

Main loop records are buffered until durable `step/end`, allowing outer tool
calls and Code/PTC sub-dispatch IDs to be correlated with the request that
produced them. Auxiliary calls lacking an agent-loop step are written when their
stream closes. Writes are serialized and drained on plugin disposal.

## Intentionally disabled in v0

- title-generation LLM provider and model retry;
- telemetry exporter;
- attachments and image tool support;
- all global model-facing coding tools, replaced by the preset rows;
- jobs and background bash;
- repository instruction loading;
- skills and broad catalog;
- commands, goal, plan and todo;
- subagent, workflow and Ralph;
- Code/PTC runtime;
- web search and its auxiliary route;
- stock headless startup/runner;
- every Creator/Cordis runtime mutation package, which is absent rather than
  merely hidden;
- Web/Host/client UI packages, which the headless bundle never inserts;
- MCP, which the selected bundles never insert.

The DeepSeek and pi-ai adapters remain host capabilities from `dsh-base`. The
worker kernel does not select either; all worker tests substitute an explicit
scripted adapter. The development dump script makes no provider request.

## Authority and security

- Request tracing is an observer, not a policy boundary.
- Creator is not part of the production composition. No dynamic Cordis code is
  used to author or run this repository.
- DSH's filesystem sandbox remains a trusted policy layer; it does not itself
  imply process or network isolation. The strict worker separately requires the
  tested bubblewrap controller before either Agent or TaskCheck command execution.
- Suppressing runtime-context prose changes model input, not enforcement.
- The strict worker now composes outer OS containment and independent TaskCheck
  validation; neither replaces PathGuard or the other.
- Credentials remain owned by DSH credential/environment services. The trace
  schema is an allowlist and never records credential objects, API keys, HTTP
  authorization headers, or provider wire headers.
- The Web Host loopback API is not an authenticated remote-worker protocol.

## Implemented v1 spine and remaining future boundaries

### v1 deterministic worker kernel

- `task-contract`: implemented as the immutable shared authority object.
- `path-authority`: implemented as the pure structured-path compiler and
  decision engine; it deliberately performs no execution or rc.6 integration.
- `plugin-path-guard`: implemented for structured `edit`/`write` only, with
  monotonic rc.6 guard integration and symlink-fail-closed filesystem binding.
- `task-check-core` and `task-check-local`: implemented as host-only,
  single-use baseline/snapshot/structural-command checking with one typed
  GREEN/RED/ABORTED predicate.
- model-facing `task_check`: implemented as a thin agent-scoped adapter over the
  same exact TaskContract and pre-existing baseline. Exact GREEN alone calls
  `ToolRunContext.concludeTurn()`; no retry is introduced.
- `worker-kernel`: implemented as the provider-agnostic one-run lifecycle with
  exactly one typed GREEN/RED/ABORTED result and no retry.
- `workspace-delta`: implemented as the immutable GREEN-only, pre-cleanup
  file-delta handoff; it is neither a completion predicate nor persistent
  evidence.
- `execution-containment`: implemented as the Linux-only, fail-closed
  bubblewrap backend shared by rc.6 Bash/subprocess and TaskCheck commands.
- `evidence`: hashes, diff, commands and fail-closed terminal result.
- evidence persistence and production transport wrappers remain future work.

### Provider overlays

- DeepSeek official worker route using the existing rc.6 adapter.
- OpenRouter route using the installed rc.6 `dsh-llm-pi-ai` adapter.
- Both must reuse the exact worker preset and deterministic policy.

### Other surfaces

- A Web profile mounts the same generated coding preset and adds only Web UX,
  approval answerers and explicitly selected human-facing context.
- An optional orchestration bundle may add jobs, goal, subagent, workflow and
  Ralph without changing default coding geometry.

### Production-target dogfood

Zigsh has now been used as a production target through the ordinary lean-coding
agent, contained Bash provider, TaskCheck, and GREEN-only WorkspaceDelta path.
That exercises the existing worker spine; it does not make Zigsh a DSH shell
provider. Three bounded tasks reached authoritative GREEN and were promoted
only after independent delta review. The detailed evidence boundary and run
facts are in `docs/production-dogfood.md`.

### Future Zigsh execution-backend experiment

The design goal is held literally:

```text
same system digest
same tool-schema digest
same task semantics
different execution backend
```

Zigsh as an execution backend would be a shell consumer/provider experiment
beneath the existing `bash` tool contract and above the same contained
`ctx.subprocess` boundary. It must not fork the preset, TaskContract, PathGuard,
TaskCheck, or containment policy merely to change shell execution behavior.
