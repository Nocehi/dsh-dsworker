import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalize,
  sha256Utf8,
  stableStringify,
  utf8Bytes,
} from "../../packages/plugin-request-trace/src/canonical.js";
import { materializeProfile } from "../../scripts/materialize-profile.mjs";
import {
  dshCliPath,
  dshNodeModules,
  REPO_ROOT,
  REQUIRED_DSH_VERSION,
} from "../../scripts/local-resolution.mjs";

const DSH_NODE_MODULES = dshNodeModules();
const DSH_CLI = dshCliPath();
const SNAPSHOT_DIR = join(REPO_ROOT, "tests", "composition", "snapshots");
const EXPECTED_TOOLS = ["bash", "edit", "glob", "grep", "read", "write"];
const EXPECTED_BOUND_TOOLS = [...EXPECTED_TOOLS, "task_check"].sort();
const PINNED_MODEL_GEOMETRY = {
  systemBytes: 1544,
  systemSha256: "a9f1dd473d1921667863cd1a7ad3f59ef11d9b9f3123063da426d9ec1014a7e0",
  toolSchemaBytes: 7005,
  toolsSha256: "47b9fb3496df75b32e656f1e8e67198b6ea9a2fe2f28c68ca9381483c4143856",
  durableInitialContextBytes: 0,
  durableInitialContextSha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};

function cleanEnvironment(dshHome) {
  return {
    PATH: "/usr/bin:/bin",
    DSH_HOME: dshHome,
    DSH_REQUEST_TRACE_PATH: join(dshHome, "traces", "requests.jsonl"),
    DSH_TELEMETRY_DISABLED: "1",
  };
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `command failed (${String(result.status)}): ${command} ${args.join(" ")}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`,
    );
  }
  return result;
}

function normalizedConfig(text, dshHome) {
  return text.replaceAll(dshHome, "<DSH_HOME>").replaceAll("\r\n", "\n");
}

function pretty(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

async function collectMode(root, mode) {
  const dshHome = join(root, mode);
  const materialized = await materializeProfile(dshHome);
  const env = cleanEnvironment(dshHome);
  const composedPath = join(materialized.profileDir, "composed.cordis.yml");
  const dumpFile = await open(composedPath, "w", 0o600);
  try {
    run(process.execPath, [DSH_CLI, "--profile", "headless-dev", "--dump-config"], {
      cwd: REPO_ROOT,
      env,
      // The pinned CLI relaunch path reliably preserves dump output through an
      // inherited descriptor; a nested spawnSync pipe can be empty on success.
      stdio: ["ignore", dumpFile.fd, "pipe"],
    });
  } finally {
    await dumpFile.close();
  }
  const configText = await readFile(composedPath, "utf8");
  assert.match(configText, /^# == /u, "DSH dump-config output was empty");
  const outputPath = join(dshHome, `snapshot-${mode}.json`);
  run(
    process.execPath,
    [
      join(REPO_ROOT, "tests", "helpers", "snapshot-runtime.mjs"),
      composedPath,
      join(materialized.profileDir, "package.json"),
      outputPath,
      mode,
    ],
    { cwd: REPO_ROOT, env },
  );
  return {
    dshHome,
    materialized,
    config: normalizedConfig(configText, dshHome),
    runtime: JSON.parse(await readFile(outputPath, "utf8")),
    tracePath: env.DSH_REQUEST_TRACE_PATH,
  };
}

function rowMap(runtime) {
  return new Map(
    runtime.rows.map((row) => [row.id.replace(/^include:/u, ""), row]),
  );
}

function dumpedRow(config, id) {
  const marker = `- id: ${id}\n`;
  const start = config.indexOf(marker);
  assert.notEqual(start, -1, `missing composed config row: ${id}`);
  const next = config.indexOf("\n- id: ", start + marker.length);
  return config.slice(start, next === -1 ? config.length : next + 1);
}

async function assertOrUpdateSnapshot(name, actual) {
  const path = join(SNAPSHOT_DIR, name);
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    await writeFile(path, actual, "utf8");
    return;
  }
  assert.equal(actual, await readFile(path, "utf8"), `snapshot mismatch: ${name}`);
}

test("headless-dev composes the rc.7 lean preset and trace has zero model geometry", async () => {
  const temp = await mkdtemp("/tmp/dsh-dsworker-composition.");
  try {
    const on = await collectMode(temp, "on");
    const off = await collectMode(temp, "off");
    const pathGuardOff = await collectMode(temp, "path-guard-off");
    const taskCheckOff = await collectMode(temp, "task-check-off");
    const taskCheckBound = await collectMode(temp, "task-check-bound");

    assert.equal(on.materialized.dshVersion, REQUIRED_DSH_VERSION);
    for (const [resolution, packageName] of [
      [on.runtime.bundleResolution, "bundle-core"],
      [on.runtime.pluginResolution, "plugin-request-trace"],
      [on.runtime.executionContainmentResolution, "execution-containment"],
      [on.runtime.taskContractResolution, "task-contract"],
      [on.runtime.pathAuthorityResolution, "path-authority"],
      [on.runtime.pathGuardResolution, "plugin-path-guard"],
      [on.runtime.taskCheckCoreResolution, "task-check-core"],
      [on.runtime.taskCheckPluginResolution, "plugin-task-check"],
      [on.runtime.taskCheckLocalResolution, "task-check-local"],
      [on.runtime.workerKernelResolution, "worker-kernel"],
      [on.runtime.workspaceDeltaResolution, "workspace-delta"],
    ]) {
      assert.equal(
        resolution,
        join(REPO_ROOT, "packages", packageName, "package.json"),
        `${packageName} must resolve from this repository`,
      );
    }
    assert.equal(
      on.materialized.executionContainmentResolution,
      on.runtime.executionContainmentResolution,
    );
    assert.equal(on.runtime.executionContainmentLoaded, true);
    assert.equal(on.runtime.executionContainmentMounted, true);
    assert.equal(
      on.materialized.pathAuthorityResolution,
      on.runtime.pathAuthorityResolution,
    );
    assert.equal(
      on.materialized.pathGuardResolution,
      on.runtime.pathGuardResolution,
    );
    assert.equal(
      on.materialized.taskCheckCoreResolution,
      on.runtime.taskCheckCoreResolution,
    );
    assert.equal(
      on.materialized.taskCheckLocalResolution,
      on.runtime.taskCheckLocalResolution,
    );
    assert.equal(on.runtime.taskContractLoaded, true);
    assert.equal(on.runtime.pathAuthorityLoaded, true);
    assert.equal(on.runtime.pathAuthorityContractIdentityRetained, true);
    assert.equal(on.runtime.pathGuardMounted, true);
    assert.equal(on.runtime.taskCheckPluginMounted, true);
    assert.equal(on.runtime.taskCheckCoreLoaded, true);
    assert.equal(on.runtime.taskCheckLocalLoaded, true);
    assert.equal(on.runtime.taskCheckHostContractIdentityRetained, true);
    assert.equal(on.runtime.taskCheckInheritsProcessEnvironment, false);
    assert.equal(pathGuardOff.runtime.pathGuardMounted, false);
    assert.equal(taskCheckOff.runtime.taskCheckPluginMounted, false);
    assert.equal(
      on.materialized.taskCheckPluginResolution,
      on.runtime.taskCheckPluginResolution,
    );
    assert.equal(on.materialized.workerKernelResolution, on.runtime.workerKernelResolution);
    assert.equal(on.runtime.workerKernelLoaded, true);
    assert.equal(
      on.materialized.workspaceDeltaResolution,
      on.runtime.workspaceDeltaResolution,
    );
    assert.equal(on.runtime.workspaceDeltaLoaded, true);
    const workerKernelManifest = JSON.parse(
      await readFile(on.runtime.workerKernelResolution, "utf8"),
    );
    assert.deepEqual(workerKernelManifest.dependencies, {
      "@dsh-dsworker/execution-containment": "file:../execution-containment",
      "@dsh-dsworker/plugin-task-check": "file:../plugin-task-check",
      "@dsh-dsworker/task-check-local": "file:../task-check-local",
      "@dsh-dsworker/task-contract": "file:../task-contract",
      "@dsh-dsworker/workspace-delta": "file:../workspace-delta",
    });
    assert.deepEqual(workerKernelManifest.peerDependencies, {
      "@deepseek-ai/dsh-agent": "0.1.0-rc.7",
      "@deepseek-ai/dsh-app-boot": "0.1.0-rc.7",
      "@deepseek-ai/dsh-llm": "0.1.0-rc.7",
      "@deepseek-ai/dsh-session": "0.1.0-rc.7",
    });
    const pathGuardManifest = JSON.parse(
      await readFile(on.runtime.pathGuardResolution, "utf8"),
    );
    assert.equal(pathGuardManifest.name, "@dsh-dsworker/plugin-path-guard");
    assert.deepEqual(pathGuardManifest.dependencies, {
      "@dsh-dsworker/path-authority": "file:../path-authority",
      "@dsh-dsworker/task-contract": "file:../task-contract",
    });
    assert.deepEqual(pathGuardManifest.peerDependencies, {
      "@deepseek-ai/cordis": "^4.0.1",
      "@deepseek-ai/dsh-agent": "0.1.0-rc.7",
      "@deepseek-ai/dsh-fs": "0.1.0-rc.7",
      "@deepseek-ai/dsh-tools": "0.1.0-rc.7",
    });
    const pathAuthorityManifest = JSON.parse(
      await readFile(on.runtime.pathAuthorityResolution, "utf8"),
    );
    const taskCheckPluginManifest = JSON.parse(
      await readFile(on.runtime.taskCheckPluginResolution, "utf8"),
    );
    assert.deepEqual(taskCheckPluginManifest.dependencies, {
      "@dsh-dsworker/task-check-core": "file:../task-check-core",
      "@dsh-dsworker/task-check-local": "file:../task-check-local",
      "@dsh-dsworker/task-contract": "file:../task-contract",
    });
    assert.deepEqual(taskCheckPluginManifest.peerDependencies, {
      "@deepseek-ai/cordis": "^4.0.1",
      "@deepseek-ai/dsh-agent": "0.1.0-rc.7",
      "@deepseek-ai/dsh-llm": "0.1.0-rc.7",
      "@deepseek-ai/dsh-tools": "0.1.0-rc.7",
    });
    assert.deepEqual(pathAuthorityManifest.dependencies, {
      "@dsh-dsworker/task-contract": "file:../task-contract",
    });
    assert.equal(
      Object.keys(pathAuthorityManifest.dependencies).some((name) =>
        /cordis|@deepseek-ai\/dsh/u.test(name),
      ),
      false,
      "path-authority must remain independent of DSH/Cordis runtime packages",
    );
    const taskCheckCoreManifest = JSON.parse(
      await readFile(on.runtime.taskCheckCoreResolution, "utf8"),
    );
    assert.deepEqual(taskCheckCoreManifest.dependencies, {
      "@dsh-dsworker/task-contract": "file:../task-contract",
    });
    const taskCheckLocalManifest = JSON.parse(
      await readFile(on.runtime.taskCheckLocalResolution, "utf8"),
    );
    assert.deepEqual(taskCheckLocalManifest.dependencies, {
      "@dsh-dsworker/execution-containment": "file:../execution-containment",
      "@dsh-dsworker/path-authority": "file:../path-authority",
      "@dsh-dsworker/task-check-core": "file:../task-check-core",
      "@dsh-dsworker/task-contract": "file:../task-contract",
    });
    const workspaceDeltaManifest = JSON.parse(
      await readFile(on.runtime.workspaceDeltaResolution, "utf8"),
    );
    assert.deepEqual(workspaceDeltaManifest.dependencies, {
      "@dsh-dsworker/task-check-local": "file:../task-check-local",
      "@dsh-dsworker/task-contract": "file:../task-contract",
    });
    for (const manifest of [
      taskCheckCoreManifest,
      taskCheckLocalManifest,
      workspaceDeltaManifest,
    ]) {
      assert.equal(
        Object.keys(manifest.dependencies).some((name) =>
          /cordis|@deepseek-ai\/dsh/u.test(name),
        ),
        false,
        `${manifest.name} must remain independent of DSH/Cordis runtime packages`,
      );
    }
    assert.equal(
      on.runtime.rows.some(
        (row) => row.moduleName === "@dsh-dsworker/task-contract",
      ),
      false,
      "task-contract is a host library and must not become a Loader row",
    );
    assert.equal(
      on.runtime.rows.some(
        (row) => row.moduleName === "@dsh-dsworker/path-authority",
      ),
      false,
      "path-authority is a host library and must not become a Loader row",
    );
    for (const hostLibrary of [
      "@dsh-dsworker/task-check-core",
      "@dsh-dsworker/task-check-local",
      "@dsh-dsworker/worker-kernel",
      "@dsh-dsworker/workspace-delta",
    ]) {
      assert.equal(
        on.runtime.rows.some((row) => row.moduleName === hostLibrary),
        false,
        `${hostLibrary} is a host library and must not become a Loader row`,
      );
    }
    assert.equal(
      on.runtime.rows.some(
        (row) =>
          row.enabled &&
          row.moduleName === "@dsh-dsworker/execution-containment",
      ),
      true,
      "execution-containment must replace the local subprocess provider",
    );
    assert.equal(
      on.runtime.rows.some(
        (row) =>
          row.enabled && row.moduleName === "@deepseek-ai/dsh-subprocess-local",
      ),
      false,
      "official local subprocess provider must not remain independently active",
    );
    assert.equal(
      on.runtime.rows.some(
        (row) => row.moduleName === "@dsh-dsworker/plugin-path-guard",
      ),
      true,
      "path-guard must be an active host policy Loader row",
    );
    assert.equal(
      on.runtime.dshResolution,
      join(DSH_NODE_MODULES, "@deepseek-ai", "dsh", "package.json"),
    );

    assert.deepEqual(on.runtime.tools, off.runtime.tools);
    assert.equal(on.runtime.system, off.runtime.system);
    assert.deepEqual(on.runtime.contextSections, off.runtime.contextSections);
    assert.equal(on.runtime.contextText, off.runtime.contextText);
    assert.deepEqual(on.runtime.tools, pathGuardOff.runtime.tools);
    assert.equal(on.runtime.system, pathGuardOff.runtime.system);
    assert.deepEqual(
      on.runtime.contextSections,
      pathGuardOff.runtime.contextSections,
    );
    assert.equal(on.runtime.contextText, pathGuardOff.runtime.contextText);
    assert.deepEqual(on.runtime.tools, taskCheckOff.runtime.tools);
    assert.equal(on.runtime.system, taskCheckOff.runtime.system);
    assert.deepEqual(
      on.runtime.contextSections,
      taskCheckOff.runtime.contextSections,
    );
    assert.equal(on.runtime.contextText, taskCheckOff.runtime.contextText);
    assert.equal(on.runtime.system, taskCheckBound.runtime.system);
    assert.deepEqual(
      on.runtime.contextSections,
      taskCheckBound.runtime.contextSections,
    );
    assert.equal(on.runtime.contextText, taskCheckBound.runtime.contextText);
    assert.deepEqual(
      taskCheckBound.runtime.tools
        .filter((tool) => tool.name !== "task_check"),
      on.runtime.tools,
    );
    assert.deepEqual(
      taskCheckBound.runtime.tools.map((tool) => tool.name).sort(),
      EXPECTED_BOUND_TOOLS,
    );
    assert.deepEqual(
      on.runtime.tools.map((tool) => tool.name).sort(),
      EXPECTED_TOOLS,
    );
    assert.equal(on.runtime.contextText, "");
    assert.deepEqual(on.runtime.contextSections, []);
    assert.equal(existsSync(on.tracePath), false, "no LLM request means no trace file");
    assert.equal(
      existsSync(taskCheckBound.tracePath),
      false,
      "binding task_check without an LLM request must not create a trace",
    );

    const rows = rowMap(on.runtime);
    for (const id of [
      "hmr",
      "session-title-llm",
      "session-telemetry-otel",
      "llm-retry",
      "attachment-local",
      "jobs",
      "tool-jobs",
      "agent-instructions",
      "skill",
      "skill-filesystem",
      "tool-skill",
      "goal",
      "goal-round-driver",
      "tool-goal",
      "tool-todo",
      "subagent",
      "subagent-spawn-in-process",
      "subagent-fork-in-process",
      "tool-subagent",
      "workflow-worker-thread",
      "tool-workflow",
      "tool-ralph",
      "web",
      "web-search-deepseek",
      "tool-web",
      "code-runtime",
      "headless-startup",
      "headless-runner",
    ]) {
      assert.equal(rows.get(id)?.enabled, false, `expected disabled row: ${id}`);
      assert.match(dumpedRow(on.config, id), /\n  disabled: true\n/u);
    }
    for (const id of [
      "llm",
      "session",
      "session-persistence-jsonl",
      "agent",
      "execution-containment",
      "sandbox",
      "sandbox-policy",
      "bash-sandbox",
      "approval",
      "permission",
      "fs-observation-policy",
      "fs-sandbox",
      "tools",
      "system-prompt",
      "agent-loop",
      "spill-local",
      "spill-policy",
      "path-guard",
      "task-check",
      "request-trace",
      "agent-presets",
      "agent-presets:persona",
      "agent-presets:tool-bash",
      "agent-presets:tool-fs",
      "agent-presets:tool-fs-search",
      "agent-presets:compaction-basic",
      "agent-presets:tool-result-pruner",
    ]) {
      assert.equal(rows.get(id)?.enabled, true, `expected active row: ${id}`);
    }
    assert.equal(rows.get("subprocess")?.enabled, false);
    assert.equal(
      on.runtime.rows.some((row) =>
        /@deepseek-ai\/dsh-(tool-cordis|cordis-host-runner|cordis-client-runner)/u.test(
          row.moduleName ?? "",
        ),
      ),
      false,
    );
    assert.equal(
      on.runtime.rows.some(
        (row) =>
          row.enabled &&
          /@deepseek-ai\/dsh-(client-|web-app|host-)/u.test(row.moduleName ?? ""),
      ),
      false,
    );
    assert.equal(
      on.runtime.rows.some(
        (row) => row.enabled && /@deepseek-ai\/dsh-(mcp|tool-mcp)/u.test(row.moduleName ?? ""),
      ),
      false,
    );

    const compactTools = stableStringify(on.runtime.tools);
    const geometry = {
      dshVersion: REQUIRED_DSH_VERSION,
      presetId: "lean-coding",
      toolNames: on.runtime.tools.map((tool) => tool.name),
      systemBytes: utf8Bytes(on.runtime.system),
      systemSha256: sha256Utf8(on.runtime.system),
      toolSchemaBytes: utf8Bytes(compactTools),
      toolsSha256: sha256Utf8(compactTools),
      durableInitialContextBytes: utf8Bytes(on.runtime.contextText),
      durableInitialContextSha256: sha256Utf8(on.runtime.contextText),
      composedConfigBytes: utf8Bytes(on.config),
      composedConfigSha256: sha256Utf8(on.config),
      traceGeometryDelta: {
        systemBytes: utf8Bytes(on.runtime.system) - utf8Bytes(off.runtime.system),
        toolSchemaBytes: utf8Bytes(compactTools) - utf8Bytes(stableStringify(off.runtime.tools)),
        durableContextBytes:
          utf8Bytes(on.runtime.contextText) - utf8Bytes(off.runtime.contextText),
      },
      pathGuardGeometryDelta: {
        systemBytes:
          utf8Bytes(on.runtime.system) - utf8Bytes(pathGuardOff.runtime.system),
        toolSchemaBytes:
          utf8Bytes(compactTools) -
          utf8Bytes(stableStringify(pathGuardOff.runtime.tools)),
        durableContextBytes:
          utf8Bytes(on.runtime.contextText) -
          utf8Bytes(pathGuardOff.runtime.contextText),
      },
      taskCheckPluginUnboundGeometryDelta: {
        systemBytes:
          utf8Bytes(on.runtime.system) - utf8Bytes(taskCheckOff.runtime.system),
        toolSchemaBytes:
          utf8Bytes(compactTools) -
          utf8Bytes(stableStringify(taskCheckOff.runtime.tools)),
        durableContextBytes:
          utf8Bytes(on.runtime.contextText) -
          utf8Bytes(taskCheckOff.runtime.contextText),
      },
    };
    assert.deepEqual(geometry.traceGeometryDelta, {
      systemBytes: 0,
      toolSchemaBytes: 0,
      durableContextBytes: 0,
    });
    assert.deepEqual(geometry.pathGuardGeometryDelta, {
      systemBytes: 0,
      toolSchemaBytes: 0,
      durableContextBytes: 0,
    });
    assert.deepEqual(geometry.taskCheckPluginUnboundGeometryDelta, {
      systemBytes: 0,
      toolSchemaBytes: 0,
      durableContextBytes: 0,
    });
    assert.deepEqual(
      {
        systemBytes: geometry.systemBytes,
        systemSha256: geometry.systemSha256,
        toolSchemaBytes: geometry.toolSchemaBytes,
        toolsSha256: geometry.toolsSha256,
        durableInitialContextBytes: geometry.durableInitialContextBytes,
        durableInitialContextSha256: geometry.durableInitialContextSha256,
      },
      PINNED_MODEL_GEOMETRY,
      "mounting host authority/policy packages changed pinned model geometry",
    );

    const taskCheckSchema = taskCheckBound.runtime.tools.find(
      (tool) => tool.name === "task_check",
    );
    const compactTaskCheckSchema = stableStringify(taskCheckSchema);
    const compactBoundTools = stableStringify(taskCheckBound.runtime.tools);
    const boundGeometry = {
      systemBytes: utf8Bytes(taskCheckBound.runtime.system),
      systemSha256: sha256Utf8(taskCheckBound.runtime.system),
      toolSchemaBytes: utf8Bytes(compactBoundTools),
      toolsSha256: sha256Utf8(compactBoundTools),
      durableInitialContextBytes: utf8Bytes(taskCheckBound.runtime.contextText),
      durableInitialContextSha256: sha256Utf8(taskCheckBound.runtime.contextText),
      taskCheckSchemaBytes: utf8Bytes(compactTaskCheckSchema),
      taskCheckSchemaSha256: sha256Utf8(compactTaskCheckSchema),
      toolSchemaDeltaBytes: utf8Bytes(compactBoundTools) - utf8Bytes(compactTools),
    };
    assert.deepEqual(boundGeometry, {
      systemBytes: 1544,
      systemSha256: "a9f1dd473d1921667863cd1a7ad3f59ef11d9b9f3123063da426d9ec1014a7e0",
      toolSchemaBytes: 7350,
      toolsSha256: "182fd310541d14b80cfcba00837587894dd42f34a60ca089e9411f1835db700e",
      durableInitialContextBytes: 0,
      durableInitialContextSha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      taskCheckSchemaBytes: 344,
      taskCheckSchemaSha256:
        "0e03bdbbb7aa630f5ebddf26fdd6531aa381b25756e54b935a9ed5786b818477",
      toolSchemaDeltaBytes: 345,
    });

    await assertOrUpdateSnapshot("headless-dev.config.yml", on.config);
    await assertOrUpdateSnapshot("lean-coding.system.txt", on.runtime.system);
    await assertOrUpdateSnapshot("lean-coding.tools.json", pretty(on.runtime.tools));
    await assertOrUpdateSnapshot(
      "lean-coding.context.json",
      pretty({ sections: on.runtime.contextSections, text: on.runtime.contextText }),
    );
    await assertOrUpdateSnapshot("geometry.json", pretty(geometry));
    await assertOrUpdateSnapshot(
      "task-check.tool.json",
      pretty(taskCheckSchema),
    );
    await assertOrUpdateSnapshot(
      "task-check.geometry.json",
      pretty(boundGeometry),
    );
  } finally {
    if (process.env.KEEP_TEST_TEMP === "1") {
      process.stderr.write(`kept composition temp: ${temp}\n`);
    } else {
      await rm(temp, { recursive: true, force: true });
    }
  }
});
