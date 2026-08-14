import { isAgentLoopRequest, isTokenDelta } from "@deepseek-ai/dsh-llm";
import {
  applyUsage,
  completeTraceRecord,
  createTraceRecord,
  digestRequestHeader,
  markFirstToken,
} from "./record.js";
import { JsonlWriter } from "./writer.js";

export const name = "dsh-dsworker-request-trace";
export const inject = ["llm", "sessions"];

/** @typedef {ReturnType<typeof createTraceRecord>} MutableTraceRecord */

function createSessionState() {
  return {
    requestCount: 0,
    latestHeaderDigest: null,
    pendingHeaderReason: null,
    pendingContextCauses: [],
    compactionGeneration: 0,
    activeStepKey: null,
    records: new Map(),
  };
}

/** @param {{type: string, seq: number, data: any}} event */
function durableCause(event) {
  let sourceKind = null;
  if (event.type === "user/message") sourceKind = event.data?.source?.kind ?? null;
  if (event.type === "assistant/message") {
    sourceKind = event.data?.message?.source?.kind ?? null;
  }
  if (event.type === "tool/result") {
    sourceKind = event.data?.message?.source?.kind ?? null;
  }
  return { type: event.type, seq: event.seq, sourceKind };
}

/** @param {MutableTraceRecord} record @param {string} id */
function addUnique(record, field, id) {
  if (typeof id !== "string" || id.length === 0) return;
  if (!record[field].includes(id)) record[field].push(id);
}

/**
 * Observe all rc.6 LLM streams and correlate loop-built requests with durable
 * step/tool events. The plugin registers no prompt section, context, tool, or
 * model route.
 *
 * @param {any} ctx
 * @param {{destination?: string}} config
 */
export function apply(ctx, config) {
  const writer = new JsonlWriter(config?.destination);
  const states = new Map();
  const unscoped = createSessionState();

  const stateFor = (sessionId) => {
    if (typeof sessionId !== "string") return unscoped;
    let state = states.get(sessionId);
    if (state === undefined) {
      state = createSessionState();
      states.set(sessionId, state);
    }
    return state;
  };

  const flushTracker = (state, key) => {
    const tracker = state.records.get(key);
    if (tracker === undefined || tracker.record.completedAt === null) return;
    state.records.delete(key);
    writer.enqueue(tracker.record);
  };

  ctx.on("session/event", (session, event) => {
    const state = stateFor(session.id);
    switch (event.type) {
      case "step/start":
        state.activeStepKey = `${event.data.turn}:${event.data.step}`;
        break;
      case "request/header":
        state.latestHeaderDigest = digestRequestHeader(event.data.header);
        state.pendingHeaderReason = event.data.reason;
        break;
      case "user/message":
      case "assistant/message":
      case "tool/result":
      case "compaction/prune":
      case "compaction/summary":
        state.pendingContextCauses.push(durableCause(event));
        if (event.type === "assistant/message" && state.activeStepKey !== null) {
          const tracker = state.records.get(state.activeStepKey);
          if (tracker !== undefined && event.data.usage !== undefined) {
            applyUsage(tracker.record, event.data.usage);
          }
        }
        if (event.type === "compaction/summary") state.compactionGeneration += 1;
        break;
      case "tool/call":
        if (state.activeStepKey !== null) {
          const tracker = state.records.get(state.activeStepKey);
          if (tracker !== undefined) {
            addUnique(tracker.record, "outerToolCallIds", event.data.callId);
          }
        }
        break;
      case "tool/code-dispatch-start":
        if (state.activeStepKey !== null) {
          const tracker = state.records.get(state.activeStepKey);
          if (tracker !== undefined) {
            addUnique(tracker.record, "codeDispatchIds", event.data.subCallId);
          }
        }
        break;
      case "step/end": {
        const key = `${event.data.turn}:${event.data.step}`;
        flushTracker(state, key);
        if (state.activeStepKey === key) state.activeStepKey = null;
        break;
      }
      case "turn/end":
        for (const key of state.records.keys()) flushTracker(state, key);
        break;
      default:
        break;
    }
  });

  ctx.on("session/disposed", (session) => {
    const state = states.get(session.id);
    if (state === undefined) return;
    for (const key of state.records.keys()) flushTracker(state, key);
    states.delete(session.id);
  });

  ctx.on(
    "llm/stream",
    (options, next) => {
      const state = stateFor(options.sessionId);
      state.requestCount += 1;
      const loopRequest = isAgentLoopRequest(options);
      const stepKey = loopRequest ? state.activeStepKey : null;
      const contextCauses = loopRequest
        ? state.pendingContextCauses.splice(0)
        : [];
      const headerReason = loopRequest ? state.pendingHeaderReason : null;
      if (loopRequest) state.pendingHeaderReason = null;

      const record = createTraceRecord(options, {
        requestIndex: state.requestCount,
        headerDigest: state.latestHeaderDigest,
        headerChangeReason: headerReason,
        durableContextCauses: contextCauses,
        compactionGeneration:
          typeof options.sessionId === "string"
            ? state.compactionGeneration
            : null,
      });

      const tracker = { record };
      if (stepKey !== null) state.records.set(stepKey, tracker);

      let downstream;
      try {
        downstream = next();
      } catch (error) {
        completeTraceRecord(record, "threw", null);
        if (stepKey === null) writer.enqueue(record);
        throw error;
      }

      return (async function* observeStream() {
        let finishReason = null;
        let outcome = "incomplete";
        try {
          for await (const chunk of downstream) {
            if (isTokenDelta(chunk)) markFirstToken(record);
            if (chunk.type === "usage") applyUsage(record, chunk.usage);
            if (chunk.type === "tool-call-delta") {
              addUnique(record, "outerToolCallIds", chunk.id);
            }
            if (chunk.type === "block-end" && chunk.block.type === "tool-call") {
              addUnique(record, "outerToolCallIds", chunk.block.id);
            }
            if (chunk.type === "finish") {
              finishReason = chunk.reason.kind;
              outcome = "finished";
            }
            yield chunk;
          }
        } catch (error) {
          outcome = "threw";
          throw error;
        } finally {
          completeTraceRecord(record, outcome, finishReason);
          if (stepKey === null) writer.enqueue(record);
        }
      })();
    },
    { global: true, prepend: true },
  );

  ctx.effect(
    () => async () => {
      for (const state of [...states.values(), unscoped]) {
        for (const key of state.records.keys()) flushTracker(state, key);
      }
      await writer.drain();
    },
    "dsh-dsworker.requestTrace",
  );
}
