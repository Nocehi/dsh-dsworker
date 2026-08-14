import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const regression = String.raw`

test "cleanupStarted tolerates an already-settled child" {
    var child = try std.process.spawn(std.testing.io, .{
        .argv = &.{ "/usr/bin/true" },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    });
    _ = try child.wait(std.testing.io);
    try std.testing.expect(child.id == null);

    const children: [1]?std.process.Child = .{child};
    cleanupStarted(std.testing.io, &.{}, &children);
}
`;

const root = await mkdtemp("/tmp/dsh-zigsh-pipeline-oracle.");
let status = 1;
try {
  await cp("src", join(root, "src"), {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  const pipelinePath = join(root, "src", "pipeline.zig");
  const source = await readFile(pipelinePath, "utf8");
  await writeFile(pipelinePath, `${source}${regression}`, "utf8");

  status = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("zig", ["test", "src/pipeline.zig"], {
      cwd: root,
      env: {
        ...process.env,
        ZIG_GLOBAL_CACHE_DIR: "/tmp/zig-cache/global",
        ZIG_LOCAL_CACHE_DIR: "/tmp/zig-cache/local",
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
  throw new Error(`immutable pipeline cleanup oracle failed with status ${status}`);
}
