# Production dogfood

This document records bounded observations from using `dsh-dsworker` for real
Zigsh production changes. It is not a benchmark, a provider comparison, a
general model-quality claim, or durable `RunManifest` evidence. Provider
requests were separately authorized per trajectory; nothing here authorizes a
future request.

The frozen dogfood TaskContract input fixtures retain their original
machine-local repository string only as non-authoritative historical metadata.
That field is excluded from `contractSha256`, is never used for workspace
resolution, and is not a runtime dependency. The fixtures remain byte-stable
so the reported parsed contract identities are reproducible.

## Invariants held during the successful tasks

The worker used one immutable TaskContract, one attempt, no repair retry, the
same PathAuthority/PathGuard and TaskCheck authority, mandatory Linux
bubblewrap containment, and an exact GREEN-only WorkspaceDelta. Model geometry
remained:

```text
system:          1544 bytes
unbound tools:   7005 bytes / 6
bound tools:     7350 bytes / 7
task_check:      +345 bytes
durable context: 0 bytes
```

Zigsh was a source repository handled by the existing `bash`, `read`, `edit`,
`glob`, `grep`, `write`, and bound `task_check` surface. These runs do not prove
or implement Zigsh as `ctx.shell`, a Bash replacement, or a subprocess backend.

## Completed task 1: pipeline cleanup

- Frozen Git base: `9a0fec8cd1815ad468e3dc91c801647ec5887f3d`.
- Task: make `cleanupStarted()` tolerate a settled child with null `child.id`
  while still terminating and reaping running children.
- Mutable source: `src/pipeline.zig` only.
- TaskContract: `bd287e164a93bcbeaa3b72546677bd96a93f2951091196314298d16cd2122454`.
- Two earlier, separately authorized trajectories ended authoritative RED when
  `.git/index` changed. Investigation separated optional read-only stat-cache
  refresh from a genuine metadata writer. The narrow fixes were
  `GIT_OPTIONAL_LOCKS=0` and a read-only overlay for contract-declared immutable
  `.git`; `.git` stayed fully immutable in TaskCheck.
- The later successful trajectory used 15 model requests and 21 model-facing
  tool calls: 14 `bash`, 3 `read`, 2 `edit`, 1 `glob`, and 1 `task_check`.
- Authoritative disposition: GREEN; `task_check` was called once.
- Promoted file SHA-256:
  `07fa5d0faf9667ee6653a7fc2afc1a08a9f6cbd6d299fd7f0f7a75d07ce66d9d`.
- WorkspaceDelta artifact SHA-256:
  `3b4eed90d84ae2622517e67f350de413425c7e49a81dcd199f0e000c15429abe`.
- Review patch SHA-256:
  `3637f38c3cfe6d0141c993dc38683814397f575dcbb856e33c7822a466000fc5`.
- Post-promotion checks included 32 focused tests, 122 full tests, format,
  build, and `git diff --check`.

## Completed task 2: lexer failure atomicity

The source baseline was the exact current working tree, not a clone of HEAD: it
included the already-promoted uncommitted `src/pipeline.zig` bytes above.

- Source working-tree manifest SHA-256:
  `e49442fccaf22380d0f3134d441267a4cba47ea76b648d181802135c12e51e0e`.
- Task: lexer failures after a valid prefix publish no partial token list.
- Mutable source: `src/lex.zig` only.
- TaskContract: `8fce850acab344c97b01a5133b1dae9ae55aebb37198eb649b848d6291a1544d`.
- Immutable independent oracle SHA-256:
  `a1e30da5d53bed63caee86c660154fc72d2c56f0ab3444781148e9c46d9f187c`.
- The one trajectory used 15 model requests and 21 model-facing tool calls: 11
  `bash`, 6 `read`, 2 `edit`, 1 `grep`, and 1 `task_check`.
- Authoritative disposition: GREEN; `task_check` was called once.
- Promoted file SHA-256:
  `451cb8f1b94f52ad40de13f44f486880fe817838830a56d50689829ae0ec4b15`.
- WorkspaceDelta artifact SHA-256:
  `568d330b6911811f36b3149647967c8f9718e1015deed5428cdecd15801170e2`.
- Review patch SHA-256:
  `d9e97179f215a435e5c6f7e40bd137f90be33330f942695709167d9e03c677c9`.
- Post-promotion checks included the 4/4 hidden oracle, 3/3 direct lexer
  tests, 123/123 full tests, format, build, and `git diff --check`.

Neither task was committed or staged by the supervisor. The current Zigsh
worktree intentionally contains both promoted modifications.

## Qualification gate for a later production task

A candidate is eligible only when all four facts exist before a live request:

1. the behavior is already admitted by repository authority;
2. the exact current source baseline has an observable deterministic failure;
3. an independent oracle fails on that baseline and is not satisfied only by
   the model's own regression;
4. a disposable supervisor proof shows a small production mutation can satisfy
   the same oracle without redefining semantics.

Static suspicion, an unresolved ledger question, or an easy refactor is not a
candidate.

## Completed task 3: EOF suffix after recoverable OOM

The frozen Zigsh baseline for candidate 3 was:

- HEAD `9a0fec8cd1815ad468e3dc91c801647ec5887f3d` on `main`;
- intentional `src/pipeline.zig` SHA-256
  `07fa5d0faf9667ee6653a7fc2afc1a08a9f6cbd6d299fd7f0f7a75d07ce66d9d`;
- intentional `src/lex.zig` SHA-256
  `451cb8f1b94f52ad40de13f44f486880fe817838830a56d50689829ae0ec4b15`;
- unchanged candidate owner `src/stream.zig` SHA-256
  `4e83f34e5029cdb3947122ea5ce6187450e29b58892bc63f64b2e88e37eddd6b`.

The admitted incremental decoder semantics require eager-equivalent LF record
behavior, an unterminated suffix as the final record, and typed allocation
failure. `LineDecoder.pull()` additionally states its exact recovery contract:
a failed `dupeString` leaves the record pending so a later retry may succeed.

The independent oracle is
`tests/fixtures/dogfood/zigsh-stream-eof-oom-oracle.mjs`, SHA-256
`1f9d2de85745ca937516fcd9fee1ede25d70cdaa3df35fa6fb5ff340c1daf914`.
It uses an allocator that fails exactly the EOF record-copy allocation, then
allows allocations again. On the current source, the EOF case loses `"tail"`
and fails with `RecordLostAfterRecoverableOom`; the LF-delimited control case
recovers correctly. The appended focused run reports 54 passed and 1 failed.

A disposable proof moved the `trailing_delivered` state transition until after
the EOF suffix copy succeeds (while still marking an actually empty EOF as
delivered). The same oracle then passed 55/55, and the unmodified repository
test suite on that proof passed 123/123 plus format and build checks. That proof
was discardable and was not applied to the original Zigsh checkout.

The frozen TaskContract is
`1b6b8a888e6c94adc026747bb1e6770ed2f755dd3f1d102309aac47788f1f139`.
It makes only `src/stream.zig` mutable. `.git`, `AGENTS.md`,
`docs/language-ledger.md`, both already-promoted source files, the oracle, and
every unrelated tracked source remain immutable. Its semantic commands are the
immutable oracle, `zig test src/stream.zig`, and
`zig build test --summary all`; validation remains format and build, with
`git diff --check` as finish. Retry remains none/one attempt.

The first separately authorized trajectory ran against that exact authority. It used
39 model requests and 44 model-facing tool calls: 17 `bash`, 13 `read`, 5
`grep`, 8 `edit`, and exactly 1 `task_check`. TaskCheck returned authoritative
RED at its pre-command scope gate. The intended `src/stream.zig` mutation was
allowed, but model-side Zig inspection had also created 49 unauthorized
`.zig-cache/**` nodes. No semantic, validation, or finish command executed;
there was no WorkspaceDelta and no promotion. The whole immutable `.git`
authority remained unchanged and its read-only containment overlay worked.

Provider-free reproduction refined the execution cause: bare Zig initially
failed against the intentionally read-only private HOME, while supplying only
`ZIG_GLOBAL_CACHE_DIR` allowed `zig build` to create workspace `.zig-cache`.
The runner-owned final environment normalization now forces both global and
local Zig caches into sandbox-private `/tmp`, shared by model Bash and
TaskCheck. TaskCheck still snapshots `.zig-cache` normally and still REDs any
such surviving or deliberately redirected workspace output.

One further provider-free fixture refinement separated compiler cache from Zig
testing scratch. Zig 0.16 `std.testing.tmpDir` uses `cwd/.zig-cache/tmp`
independently of the two compiler-cache variables. The controlled-rerun source
therefore began with exactly an empty `.zig-cache/tmp` directory as baseline.
TaskCheck did not ignore or grant mutation authority to that path: the
directory had to be empty again after checks, any residual child remained RED,
and compiler-cache siblings such as `.zig-cache/h`, `.zig-cache/o`, or
`.zig-cache/z` remained unauthorized. The frozen TaskContract and its digest
did not change.

Before the live rerun, the same frozen TaskCheck sequence produced RED for the
oracle alone: the oracle exited 1, while focused stream tests, the 123-test full
suite, format, build, and `git diff --check` all exited 0. Scope and immutable
findings were empty, `.git` was unchanged, `.zig-cache/tmp` was empty, and no
compiler cache or `zig-out` existed.

The one controlled-rerun trajectory used 35 model requests and 44 model-facing
tool calls: 22 `bash`, 6 `grep`, 10 `read`, 5 `edit`, and exactly 1
`task_check`. All six authoritative commands exited 0; both pre- and
post-command scope contained only the allowed `src/stream.zig` modification,
and immutable findings were empty. The containment controller prepared and
settled 34 executions with no survivor, retained the immutable `.git`
read-only overlay, and cleanup disposed every owned resource.

Authoritative disposition was GREEN. The exact WorkspaceDelta contained only
`src/stream.zig`:

- before SHA-256:
  `4e83f34e5029cdb3947122ea5ce6187450e29b58892bc63f64b2e88e37eddd6b`;
- after/promoted SHA-256:
  `65625a7c77216f442a508c4efaf5728dc1e7abd1722d0832a73634c5b86803f2`;
- artifact SHA-256:
  `c2e0f9771d5b45bf39586d7112e96d0cab5e7f613975115e7eaadef3bfdfceb6`;
- review-patch SHA-256:
  `62ac3486ac98575268c655b7c6a46a14ff6d0d09ebea036c36cde4389ae86a66`.

Independent post-promotion checks passed the 56/56 hidden oracle, 54/54 direct
stream tests, 124/124 full suite, format, build, and `git diff --check`. The
patch delays `trailing_delivered` until the EOF suffix copy succeeds while
still completing an actually empty EOF, and adds a focused allocator-failure
regression in the same authorized file. No cache, Git, oracle, binary, or
unrelated path was promoted.

This record does not authorize another provider trajectory. Request/tool-count
differences between the cache-blocked and successful trajectories are not a
benchmark or provider-quality conclusion.
