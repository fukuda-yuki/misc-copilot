// 親から届いた操作の適用。版・重複・状態を検証してから実行する。

import { STATE as INTEGRATION_STATE } from "../core/state.mjs";
import { startAttempt } from "./attempts.mjs";
import { finishRun, record, setTaskState, stopRun } from "./journal.mjs";
import { integrateTask } from "./merge.mjs";
import { OPERATION_KIND } from "./protocol.mjs";
import { RESUMABLE_STATES, TASK_DETAIL, TASK_STATE } from "./state.mjs";
import { listOperationRecords, readOperationRecord, writeOperationRecord, writeTask } from "./store.mjs";


export async function applyOperation(context, operation) {
  const layout = context.layout;
  const existing = await readOperationRecord(layout, operation.operationId);
  if (existing !== null) {
    await record(context, {
      type: "operation-rejected",
      operationId: operation.operationId,
      kind: operation.kind,
      detail: TASK_DETAIL.OPERATION_DUPLICATE,
      message: "同じ operationId を既に受け取っています。",
    });
    return { status: "rejected", detail: TASK_DETAIL.OPERATION_DUPLICATE };
  }

  const presented = context.presentedRevision ?? context.run.snapshotRevision;
  if (operation.snapshotRevision !== presented) {
    const record_ = await writeOperationRecord(layout, {
      operationId: operation.operationId,
      kind: operation.kind,
      taskId: operation.taskId,
      snapshotRevision: operation.snapshotRevision,
      receivedAt: new Date().toISOString(),
      status: "rejected",
      detail: TASK_DETAIL.SNAPSHOT_STALE,
      presentedRevision: presented,
      payload: operation.payload,
    });
    await record(context, {
      type: "operation-rejected",
      operationId: operation.operationId,
      kind: operation.kind,
      detail: TASK_DETAIL.SNAPSHOT_STALE,
      message: `提案の snapshotRevision ${operation.snapshotRevision} は提示した ${presented} と一致しません。`,
    });
    return { status: "rejected", detail: TASK_DETAIL.SNAPSHOT_STALE, record: record_ };
  }

  const rejected = async (detail, message) => {
    await writeOperationRecord(layout, {
      operationId: operation.operationId,
      kind: operation.kind,
      taskId: operation.taskId,
      snapshotRevision: operation.snapshotRevision,
      receivedAt: new Date().toISOString(),
      status: "rejected",
      detail,
      message,
      payload: operation.payload,
    });
    await record(context, { type: "operation-rejected", operationId: operation.operationId, kind: operation.kind, taskId: operation.taskId, detail, message });
    return { status: "rejected", detail, message };
  };

  const task = operation.taskId === null ? null : context.findTask(operation.taskId);
  if (operation.taskId !== null && task === null && operation.kind !== OPERATION_KIND.DISPATCH) {
    return await rejected(TASK_DETAIL.TASK_NOT_FOUND, `taskId ${operation.taskId} は存在しません。`);
  }

  switch (operation.kind) {
    case OPERATION_KIND.DISPATCH: {
      const taskId = operation.taskId ?? nextTaskId(context);
      if (context.findTask(taskId) !== null) {
        return await rejected(TASK_DETAIL.OPERATION_INVALID, `taskId ${taskId} は既に存在します。`);
      }
      const created = await writeTask(layout, {
        taskId,
        title: operation.payload.title,
        prompt: operation.payload.prompt,
        dependsOn: operation.payload.dependsOn,
        base: operation.payload.base ?? null,
        state: TASK_STATE.PLANNED,
        detail: null,
        message: null,
        attemptCount: 0,
        reworkCount: 0,
        currentAttemptId: null,
        lastAttemptId: null,
        submittedHead: null,
        sessionId: null,
        worktree: null,
        branch: null,
        baseCommit: null,
        integrationId: null,
        integration: null,
        question: null,
        createdAt: new Date().toISOString(),
      });
      context.replaceTask(created);
      await writeOperationRecord(layout, {
        operationId: operation.operationId,
        kind: operation.kind,
        taskId,
        snapshotRevision: operation.snapshotRevision,
        receivedAt: new Date().toISOString(),
        status: "applied",
        payload: operation.payload,
      });
      await record(context, { type: "operation-applied", operationId: operation.operationId, kind: operation.kind, taskId });
      return { status: "applied", taskId, detail: null };
    }

    case OPERATION_KIND.ANSWER: {
      if (task.state !== TASK_STATE.NEEDS_PARENT) {
        return await rejected(TASK_DETAIL.TASK_STATE_INVALID, `taskId ${task.taskId} は ${task.state} です。質問待ちではありません。`);
      }
      if (typeof task.sessionId !== "string" || task.sessionId === "") {
        await setTaskState(context, task, TASK_STATE.NEEDS_HUMAN, TASK_DETAIL.SESSION_LOST, "再開するセッション ID がありません。");
        return await rejected(TASK_DETAIL.SESSION_LOST, "再開するセッション ID がありません。");
      }
      await writeOperationRecord(layout, {
        operationId: operation.operationId,
        kind: operation.kind,
        taskId: task.taskId,
        snapshotRevision: operation.snapshotRevision,
        receivedAt: new Date().toISOString(),
        status: "applied",
        payload: operation.payload,
      });
      await record(context, { type: "operation-applied", operationId: operation.operationId, kind: operation.kind, taskId: task.taskId });
      const started = await startAttempt(context, task, { kind: "answer", reuseWorktree: true, resumeSessionId: task.sessionId, answer: operation.payload.answer });
      return { status: "applied", taskId: task.taskId, detail: null, started };
    }

    case OPERATION_KIND.REWORK: {
      if (!RESUMABLE_STATES.has(task.state)) {
        return await rejected(TASK_DETAIL.TASK_STATE_INVALID, `taskId ${task.taskId} は ${task.state} です。差し戻せません。`);
      }
      if (Number(task.reworkCount ?? 0) >= context.config.maxReworks) {
        return await rejected(TASK_DETAIL.TASK_STATE_INVALID, `taskId ${task.taskId} の差し戻しが上限（${context.config.maxReworks}）に達しています。`);
      }
      const reset = operation.payload.resetWorktree || task.state === TASK_STATE.STALE_TARGET;
      const resume = reset || typeof task.sessionId !== "string" || task.sessionId === "" ? null : task.sessionId;
      await writeOperationRecord(layout, {
        operationId: operation.operationId,
        kind: operation.kind,
        taskId: task.taskId,
        snapshotRevision: operation.snapshotRevision,
        receivedAt: new Date().toISOString(),
        status: "applied",
        payload: operation.payload,
      });
      await record(context, { type: "operation-applied", operationId: operation.operationId, kind: operation.kind, taskId: task.taskId, resetWorktree: reset });
      const prepared = await writeTask(layout, {
        ...task,
        reworkCount: Number(task.reworkCount ?? 0) + 1,
        integration: null,
        integrationId: reset ? null : task.integrationId,
        submittedHead: reset ? null : task.submittedHead,
      });
      context.replaceTask(prepared);
      const started = await startAttempt(context, prepared, {
        kind: "rework",
        reuseWorktree: !reset,
        resumeSessionId: resume,
        instruction: operation.payload.instruction,
      });
      return { status: "applied", taskId: task.taskId, detail: null, started };
    }

    case OPERATION_KIND.CHECK_MERGE:
    case OPERATION_KIND.APPLY_MERGE: {
      const mode = operation.kind === OPERATION_KIND.CHECK_MERGE ? "check" : "apply";
      if (task.state !== TASK_STATE.SUBMITTED) {
        return await rejected(TASK_DETAIL.TASK_STATE_INVALID, `taskId ${task.taskId} は ${task.state} です。提出待ちではありません。`);
      }
      if (mode === "apply" && task.integration?.state !== INTEGRATION_STATE.VERIFIED_NOT_PUBLISHED) {
        return await rejected(TASK_DETAIL.TASK_STATE_INVALID, `taskId ${task.taskId} は検証済みではありません。先に CHECK_MERGE が必要です。`);
      }
      await writeOperationRecord(layout, {
        operationId: operation.operationId,
        kind: operation.kind,
        taskId: task.taskId,
        snapshotRevision: operation.snapshotRevision,
        receivedAt: new Date().toISOString(),
        status: "applied",
        payload: operation.payload,
      });
      await record(context, { type: "operation-applied", operationId: operation.operationId, kind: operation.kind, taskId: task.taskId, mode });
      const outcome = await integrateTask(context, task, mode);
      return { status: "applied", taskId: task.taskId, detail: outcome.detail, integration: outcome };
    }

    case OPERATION_KIND.REQUEST_HUMAN: {
      await writeOperationRecord(layout, {
        operationId: operation.operationId,
        kind: operation.kind,
        taskId: operation.taskId,
        snapshotRevision: operation.snapshotRevision,
        receivedAt: new Date().toISOString(),
        status: "applied",
        payload: operation.payload,
      });
      await record(context, { type: "operation-applied", operationId: operation.operationId, kind: operation.kind, taskId: operation.taskId });
      if (task !== null && task.state !== TASK_STATE.INTEGRATED) {
        await setTaskState(context, task, TASK_STATE.NEEDS_HUMAN, TASK_DETAIL.HUMAN_REQUESTED, operation.payload.reason);
      }
      await stopRun(context, TASK_DETAIL.HUMAN_REQUESTED, operation.payload.reason);
      return { status: "applied", taskId: operation.taskId, detail: TASK_DETAIL.HUMAN_REQUESTED };
    }

    case OPERATION_KIND.FINISH: {
      const unfinished = context.tasks.filter((entry) => entry.state !== TASK_STATE.INTEGRATED);
      if (unfinished.length > 0) {
        return await rejected(
          TASK_DETAIL.OPERATION_INVALID,
          `未統合のタスクがあります: ${unfinished.map((entry) => `${entry.taskId}(${entry.state})`).join(", ")}`,
        );
      }
      await writeOperationRecord(layout, {
        operationId: operation.operationId,
        kind: operation.kind,
        taskId: null,
        snapshotRevision: operation.snapshotRevision,
        receivedAt: new Date().toISOString(),
        status: "applied",
        payload: operation.payload,
      });
      await record(context, { type: "operation-applied", operationId: operation.operationId, kind: operation.kind });
      await finishRun(context, operation.payload.summary ?? "親セッションの FINISH により終了しました。");
      return { status: "applied", detail: null };
    }

    default: {
      return await rejected(TASK_DETAIL.OPERATION_INVALID, `未対応の操作種別です: ${operation.kind}`);
    }
  }
}

function nextTaskId(context) {
  for (let index = context.tasks.length + 1; index < context.tasks.length + 1000; index += 1) {
    const candidate = `task-${String(index).padStart(3, "0")}`;
    if (context.findTask(candidate) === null) return candidate;
  }
  throw new Error("taskId を採番できません。");
}

export async function operationsOf(context) {
  return listOperationRecords(context.layout);
}
