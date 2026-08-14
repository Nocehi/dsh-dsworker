import { isGuardBinding } from "./binding.js";
import { proveFilesystemBinding } from "./filesystem.js";
import { deepFreeze } from "./freeze.js";

/**
 * Pure monotonic join: execution can proceed only when both independent
 * authority layers say allow. Unsupported is deliberately not a permit state.
 *
 * @param {unknown} lexicalDecision
 * @param {unknown} filesystemDecision
 */
export function monotonicGuardOutcome(lexicalDecision, filesystemDecision) {
  return lexicalDecision === "allow" && filesystemDecision === "allow"
    ? "permit"
    : "deny";
}

/** @param {Record<string, unknown>} fields */
function guardRecord(fields) {
  return deepFreeze({
    contractSha256: fields.contractSha256 ?? null,
    toolName: fields.toolName ?? null,
    toolCallId: fields.toolCallId ?? null,
    requestedPath: fields.requestedPath ?? null,
    normalizedContractPath: fields.normalizedContractPath ?? null,
    operation: fields.operation ?? null,
    lexicalDecision: fields.lexicalDecision ?? null,
    lexicalCode: fields.lexicalCode ?? null,
    filesystemBindingResult: fields.filesystemBindingResult ?? null,
    finalGuardDecision: fields.finalGuardDecision,
    denialCategory: fields.denialCategory ?? null,
    denialCode: fields.denialCode ?? null,
  });
}

/**
 * Evaluate one already-mapped mutation through the exact compiled authority and
 * the filesystem seam. Every non-proven state becomes a final guard denial.
 *
 * @param {unknown} fs
 * @param {unknown} binding
 * @param {any} intent
 * @param {AbortSignal | undefined} signal
 */
export async function evaluateMutationIntent(fs, binding, intent, signal) {
  const base = {
    contractSha256: isGuardBinding(binding) ? binding.contractSha256 : null,
    toolName: intent?.toolName ?? null,
    toolCallId: intent?.toolCallId ?? null,
    requestedPath: intent?.requestedPath ?? null,
  };
  if (!isGuardBinding(binding)) {
    return guardRecord({
      ...base,
      finalGuardDecision: "deny",
      denialCategory: "adapter-configuration",
      denialCode: "missing-or-invalid-guard-binding",
    });
  }
  if (intent?.status !== "mapped") {
    return guardRecord({
      ...base,
      finalGuardDecision: "deny",
      denialCategory: "adapter-input",
      denialCode: intent?.code ?? "unmapped-mutation-intent",
    });
  }
  if (
    (intent.operation !== "edit-file" && intent.operation !== "write-file") ||
    typeof intent.requestedPath !== "string" ||
    (intent.toolName !== "edit" && intent.toolName !== "write")
  ) {
    return guardRecord({
      ...base,
      finalGuardDecision: "deny",
      denialCategory: "adapter-input",
      denialCode: "invalid-mutation-intent",
    });
  }

  const preliminaryOperation =
    intent.operation === "edit-file" ? "edit-file" : "create-file";
  const preliminary = binding.policy.decide({
    operation: preliminaryOperation,
    path: intent.requestedPath,
  });
  const lexicalBase = {
    ...base,
    normalizedContractPath: preliminary.normalizedPath,
    lexicalDecision: preliminary.decision,
    lexicalCode: preliminary.code,
  };
  if (monotonicGuardOutcome(preliminary.decision, "allow") !== "permit") {
    return guardRecord({
      ...lexicalBase,
      operation: preliminaryOperation,
      finalGuardDecision: "deny",
      denialCategory:
        preliminary.decision === "unsupported"
          ? "unsupported-authority"
          : "policy-deny",
      denialCode: preliminary.code,
    });
  }

  const filesystem = await proveFilesystemBinding(
    fs,
    binding,
    {
      operation: intent.operation,
      normalizedPath: preliminary.normalizedPath,
    },
    signal,
  );
  if (
    monotonicGuardOutcome(preliminary.decision, filesystem.decision) !==
    "permit"
  ) {
    return guardRecord({
      ...lexicalBase,
      operation: filesystem.operation ?? preliminaryOperation,
      filesystemBindingResult: filesystem,
      finalGuardDecision: "deny",
      denialCategory:
        filesystem.decision === "unsupported"
          ? "unsupported-filesystem-authority"
          : "filesystem-deny",
      denialCode: filesystem.code,
    });
  }

  const finalLexical = binding.policy.decide({
    operation: filesystem.operation,
    path: intent.requestedPath,
  });
  if (
    monotonicGuardOutcome(finalLexical.decision, filesystem.decision) !==
    "permit"
  ) {
    return guardRecord({
      ...lexicalBase,
      operation: filesystem.operation,
      lexicalDecision: finalLexical.decision,
      lexicalCode: finalLexical.code,
      filesystemBindingResult: filesystem,
      finalGuardDecision: "deny",
      denialCategory:
        finalLexical.decision === "unsupported"
          ? "unsupported-authority"
          : "policy-deny",
      denialCode: finalLexical.code,
    });
  }
  return guardRecord({
    ...lexicalBase,
    operation: filesystem.operation,
    lexicalDecision: finalLexical.decision,
    lexicalCode: finalLexical.code,
    filesystemBindingResult: filesystem,
    finalGuardDecision: "permit",
  });
}

/** @param {any} record */
export function guardDenialMessage(record) {
  const path =
    typeof record?.requestedPath === "string" ? ` path=${JSON.stringify(record.requestedPath)}` : "";
  const digest =
    typeof record?.contractSha256 === "string"
      ? ` contract=${record.contractSha256}`
      : " contract=unbound";
  const code = record?.denialCode ?? "unproven-mutation";
  return `path guard denied structured mutation [${code}]${path}${digest}`;
}

/** @param {Record<string, unknown>} fields */
export function adapterDenialRecord(fields) {
  return guardRecord({
    contractSha256: fields.contractSha256 ?? null,
    toolName: fields.toolName ?? null,
    toolCallId: fields.toolCallId ?? null,
    requestedPath: fields.requestedPath ?? null,
    finalGuardDecision: "deny",
    denialCategory: fields.denialCategory ?? "adapter-configuration",
    denialCode: fields.denialCode ?? "unproven-mutation",
  });
}
