import {
  adapterDenialRecord,
  evaluateMutationIntent,
  guardDenialMessage,
  monotonicGuardOutcome,
} from "./decision.js";
import {
  PathGuardApiError,
  PathGuardConfigurationError,
  PathGuardError,
} from "./errors.js";
import { PathGuardRuntime } from "./runtime.js";

export {
  LEAN_TOOL_SURFACE,
  OUTSIDE_PATH_GUARD_TOOLS,
  READ_ONLY_TOOLS,
  STRUCTURED_MUTATION_TOOLS,
  classifyLeanTool,
  extractMutationIntent,
} from "./mapping.js";
export {
  compileGuardBinding,
  createGuardBinding,
  isGuardBinding,
} from "./binding.js";
export { proveFilesystemBinding } from "./filesystem.js";
export {
  PathGuardApiError,
  PathGuardConfigurationError,
  PathGuardError,
  PathGuardRuntime,
  adapterDenialRecord,
  evaluateMutationIntent,
  guardDenialMessage,
  monotonicGuardOutcome,
};

export const name = "dsh-dsworker-path-guard";
export const inject = ["tools", "fs", "agents"];

/**
 * Mount the global host-side policy service. The pre-execute listener computes
 * an async, read-only proof; the synchronous rc.6 guard consumes exactly that
 * proof after the existing pre-execute/approval stage.
 *
 * @param {any} ctx
 */
export function apply(ctx) {
  const runtime = new PathGuardRuntime(ctx.fs, ctx.agents);
  ctx.provide("pathGuard", runtime);
  ctx.on(
    "tools/pre-execute",
    async (exec, next) => {
      await runtime.prepare(exec);
      return next();
    },
    { global: true, prepend: true },
  );
  ctx.tools.guard((exec) => runtime.guard(exec));
  ctx.effect(() => () => runtime.dispose(), "dsh-dsworker.pathGuard");
}
