// 状態・理由コード・結果の形は、設計資料 v0.1 の enum をそのまま使う。
export const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const STATE = Object.freeze({
  NEEDS_PARENT: "NEEDS_PARENT",
  STALE_TARGET: "STALE_TARGET",
  BLOCKED: "BLOCKED",
  VERIFIED_NOT_PUBLISHED: "VERIFIED_NOT_PUBLISHED",
  INTEGRATED: "INTEGRATED",
});

// 台帳だけが持つ受付直後の状態。ワークフローの戻り値には使わない。
export const LEDGER_STATE = Object.freeze({
  REGISTERED: "REGISTERED",
});

export const DETAIL = Object.freeze({
  TARGET_BUSY: "target-busy",
  MERGE_CONFLICT: "merge-conflict",
  MERGE_FAILED: "merge-failed",
  DEPENDENCY_NOT_INTEGRATED: "dependency-not-integrated",
  TARGET_DIRTY: "target-dirty",
  TARGET_MOVED: "target-moved",
  TARGET_GIT_OPERATION: "target-git-operation",
  TARGET_WORKTREE_MISMATCH: "target-worktree-mismatch",
  TARGET_WORKTREE_MISSING: "target-worktree-missing",
  POLICY_CHANGED: "policy-changed",
  POLICY_MISSING: "policy-missing",
  GUARD_PATH_TOUCHED: "guard-path-touched",
  VERIFY_FAILED: "verify-failed",
  VERIFY_MUTATED_WORKTREE: "verify-mutated-worktree",
  EVIDENCE_MISSING: "evidence-missing",
  SUBMITTED_HEAD_MISSING: "submitted-head-missing",
  ALREADY_INTEGRATED: "already-integrated",
  RECOVERED_AFTER_PUBLISH: "recovered-after-publish",
  INTEGRATION_RECORD_INCONSISTENT: "integration-record-inconsistent",
  UNEXPECTED_ANCESTRY: "unexpected-ancestry",
  CANDIDATE_MISSING: "candidate-missing",
  CANDIDATE_CHANGED: "candidate-changed",
  CANDIDATE_SHAPE_MISMATCH: "candidate-shape-mismatch",
  PUBLISH_FAILED: "publish-failed",
  PUBLISH_VERIFY_FAILED: "publish-verify-failed",
  CHECK_ONLY: "check-only",
});

export function result(state, detail, options = {}) {
  const { message = "", candidateHead = null, evidenceRef = null, extra = {} } = options;
  return { state, detail, message, candidateHead, evidenceRef, ...extra };
}

export function assertOperationId(value) {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) {
    throw new Error("operationId は英数字で始まる 1〜100 文字の [A-Za-z0-9._-] で指定してください。");
  }
  return value;
}

export function validateArgs(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("引数はオブジェクトで指定してください。");
  }
  const args = /** @type {Record<string, unknown>} */ (value);
  const unknownKeys = Object.keys(args).filter((key) => key !== "operationId" && key !== "mode");
  if (unknownKeys.length > 0) {
    throw new Error(`未知の引数です: ${unknownKeys.join(", ")}`);
  }
  assertOperationId(args.operationId);
  if (args.mode !== "check" && args.mode !== "apply") {
    throw new Error("mode は check または apply を指定してください。");
  }
  return { operationId: args.operationId, mode: args.mode };
}
