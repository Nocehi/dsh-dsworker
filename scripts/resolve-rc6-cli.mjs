import { pathToFileURL } from "node:url";
import { assertRc6, rc6CliPath } from "./local-resolution.mjs";

export async function resolveRc6Cli() {
  await assertRc6();
  return rc6CliPath();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${await resolveRc6Cli()}\n`);
}
