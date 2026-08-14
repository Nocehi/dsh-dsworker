import { compileGuardBinding } from "./binding.js";
import {
  adapterDenialRecord,
  evaluateMutationIntent,
  guardDenialMessage,
} from "./decision.js";
import { PathGuardApiError, PathGuardConfigurationError } from "./errors.js";
import { classifyLeanTool, extractMutationIntent } from "./mapping.js";

/** @param {unknown} agent */
function workspaceRootOf(agent) {
  if (agent === null || typeof agent !== "object") return undefined;
  const session = agent.session;
  if (session === null || typeof session !== "object") return undefined;
  const header = session.header;
  if (header === null || typeof header !== "object") return undefined;
  return header.cwd;
}

/** Host-only registry and execution-local proof cache for the rc.6 adapter. */
export class PathGuardRuntime {
  /** @param {any} fs @param {any} agents */
  constructor(fs, agents) {
    this.fs = fs;
    this.agents = agents;
    this.bindings = new WeakMap();
    this.prepared = new WeakMap();
    this.disposed = false;
  }

  /**
   * Bind the exact live Agent identity to one genuine TaskContract. The current
   * immutable session-header cwd is pinned as the runner-supplied workspace.
   *
   * @param {any} agent
   * @param {unknown} contract
   * @param {{onDecision?: (record: any) => void}} [options]
   */
  bind(agent, contract, options = {}) {
    if (this.disposed) {
      throw new PathGuardConfigurationError(
        "path-guard-disposed",
        "$",
        "cannot bind an agent after path-guard disposal",
      );
    }
    if (agent === null || typeof agent !== "object") {
      throw new PathGuardApiError(
        "invalid-agent",
        "$.agent",
        "bind requires the exact live rc.6 Agent object",
      );
    }
    if (
      typeof agent.id !== "string" ||
      typeof this.agents?.get !== "function" ||
      this.agents.get(agent.id) !== agent
    ) {
      throw new PathGuardConfigurationError(
        "unregistered-agent",
        "$.agent",
        "bind requires an exact live Agent registered in the rc.6 AgentRegistry",
      );
    }
    if (this.bindings.has(agent)) {
      throw new PathGuardConfigurationError(
        "agent-already-bound",
        "$.agent",
        "an agent may have only one active TaskContract binding",
      );
    }
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== "onDecision")
    ) {
      throw new PathGuardApiError(
        "invalid-bind-options",
        "$.options",
        "bind options may contain only onDecision",
      );
    }
    if (
      options.onDecision !== undefined &&
      typeof options.onDecision !== "function"
    ) {
      throw new PathGuardApiError(
        "invalid-decision-callback",
        "$.options.onDecision",
        "onDecision must be a function when present",
      );
    }
    const workspaceRoot = workspaceRootOf(agent);
    const binding = compileGuardBinding(contract, workspaceRoot);
    const state = Object.freeze({
      binding,
      onDecision: options.onDecision,
    });
    this.bindings.set(agent, state);
    let active = true;
    const dispose = Object.freeze(() => {
      if (!active) return;
      active = false;
      if (this.bindings.get(agent) === state) this.bindings.delete(agent);
    });
    return Object.freeze({
      contract: binding.contract,
      policy: binding.policy,
      contractSha256: binding.contractSha256,
      workspaceRoot: binding.workspaceRoot,
      dispose,
    });
  }

  /** @param {any} exec */
  async prepare(exec) {
    const classification = classifyLeanTool(exec?.name);
    if (classification.classification !== "structured-mutation") return;
    const intent = extractMutationIntent(exec);
    const state =
      exec?.agent !== undefined ? this.bindings.get(exec.agent) : undefined;
    let record;
    try {
      record = await evaluateMutationIntent(
        this.fs,
        state?.binding,
        intent,
        exec?.signal,
      );
    } catch {
      record = adapterDenialRecord({
        contractSha256: state?.binding.contractSha256 ?? null,
        toolName: exec?.name ?? null,
        toolCallId: exec?.callId ?? null,
        requestedPath: intent?.requestedPath ?? null,
        denialCategory: "adapter-error",
        denialCode: "unexpected-adapter-error",
      });
    }
    this.prepared.set(exec, { record, callback: state?.onDecision });
  }

  /** @param {any} exec */
  guard(exec) {
    const classification = classifyLeanTool(exec?.name);
    if (classification.classification !== "structured-mutation") {
      return undefined;
    }
    const prepared = this.prepared.get(exec);
    this.prepared.delete(exec);
    const record =
      prepared?.record ??
      adapterDenialRecord({
        toolName: exec?.name ?? null,
        toolCallId: exec?.callId ?? null,
        denialCategory: "adapter-error",
        denialCode: "missing-pre-execution-proof",
      });
    if (prepared?.callback !== undefined) {
      try {
        prepared.callback(record);
      } catch {
        // Observation callbacks are deliberately contained and never influence policy.
      }
    }
    return record.finalGuardDecision === "permit"
      ? undefined
      : guardDenialMessage(record);
  }

  dispose() {
    this.disposed = true;
    this.bindings = new WeakMap();
    this.prepared = new WeakMap();
  }
}
