// 実行とタスクの状態遷移・イベント記録・停止と完了・停止要求。
// 実行の記録を書き換えるのはこのファイルだけにする。

import fs from "node:fs/promises";
import path from "node:path";

import { isProcessAlive, stopSession } from "./session.mjs";
import { ATTEMPT_STATE, RUN_STATE, TASK_DETAIL, TASK_STATE, canTransition } from "./state.mjs";
import { appendEvent, listAttempts, listTasks, readRun, updateRun, writeAttempt, writeTask } from "./store.mjs";

const STOP_REQUEST_FILE = "stop-request.json";

export async function record(context, event) {
  const written = await appendEvent(context.layout, event);
  context.run = await readRun(context.layout);
  context.events.push(written);
  return written;
}

export async function setRunState(context, patch) {
  context.run = await updateRun(context.layout, patch);
  return context.run;
}

export async function setTaskState(context, task, state, detail, message, extra = {}) {
  if (task.state !== state && !canTransition(task.state, state)) {
    await record(context, {
      type: "task-transition-rejected",
      taskId: task.taskId,
      from: task.state,
      to: state,
      detail: detail ?? null,
      message: message ?? null,
    });
    return null;
  }
  const next = await writeTask(context.layout, { ...task, ...extra, state, detail: detail ?? null, message: message ?? null });
  context.replaceTask(next);
  await record(context, {
    type: "task-state",
    taskId: task.taskId,
    from: task.state,
    state,
    detail: detail ?? null,
    message: message ?? null,
  });
  return next;
}

export async function stopRun(context, detail, message) {
  const stopped = [];
  for (const entry of context.live.values()) {
    const outcome = await stopSession(context.registry, entry.attempt, { force: false });
    stopped.push({ attemptId: entry.attemptId, ...outcome });
  }
  context.live.clear();
  await setRunState(context, {
    state: RUN_STATE.STOPPED,
    stopDetail: detail,
    stopMessage: message,
    stoppedAt: new Date().toISOString(),
  });
  await record(context, { type: "run-stopped", detail, message, stopped });
  return { detail, message, stopped };
}

export async function finishRun(context, summary) {
  await setRunState(context, {
    state: RUN_STATE.FINISHED,
    stopDetail: null,
    stopMessage: summary,
    finishedAt: new Date().toISOString(),
  });
  await record(context, { type: "run-finished", summary });
  return { summary };
}


/**
 * 前回の driver が残した試行の後始末。生きている driver が所有している試行には触れない。
 * status のような読み取り専用の入口からは呼ばない。
 */
export async function recover(context) {
  const changes = [];
  const tasks = await listTasks(context.layout);
  for (const task of tasks) {
    const attempts = await listAttempts(context.layout, task.taskId);
    for (const attempt of attempts) {
      if (attempt.state !== ATTEMPT_STATE.RUNNING) continue;
      // この driver 自身が起こした試行は、いま走っているので触らない。
      if (attempt.driverPid === process.pid) continue;
      const ownerAlive = isProcessAlive(attempt.driverPid);
      const childAlive = isProcessAlive(attempt.pid);
      if (ownerAlive) continue;
      if (childAlive) {
        await writeAttempt(context.layout, { ...attempt, state: ATTEMPT_STATE.UNKNOWN, note: "driver が消えた後もプロセスが残っています。" });
        await setTaskState(context, task, TASK_STATE.NEEDS_HUMAN, TASK_DETAIL.OWNER_UNKNOWN, "担当プロセスの所有権が不明です。手動で確認してください。");
        changes.push({ attemptId: attempt.attemptId, action: "owner-unknown" });
      } else {
        await writeAttempt(context.layout, { ...attempt, state: ATTEMPT_STATE.INTERRUPTED, note: "driver の再起動時に既に終了していました。" });
        await setTaskState(context, task, TASK_STATE.INTERRUPTED, TASK_DETAIL.STOPPED, "担当プロセスは driver の停止時に終了していました。");
        changes.push({ attemptId: attempt.attemptId, action: "interrupted" });
      }
    }
    if (task.state === TASK_STATE.VERIFYING) {
      await setTaskState(context, task, TASK_STATE.SUBMITTED, TASK_DETAIL.INTEGRATION_FAILED, "検証の途中で driver が停止しました。再検証してください。");
      changes.push({ taskId: task.taskId, action: "verify-interrupted" });
    } else if (task.state === TASK_STATE.RUNNING) {
      const stillRunning = (await listAttempts(context.layout, task.taskId)).some((attempt) => attempt.state === ATTEMPT_STATE.RUNNING);
      if (!stillRunning) {
        await setTaskState(context, task, TASK_STATE.INTERRUPTED, TASK_DETAIL.STOPPED, "実行中の試行がありません。再開または差し戻しが必要です。");
        changes.push({ taskId: task.taskId, action: "running-without-attempt" });
      }
    }
  }
  if (changes.length > 0) await record(context, { type: "recovered", changes });
  return changes;
}

export async function readStopRequest(context) {
  try {
    const text = await fs.readFile(path.join(context.layout.base, STOP_REQUEST_FILE), "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function requestStop(context, reason) {
  const file = path.join(context.layout.base, STOP_REQUEST_FILE);
  const payload = { requestedAt: new Date().toISOString(), requestedByPid: process.pid, reason: reason ?? "停止要求" };
  await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

export async function clearStopRequest(context) {
  await fs.rm(path.join(context.layout.base, STOP_REQUEST_FILE), { force: true });
}
