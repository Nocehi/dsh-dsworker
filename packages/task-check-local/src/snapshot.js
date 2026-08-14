import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { TaskCheckLocalApiError } from "./errors.js";
import { deepFreeze, isPlainDataObject } from "./freeze.js";

export const DEFAULT_SNAPSHOT_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxFileBytes: 256 * 1024 * 1024,
});

const snapshots = new WeakSet();
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

class SnapshotFailure extends Error {
  /** @param {string} code @param {string | null} path @param {string | null} nodeType */
  constructor(code, path = null, nodeType = null) {
    super(code);
    this.code = code;
    this.path = path;
    this.nodeType = nodeType;
  }
}

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} root @param {string} candidate */
function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** @param {unknown} value */
export function normalizeSnapshotLimits(value = {}) {
  if (!isPlainDataObject(value)) {
    throw new TaskCheckLocalApiError(
      "invalid-snapshot-limits",
      "$.snapshotLimits",
      "snapshotLimits must be a plain data object",
    );
  }
  const allowed = ["maxEntries", "maxFileBytes"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TaskCheckLocalApiError(
        "unknown-snapshot-limit",
        `$.snapshotLimits.${key}`,
        `unknown snapshot limit '${key}'`,
      );
    }
  }
  const limits = {
    maxEntries: value.maxEntries ?? DEFAULT_SNAPSHOT_LIMITS.maxEntries,
    maxFileBytes: value.maxFileBytes ?? DEFAULT_SNAPSHOT_LIMITS.maxFileBytes,
  };
  for (const [key, entry] of Object.entries(limits)) {
    if (!Number.isSafeInteger(entry) || entry < 1) {
      throw new TaskCheckLocalApiError(
        "invalid-snapshot-limit",
        `$.snapshotLimits.${key}`,
        `${key} must be a positive safe integer`,
      );
    }
  }
  return deepFreeze(limits);
}

/** @param {import("node:fs").BigIntStats} stat */
function modeOf(stat) {
  return Number(stat.mode & 0o7777n);
}

/** @param {import("node:fs").BigIntStats} stat */
function identityOf(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/**
 * Hash one already-lstat'd regular file without following a final symlink.
 * @param {string} absolutePath
 * @param {import("node:fs").BigIntStats} before
 * @param {{totalFileBytes: number}} counters
 * @param {{maxFileBytes: number}} limits
 * @param {string} relativePath
 */
async function hashRegularFile(absolutePath, before, counters, limits, relativePath) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new SnapshotFailure("file-identity-race", relativePath, "file");
    }
    if (opened.nlink !== 1n) {
      throw new SnapshotFailure("hardlink-unsupported", relativePath, "file");
    }
    if (
      opened.size >
      BigInt(limits.maxFileBytes - counters.totalFileBytes)
    ) {
      throw new SnapshotFailure("file-byte-limit-exceeded", relativePath, "file");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      counters.totalFileBytes += bytesRead;
      if (counters.totalFileBytes > limits.maxFileBytes) {
        throw new SnapshotFailure("file-byte-limit-exceeded", relativePath, "file");
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (identityOf(after) !== identityOf(opened)) {
      throw new SnapshotFailure("file-changed-during-snapshot", relativePath, "file");
    }
    return {
      path: relativePath,
      type: "file",
      mode: modeOf(after),
      uid: after.uid.toString(),
      gid: after.gid.toString(),
      size: Number(after.size),
      mtimeNs: after.mtimeNs.toString(),
      ctimeNs: after.ctimeNs.toString(),
      sha256: digest.digest("hex"),
    };
  } catch (error) {
    if (error instanceof SnapshotFailure) throw error;
    throw new SnapshotFailure(
      error?.code === "ELOOP" ? "symlink-race" : "file-read-failure",
      relativePath,
      "file",
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** @param {string} workspaceRoot @param {unknown} [limitsInput] */
export async function captureWorkspaceSnapshot(workspaceRoot, limitsInput = {}) {
  const limits = normalizeSnapshotLimits(limitsInput);
  if (
    typeof workspaceRoot !== "string" ||
    !isAbsolute(workspaceRoot) ||
    workspaceRoot.length === 0 ||
    CONTROL_CHARACTER.test(workspaceRoot)
  ) {
    throw new TaskCheckLocalApiError(
      "invalid-workspace-root",
      "$.workspaceRoot",
      "workspaceRoot must be an absolute path without control characters",
    );
  }
  const root = resolve(workspaceRoot);
  const entries = [];
  const counters = { totalFileBytes: 0 };
  let rootDevice = null;
  try {
    const rootStat = await lstat(root, { bigint: true });
    if (rootStat.isSymbolicLink()) {
      throw new SnapshotFailure("workspace-root-symlink", null, "symlink");
    }
    if (!rootStat.isDirectory()) {
      throw new SnapshotFailure("workspace-root-not-directory", null, "other");
    }
    const canonicalRoot = await realpath(root);
    if (canonicalRoot !== root) {
      throw new SnapshotFailure("workspace-root-symlink-ancestor", null, "symlink");
    }
    rootDevice = rootStat.dev;
    const rootIdentity = {
      type: "directory",
      mode: modeOf(rootStat),
      uid: rootStat.uid.toString(),
      gid: rootStat.gid.toString(),
      device: rootStat.dev.toString(),
      inode: rootStat.ino.toString(),
    };

    /** @param {string} relativeDirectory */
    const walk = async (relativeDirectory) => {
      const absoluteDirectory =
        relativeDirectory === "" ? root : join(root, relativeDirectory);
      const canonicalDirectory = await realpath(absoluteDirectory);
      if (canonicalDirectory !== absoluteDirectory || !inside(root, canonicalDirectory)) {
        throw new SnapshotFailure(
          "directory-symlink-transition",
          relativeDirectory || null,
          "directory",
        );
      }
      const before = await lstat(absoluteDirectory, { bigint: true });
      if (!before.isDirectory()) {
        throw new SnapshotFailure("directory-identity-race", relativeDirectory || null, "directory");
      }
      const rawNames = await readdir(absoluteDirectory, { encoding: "buffer" });
      const names = rawNames.map((rawName) => {
        try {
          return UTF8_DECODER.decode(rawName);
        } catch {
          throw new SnapshotFailure(
            "non-utf8-path-name",
            relativeDirectory || null,
            null,
          );
        }
      });
      names.sort();
      for (const name of names) {
        if (name.includes("\\") || CONTROL_CHARACTER.test(name)) {
          throw new SnapshotFailure("unrepresentable-path-name", relativeDirectory ? `${relativeDirectory}/${name}` : name, null);
        }
        const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        const absolutePath = join(root, ...relativePath.split("/"));
        if (!inside(root, absolutePath)) {
          throw new SnapshotFailure("workspace-escape", relativePath, null);
        }
        const stat = await lstat(absolutePath, { bigint: true });
        if (stat.dev !== rootDevice) {
          throw new SnapshotFailure("mount-boundary-unsupported", relativePath, null);
        }
        if (stat.isSymbolicLink()) {
          throw new SnapshotFailure("symlink-unsupported", relativePath, "symlink");
        }
        if (entries.length + 1 > limits.maxEntries) {
          throw new SnapshotFailure("entry-limit-exceeded", relativePath, null);
        }
        if (stat.isDirectory()) {
          entries.push({
            path: relativePath,
            type: "directory",
            mode: modeOf(stat),
            uid: stat.uid.toString(),
            gid: stat.gid.toString(),
            size: null,
            mtimeNs: null,
            ctimeNs: null,
            sha256: null,
          });
          await walk(relativePath);
        } else if (stat.isFile()) {
          entries.push(
            await hashRegularFile(absolutePath, stat, counters, limits, relativePath),
          );
        } else {
          throw new SnapshotFailure("special-node-unsupported", relativePath, "other");
        }
      }
      const after = await lstat(absoluteDirectory, { bigint: true });
      if (!after.isDirectory() || identityOf(before) !== identityOf(after)) {
        throw new SnapshotFailure("directory-changed-during-snapshot", relativeDirectory || null, "directory");
      }
    };
    await walk("");
    const frozenEntries = deepFreeze(entries);
    const snapshot = deepFreeze({
      ok: true,
      code: "snapshot-complete",
      root,
      limits,
      rootIdentity,
      entries: frozenEntries,
      entryCount: entries.length,
      totalFileBytes: counters.totalFileBytes,
      snapshotSha256: sha256(
        Buffer.from(JSON.stringify({ rootIdentity, entries }), "utf8"),
      ),
      failure: null,
    });
    snapshots.add(snapshot);
    return snapshot;
  } catch (error) {
    const failure =
      error instanceof SnapshotFailure
        ? error
        : new SnapshotFailure("snapshot-io-failure", null, null);
    const snapshot = deepFreeze({
      ok: false,
      code: failure.code,
      root,
      limits,
      rootIdentity: null,
      entries: [],
      entryCount: 0,
      totalFileBytes: counters.totalFileBytes,
      snapshotSha256: null,
      failure: {
        code: failure.code,
        path: failure.path,
        nodeType: failure.nodeType,
      },
    });
    snapshots.add(snapshot);
    return snapshot;
  }
}

/** @param {unknown} value */
export function isWorkspaceSnapshot(value) {
  return value !== null && typeof value === "object" && snapshots.has(value);
}

/** @param {any} snapshot */
export function snapshotSummary(snapshot) {
  if (!isWorkspaceSnapshot(snapshot)) {
    throw new TaskCheckLocalApiError(
      "invalid-workspace-snapshot",
      "$.snapshot",
      "snapshotSummary requires a genuine captured snapshot",
    );
  }
  return deepFreeze({
    ok: snapshot.ok,
    code: snapshot.code,
    entryCount: snapshot.entryCount,
    totalFileBytes: snapshot.totalFileBytes,
    snapshotSha256: snapshot.snapshotSha256,
    failure: snapshot.failure,
  });
}
