import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTaskContract } from "@dsh-dsworker/task-contract";
import { REPO_ROOT } from "../../scripts/local-resolution.mjs";

export const TASK_CHECK_FIXTURE_ROOT = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "task-check",
  "python-argv-lexer",
);

export const TEST_BASE_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
});

export async function loadPythonArgvLexerContract() {
  const input = JSON.parse(
    await readFile(
      join(
        REPO_ROOT,
        "tests",
        "fixtures",
        "task-contract",
        "python-argv-lexer.input.json",
      ),
      "utf8",
    ),
  );
  return parseTaskContract(input);
}

export async function materializePythonArgvLexer(root, lexer = "initial") {
  await copyFile(
    join(TASK_CHECK_FIXTURE_ROOT, "lexer." + lexer + ".py"),
    join(root, "lexer.py"),
  );
  await copyFile(
    join(TASK_CHECK_FIXTURE_ROOT, "test_lexer.py"),
    join(root, "test_lexer.py"),
  );
}
