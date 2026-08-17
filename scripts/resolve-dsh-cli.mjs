import { pathToFileURL } from "node:url";
import { assertDshVersion, dshCliPath } from "./local-resolution.mjs";

export async function resolveDshCli() {
  await assertDshVersion();
  return dshCliPath();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${await resolveDshCli()}\n`);
}
