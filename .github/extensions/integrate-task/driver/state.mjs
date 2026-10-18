// CLI 限定並列開発（driver）の状態。統合側 core/state.mjs とは別名前空間。
// 設計資料 v0.2 §9 の状態に、人間の判断待ち（NEEDS_HUMAN）を加える。

export const RUN_STATE = Object.freeze({
  RUNNING: "RUNNING",
  STOPPED: "STOPPED",
  FINISHED: "FINISHED",
});

export const TASK_STATE = Object.freeze({
  PLANNED: "PLANNED",
  RUNNING: "RUNNING",
  SUBMITTED: "SUBMITTED",
  VERIFYING: "VERIFYING",
  INTEGRATED: "INTEGRATED",
  NEEDS_PARENT: "NEEDS_PARENT",
  NEEDS_HUMAN: "NEEDS_HUMAN",
  BLOCKED: "BLOCKED",
  INTERRUPTED: "INTERRUPTED",
  STALE_TARGET: "STALE_TARGET",
});

// 実行中の担当ではないが、driver が起こす可能性を残す状態。
export const RESUMABLE_STATES = new Set([TASK_STATE.NEEDS_PARENT, TASK_STATE.INTERRUPTED, TASK_STATE.BLOCKED, TASK_STATE.STALE_TARGET]);
export const ACTIVE_STATES = new Set([TASK_STATE.RUNNING, TASK_STATE.SUBMITTED, TASK_STATE.VERIFYING]);
export const DONE_STATES = new Set([TASK_STATE.INTEGRATED]);

export const TASK_DETAIL = Object.freeze({
  PERMISSION_DENIED: "permission-denied",
  UNCLASSIFIED_OUTPUT: "unclassified-output",
  REPORT_MISSING: "report-missing",
  REPORT_INVALID: "report-invalid",
  SUBMITTED_HEAD_MISSING: "submitted-head-missing",
  SUBMITTED_HEAD_MISMATCH: "submitted-head-mismatch",
  NO_NEW_COMMITS: "no-new-commits",
  WORKTREE_DIRTY: "worktree-dirty",
  WORKTREE_MISSING: "worktree-missing",
  EXIT_NONZERO: "exit-nonzero",
  TIMEOUT: "timeout",
  LAUNCH_FAILED: "launch-failed",
  TASKS_UNFINISHED: "tasks-unfinished",
  OWNER_UNKNOWN: "owner-unknown",
  SESSION_LOST: "session-lost",
  SLOTS_FULL: "slots-full",
  DEPENDENCY_NOT_INTEGRATED: "dependency-not-integrated",
  TARGET_BUSY: "target-busy",
  OPERATION_INVALID: "operation-invalid",
  OPERATION_DUPLICATE: "operation-duplicate",
  SNAPSHOT_STALE: "snapshot-stale",
  TASK_NOT_FOUND: "task-not-found",
  TASK_STATE_INVALID: "task-state-invalid",
  QUESTION: "question",
  TASK_FAILED: "task-failed",
  INTEGRATION_FAILED: "integration-failed",
  HUMAN_REQUESTED: "human-requested",
  NO_OPERATION: "no-operation",
  STOPPED: "stopped",
  RUN_STOPPED: "run-stopped",
});

export const ATTEMPT_STATE = Object.freeze({
  RUNNING: "RUNNING",
  DONE: "DONE",
  QUESTION: "QUESTION",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
  INTERRUPTED: "INTERRUPTED",
  UNKNOWN: "UNKNOWN",
});

const TRANSITIONS = {
  [TASK_STATE.PLANNED]: [TASK_STATE.RUNNING, TASK_STATE.BLOCKED, TASK_STATE.NEEDS_HUMAN],
  [TASK_STATE.RUNNING]: [
    TASK_STATE.RUNNING,
    TASK_STATE.SUBMITTED,
    TASK_STATE.NEEDS_PARENT,
    TASK_STATE.BLOCKED,
    TASK_STATE.INTERRUPTED,
    TASK_STATE.NEEDS_HUMAN,
    TASK_STATE.STALE_TARGET,
  ],
  [TASK_STATE.SUBMITTED]: [
    TASK_STATE.SUBMITTED,
    TASK_STATE.VERIFYING,
    TASK_STATE.NEEDS_PARENT,
    TASK_STATE.BLOCKED,
    TASK_STATE.NEEDS_HUMAN,
    TASK_STATE.STALE_TARGET,
  ],
  [TASK_STATE.VERIFYING]: [
    TASK_STATE.VERIFYING,
    TASK_STATE.SUBMITTED,
    TASK_STATE.INTEGRATED,
    TASK_STATE.NEEDS_PARENT,
    TASK_STATE.BLOCKED,
    TASK_STATE.NEEDS_HUMAN,
    TASK_STATE.STALE_TARGET,
  ],
  [TASK_STATE.NEEDS_PARENT]: [TASK_STATE.NEEDS_PARENT, TASK_STATE.RUNNING, TASK_STATE.BLOCKED, TASK_STATE.NEEDS_HUMAN, TASK_STATE.INTERRUPTED],
  [TASK_STATE.INTERRUPTED]: [TASK_STATE.INTERRUPTED, TASK_STATE.RUNNING, TASK_STATE.BLOCKED, TASK_STATE.NEEDS_HUMAN, TASK_STATE.NEEDS_PARENT],
  [TASK_STATE.STALE_TARGET]: [TASK_STATE.STALE_TARGET, TASK_STATE.RUNNING, TASK_STATE.BLOCKED, TASK_STATE.NEEDS_HUMAN],
  [TASK_STATE.BLOCKED]: [TASK_STATE.BLOCKED, TASK_STATE.RUNNING, TASK_STATE.NEEDS_HUMAN],
  [TASK_STATE.NEEDS_HUMAN]: [TASK_STATE.NEEDS_HUMAN, TASK_STATE.RUNNING, TASK_STATE.BLOCKED],
  [TASK_STATE.INTEGRATED]: [TASK_STATE.INTEGRATED],
};

export function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function assertTaskId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error("taskId は英数字で始まる 1〜64 文字の [A-Za-z0-9._-] で指定してください。");
  }
  return value;
}

export function summarizeTasks(tasks) {
  const counts = {};
  for (const task of tasks) {
    counts[task.state] = (counts[task.state] ?? 0) + 1;
  }
  return counts;
}
