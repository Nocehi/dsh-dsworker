import { pathToFileURL } from "node:url";
import { ensureRepoLinks, REPO_ROOT } from "./local-resolution.mjs";

export { ensureRepoLinks } from "./local-resolution.mjs";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dsh = await ensureRepoLinks();
  process.stdout.write(
    `resolved @deepseek-ai/dsh ${dsh.version} from ${dsh.root}; local workspaces are available under ${REPO_ROOT}/node_modules\n`,
  );
}
