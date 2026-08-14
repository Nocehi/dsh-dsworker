import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "./local-resolution.mjs";

const roots = ["packages", "scripts", "tests"];
const files = [];

async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) await walk(child);
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) files.push(child);
  }
}

for (const root of roots) await walk(join(REPO_ROOT, root));
files.sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}
process.stdout.write(`syntax ok: ${files.length} JavaScript files\n`);
