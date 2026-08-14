import { compilePathAuthority } from "@dsh-dsworker/path-authority";
import {
  isContractPathDescendant,
  isTaskContract,
} from "@dsh-dsworker/task-contract";
import { TaskCheckLocalApiError } from "./errors.js";
import { deepFreeze } from "./freeze.js";
import { isWorkspaceSnapshot } from "./snapshot.js";

/** @param {any} snapshot */
function entryMap(snapshot) {
  return new Map(snapshot.entries.map((entry) => [entry.path, entry]));
}

/** @param {any} left @param {any} right */
function sameEntry(left, right) {
  return (
    left.type === right.type &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.sha256 === right.sha256
  );
}

/** @param {unknown} contract @param {unknown} baseline @param {unknown} candidate */
function assertComparisonInputs(contract, baseline, candidate) {
  if (!isTaskContract(contract)) {
    throw new TaskCheckLocalApiError(
      "unparsed-task-contract",
      "$.contract",
      "workspace comparison requires the exact parsed TaskContract",
    );
  }
  if (!isWorkspaceSnapshot(baseline) || !isWorkspaceSnapshot(candidate)) {
    throw new TaskCheckLocalApiError(
      "invalid-workspace-snapshot",
      "$.snapshot",
      "workspace comparison requires genuine captured snapshots",
    );
  }
  if (baseline.root !== candidate.root) {
    throw new TaskCheckLocalApiError(
      "snapshot-workspace-mismatch",
      "$.candidate.root",
      "baseline and candidate snapshots must bind the same workspace root",
    );
  }
}

/** @param {any} before @param {any} after */
function changeKind(before, after) {
  if (before === undefined) return "created";
  if (after === undefined) return "deleted";
  if (before.type !== after.type) return "type-changed";
  return "changed";
}

/** @param {any} policy @param {string} path @param {any} before @param {any} after */
function authorityForChange(policy, path, before, after) {
  const decisions = [];
  let unsupportedCode = null;
  if (before === undefined) {
    decisions.push(
      policy.decide({
        operation: after.type === "file" ? "create-file" : "create-directory",
        path,
      }),
    );
  } else if (after === undefined) {
    decisions.push(
      policy.decide({
        operation: before.type === "file" ? "remove-file" : "remove-directory",
        path,
      }),
    );
  } else if (before.type !== after.type) {
    decisions.push(
      policy.decide({
        operation: before.type === "file" ? "remove-file" : "remove-directory",
        path,
      }),
      policy.decide({
        operation: after.type === "file" ? "create-file" : "create-directory",
        path,
      }),
    );
  } else if (before.type === "directory") {
    unsupportedCode = "directory-metadata-change-unsupported";
  } else if (
    before.mode !== after.mode ||
    before.uid !== after.uid ||
    before.gid !== after.gid
  ) {
    unsupportedCode = "file-metadata-change-unsupported";
  } else {
    decisions.push(policy.decide({ operation: "replace-file", path }));
  }
  return { decisions, unsupportedCode };
}

/**
 * Compare two complete snapshots and classify every final-state change against
 * the exact TaskContract path authority.
 *
 * @param {unknown} contract
 * @param {unknown} baseline
 * @param {unknown} candidate
 */
export function compareWorkspaceSnapshots(contract, baseline, candidate) {
  assertComparisonInputs(contract, baseline, candidate);
  if (!baseline.ok || !candidate.ok) {
    return deepFreeze({
      ok: false,
      changedPaths: [],
      changes: [],
      findings: [
        {
          code: "snapshot-unavailable",
          baselineCode: baseline.code,
          candidateCode: candidate.code,
        },
      ],
    });
  }
  const policy = compilePathAuthority(contract);
  const before = entryMap(baseline);
  const after = entryMap(candidate);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = [];
  const findings = [];
  if (JSON.stringify(baseline.rootIdentity) !== JSON.stringify(candidate.rootIdentity)) {
    findings.push({
      code: "workspace-root-state-changed",
      path: ".",
      change: "changed",
      authority: [],
    });
  }
  for (const path of paths) {
    const left = before.get(path);
    const right = after.get(path);
    if (left !== undefined && right !== undefined && sameEntry(left, right)) continue;
    const authority = authorityForChange(policy, path, left, right);
    const allowed =
      authority.unsupportedCode === null &&
      authority.decisions.length > 0 &&
      authority.decisions.every((decision) => decision.decision === "allow");
    const change = {
      path,
      change: changeKind(left, right),
      beforeType: left?.type ?? null,
      afterType: right?.type ?? null,
      authority: authority.decisions.map((decision) => ({
        decision: decision.decision,
        code: decision.code,
        operation: decision.operation,
      })),
      allowed,
    };
    changes.push(change);
    if (!allowed) {
      findings.push({
        code: authority.unsupportedCode ?? "outside-mutable-authority",
        path,
        change: change.change,
        authority: change.authority,
      });
    }
  }
  return deepFreeze({
    ok: findings.length === 0,
    changedPaths: changes.map((change) => change.path),
    changes,
    findings,
  });
}

/** @param {any} entry @param {string} path */
function entryInImmutableTree(entry, path) {
  return entry.path === path || isContractPathDescendant(path, entry.path);
}

/**
 * Check required immutable baseline identity, then compare a checkpoint to it.
 * Pinned file digests must match at both baseline and checkpoint.
 *
 * @param {unknown} contract
 * @param {unknown} baseline
 * @param {unknown} candidate
 */
export function verifyImmutableAuthority(contract, baseline, candidate) {
  assertComparisonInputs(contract, baseline, candidate);
  const checked = contract.authority.paths.immutable.map((entry) => entry.path);
  if (!baseline.ok || !candidate.ok) {
    return deepFreeze({
      ok: false,
      checked,
      findings: [
        {
          code: "snapshot-unavailable",
          baselineCode: baseline.code,
          candidateCode: candidate.code,
        },
      ],
    });
  }
  const baselineByPath = entryMap(baseline);
  const candidateByPath = entryMap(candidate);
  const findings = [];
  for (const authority of contract.authority.paths.immutable) {
    const baselineEntry = baselineByPath.get(authority.path);
    const candidateEntry = candidateByPath.get(authority.path);
    if (baselineEntry === undefined || baselineEntry.type !== authority.kind) {
      findings.push({
        code: "immutable-baseline-missing-or-kind-mismatch",
        path: authority.path,
        expectedKind: authority.kind,
      });
      continue;
    }
    if (
      authority.sha256 !== undefined &&
      (baselineEntry.type !== "file" || baselineEntry.sha256 !== authority.sha256)
    ) {
      findings.push({
        code: "immutable-baseline-digest-mismatch",
        path: authority.path,
        expectedSha256: authority.sha256,
        actualSha256: baselineEntry.sha256,
      });
    }
    if (candidateEntry === undefined || candidateEntry.type !== authority.kind) {
      findings.push({
        code: "immutable-missing-or-kind-mismatch",
        path: authority.path,
        expectedKind: authority.kind,
      });
      continue;
    }
    if (
      authority.sha256 !== undefined &&
      (candidateEntry.type !== "file" || candidateEntry.sha256 !== authority.sha256)
    ) {
      findings.push({
        code: "immutable-digest-mismatch",
        path: authority.path,
        expectedSha256: authority.sha256,
        actualSha256: candidateEntry.sha256,
      });
    }
    const baselineTree = [...baselineByPath.values()]
      .filter((entry) => entryInImmutableTree(entry, authority.path))
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      );
    const candidateTree = [...candidateByPath.values()]
      .filter((entry) => entryInImmutableTree(entry, authority.path))
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      );
    if (
      baselineTree.length !== candidateTree.length ||
      baselineTree.some(
        (entry, index) =>
          candidateTree[index] === undefined ||
          entry.path !== candidateTree[index].path ||
          !sameEntry(entry, candidateTree[index]),
      )
    ) {
      findings.push({ code: "immutable-state-changed", path: authority.path });
    }
  }
  return deepFreeze({ ok: findings.length === 0, checked, findings });
}
