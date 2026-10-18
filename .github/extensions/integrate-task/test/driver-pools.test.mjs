// 並列枠と依存の判定。枠を数え間違えると設計の「枠を分ける」が崩れる。

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_POOLS, countActive, failedDependencies, missingDependencies, normalizePools, pendingDispatches, verifySlotScope } from "../driver/pools.mjs";
import { TASK_STATE } from "../driver/state.mjs";

function task(taskId, state, dependsOn = []) {
  return { taskId, state, dependsOn };
}

test("normalizePools は未指定を既定で埋める", () => {
  assert.deepEqual(normalizePools(), { ...DEFAULT_POOLS });
  assert.deepEqual(normalizePools({ tasks: 4 }), { tasks: 4, verify: 1, integration: 1 });
  assert.deepEqual(normalizePools({ tasks: "4", verify: null }), { ...DEFAULT_POOLS });
});

test("normalizePools は範囲外を拒否する", () => {
  assert.throws(() => normalizePools({ tasks: 0 }), /実行枠 tasks は 1〜16/);
  assert.throws(() => normalizePools({ verify: 17 }), /実行枠 verify は 1〜16/);
  assert.throws(() => normalizePools({ integration: -1 }), /実行枠 integration は 1〜16/);
  assert.deepEqual(normalizePools({ tasks: 16 }), { tasks: 16, verify: 1, integration: 1 });
});

test("countActive は実行中の担当だけを数える", () => {
  const tasks = [
    task("t1", TASK_STATE.RUNNING),
    task("t2", TASK_STATE.SUBMITTED),
    task("t3", TASK_STATE.VERIFYING),
    task("t4", TASK_STATE.PLANNED),
    task("t5", TASK_STATE.INTEGRATED),
    task("t6", TASK_STATE.BLOCKED),
  ];
  assert.equal(countActive(tasks), 3);
  assert.equal(countActive([]), 0);
});

test("verifySlotScope は共通ディレクトリごとの名前になる", () => {
  assert.equal(verifySlotScope("/repo/.git"), "verify-slot:/repo/.git");
});

test("missingDependencies は未受入と不明の依存を返す", () => {
  const tasks = [
    task("t1", TASK_STATE.INTEGRATED),
    task("t2", TASK_STATE.SUBMITTED),
    task("t3", TASK_STATE.PLANNED, ["t1", "t2", "t9"]),
  ];
  assert.deepEqual(missingDependencies(tasks[2], tasks), ["t2", "t9"]);
  assert.deepEqual(missingDependencies(task("t4", TASK_STATE.PLANNED), tasks), []);
});

test("failedDependencies は差し戻し系の依存だけを返す", () => {
  const tasks = [
    task("t1", TASK_STATE.BLOCKED),
    task("t2", TASK_STATE.NEEDS_HUMAN),
    task("t3", TASK_STATE.STALE_TARGET),
    task("t4", TASK_STATE.RUNNING),
    task("t5", TASK_STATE.INTEGRATED),
    task("t6", TASK_STATE.PLANNED, ["t1", "t2", "t3", "t4", "t5", "t9"]),
  ];
  assert.deepEqual(failedDependencies(tasks[5], tasks), ["t1", "t2", "t3"]);
});

test("pendingDispatches は空き枠までしか返さない", () => {
  const tasks = [
    task("t1", TASK_STATE.RUNNING),
    task("t2", TASK_STATE.PLANNED),
    task("t3", TASK_STATE.PLANNED),
    task("t4", TASK_STATE.PLANNED),
  ];
  assert.deepEqual(pendingDispatches(tasks, { tasks: 2, verify: 1, integration: 1 }).map((entry) => entry.taskId), ["t2"]);
  assert.deepEqual(pendingDispatches(tasks, { tasks: 3, verify: 1, integration: 1 }).map((entry) => entry.taskId), ["t2", "t3"]);
  assert.deepEqual(pendingDispatches(tasks, { tasks: 1, verify: 1, integration: 1 }), []);
});

test("pendingDispatches は依存が受入済みになるまで待たせる", () => {
  const waiting = [task("t1", TASK_STATE.SUBMITTED), task("t2", TASK_STATE.PLANNED, ["t1"])];
  assert.deepEqual(pendingDispatches(waiting, { tasks: 4, verify: 1, integration: 1 }), []);

  const accepted = [task("t1", TASK_STATE.INTEGRATED), task("t2", TASK_STATE.PLANNED, ["t1"])];
  assert.deepEqual(pendingDispatches(accepted, { tasks: 4, verify: 1, integration: 1 }).map((entry) => entry.taskId), ["t2"]);
});

test("pendingDispatches は差し戻された依存を持つタスクを始めない", () => {
  const tasks = [task("t1", TASK_STATE.BLOCKED), task("t2", TASK_STATE.PLANNED, ["t1"])];
  assert.deepEqual(pendingDispatches(tasks, { tasks: 4, verify: 1, integration: 1 }), []);
});

test("pendingDispatches は依存の無いタスクを先に拾う（波で待たない）", () => {
  const tasks = [
    task("t1", TASK_STATE.PLANNED, ["t2"]),
    task("t2", TASK_STATE.PLANNED),
    task("t3", TASK_STATE.PLANNED),
  ];
  assert.deepEqual(pendingDispatches(tasks, { tasks: 2, verify: 1, integration: 1 }).map((entry) => entry.taskId), ["t2", "t3"]);
});
