import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  accessSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { isTaskContract } from "@dsh-dsworker/task-contract";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  ExecutionContainmentApiError,
  ExecutionContainmentExecutionError,
  ExecutionContainmentUnavailableError,
} from "./errors.js";
import { deepFreeze, isPlainDataObject } from "./freeze.js";

export const EXECUTION_CONTAINMENT_VERSION =
  "dsh-dsworker/execution-containment/v1";
export const BUBBLEWRAP_PATH = "/usr/bin/bwrap";
export const SANDBOX_WORKSPACE_ROOT = "/workspace";
export const SANDBOX_PACKAGED_RIPGREP_PATH = "/opt/dsh-tools/rg";
export const DEFAULT_CONTAINMENT_PROBE_TIMEOUT_MS = 5_000;

const SANDBOX_ZIG_CACHE_ROOT = "/tmp/zig-cache";
const SANDBOX_ZIG_GLOBAL_CACHE = SANDBOX_ZIG_CACHE_ROOT + "/global";
const SANDBOX_ZIG_LOCAL_CACHE = SANDBOX_ZIG_CACHE_ROOT + "/local";

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const CREDENTIAL_KEY = /(?:^|_)(?:authorization|proxy_?authorization|api_?key|access_?token|refresh_?token|auth_?token|token|secret|password|passwd|cookie|credentials?)(?:$|_)/iu;
const MAX_ARGV_BYTES = 1024 * 1024;
const controllers = new WeakSet();
const states = new WeakMap();
let capabilityProbe;

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} root @param {string} candidate */
function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** @param {unknown} input @param {readonly string[]} allowed @param {readonly string[]} required @param {string} path */
function closedInput(input, allowed, required, path) {
  if (!isPlainDataObject(input)) {
    throw new ExecutionContainmentApiError(
      "invalid-input",
      path,
      path + " must be a plain data object",
    );
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new ExecutionContainmentApiError(
        "unknown-field",
        path + "." + key,
        path + "." + key + " is not part of this API",
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(input, key)) {
      throw new ExecutionContainmentApiError(
        "missing-field",
        path + "." + key,
        path + "." + key + " is required",
      );
    }
  }
  return input;
}

/** @param {unknown} value @param {string} path @param {number} fallback */
function positiveInteger(value, path, fallback) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new ExecutionContainmentApiError(
      "invalid-positive-integer",
      path,
      path + " must be a positive safe integer",
    );
  }
  return candidate;
}

/** @param {string} root */
function assertWorkspaceRoot(root) {
  if (!isAbsolute(root) || /[\u0000-\u001f\u007f]/u.test(root)) {
    throw new ExecutionContainmentApiError(
      "invalid-workspace-root",
      "$.workspaceRoot",
      "workspaceRoot must be an absolute path without control characters",
    );
  }
  const canonical = resolve(root);
  if (canonical === "/tmp" || !inside("/tmp", canonical)) {
    throw new ExecutionContainmentUnavailableError(
      "workspace-not-disposable-tmp",
      "$.workspaceRoot",
      "Linux v1 containment requires a disposable workspace below /tmp",
    );
  }
  let stat;
  let real;
  try {
    stat = lstatSync(canonical, { bigint: true });
    real = realpathSync(canonical);
  } catch {
    throw new ExecutionContainmentUnavailableError(
      "workspace-root-unavailable",
      "$.workspaceRoot",
      "workspaceRoot must be an existing real directory",
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== canonical) {
    throw new ExecutionContainmentUnavailableError(
      "workspace-root-not-canonical-directory",
      "$.workspaceRoot",
      "workspaceRoot must be a canonical non-symlink directory",
    );
  }
  return {
    root: canonical,
    identity: sha256(
      Buffer.from(
        JSON.stringify({
          real,
          device: stat.dev.toString(),
          inode: stat.ino.toString(),
        }),
        "utf8",
      ),
    ),
  };
}

function assertRuntimeRoots() {
  try {
    const usr = lstatSync("/usr");
    const cache = lstatSync("/etc/ld.so.cache");
    if (!usr.isDirectory() || usr.isSymbolicLink() || !cache.isFile()) throw new Error();
  } catch {
    throw new ExecutionContainmentUnavailableError(
      "runtime-roots-unavailable",
      "$",
      "required read-only runtime roots are unavailable",
    );
  }
}

function resolvePinnedToolchain() {
  let hostPath;
  try {
    const fsSearchManifest = import.meta.resolve(
      "@deepseek-ai/dsh-tool-fs-search/package.json",
    );
    const requireFromFsSearch = createRequire(fsSearchManifest);
    hostPath = requireFromFsSearch("@vscode/ripgrep").rgPath;
  } catch {
    throw new ExecutionContainmentUnavailableError(
      "packaged-ripgrep-unavailable",
      "$",
      "the pinned rc.6 filesystem-search executable is unavailable",
    );
  }
  try {
    if (
      typeof hostPath !== "string" ||
      !isAbsolute(hostPath) ||
      /[\u0000-\u001f\u007f]/u.test(hostPath)
    ) {
      throw new Error();
    }
    const entry = lstatSync(hostPath);
    accessSync(hostPath, constants.X_OK);
    const real = realpathSync(hostPath);
    if (!entry.isFile() || entry.isSymbolicLink() || real !== hostPath) {
      throw new Error();
    }
  } catch {
    throw new ExecutionContainmentUnavailableError(
      "packaged-ripgrep-invalid",
      "$",
      "the pinned rc.6 filesystem-search executable is not a canonical executable file",
    );
  }
  return Object.freeze([
    Object.freeze({
      id: "ripgrep",
      hostPath,
      sandboxPath: SANDBOX_PACKAGED_RIPGREP_PATH,
    }),
  ]);
}

/** @param {string} workspaceRoot */
function hostWorkspaceParentArgs(workspaceRoot) {
  const args = [];
  let cursor = dirname(workspaceRoot);
  const parents = [];
  while (cursor !== "/tmp" && inside("/tmp", cursor)) {
    parents.push(cursor);
    cursor = dirname(cursor);
  }
  for (const parent of parents.reverse()) args.push("--dir", parent);
  return args;
}

/** @param {{status: string, hostPath: string | null}} immutableGit @param {string} destination */
function immutableGitOverlayArgs(immutableGit, destination) {
  return immutableGit.status === "read-only"
    ? ["--ro-bind", immutableGit.hostPath, destination]
    : [];
}

/** @param {string} workspaceRoot @param {string} sandboxCwd @param {Record<string, string>} environment @param {readonly string[]} commandArgv @param {readonly {hostPath: string, sandboxPath: string}[]} toolchain @param {{status: string, hostPath: string | null}} immutableGit */
function bubblewrapArgs(
  workspaceRoot,
  sandboxCwd,
  environment,
  commandArgv,
  toolchain,
  immutableGit,
) {
  const environmentArgs = Object.keys(environment)
    .sort()
    .flatMap((key) => ["--setenv", key, environment[key]]);
  return [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--hostname",
    "dsh-worker",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/bin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib",
    "/lib64",
    "--dir",
    "/etc",
    "--ro-bind",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...hostWorkspaceParentArgs(workspaceRoot),
    "--bind",
    workspaceRoot,
    workspaceRoot,
    ...immutableGitOverlayArgs(immutableGit, join(workspaceRoot, ".git")),
    "--tmpfs",
    "/home",
    "--dir",
    "/home/worker",
    "--dir",
    SANDBOX_WORKSPACE_ROOT,
    "--bind",
    workspaceRoot,
    SANDBOX_WORKSPACE_ROOT,
    ...immutableGitOverlayArgs(
      immutableGit,
      join(SANDBOX_WORKSPACE_ROOT, ".git"),
    ),
    "--dir",
    "/opt",
    "--dir",
    "/opt/dsh-tools",
    ...toolchain.flatMap((entry) => [
      "--ro-bind",
      entry.hostPath,
      entry.sandboxPath,
    ]),
    "--remount-ro",
    "/",
    "--chdir",
    sandboxCwd,
    "--clearenv",
    ...environmentArgs,
    "--",
    ...commandArgv,
  ];
}

/**
 * Compile the one deliberately narrow contract-derived mount overlay used by
 * worker subprocesses. This consumes only a genuine TaskContract and never
 * creates a missing `.git` entry.
 *
 * @param {string} workspaceRoot
 * @param {unknown} contract
 */
function compileImmutableGitOverlay(workspaceRoot, contract) {
  if (contract === undefined) {
    return Object.freeze({
      status: "unbound",
      contractSha256: null,
      hostPath: null,
      kind: null,
    });
  }
  if (!isTaskContract(contract)) {
    throw new ExecutionContainmentApiError(
      "unparsed-task-contract",
      "$.contract",
      "execution containment requires the exact object returned by parseTaskContract",
    );
  }
  const authority = contract.authority.paths.immutable.find(
    (entry) => entry.path === ".git",
  );
  if (authority === undefined) {
    return Object.freeze({
      status: "not-declared",
      contractSha256: contract.contractSha256,
      hostPath: null,
      kind: null,
    });
  }

  const hostPath = join(workspaceRoot, ".git");
  let stat;
  try {
    stat = lstatSync(hostPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        status: "declared-absent",
        contractSha256: contract.contractSha256,
        hostPath: null,
        kind: authority.kind,
      });
    }
    throw new ExecutionContainmentUnavailableError(
      "immutable-git-unavailable",
      "$.workspaceRoot/.git",
      "contract-declared immutable .git could not be inspected",
    );
  }
  if (stat.isSymbolicLink()) {
    throw new ExecutionContainmentUnavailableError(
      "immutable-git-unsupported-node",
      "$.workspaceRoot/.git",
      "contract-declared immutable .git must not be a symlink",
    );
  }
  let real;
  try {
    real = realpathSync(hostPath);
  } catch {
    throw new ExecutionContainmentUnavailableError(
      "immutable-git-unavailable",
      "$.workspaceRoot/.git",
      "contract-declared immutable .git could not be canonicalized",
    );
  }
  const kindMatches =
    (authority.kind === "directory" && stat.isDirectory()) ||
    (authority.kind === "file" && stat.isFile());
  if (real !== hostPath || !kindMatches) {
    throw new ExecutionContainmentUnavailableError(
      "immutable-git-unsupported-node",
      "$.workspaceRoot/.git",
      "contract-declared immutable .git must be a canonical node of the declared kind",
    );
  }
  return Object.freeze({
    status: "read-only",
    contractSha256: contract.contractSha256,
    hostPath,
    kind: authority.kind,
  });
}

/** @param {readonly string[]} args @param {number} timeoutMs @param {boolean} captureVersion */
function runBubblewrapProbe(args, timeoutMs, captureVersion = false) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let child;
    let stdout = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    try {
      child = spawn(BUBBLEWRAP_PATH, [...args], {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        detached: true,
        stdio: ["ignore", captureVersion ? "pipe" : "ignore", "ignore"],
      });
    } catch {
      finish({ ok: false, code: "bubblewrap-spawn-failed", stdout: "" });
      return;
    }
    if (captureVersion) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        if (stdout.length < 128) stdout += chunk.slice(0, 128 - stdout.length);
      });
    }
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      finish({ ok: false, code: "bubblewrap-probe-timeout", stdout: "" });
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      finish({ ok: false, code: "bubblewrap-spawn-failed", stdout: "" });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      finish({
        ok: code === 0 && signal === null,
        code: code === 0 && signal === null ? "bubblewrap-probe-ok" : "bubblewrap-probe-failed",
        stdout,
      });
    });
  });
}

/** @param {string} workspaceRoot @param {number} timeoutMs */
async function probeCapability(workspaceRoot, timeoutMs) {
  assertRuntimeRoots();
  const toolchain = resolvePinnedToolchain();
  const version = await runBubblewrapProbe(["--version"], timeoutMs, true);
  if (!version.ok) {
    throw new ExecutionContainmentUnavailableError(
      version.code,
      "$",
      "bubblewrap is unavailable",
    );
  }
  const match = /^bubblewrap ([0-9]+(?:\.[0-9]+)+)\s*$/u.exec(version.stdout);
  if (match?.[1] === undefined) {
    throw new ExecutionContainmentUnavailableError(
      "bubblewrap-version-unrecognized",
      "$",
      "bubblewrap returned an unrecognized version",
    );
  }
  const environment = {
    HOME: "/home/worker",
    PATH: "/usr/bin:/bin",
    TMPDIR: "/tmp",
  };
  const full = await runBubblewrapProbe(
    bubblewrapArgs(
      workspaceRoot,
      SANDBOX_WORKSPACE_ROOT,
      environment,
      ["/usr/bin/true"],
      toolchain,
      Object.freeze({ status: "unbound", hostPath: null }),
    ),
    timeoutMs,
  );
  if (!full.ok) {
    throw new ExecutionContainmentUnavailableError(
      full.code,
      "$",
      "the required bubblewrap namespace profile is unavailable",
    );
  }
  return Object.freeze({ backendVersion: match[1], toolchain });
}

/** @param {string} root @param {string} cwd */
function proveCwd(root, cwd) {
  if (!isAbsolute(cwd) || /[\u0000-\u001f\u007f]/u.test(cwd)) {
    throw new ExecutionContainmentExecutionError(
      "invalid-cwd",
      "$.cwd",
      "contained cwd must be an absolute path without control characters",
    );
  }
  const candidate = resolve(cwd);
  if (!inside(root, candidate)) {
    throw new ExecutionContainmentExecutionError(
      "cwd-outside-workspace",
      "$.cwd",
      "contained cwd must remain inside the bound workspace",
    );
  }
  let stat;
  let real;
  try {
    stat = lstatSync(candidate);
    real = realpathSync(candidate);
  } catch {
    throw new ExecutionContainmentExecutionError(
      "cwd-unavailable",
      "$.cwd",
      "contained cwd must be an existing directory",
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== candidate) {
    throw new ExecutionContainmentExecutionError(
      "cwd-symlink-or-nondirectory",
      "$.cwd",
      "contained cwd must be a canonical non-symlink directory",
    );
  }
  // Preserve the rc.6 policy root as cwd. The official inner bash-sandbox
  // re-binds this exact path writable; /workspace remains a stable alias for
  // direct contained executors and absolute test paths.
  return candidate;
}

/** @param {string} root @param {string} sandboxCwd @param {string} executable @param {readonly {hostPath: string, sandboxPath: string}[]} toolchain */
function executableHostCandidate(root, sandboxCwd, executable, toolchain) {
  if (isAbsolute(executable)) {
    if (inside(root, executable)) {
      return {
        host: executable,
        sandbox:
          executable === root
            ? SANDBOX_WORKSPACE_ROOT
            : SANDBOX_WORKSPACE_ROOT + "/" + relative(root, executable).split(sep).join("/"),
      };
    }
    if (["/usr", "/bin", "/sbin", "/lib", "/lib64"].some((base) => inside(base, executable))) {
      return { host: executable, sandbox: executable };
    }
    const pinned = toolchain.find((entry) => entry.hostPath === executable);
    if (pinned !== undefined) {
      return { host: pinned.hostPath, sandbox: pinned.sandboxPath };
    }
    throw new ExecutionContainmentExecutionError(
      "absolute-executable-outside-execution-world",
      "$.argv[0]",
      "absolute executable is outside the contained execution world",
    );
  }
  if (executable.includes("/") || executable.includes("\\")) {
    throw new ExecutionContainmentExecutionError(
      "relative-executable-unsupported",
      "$.argv[0]",
      "executable must be a bare PATH name or an allowed absolute path",
    );
  }
  return { host: null, sandbox: executable, sandboxCwd };
}

/** @param {string} root @param {string} sandboxCwd @param {string} executable @param {Record<string, string>} environment @param {readonly {hostPath: string, sandboxPath: string}[]} toolchain */
function proveExecutable(root, sandboxCwd, executable, environment, toolchain) {
  const direct = executableHostCandidate(root, sandboxCwd, executable, toolchain);
  if (direct.host !== null) {
    try {
      const stat = statSync(direct.host);
      accessSync(direct.host, constants.X_OK);
      if (!stat.isFile()) throw new Error();
      const real = realpathSync(direct.host);
      if (
        !inside(root, real) &&
        !inside("/usr", real) &&
        !toolchain.some((entry) => entry.hostPath === real)
      ) {
        throw new Error();
      }
    } catch {
      throw new ExecutionContainmentExecutionError(
        "ENOENT",
        "$.argv[0]",
        "executable is not available inside containment",
      );
    }
    return direct.sandbox;
  }

  const pathValue = environment.PATH ?? "/usr/bin:/bin";
  const candidates = [];
  for (const directory of pathValue.split(":")) {
    if (directory.length === 0 || directory === ".") {
      if (inside(root, sandboxCwd)) candidates.push(join(sandboxCwd, executable));
      else {
        const rel = sandboxCwd.slice(SANDBOX_WORKSPACE_ROOT.length).replace(/^\//u, "");
        candidates.push(join(root, ...rel.split("/").filter(Boolean), executable));
      }
      continue;
    }
    if (!isAbsolute(directory)) continue;
    if (directory === SANDBOX_WORKSPACE_ROOT || directory.startsWith(SANDBOX_WORKSPACE_ROOT + "/")) {
      candidates.push(join(root, directory.slice(SANDBOX_WORKSPACE_ROOT.length), executable));
    } else if (directory === root || directory.startsWith(root + sep)) {
      candidates.push(join(directory, executable));
    } else if (["/usr", "/bin", "/sbin"].some((base) => inside(base, directory))) {
      candidates.push(join(directory, executable));
    }
  }
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      accessSync(candidate, constants.X_OK);
      if (!stat.isFile()) continue;
      const real = realpathSync(candidate);
      if (!inside(root, real) && !inside("/usr", real)) continue;
      return executable;
    } catch {}
  }
  throw new ExecutionContainmentExecutionError(
    "ENOENT",
    "$.argv[0]",
    "bare executable is not available on the contained PATH",
  );
}

/** @param {unknown} value */
function normalizeEnvironment(value) {
  if (!isPlainDataObject(value)) {
    throw new ExecutionContainmentApiError(
      "invalid-environment",
      "$.environment",
      "environment must be a plain data object",
    );
  }
  const environment = {};
  const strippedCredentialKeys = [];
  for (const key of Object.keys(value).sort()) {
    if (!ENVIRONMENT_KEY.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) {
      throw new ExecutionContainmentApiError(
        "invalid-environment-key",
        "$.environment." + key,
        "environment key is invalid",
      );
    }
    const entry = value[key];
    if (entry === undefined) continue;
    if (typeof entry !== "string" || entry.includes("\u0000")) {
      throw new ExecutionContainmentApiError(
        "invalid-environment-value",
        "$.environment." + key,
        "environment values must be NUL-free strings",
      );
    }
    if (CREDENTIAL_KEY.test(key)) {
      strippedCredentialKeys.push(key);
      continue;
    }
    environment[key] = entry;
  }
  environment.HOME ??= "/home/worker";
  environment.PATH ??= "/usr/bin:/bin";
  environment.TMPDIR ??= "/tmp";
  // Git's read-only porcelain may take an optional index lock solely to
  // refresh cached stat data. That turns inspection into an observable
  // `.git/index` metadata write and conflicts with immutable VCS authority.
  // This is runner-owned execution policy, not TaskContract environment
  // authority: required-lock operations such as `git add` still write and are
  // independently rejected by the final TaskCheck snapshot.
  environment.GIT_OPTIONAL_LOCKS = "0";
  // Zig otherwise resolves its global cache beneath the deliberately
  // non-writable private HOME, and a caller that repairs only that half makes
  // `zig build` fall back to workspace/.zig-cache. Keep both cache roots in
  // this launch's private /tmp. These are runner-owned execution defaults at
  // the same final normalization boundary as Git optional locks; shell code
  // may still explicitly override them after Bash starts, with TaskCheck as
  // the independent fail-closed backstop for resulting workspace writes.
  environment.ZIG_GLOBAL_CACHE_DIR = SANDBOX_ZIG_GLOBAL_CACHE;
  environment.ZIG_LOCAL_CACHE_DIR = SANDBOX_ZIG_LOCAL_CACHE;
  return { environment, strippedCredentialKeys };
}

/** @param {unknown} input */
export async function createExecutionContainment(input) {
  const data = closedInput(
    input,
    ["workspaceRoot", "probeTimeoutMs", "contract"],
    ["workspaceRoot"],
    "$",
  );
  if (process.platform !== "linux") {
    throw new ExecutionContainmentUnavailableError(
      "unsupported-platform",
      "$",
      "execution containment v1 supports Linux only",
    );
  }
  const workspace = assertWorkspaceRoot(data.workspaceRoot);
  const timeoutMs = positiveInteger(
    data.probeTimeoutMs,
    "$.probeTimeoutMs",
    DEFAULT_CONTAINMENT_PROBE_TIMEOUT_MS,
  );
  const immutableGit = compileImmutableGitOverlay(
    workspace.root,
    data.contract,
  );
  capabilityProbe ??= probeCapability(workspace.root, timeoutMs);
  const capability = await capabilityProbe;
  const state = {
    workspaceRoot: workspace.root,
    workspaceIdentity: workspace.identity,
    backendVersion: capability.backendVersion,
    toolchain: capability.toolchain,
    contract: data.contract ?? null,
    immutableGit,
    preparedExecutions: 0,
    activeExecutions: 0,
    settledExecutions: 0,
    strippedCredentialKeys: new Set(),
    disposed: false,
  };
  const controller = deepFreeze({
    version: EXECUTION_CONTAINMENT_VERSION,
    workspaceIdentity: workspace.identity,
    backend: "bubblewrap",
  });
  controllers.add(controller);
  states.set(controller, state);
  return controller;
}

/** @param {unknown} controller */
export function isExecutionContainment(controller) {
  return controller !== null && typeof controller === "object" && controllers.has(controller);
}

/** @param {unknown} controller */
function requireController(controller) {
  if (!isExecutionContainment(controller)) {
    throw new ExecutionContainmentApiError(
      "invalid-containment",
      "$.containment",
      "operation requires a genuine execution containment object",
    );
  }
  const state = states.get(controller);
  if (state.disposed) {
    throw new ExecutionContainmentExecutionError(
      "containment-disposed",
      "$.containment",
      "execution containment is disposed",
    );
  }
  return state;
}

/** @param {unknown} controller @param {unknown} workspaceRoot */
export function assertExecutionContainmentWorkspace(controller, workspaceRoot) {
  const state = requireController(controller);
  if (typeof workspaceRoot !== "string" || resolve(workspaceRoot) !== state.workspaceRoot) {
    throw new ExecutionContainmentApiError(
      "containment-workspace-mismatch",
      "$.workspaceRoot",
      "containment is bound to a different workspace",
    );
  }
  return true;
}

/**
 * Convert an exact executable/argv/cwd/environment request into a bubblewrap
 * launch. The returned argv is execution-only data and is never a disposition.
 * @param {unknown} controller
 * @param {unknown} input
 */
export function prepareContainedExecution(controller, input) {
  const state = requireController(controller);
  const data = closedInput(input, ["argv", "cwd", "environment"], ["argv", "cwd", "environment"], "$" );
  if (
    !Array.isArray(data.argv) ||
    data.argv.length === 0 ||
    data.argv.some((entry) => typeof entry !== "string" || entry.includes("\u0000"))
  ) {
    throw new ExecutionContainmentApiError(
      "invalid-argv",
      "$.argv",
      "argv must be a non-empty dense array of NUL-free strings",
    );
  }
  const argvBytes = data.argv.reduce((total, entry) => total + Buffer.byteLength(entry), 0);
  if (argvBytes > MAX_ARGV_BYTES) {
    throw new ExecutionContainmentExecutionError(
      "argv-limit-exceeded",
      "$.argv",
      "argv exceeds the bounded containment launch limit",
    );
  }
  const sandboxCwd = proveCwd(state.workspaceRoot, data.cwd);
  const normalized = normalizeEnvironment(data.environment);
  for (const key of normalized.strippedCredentialKeys) state.strippedCredentialKeys.add(key);
  const executable = proveExecutable(
    state.workspaceRoot,
    sandboxCwd,
    data.argv[0],
    normalized.environment,
    state.toolchain,
  );
  const commandArgv = [executable, ...data.argv.slice(1)];
  state.preparedExecutions += 1;
  return deepFreeze({
    argv: [
      BUBBLEWRAP_PATH,
      ...bubblewrapArgs(
        state.workspaceRoot,
        sandboxCwd,
        normalized.environment,
        commandArgv,
        state.toolchain,
        state.immutableGit,
      ),
    ],
    cwd: state.workspaceRoot,
    environment: {},
    sandboxCwd,
    strippedCredentialKeys: normalized.strippedCredentialKeys,
  });
}

/** @param {unknown} controller */
export function markContainedExecutionStarted(controller) {
  const state = requireController(controller);
  state.activeExecutions += 1;
}

/** @param {unknown} controller */
export function markContainedExecutionSettled(controller) {
  if (!isExecutionContainment(controller)) return;
  const state = states.get(controller);
  state.activeExecutions = Math.max(0, state.activeExecutions - 1);
  state.settledExecutions += 1;
}

/** @param {unknown} controller */
export function containmentDisposition(controller) {
  if (!isExecutionContainment(controller)) {
    throw new ExecutionContainmentApiError(
      "invalid-containment",
      "$.containment",
      "disposition requires a genuine execution containment object",
    );
  }
  const state = states.get(controller);
  return deepFreeze({
    version: EXECUTION_CONTAINMENT_VERSION,
    status: state.disposed ? "disposed" : "ready",
    code: state.disposed ? "containment-disposed" : "containment-ready",
    backend: "bubblewrap",
    backendVersion: state.backendVersion,
    platform: "linux",
    workspaceIdentity: state.workspaceIdentity,
    boundaries: {
      filesystem: "workspace-rw-runtime-ro-private-root",
      runtimeReadOnlyRoots: ["/usr", "/etc/ld.so.cache"],
      packagedToolExecutables: ["/opt/dsh-tools/rg"],
      temporaryStorage: "private-tmpfs",
      home: "private-tmpfs-no-host-home-mount",
      network: "private-network-namespace-no-host-network",
      processes: "private-pid-namespace-managed-wrapper-tree",
      ipc: "private-ipc-namespace",
      uts: "private-uts-namespace",
      cgroupView: "private-cgroup-namespace",
      capabilities: "all-dropped",
      terminal: "unsupported-fail-closed",
      immutableGit: {
        status: state.immutableGit.status,
        contractSha256: state.immutableGit.contractSha256,
        path: state.immutableGit.status === "read-only" ? ".git" : null,
        kind: state.immutableGit.kind,
        mountTargets:
          state.immutableGit.status === "read-only"
            ? ["workspace-native/.git", "/workspace/.git"]
            : [],
      },
    },
    preparedExecutions: state.preparedExecutions,
    activeExecutions: state.activeExecutions,
    settledExecutions: state.settledExecutions,
    strippedCredentialKeys: [...state.strippedCredentialKeys].sort(),
  });
}

/** @param {unknown} controller */
export function disposeExecutionContainment(controller) {
  if (!isExecutionContainment(controller)) {
    throw new ExecutionContainmentApiError(
      "invalid-containment",
      "$.containment",
      "dispose requires a genuine execution containment object",
    );
  }
  const state = states.get(controller);
  if (state.disposed) return;
  if (state.activeExecutions !== 0) {
    throw new ExecutionContainmentExecutionError(
      "containment-executions-active",
      "$.containment",
      "cannot dispose containment while executions remain active",
    );
  }
  state.disposed = true;
}

/** @param {unknown} error */
export function containmentFailureDisposition(error) {
  const code =
    typeof error?.code === "string" && error.code.length > 0
      ? error.code
      : "containment-setup-failed";
  return deepFreeze({
    version: EXECUTION_CONTAINMENT_VERSION,
    status: "unavailable",
    code,
    backend: "bubblewrap",
    backendVersion: null,
    platform: process.platform,
    workspaceIdentity: null,
    boundaries: null,
    preparedExecutions: 0,
    activeExecutions: 0,
    settledExecutions: 0,
    strippedCredentialKeys: [],
  });
}

/** Test only: reset the process-local successful/failed capability probe. */
export function resetContainmentProbeForTests() {
  capabilityProbe = undefined;
}
