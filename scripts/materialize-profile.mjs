import { cp, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureRepoLinks,
  isInside,
  linkProfileModules,
  REPO_ROOT,
} from "./local-resolution.mjs";

export async function materializeProfile(dshHome) {
  const destination = resolve(dshHome);
  if (!isInside("/tmp", destination) || destination === "/tmp") {
    throw new Error("transient DSH_HOME must be a distinct directory under /tmp");
  }

  await ensureRepoLinks();
  const profileDir = join(destination, "profiles", "headless-dev");
  const presetDir = join(destination, ".agent-presets", "lean-coding");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await mkdir(presetDir, { recursive: true, mode: 0o700 });
  await cp(
    join(REPO_ROOT, "profiles", "headless-dev", "package.json"),
    join(profileDir, "package.json"),
  );
  await cp(
    join(REPO_ROOT, "profiles", "headless-dev", "cordis.patch.yml"),
    join(profileDir, "cordis.patch.yml"),
  );
  await cp(
    join(REPO_ROOT, "packages", "bundle-core", "presets", "lean-coding"),
    presetDir,
    { recursive: true },
  );
  const rc6 = await linkProfileModules(profileDir);

  const requireFromProfile = createRequire(join(profileDir, "package.json"));
  const bundleResolution = await realpath(
    requireFromProfile.resolve("@dsh-dsworker/bundle-core/package.json"),
  );
  const executionContainmentResolution = await realpath(
    requireFromProfile.resolve("@dsh-dsworker/execution-containment/package.json"),
  );
  const pluginResolution = await realpath(
    requireFromProfile.resolve(
      "@dsh-dsworker/plugin-request-trace/package.json",
    ),
  );
  const taskContractResolution = await realpath(
    requireFromProfile.resolve("@dsh-dsworker/task-contract/package.json"),
  );
  const pathAuthorityResolution = await realpath(
    requireFromProfile.resolve("@dsh-dsworker/path-authority/package.json"),
  );
  const pathGuardResolution = await realpath(
    requireFromProfile.resolve("@dsh-dsworker/plugin-path-guard/package.json"),
  );
  const taskCheckPluginResolution = await realpath(
    requireFromProfile.resolve("@dsh-dsworker/plugin-task-check/package.json"),
  );
  const taskCheckCoreResolution = await realpath(
    requireFromProfile.resolve("@dsh-dsworker/task-check-core/package.json"),
  );
  const taskCheckLocalResolution = await realpath(
    requireFromProfile.resolve("@dsh-dsworker/task-check-local/package.json"),
  );
  const workerKernelResolution = await realpath(
    requireFromProfile.resolve("@dsh-dsworker/worker-kernel/package.json"),
  );
  const workspaceDeltaResolution = await realpath(
    requireFromProfile.resolve("@dsh-dsworker/workspace-delta/package.json"),
  );
  if (
    !isInside(REPO_ROOT, bundleResolution) ||
    !isInside(REPO_ROOT, executionContainmentResolution) ||
    !isInside(REPO_ROOT, pluginResolution) ||
    !isInside(REPO_ROOT, taskContractResolution) ||
    !isInside(REPO_ROOT, pathAuthorityResolution) ||
    !isInside(REPO_ROOT, pathGuardResolution) ||
    !isInside(REPO_ROOT, taskCheckPluginResolution) ||
    !isInside(REPO_ROOT, taskCheckCoreResolution) ||
    !isInside(REPO_ROOT, taskCheckLocalResolution) ||
    !isInside(REPO_ROOT, workerKernelResolution) ||
    !isInside(REPO_ROOT, workspaceDeltaResolution)
  ) {
    throw new Error("local dsh-dsworker packages did not resolve from this repository");
  }

  return {
    dshHome: destination,
    profileDir,
    presetDir,
    rc6Version: rc6.version,
    rc6NodeModules: rc6.root,
    bundleResolution,
    executionContainmentResolution,
    pluginResolution,
    taskContractResolution,
    pathAuthorityResolution,
    pathGuardResolution,
    taskCheckPluginResolution,
    taskCheckCoreResolution,
    taskCheckLocalResolution,
    workerKernelResolution,
    workspaceDeltaResolution,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    throw new Error("usage: materialize-profile.mjs <transient-DSH_HOME>");
  }
  const result = await materializeProfile(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
