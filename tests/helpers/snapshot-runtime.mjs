import { writeFile, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { boot } from "@deepseek-ai/dsh-app-boot";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  joinContextSections,
  renderContextSections,
  renderPrompt,
} from "@deepseek-ai/dsh-system-prompt";

const [configPath, profileManifest, outputPath, traceMode] = process.argv.slice(2);
if (
  !configPath ||
  !profileManifest ||
  !outputPath ||
  ![
    "on",
    "off",
    "path-guard-off",
    "task-check-off",
    "task-check-bound",
  ].includes(traceMode)
) {
  throw new Error(
    "usage: snapshot-runtime.mjs <config> <profile-package.json> <output> <on|off|path-guard-off|task-check-off|task-check-bound>",
  );
}

const patches =
  traceMode === "off"
    ? [{ id: "request-trace", disabled: true }]
    : traceMode === "path-guard-off"
      ? [{ id: "path-guard", disabled: true }]
      : traceMode === "task-check-off"
        ? [{ id: "task-check", disabled: true }]
        : [];
const requireFromProfile = createRequire(profileManifest);
const taskContractEntry = requireFromProfile.resolve(
  "@dsh-dsworker/task-contract",
);
const taskContractResolution = await realpath(
  requireFromProfile.resolve("@dsh-dsworker/task-contract/package.json"),
);
const pathAuthorityEntry = requireFromProfile.resolve(
  "@dsh-dsworker/path-authority",
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
const taskCheckCoreEntry = requireFromProfile.resolve(
  "@dsh-dsworker/task-check-core",
);
const taskCheckCoreResolution = await realpath(
  requireFromProfile.resolve("@dsh-dsworker/task-check-core/package.json"),
);
const taskCheckLocalEntry = requireFromProfile.resolve(
  "@dsh-dsworker/task-check-local",
);
const taskCheckLocalResolution = await realpath(
  requireFromProfile.resolve("@dsh-dsworker/task-check-local/package.json"),
);
const workerKernelEntry = requireFromProfile.resolve(
  "@dsh-dsworker/worker-kernel",
);
const workerKernelResolution = await realpath(
  requireFromProfile.resolve("@dsh-dsworker/worker-kernel/package.json"),
);
const workspaceDeltaEntry = requireFromProfile.resolve(
  "@dsh-dsworker/workspace-delta",
);
const workspaceDeltaResolution = await realpath(
  requireFromProfile.resolve("@dsh-dsworker/workspace-delta/package.json"),
);
const executionContainmentEntry = requireFromProfile.resolve(
  "@dsh-dsworker/execution-containment",
);
const executionContainmentResolution = await realpath(
  requireFromProfile.resolve("@dsh-dsworker/execution-containment/package.json"),
);
const taskContractModule = await import(pathToFileURL(taskContractEntry).href);
const pathAuthorityModule = await import(pathToFileURL(pathAuthorityEntry).href);
const taskCheckCoreModule = await import(pathToFileURL(taskCheckCoreEntry).href);
const taskCheckLocalModule = await import(pathToFileURL(taskCheckLocalEntry).href);
const workerKernelModule = await import(pathToFileURL(workerKernelEntry).href);
const workspaceDeltaModule = await import(pathToFileURL(workspaceDeltaEntry).href);
const executionContainmentModule = await import(
  pathToFileURL(executionContainmentEntry).href
);
if (typeof taskContractModule.parseTaskContract !== "function") {
  throw new Error("task-contract did not expose its host-side parser");
}
if (typeof pathAuthorityModule.compilePathAuthority !== "function") {
  throw new Error("path-authority did not expose its host-side compiler");
}
if (typeof taskCheckCoreModule.evaluateTaskCheck !== "function") {
  throw new Error("task-check-core did not expose its host-side verdict evaluator");
}
if (typeof taskCheckLocalModule.createTaskCheckBinding !== "function") {
  throw new Error("task-check-local did not expose its host-side binding API");
}
if (typeof workerKernelModule.runWorker !== "function") {
  throw new Error("worker-kernel did not expose its host-side runner API");
}
if (typeof workspaceDeltaModule.createWorkspaceDeltaBinding !== "function") {
  throw new Error("workspace-delta did not expose its host-side binding API");
}
const hostContract = taskContractModule.parseTaskContract({
  authority: {
    version: taskContractModule.TASK_CONTRACT_VERSION,
    taskId: "composition-host-only",
    objective: "Prove host-only authority has no model-visible geometry.",
    workspace: {
      root: "runner-supplied",
      commandCwdPolicy: "workspace-relative-only",
      symlinkPolicy: "unsupported",
    },
    paths: {
      mutable: [{ path: "fixture.txt", kind: "file" }],
      immutable: [{ path: "authority.txt", kind: "file" }],
    },
    commands: {
      semantic: [
        {
          id: "not-executed",
          executable: "true",
          argv: [],
          cwd: { kind: "workspace-root" },
          environment: {},
          timeoutMs: 1_000,
          expected: { exitCodes: [0] },
        },
      ],
      validation: [],
      finish: [],
    },
    retry: { mode: "none", maxAttempts: 1 },
    terminal: {
      success: "all-authoritative-commands-pass",
      failure: "fail-closed",
    },
  },
});
const hostPathAuthority = pathAuthorityModule.compilePathAuthority(hostContract);
const hostTaskCommandDigest = taskCheckCoreModule.commandArgvSha256(
  hostContract.authority.commands.semantic[0],
);
const hostTaskEnvironment = taskCheckLocalModule.sanitizeBaseEnvironment({
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
});
if (
  hostPathAuthority.contract !== hostContract ||
  hostPathAuthority.contractSha256 !== hostContract.contractSha256
) {
  throw new Error("path-authority did not retain the exact TaskContract authority");
}
const root = await boot("dsh-dsworker-snapshot", configPath, patches);
let handle;
let taskCheckPluginBinding;
let taskCheckLocalBinding;
try {
  const agentWorkspace =
    traceMode === "task-check-bound"
      ? dirname(outputPath) + "/task-check-workspace"
      : "/tmp/dsh-dsworker-v0-workspace";
  if (traceMode === "task-check-bound") await mkdir(agentWorkspace, { recursive: true });
  handle = await root.agents.create({
    sessionId: SessionId("composition-snapshot-session"),
    meta: { cwd: agentWorkspace },
    agentOptions: { provider: "snapshot-fake", model: "snapshot-model" },
    setup: async (agentCtx) => {
      await root.agentPresets.mount(agentCtx, "lean-coding");
    },
  });
  if (traceMode === "task-check-bound") {
    taskCheckLocalBinding = await taskCheckLocalModule.createTaskCheckBinding({
      contract: hostContract,
      workspaceRoot: agentWorkspace,
      baseEnvironment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    taskCheckPluginBinding = root.taskCheckTool.bind(
      handle.agent,
      hostContract,
      taskCheckLocalBinding,
    );
  }
  const scope = scopeOf(handle.agent.ctx);
  const assembly = await root.systemPrompt.assemble({ scope, agent: handle.agent });
  const toolSchemas = root.tools.schemas(scope);
  const schemasByName = (schemas) =>
    [...schemas].sort((left, right) => left.name.localeCompare(right.name));
  if (
    JSON.stringify(schemasByName(toolSchemas)) !==
    JSON.stringify(schemasByName(assembly.tools))
  ) {
    throw new Error(
      `system-prompt and tool registry schema views diverged:\nregistry=${JSON.stringify(toolSchemas)}\nassembly=${JSON.stringify(assembly.tools)}`,
    );
  }
  const contextSections = renderContextSections(assembly);
  const rows = [...root.loader.entries()].map((entry) => ({
    id: entry.id,
    moduleName: entry.options.name,
    enabled: !entry.disabled,
    fiberState: entry.fiber?.state ?? null,
  }));

  const bundleResolution = await realpath(
    requireFromProfile.resolve("@dsh-dsworker/bundle-core/package.json"),
  );
  const pluginResolution = await realpath(
    requireFromProfile.resolve(
      "@dsh-dsworker/plugin-request-trace/package.json",
    ),
  );
  const dshResolution = await realpath(
    requireFromProfile.resolve("@deepseek-ai/dsh/package.json"),
  );

  const snapshot = {
    system: renderPrompt(assembly),
    tools: assembly.tools,
    contextSections,
    contextText: joinContextSections(contextSections),
    rows,
    bundleResolution,
    executionContainmentResolution,
    executionContainmentLoaded:
      typeof executionContainmentModule.createExecutionContainment === "function",
    executionContainmentMounted:
      typeof root.get("subprocess", false)?.bindExecutionContainment === "function",
    pluginResolution,
    taskContractResolution,
    taskContractLoaded: true,
    pathAuthorityResolution,
    pathAuthorityLoaded: true,
    pathAuthorityContractIdentityRetained:
      hostPathAuthority.contract === hostContract,
    pathGuardResolution,
    pathGuardMounted: root.get("pathGuard", false) !== undefined,
    taskCheckPluginResolution,
    taskCheckPluginMounted: root.get("taskCheckTool", false) !== undefined,
    taskCheckCoreResolution,
    taskCheckCoreLoaded: true,
    taskCheckLocalResolution,
    taskCheckLocalLoaded: true,
    workerKernelResolution,
    workspaceDeltaResolution,
    workspaceDeltaLoaded:
      typeof workspaceDeltaModule.exportWorkspaceDelta === "function",
    workerKernelLoaded: true,
    taskCheckHostContractIdentityRetained:
      hostPathAuthority.contract === hostContract &&
      typeof hostTaskCommandDigest === "string" &&
      hostTaskCommandDigest.length === 64,
    taskCheckInheritsProcessEnvironment:
      hostTaskEnvironment.policy.inheritsProcessEnvironment,
    dshResolution,
    traceMode,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot)}\n`, "utf8");
} finally {
  taskCheckPluginBinding?.dispose();
  if (taskCheckLocalBinding !== undefined) {
    taskCheckLocalModule.disposeTaskCheckBinding(taskCheckLocalBinding);
  }
  if (handle !== undefined) await handle.dispose();
  await root.fiber.dispose();
}
