import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const regression = String.raw`

test "lex errors publish no partial token prefix" {
    const allocator = std.testing.allocator;
    var tokens: std.ArrayList(Token) = .empty;
    defer tokens.deinit(allocator);

    try std.testing.expectError(
        error.UnmatchedQuote,
        lex(allocator, "alpha \"unterminated", &tokens),
    );
    try std.testing.expectEqual(@as(usize, 0), tokens.items.len);

    try std.testing.expectError(
        error.MissingArgumentSeparator,
        lex(allocator, "alpha\"beta\"", &tokens),
    );
    try std.testing.expectEqual(@as(usize, 0), tokens.items.len);
}
`;

const root = await mkdtemp("/tmp/dsh-zigsh-lex-oracle.");
let status = 1;
try {
  await cp("src", join(root, "src"), {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  const lexPath = join(root, "src", "lex.zig");
  const source = await readFile(lexPath, "utf8");
  await writeFile(lexPath, `${source}${regression}`, "utf8");

  status = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("zig", ["test", "src/lex.zig"], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ZIG_GLOBAL_CACHE_DIR: join(root, "zig-cache", "global"),
        ZIG_LOCAL_CACHE_DIR: join(root, "zig-cache", "local"),
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      resolvePromise(code ?? (signal === null ? 1 : 128));
    });
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
if (status !== 0) {
  throw new Error(`immutable lexer atomic-output oracle failed with status ${status}`);
}
