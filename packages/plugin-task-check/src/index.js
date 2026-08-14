import {
  TaskCheckPluginApiError,
  TaskCheckPluginConfigurationError,
  TaskCheckPluginError,
} from "./errors.js";
import {
  isTaskCheckToolBinding,
  TASK_CHECK_TOOL_DESCRIPTION,
  TASK_CHECK_TOOL_NAME,
  TaskCheckToolRuntime,
} from "./runtime.js";

export {
  isTaskCheckToolSummary,
  MAX_SUMMARY_CHANGED_PATHS,
  MAX_SUMMARY_COMMANDS,
  MAX_SUMMARY_FAILURES,
  MAX_SUMMARY_STRING_CODE_POINTS,
  summarizeTaskCheckResult,
  TASK_CHECK_TOOL_RESULT_VERSION,
} from "./summary.js";
export { TASK_CHECK_OUTPUT_SCHEMA, TASK_CHECK_PARAMETERS_SCHEMA } from "./schema.js";
export {
  isTaskCheckTerminalObservation,
  TASK_CHECK_TERMINAL_OBSERVATION_VERSION,
} from "./terminal.js";
export {
  isTaskCheckToolBinding,
  TASK_CHECK_TOOL_DESCRIPTION,
  TASK_CHECK_TOOL_NAME,
  TaskCheckPluginApiError,
  TaskCheckPluginConfigurationError,
  TaskCheckPluginError,
  TaskCheckToolRuntime,
};

export const name = "dsh-dsworker-task-check";
export const inject = ["agents", "tools"];

/** Mount only the host binding service; no tool exists until a runner binds an agent. */
export function apply(ctx) {
  const runtime = new TaskCheckToolRuntime(ctx.agents);
  ctx.provide("taskCheckTool", runtime);
  ctx.effect(() => () => runtime.dispose(), "dsh-dsworker.taskCheckTool");
}
