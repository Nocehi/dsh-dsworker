#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseTaskContract } from "@dsh-dsworker/task-contract";
import { runWorker, workerExitCode } from "../src/index.js";
import { createTransientProfileRuntime } from "../src/transient-runtime.js";

function usage() {
  return "usage: dsh-dsworker-run --contract <json> --workspace-source <directory>\n";
}

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { help: true };
  }
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${String(flag)}`);
    if (flag === "--contract") result.contractPath = value;
    else if (flag === "--workspace-source") result.sourceWorkspaceRoot = value;
    else throw new Error(`unknown argument: ${String(flag)}`);
  }
  if (!result.contractPath || !result.sourceWorkspaceRoot) {
    throw new Error("both --contract and --workspace-source are required");
  }
  return result;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    process.exitCode = 0;
  } else {
    const contract = parseTaskContract(
      JSON.parse(await readFile(resolve(options.contractPath), "utf8")),
    );
    const baseEnvironment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
      ...(process.env.LC_ALL === undefined ? {} : { LC_ALL: process.env.LC_ALL }),
      ...(process.env.TZ === undefined ? {} : { TZ: process.env.TZ }),
    };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    let result;
    try {
      result = await runWorker({
        contract,
        sourceWorkspaceRoot: resolve(options.sourceWorkspaceRoot),
        baseEnvironment,
        runtimeFactory: createTransientProfileRuntime,
        sessionId: `worker-${randomUUID()}`,
        signal: controller.signal,
      });
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = workerExitCode(result);
  }
} catch (error) {
  process.stderr.write(`dsh-dsworker-run: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(usage());
  process.exitCode = 64;
}
