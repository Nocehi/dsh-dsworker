import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  assertExecutionContainmentWorkspace,
  isExecutionContainment,
  markContainedExecutionSettled,
  markContainedExecutionStarted,
  prepareContainedExecution,
} from "@dsh-dsworker/execution-containment";
import { isTaskContract } from "@dsh-dsworker/task-contract";
import { TaskCheckLocalApiError } from "./errors.js";
import {
  isSanitizedBaseEnvironment,
} from "./environment.js";
import { deepFreeze } from "./freeze.js";

export const DEFAULT_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TERMINATION_GRACE_MS = 250;

/** @param {string} root @param {string} candidate */
function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** @param {string} root @param {any} command */
function lexicalCommandCwd(root, command) {
  return command.cwd.kind === "workspace-root"
    ? root
    : join(root, ...command.cwd.path.split("/"));
}

/**
 * Prove that the command cwd currently consists only of real directories
 * rooted at the exact canonical workspace.
 *
 * @param {string} root
 * @param {any} command
 */
async function proveCommandCwd(root, command) {
  const target = lexicalCommandCwd(root, command);
  if (!inside(root, target)) return { ok: false, code: "cwd-outside-workspace", cwd: target };
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { ok: false, code: "workspace-root-invalid", cwd: target };
  }
  const rootReal = await realpath(root);
  if (rootReal !== root) {
    return { ok: false, code: "workspace-root-symlink-transition", cwd: target };
  }
  const relativeCwd = relative(root, target);
  const segments = relativeCwd === "" ? [] : relativeCwd.split("/");
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, code: "cwd-component-not-real-directory", cwd: target };
    }
  }
  const targetReal = await realpath(target);
  if (targetReal !== target || !inside(rootReal, targetReal)) {
    return { ok: false, code: "cwd-symlink-transition", cwd: target };
  }
  return { ok: true, code: "cwd-proven", cwd: target };
}

/** @param {string} workspaceRoot @param {any} command */
async function resolveExecutable(workspaceRoot, command) {
  if (!command.executable.includes("/")) return command.executable;
  const executable = join(workspaceRoot, ...command.executable.split("/"));
  if (!inside(workspaceRoot, executable)) {
    throw Object.assign(new Error("workspace executable escaped"), {
      code: "EXECUTABLE_OUTSIDE_WORKSPACE",
    });
  }
  const stat = await lstat(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw Object.assign(new Error("workspace executable is not a real file"), {
      code: "EXECUTABLE_UNSUPPORTED_NODE",
    });
  }
  if ((await realpath(executable)) !== executable) {
    throw Object.assign(new Error("workspace executable crosses a symlink"), {
      code: "EXECUTABLE_SYMLINK_TRANSITION",
    });
  }
  return executable;
}

/** @param {number} pid */
function groupAlive(pid) {
  if (process.platform === "win32" || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** @param {import("node:child_process").ChildProcess} child @param {NodeJS.Signals} signal */
function signalTree(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Exit races are expected; final group observation decides cleanup state.
  }
}

/** @param {number} milliseconds */
function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/** @param {number} pid @param {number} graceMs */
async function ensureTreeGone(pid, graceMs) {
  if (process.platform === "win32" || pid <= 0) return false;
  if (!groupAlive(pid)) return false;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && groupAlive(pid)) await delay(10);
  if (groupAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline && groupAlive(pid)) await delay(10);
  return groupAlive(pid);
}

/** @param {unknown} value @param {string} path @param {number} fallback */
function positiveIntegerOption(value, path, fallback) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new TaskCheckLocalApiError(
      "invalid-executor-limit",
      path,
      path + " must be a positive safe integer",
    );
  }
  return candidate;
}

/** @param {any} command */
function emptyOutcome(command, phase, cwd, startedAt, fields = {}) {
  const empty = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  return deepFreeze({
    command,
    phase,
    cwd,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    timedOut: fields.timedOut ?? false,
    aborted: fields.aborted ?? false,
    spawnError: fields.spawnError ?? null,
    outputLimitExceeded: false,
    processTreeLeak: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutSha256: empty,
    stderrSha256: empty,
  });
}

/**
 * Execute one exact command object belonging to a genuine TaskContract.
 * There is no shell, interpolation, globbing, argv reconstruction, retry, or
 * process.env inheritance.
 *
 * @param {{
 *   contract: unknown,
 *   command: unknown,
 *   phase: unknown,
 *   workspaceRoot: unknown,
 *   baseEnvironment: unknown,
 *   executionContainment: unknown,
 *   signal?: AbortSignal,
 *   maxOutputBytes?: number,
 *   terminationGraceMs?: number,
 * }} request
 */
export async function executeContractCommand(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new TaskCheckLocalApiError(
      "invalid-command-request",
      "$",
      "executeContractCommand requires a request object",
    );
  }
  const {
    contract,
    command,
    phase,
    workspaceRoot,
    baseEnvironment,
    executionContainment,
    signal,
  } = request;
  if (!isTaskContract(contract)) {
    throw new TaskCheckLocalApiError(
      "unparsed-task-contract",
      "$.contract",
      "command execution requires the exact parsed TaskContract",
    );
  }
  if (!["semantic", "validation", "finish"].includes(phase)) {
    throw new TaskCheckLocalApiError(
      "invalid-command-phase",
      "$.phase",
      "phase must be semantic, validation, or finish",
    );
  }
  if (!contract.authority.commands[phase].includes(command)) {
    throw new TaskCheckLocalApiError(
      "command-identity-mismatch",
      "$.command",
      "command must be the exact object retained by TaskContract",
    );
  }
  if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot)) {
    throw new TaskCheckLocalApiError(
      "invalid-workspace-root",
      "$.workspaceRoot",
      "workspaceRoot must be absolute",
    );
  }
  if (!isSanitizedBaseEnvironment(baseEnvironment)) {
    throw new TaskCheckLocalApiError(
      "unsanitized-base-environment",
      "$.baseEnvironment",
      "baseEnvironment must come from sanitizeBaseEnvironment",
    );
  }
  if (!isExecutionContainment(executionContainment)) {
    throw new TaskCheckLocalApiError(
      "invalid-execution-containment",
      "$.executionContainment",
      "command execution requires genuine execution containment",
    );
  }
  try {
    assertExecutionContainmentWorkspace(executionContainment, workspaceRoot);
  } catch {
    throw new TaskCheckLocalApiError(
      "containment-workspace-mismatch",
      "$.executionContainment",
      "execution containment is bound to a different workspace",
    );
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TaskCheckLocalApiError(
      "invalid-abort-signal",
      "$.signal",
      "signal must be an AbortSignal when present",
    );
  }
  const maxOutputBytes = positiveIntegerOption(
    request.maxOutputBytes,
    "$.maxOutputBytes",
    DEFAULT_COMMAND_OUTPUT_BYTES,
  );
  const terminationGraceMs = positiveIntegerOption(
    request.terminationGraceMs,
    "$.terminationGraceMs",
    DEFAULT_TERMINATION_GRACE_MS,
  );
  const root = resolve(workspaceRoot);
  const lexicalCwd = lexicalCommandCwd(root, command);
  const startedAt = new Date().toISOString();
  if (signal?.aborted) {
    return emptyOutcome(command, phase, lexicalCwd, startedAt, { aborted: true });
  }

  let cwdProof;
  try {
    cwdProof = await proveCommandCwd(root, command);
  } catch (error) {
    return emptyOutcome(command, phase, lexicalCwd, startedAt, {
      spawnError: typeof error?.code === "string" ? error.code : "CWD_PROOF_FAILURE",
    });
  }
  if (!cwdProof.ok) {
    return emptyOutcome(command, phase, cwdProof.cwd, startedAt, {
      spawnError: cwdProof.code.toUpperCase().replaceAll("-", "_"),
    });
  }

  let executable;
  try {
    executable = await resolveExecutable(root, command);
  } catch (error) {
    return emptyOutcome(command, phase, cwdProof.cwd, startedAt, {
      spawnError: typeof error?.code === "string" ? error.code : "EXECUTABLE_PROOF_FAILURE",
    });
  }

  const environment = {
    ...baseEnvironment.environment,
    ...command.environment,
  };
  let prepared;
  try {
    prepared = prepareContainedExecution(executionContainment, {
      argv: [executable, ...command.argv],
      cwd: cwdProof.cwd,
      environment,
    });
  } catch (error) {
    return emptyOutcome(command, phase, cwdProof.cwd, startedAt, {
      spawnError:
        typeof error?.code === "string"
          ? error.code
          : "CONTAINMENT_PREPARATION_FAILURE",
    });
  }
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let totalOutputBytes = 0;
  let outputLimitExceeded = false;
  let timedOut = false;
  let aborted = false;
  let processTreeLeak = false;
  let spawnError = null;
  let exitCode = null;
  let exitSignal = null;
  let child;
  let containmentStarted = false;
  let killTimer;
  let timeoutTimer;
  let terminationStarted = false;
  let runnerDiagnostic = "";

  const terminate = () => {
    if (terminationStarted || child === undefined) return;
    terminationStarted = true;
    signalTree(child, "SIGTERM");
    killTimer = setTimeout(() => signalTree(child, "SIGKILL"), terminationGraceMs);
  };
  const ingest = (stream, chunk) => {
    if (stream === "stderr" && runnerDiagnostic.length < 4_096) {
      const diagnostic = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      runnerDiagnostic += diagnostic.slice(0, 4_096 - runnerDiagnostic.length);
    }
    if (outputLimitExceeded) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxOutputBytes - totalOutputBytes;
    const retained = bytes.subarray(0, Math.max(0, remaining));
    if (retained.length > 0) {
      if (stream === "stdout") {
        stdoutHash.update(retained);
        stdoutBytes += retained.length;
      } else {
        stderrHash.update(retained);
        stderrBytes += retained.length;
      }
      totalOutputBytes += retained.length;
    }
    if (retained.length !== bytes.length) {
      outputLimitExceeded = true;
      terminate();
    }
  };
  const onAbort = () => {
    if (terminationStarted) return;
    aborted = true;
    terminate();
  };

  try {
    child = spawn(prepared.argv[0], [...prepared.argv.slice(1)], {
      cwd: prepared.cwd,
      env: prepared.environment,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    markContainedExecutionStarted(executionContainment);
    containmentStarted = true;
  } catch (error) {
    return emptyOutcome(command, phase, cwdProof.cwd, startedAt, {
      spawnError: typeof error?.code === "string" ? error.code : "SPAWN_FAILURE",
    });
  }

  child.stdout?.on("data", (chunk) => ingest("stdout", chunk));
  child.stderr?.on("data", (chunk) => ingest("stderr", chunk));
  signal?.addEventListener("abort", onAbort, { once: true });
  timeoutTimer = setTimeout(() => {
    if (terminationStarted) return;
    timedOut = true;
    terminate();
  }, command.timeoutMs);

  await new Promise((resolvePromise) => {
    child.once("error", (error) => {
      spawnError =
        typeof error?.code === "string"
          ? error.code
          : typeof error?.name === "string"
            ? error.name
            : "SPAWN_FAILURE";
    });
    child.once("close", (code, closedSignal) => {
      exitCode = code;
      exitSignal = closedSignal;
      resolvePromise();
    });
  });
  clearTimeout(timeoutTimer);
  signal?.removeEventListener("abort", onAbort);

  const groupWasAlive = child.pid !== undefined && groupAlive(child.pid);
  if (groupWasAlive && !timedOut && !aborted && !outputLimitExceeded) {
    processTreeLeak = true;
    terminate();
  }
  if (child.pid !== undefined) {
    processTreeLeak =
      (await ensureTreeGone(child.pid, terminationGraceMs + 50)) || processTreeLeak;
  }
  clearTimeout(killTimer);
  if (containmentStarted) markContainedExecutionSettled(executionContainment);
  if (exitCode !== 0 && /^bwrap: /mu.test(runnerDiagnostic)) {
    spawnError ??= "CONTAINMENT_RUNNER_FAILED";
  }

  return deepFreeze({
    command,
    phase,
    cwd: cwdProof.cwd,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode,
    signal: exitSignal,
    timedOut,
    aborted,
    spawnError,
    outputLimitExceeded,
    processTreeLeak,
    stdoutBytes,
    stderrBytes,
    stdoutSha256: stdoutHash.digest("hex"),
    stderrSha256: stderrHash.digest("hex"),
  });
}
