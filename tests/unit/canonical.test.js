import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  adapterVisibleRequest,
  redactSecretShaped,
  safeDigest,
  sha256Utf8,
  stableStringify,
} from "../../packages/plugin-request-trace/src/canonical.js";
import {
  createTraceRecord,
  digestRequestHeader,
  normalizeUsage,
} from "../../packages/plugin-request-trace/src/record.js";
import {
  encodeJsonLine,
  JsonlWriter,
} from "../../packages/plugin-request-trace/src/writer.js";

test("canonical JSON and hashes are stable across key order", () => {
  const left = { z: 1, a: { y: true, x: [3, 2, 1] } };
  const right = { a: { x: [3, 2, 1], y: true }, z: 1 };
  assert.equal(stableStringify(left), stableStringify(right));
  assert.equal(safeDigest(left), safeDigest(right));
  assert.equal(sha256Utf8("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("usage has explicit nulls and rc.6 cache-miss derivation", () => {
  assert.deepEqual(normalizeUsage(undefined), {
    inputTokens: null,
    cacheReadTokens: null,
    cacheMissTokens: null,
    outputTokens: null,
  });
  assert.deepEqual(
    normalizeUsage({ inputTokens: 13, cacheReadTokens: 87, outputTokens: 5 }),
    {
      inputTokens: 13,
      cacheReadTokens: 87,
      cacheMissTokens: 13,
      outputTokens: 5,
    },
  );
});

test("secret-shaped values are redacted before diagnostics and never enter a record", () => {
  const secret = "super-secret-test-value";
  const header = {
    config: { provider: "fake", model: "fake-model" },
    Authorization: `Bearer ${secret}`,
    nested: {
      api_key: secret,
      password: secret,
      safe: "visible",
    },
  };
  const redacted = stableStringify(redactSecretShaped(header));
  assert.doesNotMatch(redacted, /super-secret-test-value/u);
  assert.match(redacted, /redacted-secret-shaped-field/u);

  const record = createTraceRecord(
    {
      provider: "fake",
      model: "fake-model",
      messages: [],
      authorization: secret,
      apiKey: secret,
    },
    {
      requestIndex: 1,
      headerDigest: digestRequestHeader(header),
      headerChangeReason: "initial",
      durableContextCauses: [],
      compactionGeneration: 0,
    },
    () => 0,
  );
  assert.doesNotMatch(encodeJsonLine(record), /super-secret-test-value/u);
});

test("adapter-visible snapshots retain every enumerable field except signal", () => {
  const request = {
    provider: "fake",
    model: "m",
    messages: [],
    temperature: 0,
    futureField: { b: 2, a: 1 },
    signal: new AbortController().signal,
  };
  assert.deepEqual(adapterVisibleRequest(request), {
    futureField: { a: 1, b: 2 },
    messages: [],
    model: "m",
    provider: "fake",
    temperature: 0,
  });
});

test("JSONL encoding is deterministic and writer creates a private sidecar", async () => {
  const record = { z: 1, a: [true, null] };
  assert.equal(encodeJsonLine(record), '{"a":[true,null],"z":1}\n');

  const root = await mkdtemp("/tmp/dsh-dsworker-unit.");
  try {
    const path = join(root, "nested", "trace.jsonl");
    const writer = new JsonlWriter(path);
    writer.enqueue(record);
    writer.enqueue({ second: true });
    await writer.drain();
    assert.equal(
      await readFile(path, "utf8"),
      '{"a":[true,null],"z":1}\n{"second":true}\n',
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writer rejects a relative deployment destination", () => {
  assert.throws(
    () => new JsonlWriter("relative/trace.jsonl"),
    /must be an absolute path/u,
  );
});
