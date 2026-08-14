import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const regression = String.raw`

test "recoverable OOM leaves an unterminated EOF record pending" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 1 });
    const allocator = failing.allocator();

    var decoder = LineDecoder.init(allocator);
    defer decoder.deinit();

    try decoder.push("tail");
    decoder.finish();
    try std.testing.expectError(error.OutOfMemory, decoder.pull());

    // Fail exactly one record-copy allocation, then let later allocations
    // through. The retry therefore observes decoder state, not a permanently
    // failing allocator.
    failing.fail_index = std.math.maxInt(usize);

    const recovered = (try decoder.pull()) orelse return error.RecordLostAfterRecoverableOom;
    defer recovered.deinit(allocator);
    try std.testing.expectEqualStrings("tail", recovered.string);
    try std.testing.expect((try decoder.pull()) == null);
}

test "control: recoverable OOM leaves an LF-delimited record pending" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 1 });
    const allocator = failing.allocator();

    var decoder = LineDecoder.init(allocator);
    defer decoder.deinit();

    try decoder.push("line\n");
    try std.testing.expectError(error.OutOfMemory, decoder.pull());
    failing.fail_index = std.math.maxInt(usize);

    const recovered = (try decoder.pull()) orelse return error.RecordLostAfterRecoverableOom;
    defer recovered.deinit(allocator);
    try std.testing.expectEqualStrings("line", recovered.string);
}
`;

const root = await mkdtemp("/tmp/dsh-zigsh-stream-eof-oom-oracle.");
let status = 1;
try {
  await cp("src", join(root, "src"), {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  const streamPath = join(root, "src", "stream.zig");
  const source = await readFile(streamPath, "utf8");
  await writeFile(streamPath, `${source}${regression}`, "utf8");

  status = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("zig", ["test", "src/stream.zig"], {
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
  throw new Error(`immutable stream EOF/OOM oracle failed with status ${status}`);
}
