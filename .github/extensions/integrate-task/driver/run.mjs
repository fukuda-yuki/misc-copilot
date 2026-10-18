// CLI 限定並列開発の driver。判断（いつ何を起こすか）はこのファイルに置き、
// AI は呼ばない。親セッションは非対話 CLI として起動し、操作提案だけを受け付ける。
//
// 入口は 2 つ。Copilot App からは extension.mjs、CLI からは driver/cli.mjs。
// このファイルは実行の組み立て（設定・起動・1 ステップの判断・ループ）を持つ。

import path from "node:path";

import { currentBranch, resolveCommit, resolveRepoContext } from "../core/git.mjs";
import { resolveHome } from "../core/store.mjs";
import { reap, startAttempt } from "./attempts.mjs";
import { clearStopRequest, finishRun, readStopRequest, recover, requestStop, stopRun } from "./journal.mjs";
import { parentAttention, parentTurn } from "./parent.mjs";
import { normalizePools, pendingDispatches } from "./pools.mjs";
import { DEFAULT_DENY_TOOLS, DEFAULT_PARENT_ALLOW_TOOLS, DEFAULT_TASK_ALLOW_TOOLS, createSessionRegistry, isProcessAlive, requireCapabilities } from "./session.mjs";
import { RUN_STATE, TASK_DETAIL, TASK_STATE, summarizeTasks } from "./state.mjs";
import { appendEvent, ensureRunLayout, listTasks, newRunId, readParent, readRun, runLayout, writeRun } from "./store.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function defaultConfig(overrides = {}) {
  const baseEnv = overrides.env ?? process.env;
  const home = overrides.home ?? resolveHome(baseEnv);
  // 統合の側（integrate/ports.mjs）は INTEGRATE_TASK_HOME を見るため、
  // driver の home と一致させて台帳・証拠・候補 worktree を 1 か所にそろえる。
  const env = { ...baseEnv, INTEGRATE_TASK_HOME: home };
  return {
    env,
    home,
    cwd: overrides.cwd ?? process.cwd(),
    command: overrides.command ?? "copilot",
    // command の前に置く引数。テストで copilot を差し替えるときや、
    // `node <script>` のように起動するときに使う。
    commandArgs: overrides.commandArgs ?? [],
    capabilities: overrides.capabilities ?? null,
    capabilityProbe: overrides.capabilityProbe ?? null,
    log: overrides.log ?? (() => {}),
    pools: normalizePools(overrides.pools),
    timeoutMinutes: overrides.timeoutMinutes ?? 30,
    pollSeconds: overrides.pollSeconds ?? 2,
    integrationWaitSeconds: overrides.integrationWaitSeconds ?? 60,
    noOperationLimit: overrides.noOperationLimit ?? 2,
    maxReworks: overrides.maxReworks ?? 2,
    parentModel: overrides.parentModel ?? null,
    taskModel: overrides.taskModel ?? null,
    effort: overrides.effort ?? null,
    // task-pipeline の実装役・レビュー役。CLI のフラグか DISPATCH の payload.roles で指定する。
    taskRoles: overrides.taskRoles ?? null,
    parentAllowTools: overrides.parentAllowTools ?? [...DEFAULT_PARENT_ALLOW_TOOLS],
    parentDenyTools: overrides.parentDenyTools ?? [...DEFAULT_DENY_TOOLS],
    taskAllowTools: overrides.taskAllowTools ?? [...DEFAULT_TASK_ALLOW_TOOLS],
    taskDenyTools: overrides.taskDenyTools ?? [...DEFAULT_DENY_TOOLS],
  };
}

export async function initRun(config, input = {}) {
  requireCapabilities(config);
  const startDir = path.resolve(input.repoPath ?? config.cwd);
  const { repoPath, commonDir } = await resolveRepoContext(startDir);
  const targetBranch = input.targetBranch ?? (await resolveTargetBranch(repoPath));
  const targetWorktree = path.resolve(input.targetWorktree ?? repoPath);
  const baseCommit = await resolveCommit(repoPath, input.baseCommit ?? "HEAD");
  if (baseCommit === null) throw new Error("起点コミットを解決できません。");

  const runId = input.runId ?? newRunId();
  const layout = await ensureRunLayout(runId, config.home);
  const run = await writeRun(layout, {
    version: 1,
    runId,
    state: RUN_STATE.RUNNING,
    request: input.request ?? "",
    repoPath,
    commonDir,
    targetBranch,
    targetRef: input.targetRef ?? `refs/heads/${targetBranch}`,
    targetWorktree,
    baseCommit,
    pools: config.pools,
    timeoutMinutes: config.timeoutMinutes,
    // 実装役・レビュー役の既定（DISPATCH の payload.roles が優先）。
    taskRoles: config.taskRoles,
    toolPolicy: {
      parentAllow: config.parentAllowTools,
      parentDeny: config.parentDenyTools,
      taskAllow: config.taskAllowTools,
      taskDeny: config.taskDenyTools,
    },
    driverPid: process.pid,
    driverStartedAt: new Date().toISOString(),
    nextEventId: 1,
    snapshotRevision: 0,
    createdAt: new Date().toISOString(),
    stopDetail: null,
    stopMessage: null,
    finishedAt: null,
  });
  await appendEvent(layout, { type: "run-created", runId, repoPath, targetBranch, targetWorktree, baseCommit, request: run.request });
  return { runId, layout, run: await readRun(layout) };
}

async function resolveTargetBranch(repoPath) {
  const branch = await currentBranch(repoPath);
  if (typeof branch !== "string" || branch === "") throw new Error("ターゲットブランチを特定できません。--target で指定してください。");
  return branch;
}

export async function loadContext(config, runId, options = {}) {
  const layout = runLayout(runId, config.home);
  const run = await readRun(layout);
  if (run === null) throw new Error(`run ${runId} が見つかりません。`);
  const tasks = await listTasks(layout);
  const context = {
    config,
    layout,
    run,
    tasks,
    parent: await readParent(layout),
    events: [],
    live: new Map(),
    registry: createSessionRegistry(),
    presentedRevision: null,
    replaceTask(next) {
      const index = this.tasks.findIndex((task) => task.taskId === next.taskId);
      if (index === -1) this.tasks.push(next);
      else this.tasks[index] = next;
      return next;
    },
    findTask(taskId) {
      return this.tasks.find((task) => task.taskId === taskId) ?? null;
    },
  };
  if (options.recover !== false && run.state === RUN_STATE.RUNNING) {
    context.recovery = await recover(context);
  }
  return context;
}

export async function step(context) {
  if (context.run.state !== RUN_STATE.RUNNING) return { action: "run-stopped", detail: context.run.state };

  const stopRequest = await readStopRequest(context);
  if (stopRequest !== null) {
    const outcome = await stopRun(context, TASK_DETAIL.STOPPED, stopRequest.reason ?? "停止要求を受け取りました。");
    return { action: "run-stopped", detail: outcome };
  }

  const finished = await reap(context);
  if (finished.length > 0) return { action: "reaped", detail: finished };

  const attention = parentAttention(context);
  if (attention.length > 0) {
    const outcome = await parentTurn(context);
    // 親の FINISH で終わった場合は、完了として記録する。
    if (context.run.state === RUN_STATE.FINISHED) {
      return { action: "finished", detail: { summary: context.run.stopMessage } };
    }
    return { action: "parent-turn", detail: { attention: attention.length, ...outcome } };
  }

  const ready = pendingDispatches(context.tasks, context.run.pools ?? context.config.pools);
  if (ready.length > 0) {
    const started = [];
    for (const task of ready) started.push(await startAttempt(context, task, { kind: "initial" }));
    if (context.live.size > 0) return { action: "dispatched", detail: started };
  }

  if (context.live.size > 0) return { action: "waiting", detail: { live: [...context.live.keys()] } };

  const unfinished = context.tasks.filter((task) => task.state !== TASK_STATE.INTEGRATED);
  if (unfinished.length === 0) {
    const outcome = await finishRun(context, "全タスクが統合されました。");
    return { action: "finished", detail: outcome };
  }
  const detail = unfinished.some((task) => task.state === TASK_STATE.NEEDS_HUMAN) ? TASK_DETAIL.HUMAN_REQUESTED : TASK_DETAIL.TASKS_UNFINISHED;
  const outcome = await stopRun(
    context,
    detail,
    `未完了のタスクがあります: ${unfinished.map((task) => `${task.taskId}(${task.state})`).join(", ")}`,
  );
  return { action: "run-stopped", detail: outcome };
}

export async function runLoop(context, options = {}) {
  const pollMs = (options.pollSeconds ?? context.config.pollSeconds) * 1000;
  const maxSteps = Number.isInteger(options.maxSteps) ? options.maxSteps : Number.POSITIVE_INFINITY;
  const history = [];
  let steps = 0;
  while (context.run.state === RUN_STATE.RUNNING && steps < maxSteps) {
    if (options.signal?.aborted) {
      const outcome = await stopRun(context, TASK_DETAIL.STOPPED, "中断シグナルを受け取りました。");
      history.push({ action: "run-stopped", detail: outcome });
      break;
    }
    const outcome = await step(context);
    history.push(outcome);
    steps += 1;
    options.onStep?.(outcome);
    if (outcome.action === "idle" || outcome.action === "waiting") {
      await sleep(pollMs);
    }
  }
  return { steps, history, run: context.run };
}

export function statusSnapshot(context) {
  const parent = context.parent ?? null;
  return {
    runId: context.run.runId,
    state: context.run.state,
    stopDetail: context.run.stopDetail ?? null,
    stopMessage: context.run.stopMessage ?? null,
    repoPath: context.run.repoPath,
    targetBranch: context.run.targetBranch,
    targetWorktree: context.run.targetWorktree,
    baseCommit: context.run.baseCommit,
    snapshotRevision: context.run.snapshotRevision,
    createdAt: context.run.createdAt,
    driverPid: context.run.driverPid ?? null,
    driverAlive: isProcessAlive(context.run.driverPid),
    pools: context.run.pools ?? null,
    summary: summarizeTasks(context.tasks),
    live: [...context.live.keys()],
    parent,
    tasks: context.tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      state: task.state,
      detail: task.detail ?? null,
      message: task.message ?? null,
      dependsOn: task.dependsOn ?? [],
      attemptCount: task.attemptCount ?? 0,
      submittedHead: task.submittedHead ?? null,
      integrationState: task.integration?.state ?? null,
      integrationId: task.integrationId ?? null,
      worktree: task.worktree ?? null,
      branch: task.branch ?? null,
      question: task.question ?? null,
    })),
  };
}

// 切り出した入口も、これまでどおり run.mjs から見せる。
export { applyOperation, operationsOf } from "./operations.mjs";
export { integrateTask } from "./merge.mjs";
export { clearStopRequest, recover, requestStop };
