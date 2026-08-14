import {
  safeDigest,
  sha256Utf8,
  stableStringify,
  utf8Bytes,
} from "./canonical.js";

export const TRACE_SCHEMA = "dsh-dsworker/request-trace/v0";

/** @param {unknown} value */
function tokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * rc.6 TokenUsage defines inputTokens as uncached input. Therefore cache miss
 * tokens equal inputTokens when that field is available.
 *
 * @param {Record<string, unknown> | undefined} usage
 */
export function normalizeUsage(usage) {
  const inputTokens = tokenCount(usage?.inputTokens);
  return {
    inputTokens,
    cacheReadTokens: tokenCount(usage?.cacheReadTokens),
    cacheMissTokens: inputTokens,
    outputTokens: tokenCount(usage?.outputTokens),
  };
}

/** @param {unknown} header */
export function digestRequestHeader(header) {
  return header === undefined || header === null ? null : safeDigest(header);
}

/**
 * @param {Record<string, unknown>} options
 * @param {{
 *   requestIndex: number,
 *   headerDigest: string | null,
 *   headerChangeReason: string | null,
 *   durableContextCauses: unknown[],
 *   compactionGeneration: number | null,
 * }} facts
 * @param {() => number} [clock]
 */
export function createTraceRecord(options, facts, clock = Date.now) {
  const system = typeof options.system === "string" ? options.system : undefined;
  const tools = Array.isArray(options.tools) ? options.tools : undefined;
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const startedAt = new Date(clock()).toISOString();

  return {
    traceSchema: TRACE_SCHEMA,
    sessionId: typeof options.sessionId === "string" ? options.sessionId : null,
    requestIndex: facts.requestIndex,
    purpose: typeof options.purpose === "string" ? options.purpose : null,
    provider: typeof options.provider === "string" ? options.provider : null,
    requestedModel: typeof options.model === "string" ? options.model : null,
    reasoning:
      typeof options.reasoningEffort === "string" ? options.reasoningEffort : null,
    systemSha256: system === undefined ? null : sha256Utf8(system),
    systemBytes: system === undefined ? 0 : utf8Bytes(system),
    toolsSha256: tools === undefined ? null : sha256Utf8(stableStringify(tools)),
    toolSchemaBytes: tools === undefined ? 0 : utf8Bytes(stableStringify(tools)),
    messagePrefixSha256: sha256Utf8(stableStringify(messages)),
    headerDigest: facts.headerDigest,
    headerChangeReason: facts.headerChangeReason,
    durableContextCauses: facts.durableContextCauses,
    startedAt,
    firstTokenAt: null,
    completedAt: null,
    ...normalizeUsage(undefined),
    compactionGeneration: facts.compactionGeneration,
    outerToolCallIds: [],
    codeDispatchIds: [],
    streamOutcome: null,
    finishReason: null,
  };
}

/** @param {ReturnType<typeof createTraceRecord>} record @param {Record<string, unknown>} usage */
export function applyUsage(record, usage) {
  Object.assign(record, normalizeUsage(usage));
}

/** @param {ReturnType<typeof createTraceRecord>} record @param {() => number} [clock] */
export function markFirstToken(record, clock = Date.now) {
  if (record.firstTokenAt === null) record.firstTokenAt = new Date(clock()).toISOString();
}

/**
 * @param {ReturnType<typeof createTraceRecord>} record
 * @param {string} outcome
 * @param {string | null} finishReason
 * @param {() => number} [clock]
 */
export function completeTraceRecord(
  record,
  outcome,
  finishReason,
  clock = Date.now,
) {
  record.completedAt = new Date(clock()).toISOString();
  record.streamOutcome = outcome;
  record.finishReason = finishReason;
  return Object.freeze({ ...record });
}
