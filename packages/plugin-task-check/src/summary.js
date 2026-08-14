import { isTaskCheckResult } from "@dsh-dsworker/task-check-core";
import { TaskCheckPluginApiError } from "./errors.js";
import { deepFreeze } from "./freeze.js";

export const TASK_CHECK_TOOL_RESULT_VERSION =
  "dsh-dsworker/task-check-tool-result/v1";
export const MAX_SUMMARY_COMMANDS = 32;
export const MAX_SUMMARY_FAILURES = 32;
export const MAX_SUMMARY_CHANGED_PATHS = 64;
export const MAX_SUMMARY_STRING_CODE_POINTS = 256;

const summaries = new WeakSet();
const SECRET_SHAPED =
  /(?:api[_-]?key|authorization|bearer\s+|credential|password|secret|sk-[A-Za-z0-9_-]{8,})/iu;

/** @param {unknown} value @param {string} fallback */
function boundedString(value, fallback = "unknown") {
  const source = typeof value === "string" && value.length > 0 ? value : fallback;
  if (SECRET_SHAPED.test(source)) return "<redacted>";
  return [...source].slice(0, MAX_SUMMARY_STRING_CODE_POINTS).join("");
}

/** @param {unknown} value */
function boundedNullableString(value) {
  return typeof value === "string" ? boundedString(value) : null;
}

/** @param {any} command */
function commandFailureCode(command) {
  if (command.passed) return null;
  if (command.aborted) return "command-cancelled";
  if (command.timedOut) return "command-timeout";
  if (command.outputLimitExceeded) return "command-output-limit-exceeded";
  if (command.processTreeLeak) return "command-process-tree-leak";
  if (command.spawnError !== null) return "command-spawn-failure";
  if (command.signal !== null) return "command-signal-termination";
  return "unexpected-exit-code";
}

/** @param {readonly string[]} values @param {number} limit */
function boundedStrings(values, limit) {
  return values.slice(0, limit).map((value) => boundedString(value));
}

/** @param {any} failure */
function summarizeFailure(failure) {
  return {
    category: boundedString(failure?.category),
    code: boundedString(failure?.code),
    checkpoint: boundedNullableString(failure?.checkpoint),
    phase: boundedNullableString(failure?.phase),
    commandId: boundedNullableString(failure?.commandId),
    path: boundedNullableString(failure?.path),
  };
}

/**
 * Project a genuine host verdict into the only bounded value returned to the
 * model. Objective text, argv, environment, command output, file contents and
 * arbitrary infrastructure diagnostics are deliberately absent.
 *
 * @param {unknown} result
 */
export function summarizeTaskCheckResult(result) {
  if (!isTaskCheckResult(result)) {
    throw new TaskCheckPluginApiError(
      "invalid-task-check-result",
      "$.result",
      "summary projection requires a genuine task-check result",
    );
  }

  const commandItems = result.commands.slice(0, MAX_SUMMARY_COMMANDS).map(
    (command) => ({
      phase: boundedString(command.phase),
      commandId: boundedString(command.commandId),
      passed: command.passed,
      exitCode: command.exitCode,
      signal: boundedNullableString(command.signal),
      timedOut: command.timedOut,
      aborted: command.aborted,
      failureCode: commandFailureCode(command),
    }),
  );
  const failureItems = result.failures
    .slice(0, MAX_SUMMARY_FAILURES)
    .map(summarizeFailure);
  const preChangedPaths = boundedStrings(
    result.scope.preCommands.changedPaths,
    MAX_SUMMARY_CHANGED_PATHS,
  );
  const postChangedPaths = boundedStrings(
    result.scope.postCommands.changedPaths,
    MAX_SUMMARY_CHANGED_PATHS,
  );

  const summary = deepFreeze({
    version: TASK_CHECK_TOOL_RESULT_VERSION,
    status: result.status,
    contractSha256: result.contractSha256,
    workspaceIdentity: result.workspaceIdentity,
    greenPredicate: { ...result.greenPredicate },
    snapshots: {
      baseline: { ok: result.baseline.ok, code: boundedString(result.baseline.code) },
      preCommands: {
        ok: result.preCommands.ok,
        code: boundedString(result.preCommands.code),
      },
      postCommands: {
        ok: result.postCommands.ok,
        code: boundedString(result.postCommands.code),
      },
    },
    scope: {
      ok: result.scope.ok,
      preCommandsOk: result.scope.preCommands.ok,
      postCommandsOk: result.scope.postCommands.ok,
      preChangedPathCount: result.scope.preCommands.changedPaths.length,
      postChangedPathCount: result.scope.postCommands.changedPaths.length,
      preChangedPaths,
      postChangedPaths,
      preChangedPathsOmitted:
        result.scope.preCommands.changedPaths.length - preChangedPaths.length,
      postChangedPathsOmitted:
        result.scope.postCommands.changedPaths.length - postChangedPaths.length,
    },
    immutable: {
      ok: result.immutable.ok,
      baselineOk: result.immutable.baseline.ok,
      preCommandsOk: result.immutable.preCommands.ok,
      postCommandsOk: result.immutable.postCommands.ok,
      findingCount: result.immutable.findings.length,
    },
    commands: {
      total: result.commands.length,
      passed: result.commands.filter((command) => command.passed).length,
      items: commandItems,
      omitted: result.commands.length - commandItems.length,
    },
    failures: {
      total: result.failures.length,
      items: failureItems,
      omitted: result.failures.length - failureItems.length,
    },
  });
  summaries.add(summary);
  return summary;
}

/** @param {unknown} value */
export function isTaskCheckToolSummary(value) {
  return value !== null && typeof value === "object" && summaries.has(value);
}
