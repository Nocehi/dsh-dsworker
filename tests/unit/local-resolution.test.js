import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertRc6,
  rc6CliPath,
  rc6NodeModules,
  REQUIRED_DSH_VERSION,
} from "../../scripts/local-resolution.mjs";

async function fakeInstallation(version = REQUIRED_DSH_VERSION) {
  const root = await mkdtemp("/tmp/dsh-dsworker-resolution.");
  const packageDirectory = join(root, "@deepseek-ai", "dsh");
  await mkdir(join(packageDirectory, "lib"), { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "@deepseek-ai/dsh", version })}\n`,
    "utf8",
  );
  return root;
}

test("rc.6 resolves through ordinary project package resolution", async () => {
  const root = rc6NodeModules();
  const resolved = await assertRc6({ root });
  assert.equal(resolved.version, REQUIRED_DSH_VERSION);
  assert.equal(
    rc6CliPath(),
    join(root, "@deepseek-ai", "dsh", "lib", "bin.js"),
  );
});

test("explicit DSH_RC6_NODE_MODULES-style override remains exact and version-checked", async () => {
  const root = await fakeInstallation();
  try {
    assert.equal(rc6NodeModules({ override: root }), root);
    assert.equal((await assertRc6({ override: root })).version, REQUIRED_DSH_VERSION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing and mismatched overrides fail with actionable errors", async () => {
  const missing = join("/tmp", "dsh-dsworker-resolution-does-not-exist");
  await assert.rejects(
    assertRc6({ override: missing }),
    /cannot read @deepseek-ai\/dsh 0\.1\.0-rc\.6/u,
  );

  const root = await fakeInstallation("0.1.0-rc.5");
  try {
    await assert.rejects(
      assertRc6({ override: root }),
      /expected @deepseek-ai\/dsh 0\.1\.0-rc\.6, found 0\.1\.0-rc\.5/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolver errors and empty overrides are fail-closed", () => {
  assert.throws(
    () => rc6NodeModules({ override: "" }),
    /DSH_RC6_NODE_MODULES must be a non-empty path/u,
  );
  assert.throws(
    () =>
      rc6NodeModules({
        resolveManifest() {
          throw new Error("not installed");
        },
      }),
    /run npm install \(or npm ci\)/u,
  );
});
