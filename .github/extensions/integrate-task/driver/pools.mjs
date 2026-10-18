import { ACTIVE_STATES, DONE_STATES, TASK_STATE } from "./state.mjs";

export const DEFAULT_POOLS = Object.freeze({ tasks: 2, verify: 1, integration: 1 });

export function normalizePools(value) {
  const source = value ?? {};
  const pools = {
    tasks: Number.isInteger(source.tasks) ? source.tasks : DEFAULT_POOLS.tasks,
    verify: Number.isInteger(source.verify) ? source.verify : DEFAULT_POOLS.verify,
    integration: Number.isInteger(source.integration) ? source.integration : DEFAULT_POOLS.integration,
  };
  for (const [name, count] of Object.entries(pools)) {
    if (count < 1 || count > 16) throw new Error(`実行枠 ${name} は 1〜16 で指定してください。`);
  }
  return pools;
}

export function countActive(tasks) {
  return tasks.filter((task) => ACTIVE_STATES.has(task.state)).length;
}

/** 検証枠は統合の check / apply で共有する。ロックのスコープ名に使う。 */
export function verifySlotScope(commonDir) {
  return `verify-slot:${commonDir}`;
}

export function missingDependencies(task, tasks) {
  const byId = new Map(tasks.map((entry) => [entry.taskId, entry]));
  return (task.dependsOn ?? []).filter((id) => {
    const dependency = byId.get(id);
    return dependency === undefined || !DONE_STATES.has(dependency.state);
  });
}

export function failedDependencies(task, tasks) {
  const byId = new Map(tasks.map((entry) => [entry.taskId, entry]));
  return (task.dependsOn ?? []).filter((id) => {
    const dependency = byId.get(id);
    return dependency !== undefined && [TASK_STATE.BLOCKED, TASK_STATE.NEEDS_HUMAN, TASK_STATE.STALE_TARGET].includes(dependency.state);
  });
}

/**
 * 起動してよいタスクを、依存の受入済みと空き枠の両方で決める。
 * 「全員完了」の波で待たせず、依存先が INTEGRATED になった時点で次を始める。
 */
export function pendingDispatches(tasks, pools) {
  let free = Math.max(0, pools.tasks - countActive(tasks));
  const ready = [];
  for (const task of tasks) {
    if (free === 0) break;
    if (task.state !== TASK_STATE.PLANNED) continue;
    if (missingDependencies(task, tasks).length > 0) continue;
    if (failedDependencies(task, tasks).length > 0) continue;
    ready.push(task);
    free -= 1;
  }
  return ready;
}
