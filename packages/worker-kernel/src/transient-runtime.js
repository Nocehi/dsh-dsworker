import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "@deepseek-ai/dsh-app-boot";
import { materializeProfile } from "../../../scripts/materialize-profile.mjs";
import { rc6CliPath } from "../../../scripts/local-resolution.mjs";

const DSH_CLI = rc6CliPath();

/** @param {string} configPath @param {string} dshHome @param {string} workspaceRoot */
async function dumpConfig(configPath, dshHome, workspaceRoot) {
  const output = await open(configPath, "w", 0o600);
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(
        process.execPath,
        [DSH_CLI, "--profile", "headless-dev", "--dump-config"],
        {
          cwd: workspaceRoot,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            DSH_HOME: dshHome,
            DSH_REQUEST_TRACE_PATH: join(dshHome, "trace-disabled.jsonl"),
            DSH_TELEMETRY_DISABLED: "1",
          },
          stdio: ["ignore", output.fd, "pipe"],
        },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 65_536) stderr += chunk.slice(0, 65_536 - stderr.length);
      });
      child.once("error", rejectPromise);
      child.once("close", (code, signal) => {
        if (code === 0) resolvePromise();
        else {
          rejectPromise(
            new Error(
              `rc.6 dump-config failed (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
            ),
          );
        }
      });
    });
  } finally {
    await output.close();
  }
  const rendered = await readFile(configPath, "utf8");
  if (!rendered.startsWith("# == ")) {
    throw new Error("rc.6 dump-config produced no composed configuration");
  }
}

/**
 * Repo-local CLI runtime factory. It changes no provider/model selection: the
 * generated profile's existing rc.6 agentDefaultModel service remains the sole
 * source. Request tracing is disabled because worker evidence persistence is
 * outside step 6.
 *
 * @param {{workspaceRoot: string}} binding
 */
export async function createTransientProfileRuntime(binding) {
  const dshHome = await mkdtemp("/tmp/dsh-dsworker-home.");
  const hadDshHome = Object.hasOwn(process.env, "DSH_HOME");
  const previousDshHome = process.env.DSH_HOME;
  let root;
  let restored = false;
  const restoreDshHome = () => {
    if (restored) return;
    restored = true;
    if (hadDshHome) process.env.DSH_HOME = previousDshHome;
    else delete process.env.DSH_HOME;
  };
  try {
    const materialized = await materializeProfile(dshHome);
    const configPath = join(materialized.profileDir, "worker.cordis.yml");
    await dumpConfig(configPath, dshHome, binding.workspaceRoot);
    process.env.DSH_HOME = dshHome;
    root = await boot("dsh-dsworker-run", configPath, [
      { id: "request-trace", disabled: true },
    ]);
  } catch (error) {
    if (root !== undefined) await root.fiber.dispose().catch(() => {});
    restoreDshHome();
    await rm(dshHome, { recursive: true, force: true });
    throw error;
  }

  let disposed = false;
  return {
    ctx: root,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await root.fiber.dispose();
      } finally {
        restoreDshHome();
        await rm(dshHome, { recursive: true, force: true });
      }
    },
  };
}
