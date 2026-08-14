# TaskCheck phase effect attribution

TaskCheck v1 permits authoritative `semantic`, `validation`, and `finish`
commands to mutate paths covered by mutable TaskContract authority. That is
intentional authoritative-finalization behavior: GREEN describes the final
workspace state and does not by itself prove that every promoted byte was
written before `task_check` began.

The local checker already observes three deterministic workspace checkpoints:

```text
baseline
   |
   | worker/model phase
   v
preCommands
   |
   | authoritative semantic / validation / finish commands
   v
postCommands
```

A genuine local `TaskCheckResult` therefore carries host-only
`effectAttribution` with three comparisons using the same
`compareWorkspaceSnapshots()` authority classifier:

```text
modelPhase:
  baseline -> preCommands

authoritativeCommandPhase:
  preCommands -> postCommands

final:
  baseline -> postCommands
```

Each comparison retains deterministic changed paths, change classifications,
authority decisions, and findings. It does not retain file contents or command
output.

## Semantics

This is **phase attribution**, not byte-level authorship attribution.
`modelPhase` means surviving workspace effects present when `task_check` starts;
those effects may include model-directed tool/runtime side effects. Likewise,
`authoritativeCommandPhase` records the difference across the complete
host-authored command sequence rather than attributing individual bytes to one
specific command.

The attribution is evidence only:

- it does not change the GREEN / RED / ABORTED predicate;
- it does not make authoritative commands read-only;
- it does not authorize any path that was previously unauthorized;
- it does not alter `WorkspaceDelta`, which remains baseline -> final;
- it is not added to the model-facing `task_check` summary or schema;
- direct pure-core callers may omit it, in which case the result records
  `effectAttribution: null`.

A local run populates the field because it owns all three genuine snapshots.
Binding failures that never reach those checkpoints leave attribution absent.

## Why keep all three comparisons?

The existing completion question remains:

> Is the final artifact authoritative and promotable?

That continues to use post-command state and the final WorkspaceDelta.

The additional evidence allows a supervisor or later RunManifest layer to ask
separate questions without changing completion semantics:

- what surviving workspace state was submitted to authoritative commands?
- did the authoritative command phase itself change mutable state?
- what final change is being proposed for promotion?

For example, a model phase may leave `src/target.txt` as `wrong`, while an
authoritative semantic command deterministically rewrites it to `correct` and a
later validation command passes. The run can remain GREEN and the final
WorkspaceDelta can validly contain `correct`, while effect attribution records
that the same path changed both before and during the authoritative-command
phase.

This avoids silently conflating successful artifact finalization with a claim
that the pre-command model phase independently produced the final bytes.
