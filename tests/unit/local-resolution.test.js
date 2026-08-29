import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertDshVersion,
  dshCliPath,
  dshNodeModules,
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

test("configured DSH baseline resolves through ordinary project package resolution", async () => {
  assert.equal(REQUIRED_DSH_VERSION, "0.1.1-rc.2");
  const root = dshNodeModules();
  const resolved = await assertDshVersion({ root });
  assert.equal(resolved.version, REQUIRED_DSH_VERSION);
  assert.equal(
    dshCliPath(),
    join(root, "@deepseek-ai", "dsh", "lib", "bin.js"),
  );
});

test("explicit DSH_NODE_MODULES-style override remains exact and version-checked", async () => {
  const root = await fakeInstallation();
  try {
    assert.equal(dshNodeModules({ override: root }), root);
    assert.equal((await assertDshVersion({ override: root })).version, REQUIRED_DSH_VERSION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing and mismatched overrides fail with actionable errors", async () => {
  const missing = join("/tmp", "dsh-dsworker-resolution-does-not-exist");
  await assert.rejects(
    assertDshVersion({ override: missing }),
    /cannot read @deepseek-ai\/dsh 0\.1\.1-rc\.2/u,
  );

  const root = await fakeInstallation("0.1.0-rc.7");
  try {
    await assert.rejects(
      assertDshVersion({ override: root }),
      /expected @deepseek-ai\/dsh 0\.1\.1-rc\.2, found 0\.1\.0-rc\.7/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolver errors and empty overrides are fail-closed", () => {
  assert.throws(
    () => dshNodeModules({ override: "" }),
    /DSH_NODE_MODULES must be a non-empty path/u,
  );
  assert.throws(
    () =>
      dshNodeModules({
        resolveManifest() {
          throw new Error("not installed");
        },
      }),
    /run npm install \(or npm ci\)/u,
  );
});
