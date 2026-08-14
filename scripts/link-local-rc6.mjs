import { pathToFileURL } from "node:url";
import { ensureRepoLinks, REPO_ROOT } from "./local-resolution.mjs";

export { ensureRepoLinks } from "./local-resolution.mjs";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rc6 = await ensureRepoLinks();
  process.stdout.write(
    `resolved @deepseek-ai/dsh ${rc6.version} from ${rc6.root}; local workspaces are available under ${REPO_ROOT}/node_modules\n`,
  );
}
