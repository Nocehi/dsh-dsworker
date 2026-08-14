# Request trace schema v0

Each completed model request emits exactly one canonical JSON line to the
deployment-supplied absolute path. The path is outside DSH session history.
Object keys are recursively sorted before encoding, and records are serialized
through an explicit allowlist.

Schema identifier:

```text
dsh-dsworker/request-trace/v0
```

## Fields

| Field | Meaning and null semantics |
|---|---|
| `sessionId` | rc.6 `GenerateOptions.sessionId`, or `null` for an unscoped auxiliary request. |
| `requestIndex` | One-based, process-local count for that session; unscoped calls use their own counter. It is not a persisted provider request ID. |
| `purpose` | `compaction`, `session-title`, or `null` for the ordinary loop. |
| `provider` | Requested/resolved DSH provider route visible in `GenerateOptions`, or `null` if a future malformed caller bypasses the contract. |
| `requestedModel` | DSH request model. It is not claimed to be provider-returned runtime identity. |
| `reasoning` | `reasoningEffort`, or `null` when absent. |
| `systemSha256`, `systemBytes` | Exact UTF-8 rendered system prompt; absent system is `null` digest and zero bytes. |
| `toolsSha256`, `toolSchemaBytes` | Canonical compact JSON over exact rc.6 tool schemas; absent tools are `null` digest and zero bytes, while an explicit empty array hashes as `[]`. |
| `messagePrefixSha256` | Canonical compact JSON over the exact request messages. Message content is never copied to the sidecar. |
| `headerDigest` | Digest of the latest durable rc.6 `request/header`, or `null` when none is observable. Secret-shaped keys are redacted before hashing defensively. |
| `headerChangeReason` | `initial`, `resume`, or `change` only when a new header event preceded this loop request; otherwise `null`. |
| `durableContextCauses` | Metadata-only `{type, seq, sourceKind}` entries for surface/compaction events accumulated since the preceding loop request. No message text is recorded. |
| `startedAt` | UTC ISO timestamp at middleware entry. |
| `firstTokenAt` | First non-empty rc.6 token delta, or `null` when no token delta was emitted. |
| `completedAt` | UTC ISO timestamp when the downstream stream settled. |
| `inputTokens` | rc.6 uncached input tokens, or `null` when usage is absent. |
| `cacheReadTokens` | rc.6 cache-read tokens, or `null`. |
| `cacheMissTokens` | Equal to rc.6 `inputTokens`, whose contract is already disjoint uncached input; `null` when unavailable. |
| `outputTokens` | rc.6 output tokens, or `null`. |
| `compactionGeneration` | Number of observed committed `compaction/summary` events for the live session, or `null` without a session. Prune events remain separately named context causes. |
| `outerToolCallIds` | Unique call IDs produced by this model response and confirmed by the step log. |
| `codeDispatchIds` | Unique `subCallId` values observed before this request's durable `step/end`. Empty means none were observed. |
| `streamOutcome` | `finished`, `incomplete`, or `threw`, describing the rc.6 stream wrapper rather than task success. |
| `finishReason` | rc.6 terminal finish kind, or `null` when no terminal finish arrived. |

## Deliberately unavailable

The generic rc.6 seams do not expose these as successful-call facts, so v0 does
not invent them:

- provider-returned model identity;
- provider HTTP response/request IDs on success;
- literal outbound HTTP header values or their complete wire digest;
- credentials, API keys, authorization, cookies or credential-store records;
- intermediate Code/PTC values that rc.6 intentionally keeps out of model and
  durable session surfaces.

The request observer hashes the model-visible envelope before the adapter and
correlates durable topology after it. A later adapter-specific observer may add
non-secret transport metadata under a new schema version; it must not rewrite
v0 records or inspect credentials.
