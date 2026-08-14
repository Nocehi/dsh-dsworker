# TaskCheck v1 authoritative finalization

TaskCheck v1 permits authoritative `semantic`, `validation`, and `finish`
commands to mutate paths already covered by mutable TaskContract authority.
This is **authoritative finalization**: GREEN describes the post-command checked
state and does not prove that every final byte existed before `task_check`
started.

## Checkpoint semantics

The local checker uses this fixed lifecycle:

```text
already-captured baseline
  -> pre-command complete snapshot
  -> pre-command scope and immutable checks against the baseline
  -> semantic commands
  -> validation commands
  -> finish commands
  -> post-command complete snapshot
  -> post-command scope and immutable checks against the baseline
  -> terminal GREEN / RED / ABORTED predicate
```

Both scope checkpoints are compared independently with the original baseline.
Commands execute only after the baseline and pre-command authority checks pass.
The post-command checked state may differ from the pre-command state on paths
that the same TaskContract already declares mutable. Any surviving change
outside mutable authority, any immutable violation, an invalid snapshot, a
command failure, cancellation, or checker infrastructure failure remains
non-GREEN.

GREEN therefore proves that the final checked workspace state satisfies path
and immutable authority and that every authoritative command passed in order.
It does not prove model authorship, command authorship, verifier
non-interference, or a complete record of transient filesystem activity.

TaskCheck state comparisons and WorkspaceDelta also answer different questions.
TaskCheck observes bounded workspace state, including filesystem metadata used
by its authority checks. WorkspaceDelta is a baseline-to-final promotable
content artifact with exact before/after content hashes and bytes. Their path
projections are not interchangeable, and neither is an authorship record.

## Provider-free characterization

The integration regression fixes the current v1 behavior with one mutable file:

```text
baseline:
  src/target.txt = "old\n"

pre-command state:
  src/target.txt = "wrong\n"

authoritative semantic command:
  src/target.txt = "correct\n"

authoritative validation command:
  succeeds only for "correct\n"
```

The expected result is genuine TaskCheck GREEN. Both pre-command and
post-command scope remain within the same mutable-file authority, and the final
WorkspaceDelta contains exactly `src/target.txt` with `old\n` as its before
bytes and `correct\n` as its after bytes.

This regression characterizes existing v1 completion semantics. It adds no
checkpoint-comparison or effect-attribution API, changes no public result
shape, and adds nothing to the model-facing prompt, tool schema, or durable
context. Richer provenance remains deferred.
