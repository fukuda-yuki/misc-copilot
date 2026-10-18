// 提出の検証と統合。候補の作成・検証・公開は integrate/ に委ね、
// ここは driver の状態と台帳をつなぐ。

import { revParseOrNull } from "../core/git.mjs";
import { acquireScopeLock, releaseScopeLock } from "../core/lock.mjs";
import { LEDGER_STATE, STATE as INTEGRATION_STATE } from "../core/state.mjs";
import { createIntegrationRun } from "../integrate/engine.mjs";
import { createProjectPorts, readRegisteredOperation, registerOperation, removeOperation } from "../integrate/ports.mjs";
import { record, setTaskState } from "./journal.mjs";
import { verifySlotScope } from "./pools.mjs";
import { TASK_DETAIL, TASK_STATE } from "./state.mjs";

const INTEGRATION_TO_TASK_STATE = Object.freeze({
  [INTEGRATION_STATE.INTEGRATED]: TASK_STATE.INTEGRATED,
  [INTEGRATION_STATE.VERIFIED_NOT_PUBLISHED]: TASK_STATE.SUBMITTED,
  [INTEGRATION_STATE.NEEDS_PARENT]: TASK_STATE.NEEDS_PARENT,
  [INTEGRATION_STATE.STALE_TARGET]: TASK_STATE.STALE_TARGET,
  [INTEGRATION_STATE.BLOCKED]: TASK_STATE.BLOCKED,
});


export async function integrateTask(context, task, mode) {
  const config = context.config;
  const run = context.run;
  if (typeof task.submittedHead !== "string" || task.submittedHead === "") {
    await setTaskState(context, task, TASK_STATE.NEEDS_HUMAN, TASK_DETAIL.SUBMITTED_HEAD_MISSING, "提出コミットが記録されていません。");
    return { state: TASK_STATE.NEEDS_HUMAN, detail: TASK_DETAIL.SUBMITTED_HEAD_MISSING };
  }
  const integrationId = task.integrationId ?? `int-${task.taskId}`;
  const dependsOn = [];
  for (const dependency of task.dependsOn ?? []) {
    const record_ = context.findTask(dependency);
    if (record_?.integrationId) dependsOn.push(record_.integrationId);
  }

  const targetHead = (await revParseOrNull(run.targetWorktree, "HEAD")) ?? run.baseCommit;
  let existing = await readRegisteredOperation(integrationId, { env: config.env });

  if (existing !== null && existing.state === LEDGER_STATE.INTEGRATED) {
    await setTaskState(context, task, TASK_STATE.INTEGRATED, null, "台帳では既に統合済みです。", {
      integrationId,
      integration: { integrationId, mode, state: INTEGRATION_STATE.INTEGRATED, detail: "already-integrated", at: new Date().toISOString() },
    });
    return { state: TASK_STATE.INTEGRATED, detail: "already-integrated" };
  }

  const needsRegister =
    existing === null ||
    existing.submittedHead !== task.submittedHead ||
    existing.expectedTargetHead !== targetHead ||
    (existing.dependsOn ?? []).join(",") !== dependsOn.join(",");
  if (needsRegister) {
    if (existing !== null) await removeOperation(integrationId, { env: config.env });
    try {
      await registerOperation(
        {
          operationId: integrationId,
          repoPath: run.repoPath,
          targetBranch: run.targetBranch,
          targetRef: run.targetRef,
          targetWorktree: run.targetWorktree,
          submittedHead: task.submittedHead,
          expectedTargetHead: targetHead,
          dependsOn,
          childSessionId: task.sessionId ?? null,
        },
        { env: config.env },
      );
    } catch (error) {
      await setTaskState(context, task, TASK_STATE.NEEDS_HUMAN, TASK_DETAIL.INTEGRATION_FAILED, `受付を登録できません: ${error.message}`);
      return { state: TASK_STATE.NEEDS_HUMAN, detail: TASK_DETAIL.INTEGRATION_FAILED, message: error.message };
    }
  }

  const scope = verifySlotScope(run.commonDir);
  const lock = await acquireScopeLock(context.layout, scope, {
    owner: integrationId,
    purpose: `integrate:${mode}`,
    waitSeconds: config.integrationWaitSeconds,
  });
  if (!lock.acquired) {
    await record(context, { type: "integration-wait", taskId: task.taskId, integrationId, mode, owner: lock.owner ?? null });
    return { state: task.state, detail: TASK_DETAIL.TARGET_BUSY, message: "検証枠が埋まっています。時間をおいて再実行します。" };
  }

  const previousState = task.state;
  if (previousState !== TASK_STATE.VERIFYING) {
    await setTaskState(context, task, TASK_STATE.VERIFYING, null, `${mode} を実行しています。`, { integrationId });
  }
  try {
    const engineRun = createIntegrationRun(createPorts(config));
    const outcome = await engineRun({ args: { operationId: integrationId, mode }, log: config.log });
    const mapped = INTEGRATION_TO_TASK_STATE[outcome.state] ?? TASK_STATE.NEEDS_PARENT;
    const integration = {
      integrationId,
      mode,
      state: outcome.state,
      detail: outcome.detail,
      message: outcome.message,
      candidateHead: outcome.candidateHead ?? null,
      evidenceRef: outcome.evidenceRef ?? null,
      expectedTargetHead: targetHead,
      at: new Date().toISOString(),
    };
    await record(context, {
      type: "integration-result",
      taskId: task.taskId,
      integrationId,
      mode,
      state: outcome.state,
      detail: outcome.detail,
      candidateHead: integration.candidateHead,
      evidenceRef: integration.evidenceRef,
    });
    const current = context.findTask(task.taskId) ?? task;
    await setTaskState(
      context,
      current,
      mapped,
      mapped === TASK_STATE.INTEGRATED ? null : outcome.detail ?? TASK_DETAIL.INTEGRATION_FAILED,
      outcome.message ?? null,
      { integrationId, integration },
    );
    return { state: mapped, detail: outcome.detail, message: outcome.message, candidateHead: integration.candidateHead };
  } finally {
    await releaseScopeLock(context.layout, scope, integrationId);
  }
}

function createPorts(config) {
  return createProjectPorts({ env: config.env, log: config.log });
}
