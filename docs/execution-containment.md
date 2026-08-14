# Linux execution containment

`@dsh-dsworker/execution-containment` is the fail-closed execution world for
the strict worker. It is host policy, not a model tool, prompt section, durable
context producer, task-success predicate, or evidence store.

The layers remain independent:

```text
structured edit/write -> PathGuard
arbitrary subprocess  -> execution-containment
final workspace/checks -> TaskCheck
```

Containment does not broaden TaskContract authority, and TaskCheck does not
grant process authority.

## Observed rc.6 seam

The local `0.1.0-rc.6` process path is:

```text
dsh-tool-bash
  -> ctx.shell (dsh-bash-sandbox)
  -> LocalBashExecutor.runArgv/startArgv
  -> ctx.subprocess.spawn(SubprocessSpawnSpec)
  -> dsh-subprocess-local managed handle
```

`SubprocessSpawnSpec` carries an exact argv vector, cwd, environment, stdio,
grace, and AbortSignal. `dsh-bash-local` does not inject or directly call
Node's spawn; its protected `runArgv` and `startArgv` both delegate to
`ctx.subprocess.spawn`. The local provider owns detached process groups,
bounded/spill-backed output, TERM-to-KILL escalation, handle completion, and
disposal.

The bundle therefore disables the stock `subprocess` Loader row and mounts
`ContainedSubprocessRuntime`, a narrow subclass of the official local provider.
It replaces only `spawn` preparation, preserving the official managed handle.
It fails closed until the worker binds one genuine containment controller.
No installed rc.6 file is patched or copied.

The existing `dsh-bash-sandbox` remains above this seam. Its inner bwrap policy
still supplies the rc.6 sandbox/approval result contract. The outer profile is
the security boundary described here; nesting was tested with the exact
workspace path retained as cwd because the inner rc.6 sandbox rebinds that path.

## Controller and disposition

`createExecutionContainment({ workspaceRoot, contract? })` accepts only a canonical,
non-symlink directory strictly below `/tmp`. It verifies Linux, `/usr`,
`/etc/ld.so.cache`, `/usr/bin/bwrap`, the bubblewrap version, and a functional
launch using the complete required namespace profile. Absence or setup failure
throws a typed `unavailable` error; there is no direct-execution fallback.

The returned controller is branded, deeply frozen, bound to one workspace
identity, and recognized through private WeakSet/WeakMap state. A structural
lookalike cannot be used. Every launch checks the exact workspace relation.
When supplied, `contract` must be the genuine object returned by
`parseTaskContract()`. WorkerKernel always supplies its exact contract; the
controller retains that digest and derives only the narrow immutable-Git mount
policy described below. It does not parse source JSON or create a second path
authority representation.

`containmentDisposition()` is a deeply immutable host diagnostic containing
only version/status/code, backend and version, platform, workspace identity,
boundary labels, execution counts, and the names of credential-shaped keys
that were stripped. It never contains environment values, stdout/stderr,
credentials, file contents, command text, or arbitrary exception text.

## Exact bubblewrap boundary

The v1 profile uses the fixed `/usr/bin/bwrap` backend with:

- new user, PID, network, IPC, UTS, and cgroup namespaces;
- `--die-with-parent`, a new session, a private hostname, and all capabilities
  dropped;
- an execution root assembled only from read-only `/usr`, read-only
  `/etc/ld.so.cache`, compatibility symlinks for `/bin`, `/sbin`, `/lib`, and
  `/lib64`, private `/proc`, and minimal private `/dev`;
- the one rc.6 lean-tool executable outside `/usr`: the exact
  `@vscode/ripgrep` binary resolved through `dsh-tool-fs-search`, verified as a
  canonical executable, and mapped read-only to `/opt/dsh-tools/rg` without
  exposing its npm package directory;
- private tmpfs instances for `/tmp` and `/home`, with `/home/worker` as the
  default home;
- the disposable workspace exposed read/write at its exact rc.6 path and at
  `/workspace`;
- when the bound TaskContract declares exact `.git` immutable and that node
  exists as the declared canonical file/directory, an immediate read-only
  overlay after each corresponding workspace bind:

  ```text
  --bind    <workspace>      <workspace>
  --ro-bind <workspace>/.git <workspace>/.git
  --bind    <workspace>      /workspace
  --ro-bind <workspace>/.git /workspace/.git
  ```

  Both aliases are covered, and the ordering survives the nested rc.6 Bash
  bwrap profile. No other immutable path is compiled into a mount in this
  phase;
- no host root, user home, DSH home, repository parent, browser/SSH data, or
  host `/tmp` bind;
- `--clearenv` followed by the sorted, explicit, credential-scrubbed child
  environment;
- no network allowlist and no v1 escape switch.

TaskCheck invokes the host-side wrapper with an empty environment. On the rc.6
path, the preserved official local subprocess provider applies its documented
credential/`DSH_*`-scrubbed parent base to the trusted bwrap wrapper. In both
paths, bwrap itself applies `--clearenv`, so the requested process sees only the
explicit sorted `--setenv` map inside the sandbox. Executables must be a bare
name found through the supplied contained PATH, an allowed absolute file under
`/usr` or the workspace, or the one exact pinned ripgrep path. Requested cwd
must be a canonical real directory within the exact workspace.

The final environment normalization forces these runner-owned values for every
contained process:

```text
GIT_OPTIONAL_LOCKS=0
ZIG_GLOBAL_CACHE_DIR=/tmp/zig-cache/global
ZIG_LOCAL_CACHE_DIR=/tmp/zig-cache/local
```

This policy is shared by model Bash and TaskCheck; it is not TaskContract
authority. `GIT_OPTIONAL_LOCKS=0` prevents read-only Git porcelain such as
`git status` from refreshing cached stat data by rewriting `.git/index`. It
does not make Git metadata mutable or ignore index changes. With the
immutable-Git overlay active, required-lock operations such as `git add` and
`git update-index` fail at the process boundary because `.git/index.lock`
cannot be created.

The two Zig values repair a different execution seam. The private HOME is
deliberately not writable, so an ordinary Zig process without a global-cache
override fails. Supplying only a private global cache lets `zig build` fall
back to workspace `.zig-cache`, which is correctly outside ordinary source
authority. Both defaults now target the launch's private `/tmp`; Zig creates
the directories on demand, the host workspace and host caches are never
mounted there, and each contained launch loses that temporary cache when it
settles. In the model Bash path the inner rc.6 sandbox has its own private
`/tmp`, nested inside the outer worker boundary.

Environment precedence is deliberately narrow and unchanged apart from these
final values:

1. rc.6 model Bash constructs an explicit environment as its fixed noninteractive
   overrides, then caller `env`, then agent `dshEnv`;
2. TaskCheck constructs an explicit environment as sanitized runner base, then
   the structural TaskContract command override;
3. `prepareContainedExecution()` validates that map, strips credential-shaped
   keys, supplies missing `HOME`/`PATH`/`TMPDIR`, then overwrites the three
   runner-owned values above;
4. bubblewrap applies `--clearenv` followed only by the resulting sorted
   `--setenv` entries.

A caller-supplied spawn environment therefore cannot replace these values.
Once `bash -c` has started, shell syntax can explicitly export, unset, or
override an environment variable; v1 does not parse shell text to prevent
that. TaskCheck remains the independent fail-closed backstop for any resulting
workspace `.zig-cache` or other unauthorized write.

If exact `.git` is not declared immutable, the overlay status is
`not-declared`. If the contract declares it but the node is absent, status is
`declared-absent`: containment does not invent a Git repository or mount point,
and TaskCheck still rejects later creation. A symlink, kind mismatch, or other
unprovable existing `.git` node fails containment setup closed.

Provider networking remains in the host AgentLoop and is outside this process
boundary. Contained Bash/check commands receive a private network namespace.

## Bash integration

The model-visible Bash schema and `dsh-bash-sandbox` implementation are
unchanged. The execution vector eventually reaching `ctx.subprocess.spawn` is
wrapped by the bound provider. Unbound subprocess execution fails with
`containment-unbound` instead of running on the host.

This package does not parse shell text or decide which workspace paths Bash may
change. It prevents host escape; the final TaskCheck snapshot still makes an
in-workspace but out-of-authority Bash write RED.

The private Zig-cache normalization does not make Zigsh a shell provider or
execution backend. Zig remains an ordinary compiler invoked through the same
model-visible Bash tool and contained subprocess service.

Background jobs remain disabled in the lean preset. Independently, each bwrap
launch has a private PID namespace. Official rc.6 process-group cleanup,
`--die-with-parent`, and namespace-init teardown ensure that descendants cannot
survive a completed, cancelled, timed-out, or disposed launch.

## TaskCheck integration

TaskCheckLocal consumes the same genuine controller and calls
`prepareContainedExecution()` with the already-proven exact executable, frozen
argv, cwd, and sanitized environment. It then spawns the fixed bwrap wrapper
with `shell: false`; no command string, interpolation, splitting, globbing, or
retry is introduced. TaskContract command order, timeout, expected exits, and
output hashing/bounds remain unchanged.

Standalone TaskCheckLocal creates and owns a controller when one is not supplied.
The worker kernel instead creates one controller and binds it to both the rc.6
subprocess runtime and TaskCheckLocal. A wrapper failure is a typed execution or
infrastructure failure and can never yield GREEN.

The read-only overlay is preventive process policy, not completion authority.
TaskCheck snapshots still include `.git` without exclusions. Tests mutate the
index from trusted host code outside containment and prove TaskCheck remains
RED with both `outside-mutable-authority` for `.git/index` and
`immutable-state-changed` for `.git`.

## Cleanup and process ownership

The rc.6 provider retains its managed process handle and detached group. The
TaskCheck executor likewise starts the bwrap wrapper in a detached group and
uses TERM followed by KILL on timeout/cancellation/output overflow. Both wait
for closure before settling the controller's active-execution count. The worker
does not dispose the controller until the Agent and runtime are drained; a
controller with active executions refuses disposal.

Tests prove that a `setsid` background descendant cannot perform a delayed
write after its parent returns, and that a detached descendant is gone after a
TaskCheck timeout or AbortSignal.

## Filesystem and namespace limits

Except for the exact optional `.git` overlay, the sandbox exposes the
disposable workspace read/write because coding and checks need it. It therefore
does not decide general TaskContract path authority.
PathGuard remains required for structured mutations, and the two complete
TaskCheck snapshots remain required for all surviving changes.

Symlinks cannot reveal a host path that was not mounted: an absolute host-home
target resolves into private `/home`, and a relative parent escape resolves
into private sandbox directories. Runtime roots are read-only. Cross-mount
hard links fail, and mount operations fail after all capabilities are dropped.
Separately, TaskCheck's snapshot fails closed on symlinks, multi-link regular
files, special nodes, and nested device boundaries.

These tests and controls do not claim protection from kernel/bubblewrap bugs,
hardware attacks, or a hostile same-UID host process outside the worker. The
workspace itself is intentionally writable and visible to its contained
processes.

## Unsupported boundaries

Linux with functional bubblewrap/user namespaces is the only v1 platform. The
following deliberately have no weak fallback:

- PTY/terminal spawning (`spawnTerminal`) fails with `terminal-unsupported`;
- no deterministic memory, CPU, process-count, workspace-size, or tmpfs-size
  quota is implemented;
- no seccomp profile beyond the namespace/capability boundary;
- no outbound network allowlist;
- no additional read-only toolchain roots beyond `/usr`, the loader cache, and
  the one pinned packaged ripgrep executable;
- no PTC, Code mode, Zigsh, or remote-worker transport.

TaskContract command timeouts and existing output bounds remain authoritative
and tested. They are not advertised as CPU/memory quotas.

## Model geometry

The containment provider is a host Loader row but registers no model tool,
prompt section, durable context, or session event. The pinned geometry remains:

```text
system:          1544 bytes
unbound tools:   7005 bytes / 6
bound tools:     7350 bytes / 7
task_check:      +345 bytes
durable context: 0 bytes
```

## Dogfood boundary

The immutable-Git overlay has been exercised by two separately authorized
Zigsh production tasks. Read-only Git inspection remained functional, actual
metadata writes were blocked at the process boundary, and TaskCheck continued
to verify `.git` independently. This use did not add Zigsh, change the shell
backend, or relax the literal acceptance gate: same system digest, same
tool-schema digest, same TaskContract/PathGuard/TaskCheck semantics.

Dogfood authorization remains trajectory-specific. A past run never authorizes
another provider request, and containment success is not task success; exact
TaskCheck GREEN remains the only completion predicate.
