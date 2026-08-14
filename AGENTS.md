# dsh-dsworker repository instructions

This repository is an out-of-tree DeepSeek Harness composition. Treat the
project-installed `@deepseek-ai/*` `0.1.0-rc.6` closure as the implementation
authority until an explicit upgrade task changes that baseline.

- Never edit or copy the official DSH installation.
- Never read, print, copy, or persist credential values.
- Use a transient `DSH_HOME` under `/tmp` for development and tests.
- Do not make real provider requests from unit, composition, or integration
  tests. Tests use deterministic fake adapters only.
- Creator/Cordis dynamic execution is outside the production composition.
- Request tracing is observation, never an authorization or sandbox boundary.
- Keep model-visible prompt and tool changes snapshot-tested.
- Preserve the single authority spine: consumers use the genuine immutable
  TaskContract rather than parsing a parallel task representation.
- PathGuard, execution containment, TaskCheck, WorkerKernel terminal semantics,
  and GREEN-only WorkspaceDelta are independent fail-closed layers. Do not
  weaken one because another exists.
- Provider/model routing, evidence persistence, OpenRouter, orchestration, Web
  hosting, PTC, retries, and Zigsh as an execution backend require separately
  authorized phases.
- Run `npm run check` outside a nested sandbox when exercising bubblewrap; a
  `bubblewrap-probe-failed` result from an outer namespace restriction is not a
  repository assertion failure.
