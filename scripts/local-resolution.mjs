import { readFile, mkdir, lstat, readlink, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REQUIRED_DSH_VERSION = "0.1.0-rc.6";
const requireFromRepository = createRequire(join(REPO_ROOT, "package.json"));

/**
 * Resolve the external DeepSeek Harness installation. Normal package
 * resolution is authoritative; DSH_RC6_NODE_MODULES is an explicit local
 * development override, not a machine-specific default.
 *
 * @param {{override?: string, resolveManifest?: (specifier: string) => string}} [options]
 */
export function rc6NodeModules(options = {}) {
  const override = options.override ?? process.env.DSH_RC6_NODE_MODULES;
  if (override !== undefined) {
    if (typeof override !== "string" || override.trim() === "") {
      throw new TypeError("DSH_RC6_NODE_MODULES must be a non-empty path");
    }
    return resolve(override);
  }

  const resolveManifest = options.resolveManifest ?? requireFromRepository.resolve;
  let manifestPath;
  try {
    manifestPath = resolveManifest("@deepseek-ai/dsh/package.json");
  } catch (cause) {
    throw new Error(
      `cannot resolve @deepseek-ai/dsh ${REQUIRED_DSH_VERSION} from this project; run npm install (or npm ci), or set DSH_RC6_NODE_MODULES to an existing exact rc.6 node_modules directory`,
      { cause },
    );
  }

  const packageDirectory = dirname(resolve(manifestPath));
  const scopeDirectory = dirname(packageDirectory);
  if (scopeDirectory.split(/[\\/]/u).at(-1) !== "@deepseek-ai") {
    throw new Error(
      `resolved @deepseek-ai/dsh manifest is not under an @deepseek-ai package scope: ${manifestPath}`,
    );
  }
  return dirname(scopeDirectory);
}

/** @param {{root?: string, override?: string, resolveManifest?: (specifier: string) => string}} [options] */
export async function assertRc6(options = {}) {
  const root = resolve(options.root ?? rc6NodeModules(options));
  const manifestPath = join(root, "@deepseek-ai", "dsh", "package.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    throw new Error(
      `cannot read @deepseek-ai/dsh ${REQUIRED_DSH_VERSION} at ${manifestPath}`,
      { cause },
    );
  }
  if (manifest.version !== REQUIRED_DSH_VERSION) {
    throw new Error(
      `expected @deepseek-ai/dsh ${REQUIRED_DSH_VERSION}, found ${String(manifest.version)}`,
    );
  }
  return { root, manifestPath, version: manifest.version };
}

/** @param {{override?: string, resolveManifest?: (specifier: string) => string}} [options] */
export function rc6CliPath(options = {}) {
  return join(rc6NodeModules(options), "@deepseek-ai", "dsh", "lib", "bin.js");
}

async function ensureSymlink(linkPath, targetPath, type = "dir") {
  await mkdir(dirname(linkPath), { recursive: true });
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`${linkPath} exists and is not a symlink`);
    }
    const existing = resolve(dirname(linkPath), await readlink(linkPath));
    if (existing !== resolve(targetPath)) {
      throw new Error(`${linkPath} points to ${existing}, expected ${targetPath}`);
    }
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await symlink(targetPath, linkPath, type);
}

export async function ensureRepoLinks() {
  const rc6 = await assertRc6();
  const modules = join(REPO_ROOT, "node_modules");
  const repositoryScope = join(modules, "@deepseek-ai");
  const resolvedScope = join(rc6.root, "@deepseek-ai");
  if (resolve(repositoryScope) !== resolve(resolvedScope)) {
    await ensureSymlink(repositoryScope, resolvedScope);
  }
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "plugin-request-trace"),
    join(REPO_ROOT, "packages", "plugin-request-trace"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "bundle-core"),
    join(REPO_ROOT, "packages", "bundle-core"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "execution-containment"),
    join(REPO_ROOT, "packages", "execution-containment"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "task-contract"),
    join(REPO_ROOT, "packages", "task-contract"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "path-authority"),
    join(REPO_ROOT, "packages", "path-authority"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "plugin-path-guard"),
    join(REPO_ROOT, "packages", "plugin-path-guard"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "plugin-task-check"),
    join(REPO_ROOT, "packages", "plugin-task-check"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "task-check-core"),
    join(REPO_ROOT, "packages", "task-check-core"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "task-check-local"),
    join(REPO_ROOT, "packages", "task-check-local"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "worker-kernel"),
    join(REPO_ROOT, "packages", "worker-kernel"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "workspace-delta"),
    join(REPO_ROOT, "packages", "workspace-delta"),
  );
  return rc6;
}

export async function linkProfileModules(profileDir) {
  const rc6 = await assertRc6();
  const modules = join(profileDir, "node_modules");
  await ensureSymlink(
    join(modules, "@deepseek-ai"),
    join(rc6.root, "@deepseek-ai"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "plugin-request-trace"),
    join(REPO_ROOT, "packages", "plugin-request-trace"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "bundle-core"),
    join(REPO_ROOT, "packages", "bundle-core"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "execution-containment"),
    join(REPO_ROOT, "packages", "execution-containment"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "task-contract"),
    join(REPO_ROOT, "packages", "task-contract"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "path-authority"),
    join(REPO_ROOT, "packages", "path-authority"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "plugin-path-guard"),
    join(REPO_ROOT, "packages", "plugin-path-guard"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "plugin-task-check"),
    join(REPO_ROOT, "packages", "plugin-task-check"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "task-check-core"),
    join(REPO_ROOT, "packages", "task-check-core"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "task-check-local"),
    join(REPO_ROOT, "packages", "task-check-local"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "worker-kernel"),
    join(REPO_ROOT, "packages", "worker-kernel"),
  );
  await ensureSymlink(
    join(modules, "@dsh-dsworker", "workspace-delta"),
    join(REPO_ROOT, "packages", "workspace-delta"),
  );
  return rc6;
}

export function isInside(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}
