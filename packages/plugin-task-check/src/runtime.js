import { isAbsolute, resolve } from "node:path";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import {
  isTaskCheckBinding,
  runTaskCheck,
} from "@dsh-dsworker/task-check-local";
import { isTaskContract } from "@dsh-dsworker/task-contract";
import {
  TaskCheckPluginApiError,
  TaskCheckPluginConfigurationError,
} from "./errors.js";
import { TASK_CHECK_OUTPUT_SCHEMA, TASK_CHECK_PARAMETERS_SCHEMA } from "./schema.js";
import { summarizeTaskCheckResult } from "./summary.js";
import { createTaskCheckTerminalObservation } from "./terminal.js";

export const TASK_CHECK_TOOL_NAME = "task_check";
export const TASK_CHECK_TOOL_DESCRIPTION =
  "Run the single authoritative host-side task check after completing the task. Call exactly once with no arguments. GREEN ends this agent turn; RED or ABORTED reports bounded deterministic findings and does not end it.";

const bindings = new WeakSet();

/** @param {unknown} value */
function emptyPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).length === 0
  );
}

/** @param {unknown} agent */
function workspaceRootOf(agent) {
  if (agent === null || typeof agent !== "object") return undefined;
  const cwd = agent.session?.header?.cwd;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return undefined;
  return resolve(cwd);
}

/** @param {string} code @param {string} message */
function rejectTool(code, message) {
  throw new HarnessError(message, code);
}

/** @param {any} state */
function taskCheckDefinition(state) {
  return {
    name: TASK_CHECK_TOOL_NAME,
    description: TASK_CHECK_TOOL_DESCRIPTION,
    parameters: TASK_CHECK_PARAMETERS_SCHEMA,
    output: {
      schema: TASK_CHECK_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!emptyPlainObject(args)) {
        return rejectTool(
          "TASK_CHECK_INVALID_ARGUMENTS",
          "task_check accepts exactly one empty object and no fields",
        );
      }
      if (state.disposed) {
        return rejectTool(
          "TASK_CHECK_BINDING_DISPOSED",
          "task_check is no longer bound to this agent",
        );
      }
      if (
        exec.agent !== state.agent ||
        state.runtime.agents.get(state.agent.id) !== state.agent
      ) {
        return rejectTool(
          "TASK_CHECK_AGENT_IDENTITY_MISMATCH",
          "task_check requires its exact live bound agent",
        );
      }
      if (exec.parent !== undefined) {
        return rejectTool(
          "TASK_CHECK_DIRECT_CALL_REQUIRED",
          "task_check must be called directly by the bound native agent",
        );
      }
      if (state.used) {
        return rejectTool(
          "TASK_CHECK_ALREADY_USED",
          "task_check is single-use and has already been attempted",
        );
      }
      state.used = true;

      let result;
      let summary;
      try {
        result = await runTaskCheck(state.taskCheckBinding, {
          contract: state.contract,
          workspaceRoot: state.taskCheckBinding.workspaceRoot,
          signal: exec.signal,
        });
        summary = summarizeTaskCheckResult(result);
      } catch {
        return rejectTool(
          "TASK_CHECK_ADAPTER_FAILURE",
          "authoritative task_check failed closed before producing a verdict",
        );
      }

      state.pendingTerminal = {
        exec,
        taskCheckResult: result,
        summary,
        concludeFailed: false,
      };

      if (result.status === "green") {
        state.pendingGreenExecution = exec;
        try {
          exec.concludeTurn();
        } catch {
          state.pendingGreenExecution = undefined;
          state.pendingTerminal.concludeFailed = true;
          return rejectTool(
            "TASK_CHECK_CONCLUDE_FAILURE",
            "authoritative GREEN could not mark the current turn complete",
          );
        }
      }
      return summary;
    },
  };
}

/** Host-only registry that binds one pre-existing local baseline to one agent. */
export class TaskCheckToolRuntime {
  /** @param {any} agents */
  constructor(agents) {
    this.agents = agents;
    this.agentBindings = new WeakMap();
    this.states = new Set();
    this.disposed = false;
  }

  /**
   * @param {any} agent
   * @param {unknown} contract
   * @param {unknown} taskCheckBinding
   * @param {{onTerminalObservation?: (observation: any) => void}} [options]
   */
  bind(agent, contract, taskCheckBinding, options = {}) {
    if (this.disposed) {
      throw new TaskCheckPluginConfigurationError(
        "task-check-plugin-disposed",
        "$",
        "cannot bind an agent after task-check plugin disposal",
      );
    }
    if (agent === null || typeof agent !== "object") {
      throw new TaskCheckPluginApiError(
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
      throw new TaskCheckPluginConfigurationError(
        "unregistered-agent",
        "$.agent",
        "bind requires an exact live Agent registered in rc.6 AgentRegistry",
      );
    }
    if (this.agentBindings.has(agent)) {
      throw new TaskCheckPluginConfigurationError(
        "agent-already-bound",
        "$.agent",
        "an agent may have only one active task_check binding",
      );
    }
    if (!isTaskContract(contract)) {
      throw new TaskCheckPluginConfigurationError(
        "unparsed-task-contract",
        "$.contract",
        "task_check requires the exact object returned by parseTaskContract",
      );
    }
    if (!isTaskCheckBinding(taskCheckBinding)) {
      throw new TaskCheckPluginConfigurationError(
        "invalid-task-check-binding",
        "$.taskCheckBinding",
        "task_check requires a genuine pre-existing local task-check binding",
      );
    }
    if (
      taskCheckBinding.contract !== contract ||
      taskCheckBinding.contractSha256 !== contract.contractSha256
    ) {
      throw new TaskCheckPluginConfigurationError(
        "task-contract-binding-identity-mismatch",
        "$.taskCheckBinding",
        "task_check binding does not retain the exact supplied TaskContract",
      );
    }
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== "onTerminalObservation")
    ) {
      throw new TaskCheckPluginApiError(
        "invalid-bind-options",
        "$.options",
        "bind options may contain only onTerminalObservation",
      );
    }
    if (
      options.onTerminalObservation !== undefined &&
      typeof options.onTerminalObservation !== "function"
    ) {
      throw new TaskCheckPluginApiError(
        "invalid-terminal-observer",
        "$.options.onTerminalObservation",
        "onTerminalObservation must be a function when present",
      );
    }
    const agentWorkspaceRoot = workspaceRootOf(agent);
    if (
      agentWorkspaceRoot === undefined ||
      agentWorkspaceRoot !== taskCheckBinding.workspaceRoot
    ) {
      throw new TaskCheckPluginConfigurationError(
        "workspace-binding-mismatch",
        "$.taskCheckBinding.workspaceRoot",
        "task_check binding and agent session header must name the same workspace",
      );
    }

    const state = {
      runtime: this,
      agent,
      contract,
      taskCheckBinding,
      used: false,
      pendingGreenExecution: undefined,
      pendingTerminal: undefined,
      observationPublished: false,
      onTerminalObservation: options.onTerminalObservation,
      terminal: false,
      disposed: false,
      unregister: [],
    };
    try {
      state.unregister.push(agent.ctx.tools.register(taskCheckDefinition(state)));
      state.unregister.push(
        agent.ctx.tools.guard(() =>
          state.pendingGreenExecution !== undefined || state.terminal
            ? "authoritative task_check is GREEN; later tool calls in this turn are denied"
            : undefined,
        ),
      );
      state.unregister.push(
        agent.ctx.on("tools/result", (exec, result) => {
          if (
            exec.agent !== state.agent ||
            exec.name !== TASK_CHECK_TOOL_NAME
          ) {
            return;
          }
          const pending =
            state.pendingTerminal?.exec === exec
              ? state.pendingTerminal
              : undefined;
          state.pendingTerminal = undefined;
          if (exec === state.pendingGreenExecution) {
            state.pendingGreenExecution = undefined;
            if (!result.isError && result.concludesTurn === true) {
              state.terminal = true;
            }
          }
          if (state.observationPublished) return;
          const observation = createTaskCheckTerminalObservation({
            contractSha256: state.contract.contractSha256,
            exec,
            finalResult: result,
            ...(pending === undefined ? {} : { pending }),
          });
          state.observationPublished = true;
          if (state.onTerminalObservation !== undefined) {
            try {
              state.onTerminalObservation(observation);
            } catch {
              // Host observation is contained and cannot rewrite tool authority.
            }
          }
        }),
      );
    } catch (error) {
      for (const unregister of state.unregister.reverse()) unregister();
      throw error;
    }

    this.agentBindings.set(agent, state);
    let active = true;
    const dispose = Object.freeze(() => {
      if (!active) return;
      active = false;
      state.disposed = true;
      for (const unregister of state.unregister.reverse()) unregister();
      state.unregister = [];
      if (this.agentBindings.get(agent) === state) this.agentBindings.delete(agent);
      this.states.delete(state);
    });
    state.dispose = dispose;
    this.states.add(state);
    const binding = Object.freeze({
      contract,
      taskCheckBinding,
      contractSha256: contract.contractSha256,
      workspaceRoot: taskCheckBinding.workspaceRoot,
      toolName: TASK_CHECK_TOOL_NAME,
      dispose,
    });
    bindings.add(binding);
    return binding;
  }

  dispose() {
    for (const state of [...this.states]) state.dispose();
    this.disposed = true;
    this.agentBindings = new WeakMap();
    this.states.clear();
  }
}

/** @param {unknown} value */
export function isTaskCheckToolBinding(value) {
  return value !== null && typeof value === "object" && bindings.has(value);
}
