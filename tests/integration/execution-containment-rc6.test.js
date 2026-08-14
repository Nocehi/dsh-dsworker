import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  containmentDisposition,
  createExecutionContainment,
  disposeExecutionContainment,
} from "@dsh-dsworker/execution-containment";
import {
  createTaskCheckBinding,
  disposeTaskCheckBinding,
  runTaskCheck,
} from "@dsh-dsworker/task-check-local";
import {
  TASK_CONTRACT_VERSION,
  parseTaskContract,
} from "@dsh-dsworker/task-contract";
import { createTransientProfileRuntime } from "../../packages/worker-kernel/src/transient-runtime.js";
import { TEST_BASE_ENVIRONMENT } from "../helpers/task-check-fixtures.mjs";

function commandContract({ taskId, mutable, argv, timeoutMs = 2_000 }) {
  return parseTaskContract({
    authority: {
      version: TASK_CONTRACT_VERSION,
      taskId,
      objective: "Exercise one exact command inside Linux containment.",
      workspace: {
        root: "runner-supplied",
        commandCwdPolicy: "workspace-relative-only",
        symlinkPolicy: "unsupported",
      },
      paths: { mutable, immutable: [] },
      commands: {
        semantic: [
          {
            id: "contained-command",
            executable: "node",
            argv,
            cwd: { kind: "workspace-root" },
            environment: { EXACT_LITERAL: "space quote \" slash \\ unicode 廣" },
            timeoutMs,
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
}

async function runBash(ctx, workspaceRoot, command, timeoutMs = 3_000) {
  return ctx.shell.run(
    ctx.shell.resolve({
      command,
      workdir: workspaceRoot,
      timeoutMs,
      sandboxPolicy: {
        mode: "workspace-write",
        workspaceRoot,
      },
    }),
  );
}

test("rc.6 Bash and TaskCheck share the strict bubblewrap execution world", async () => {
  const runRoot = await mkdtemp("/tmp/dsh-dsworker-containment-rc6.");
  const workspace = join(runRoot, "workspace");
  const sourceSibling = join(runRoot, "source-sibling");
  const outsideSentinel = join(runRoot, "outside.txt");
  const hostTmpMarker = "/tmp/dsh-dsworker-containment-host-tmp-marker";
  await mkdir(workspace);
  await mkdir(sourceSibling);
  await writeFile(outsideSentinel, "guard\n", "utf8");
  await rm(hostTmpMarker, { force: true });

  let containment;
  let runtime;
  let runtimeBinding;
  try {
    containment = await createExecutionContainment({ workspaceRoot: workspace });
    runtime = await createTransientProfileRuntime({ workspaceRoot: workspace });

    assert.throws(
      () =>
        runtime.ctx.subprocess.spawn({
          argv: ["true"],
          cwd: workspace,
          stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
          graceMs: 50,
        }),
      (error) => error?.code === "containment-unbound",
    );

    runtimeBinding = runtime.ctx.subprocess.bindExecutionContainment(containment);
    assert.equal(Object.isFrozen(runtimeBinding), true);

    await writeFile(
      join(workspace, "hello.c"),
      "int main(void) { return 0; }\n",
      "utf8",
    );
    const compile = await runBash(
      runtime.ctx,
      workspace,
      "cc hello.c -o hello && ./hello",
    );
    assert.equal(compile.exitCode, 0, compile.stderr.text);
    assert.equal(compile.timedOut, false);
    assert.equal(compile.aborted, false);
    assert.equal(compile.sandbox?.enforcement, "full");
    assert.equal(existsSync(join(workspace, "hello")), true);

    const outsideAttempt = await runBash(
      runtime.ctx,
      workspace,
      [
        "printf bad > ../escape-relative 2>/dev/null || true",
        `printf bad > '${outsideSentinel}' 2>/dev/null || true`,
        `printf bad > '${join(sourceSibling, "escape")}' 2>/dev/null || true`,
        "printf bad > /home/example-user/.dsh/escape 2>/dev/null || true",
        `printf bad > '${hostTmpMarker}' 2>/dev/null || true`,
        "test ! -e /home/example-user/.dsh/settings.yaml",
      ].join("; "),
    );
    assert.equal(outsideAttempt.exitCode, 0);
    assert.equal(await readFile(outsideSentinel, "utf8"), "guard\n");
    assert.equal(existsSync(join(sourceSibling, "escape")), false);
    assert.equal(existsSync(hostTmpMarker), false);

    await symlink("/home/example-user", join(workspace, "home-link"));
    const objectEscape = await runBash(
      runtime.ctx,
      workspace,
      [
        "! printf bad > home-link/escape 2>/dev/null",
        "! ln /usr/bin/true hardlink 2>/dev/null",
        "mkdir -p mountpoint",
        "! mount --bind /usr mountpoint 2>/dev/null",
      ].join("; "),
    );
    assert.equal(objectEscape.exitCode, 0);
    assert.equal(existsSync(join(workspace, "hardlink")), false);
    await unlink(join(workspace, "home-link"));

    const network = await runBash(
      runtime.ctx,
      workspace,
      "node -e \"const n=require('node:net');const s=n.connect({host:'127.0.0.1',port:3080});s.on('connect',()=>process.exit(41));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),250)\"",
    );
    assert.equal(network.exitCode, 0);

    const hostPid = process.pid;
    const processIsolation = await runBash(
      runtime.ctx,
      workspace,
      `node -e \"const f=require('node:fs');const p=${hostPid};if(f.existsSync('/proc/'+p))process.exit(41);try{process.kill(p,0);process.exit(42)}catch(e){process.exit(e.code==='ESRCH'?0:43)}\"`,
    );
    assert.equal(processIsolation.exitCode, 0);

    const daemon = await runBash(
      runtime.ctx,
      workspace,
      "setsid bash -c 'sleep 0.25; printf survived > daemon-survived' >/dev/null 2>&1 &",
    );
    assert.equal(daemon.exitCode, 0);
    await delay(450);
    assert.equal(existsSync(join(workspace, "daemon-survived")), false);

    const exact = ["", "two words", "\"quoted\"", "back\\slash", "廣東話"];
    const exactScript =
      "const f=require('node:fs');" +
      `const want=${JSON.stringify(exact)};` +
      "if(JSON.stringify(process.argv.slice(1))!==JSON.stringify(want))process.exit(51);" +
      "if(process.env.EXACT_LITERAL!=='space quote \\\" slash \\\\ unicode 廣')process.exit(52);" +
      "f.writeFileSync('argv-ok.txt','ok\\n')";
    const exactContract = commandContract({
      taskId: "contained-exact-argv",
      mutable: [{ path: "argv-ok.txt", kind: "file" }],
      argv: ["-e", exactScript, ...exact],
    });
    const exactBinding = await createTaskCheckBinding({
      contract: exactContract,
      workspaceRoot: workspace,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      executionContainment: containment,
    });
    const exactResult = await runTaskCheck(exactBinding, {
      contract: exactContract,
      workspaceRoot: workspace,
    });
    disposeTaskCheckBinding(exactBinding);
    assert.equal(exactResult.status, "green");
    assert.equal(exactResult.commands[0].exitCode, 0);

    const scopeContract = commandContract({
      taskId: "contained-independent-scope",
      mutable: [{ path: "allowed.txt", kind: "file" }],
      argv: ["-e", "process.exit(0)"],
    });
    const scopeBinding = await createTaskCheckBinding({
      contract: scopeContract,
      workspaceRoot: workspace,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      executionContainment: containment,
    });
    const bashSideEffect = await runBash(
      runtime.ctx,
      workspace,
      "printf unauthorized > foo.py",
    );
    assert.equal(bashSideEffect.exitCode, 0);
    const scopeResult = await runTaskCheck(scopeBinding, {
      contract: scopeContract,
      workspaceRoot: workspace,
    });
    disposeTaskCheckBinding(scopeBinding);
    assert.equal(scopeResult.status, "red");
    assert.ok(scopeResult.scope.preCommands.changedPaths.includes("foo.py"));

    const latePath = join(workspace, "late-descendant.txt");
    const timeoutContract = commandContract({
      taskId: "contained-timeout-tree",
      mutable: [{ path: "late-descendant.txt", kind: "file" }],
      timeoutMs: 50,
      argv: [
        "-e",
        "const c=require('node:child_process');c.spawn('bash',['-c','sleep 0.25; printf late > /workspace/late-descendant.txt'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)",
      ],
    });
    const timeoutBinding = await createTaskCheckBinding({
      contract: timeoutContract,
      workspaceRoot: workspace,
      baseEnvironment: TEST_BASE_ENVIRONMENT,
      executionContainment: containment,
    });
    const timeoutResult = await runTaskCheck(timeoutBinding, {
      contract: timeoutContract,
      workspaceRoot: workspace,
    });
    disposeTaskCheckBinding(timeoutBinding);
    assert.equal(timeoutResult.status, "red");
    assert.equal(timeoutResult.commands[0].timedOut, true);
    await delay(450);
    assert.equal(existsSync(latePath), false);

    await assert.rejects(
      () =>
        runtime.ctx.subprocess.spawnTerminal({
          argv: ["bash"],
          cwd: workspace,
          env: {},
          rows: 24,
          cols: 80,
          graceMs: 50,
        }),
      (error) => error?.code === "terminal-unsupported",
    );

    const disposition = containmentDisposition(containment);
    assert.equal(disposition.status, "ready");
    assert.ok(disposition.preparedExecutions >= 9);
    assert.equal(disposition.activeExecutions, 0);
    assert.equal(disposition.preparedExecutions, disposition.settledExecutions);
  } finally {
    runtimeBinding?.dispose();
    if (runtime !== undefined) await runtime.dispose();
    if (containment !== undefined) disposeExecutionContainment(containment);
    await rm(hostTmpMarker, { force: true });
    await rm(runRoot, { recursive: true, force: true });
  }
});
