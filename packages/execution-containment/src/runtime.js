import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import {
  containmentDisposition,
  isExecutionContainment,
  markContainedExecutionSettled,
  markContainedExecutionStarted,
  prepareContainedExecution,
} from "./profile.js";
import {
  ExecutionContainmentApiError,
  ExecutionContainmentExecutionError,
} from "./errors.js";
import { deepFreeze } from "./freeze.js";

/**
 * rc.6 subprocess provider that preserves the official managed-handle and
 * output semantics while moving every executable into the bound bwrap world.
 */
export class ContainedSubprocessRuntime extends LocalSubprocessRuntime {
  containment;
  bindingToken;

  constructor(ctx) {
    super(ctx);
    ctx.effect(() => () => {
      this.bindingToken = undefined;
      this.containment = undefined;
    }, "execution containment binding cleanup");
  }

  bindExecutionContainment(containment) {
    if (!isExecutionContainment(containment)) {
      throw new ExecutionContainmentApiError(
        "invalid-containment",
        "$.containment",
        "subprocess binding requires genuine execution containment",
      );
    }
    if (this.bindingToken !== undefined) {
      throw new ExecutionContainmentApiError(
        "containment-already-bound",
        "$.containment",
        "subprocess runtime already has an active containment binding",
      );
    }
    const token = {};
    this.bindingToken = token;
    this.containment = containment;
    let disposed = false;
    return deepFreeze({
      containment,
      disposition: containmentDisposition(containment),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.bindingToken === token) {
          this.bindingToken = undefined;
          this.containment = undefined;
        }
      },
    });
  }

  requireContainment() {
    if (this.containment === undefined) {
      throw new ExecutionContainmentExecutionError(
        "containment-unbound",
        "$.subprocess",
        "subprocess execution is disabled until worker containment is bound",
      );
    }
    return this.containment;
  }

  spawn(spec) {
    const containment = this.requireContainment();
    const prepared = prepareContainedExecution(containment, {
      argv: spec.argv,
      cwd: spec.cwd,
      environment: spec.env ?? {},
    });
    const handle = super.spawn({
      ...spec,
      argv: prepared.argv,
      cwd: prepared.cwd,
      env: prepared.environment,
    });
    markContainedExecutionStarted(containment);
    handle.done.then(
      () => markContainedExecutionSettled(containment),
      () => markContainedExecutionSettled(containment),
    );
    return handle;
  }

  async resolveExecutable(command, env, signal) {
    const containment = this.requireContainment();
    signal?.throwIfAborted();
    const disposition = containmentDisposition(containment);
    const workspaceIdentity = disposition.workspaceIdentity;
    if (typeof workspaceIdentity !== "string") {
      throw new ExecutionContainmentExecutionError(
        "containment-workspace-unavailable",
        "$.command",
        "containment workspace identity is unavailable",
      );
    }
    const candidates = isAbsolute(command)
      ? [command]
      : [join("/usr/bin", command), join("/bin", command)];
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, constants.X_OK);
        const real = await realpath(candidate);
        if (real === "/usr" || real.startsWith("/usr/")) return resolve(candidate);
      } catch {}
    }
    throw new ExecutionContainmentExecutionError(
      "ENOENT",
      "$.command",
      "executable is unavailable in the contained runtime roots",
    );
  }

  async spawnTerminal() {
    this.requireContainment();
    throw new ExecutionContainmentExecutionError(
      "terminal-unsupported",
      "$.subprocess",
      "PTY/terminal execution is unsupported and fails closed in containment v1",
    );
  }
}

export default ContainedSubprocessRuntime;
