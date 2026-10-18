// 親セッションの 1 ターン。プロンプトを作り、非対話 CLI として起動し、
// 返ってきた操作提案だけを受け付ける。

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { STATE as INTEGRATION_STATE } from "../core/state.mjs";
import { ensureReportIgnored } from "./attempts.mjs";
import { record, stopRun } from "./journal.mjs";
import { applyOperation } from "./operations.mjs";
import { describeOperation, extractSessionId, parseOperationBlocksFromOutput, protocolInstructions, validateOperation } from "./protocol.mjs";
import { CapabilityError, buildArgs, promptReference, requireCapabilities, runSession } from "./session.mjs";
import { TASK_DETAIL, TASK_STATE } from "./state.mjs";
import { readParent, writeParent } from "./store.mjs";

const PARENT_ATTENTION_STATES = new Set([TASK_STATE.BLOCKED, TASK_STATE.INTERRUPTED, TASK_STATE.STALE_TARGET]);

function buildParentPrompt(context, presented, attention = parentAttention(context)) {
  const run = context.run;
  const lines = [];
  lines.push("# 並列開発の親セッション");
  lines.push("");
  lines.push(`- 実行 ID: ${run.runId}`);
  lines.push(`- リポジトリ: ${run.repoPath}`);
  lines.push(`- 統合先: ${run.targetBranch}（${run.targetWorktree}）`);
  lines.push(`- 起動時点の HEAD: ${run.baseCommit}`);
  lines.push(`- 実行枠: 担当 ${run.pools.tasks} / 検証 ${run.pools.verify} / 統合 ${run.pools.integration}`);
  lines.push("");
  lines.push("## 依頼された目的");
  lines.push("");
  lines.push(run.request === "" ? "(指定なし)" : run.request);
  lines.push("");
  lines.push("## タスクの状況");
  lines.push("");
  if (context.tasks.length === 0) {
    lines.push("(タスクはまだありません。DISPATCH で担当を起こしてください。)");
  } else {
    for (const task of context.tasks) {
      const parts = [`- ${task.taskId} [${task.state}] ${task.title}`];
      if (task.detail !== null && task.detail !== undefined) parts.push(`詳細=${task.detail}`);
      if (task.submittedHead) parts.push(`提出=${String(task.submittedHead).slice(0, 12)}`);
      if (task.integration?.state) parts.push(`統合=${task.integration.state}`);
      if ((task.dependsOn ?? []).length > 0) parts.push(`依存=${task.dependsOn.join(",")}`);
      if (task.attemptCount) parts.push(`試行=${task.attemptCount}`);
      lines.push(parts.join(" "));
      if (task.message) lines.push(`  理由: ${task.message}`);
      if (task.question) lines.push(`  質問: ${task.question}`);
    }
  }
  lines.push("");
  lines.push("## 判断が必要なこと");
  lines.push("");
  if (attention.length === 0) {
    lines.push("(なし)");
  } else {
    for (const item of attention) {
      lines.push(`- ${item.taskId ?? "(全体)"}: ${item.reason}${item.question ? ` — ${item.question}` : ""}`);
    }
  }
  lines.push("");
  lines.push("## 判断の指針");
  lines.push("");
  lines.push("- タスクが無い、または依存の無い作業が残っているなら DISPATCH で担当を起こす。");
  lines.push("- 質問には ANSWER、行き詰まりには REWORK、提出の検証には CHECK_MERGE を出す。");
  lines.push("- CHECK_MERGE が VERIFIED_NOT_PUBLISHED を返したときだけ APPLY_MERGE を出す。");
  lines.push("- 全タスクが INTEGRATED になったら FINISH を出す。");
  lines.push("- 人間の判断が要るなら REQUEST_HUMAN を出して止める。");
  lines.push("");
  lines.push(protocolInstructions({ snapshotRevision: presented, taskIds: context.tasks.map((task) => task.taskId) }));
  return lines.join("\n");
}

export function parentAttention(context) {
  const items = [];
  for (const task of context.tasks) {
    if (task.state === TASK_STATE.NEEDS_PARENT) {
      items.push({ kind: "question", taskId: task.taskId, reason: "担当が質問しています", question: task.question ?? "" });
      continue;
    }
    if (task.state === TASK_STATE.SUBMITTED && task.integration?.state !== INTEGRATION_STATE.INTEGRATED) {
      // 検証前は CHECK_MERGE、検証済みで未反映なら APPLY_MERGE を親に判断してもらう。
      const reason = task.integration?.state === INTEGRATION_STATE.VERIFIED_NOT_PUBLISHED
        ? "検証済みの候補があります（APPLY_MERGE か差し戻し）"
        : "提出の検証が必要です（CHECK_MERGE）";
      items.push({ kind: "integration", taskId: task.taskId, reason });
      continue;
    }
    if (PARENT_ATTENTION_STATES.has(task.state) && Number(task.reworkCount ?? 0) < context.config.maxReworks) {
      items.push({
        kind: "stalled",
        taskId: task.taskId,
        reason: `${task.state} のまま止まっています（REWORK か REQUEST_HUMAN）`,
        question: task.message ?? "",
      });
    }
  }
  if (context.tasks.length === 0) {
    items.push({ kind: "dispatch", taskId: null, reason: "タスクがありません（DISPATCH）" });
    return items;
  }
  // 完了の宣言は親に出す。一度だけ尋ね、答えが無ければ driver が受け入れ状態で終了する。
  if (context.tasks.every((task) => task.state === TASK_STATE.INTEGRATED) && context.parent?.finishAsked !== true) {
    items.push({ kind: "finish", taskId: null, reason: "全タスクが統合済みです（FINISH で終了を宣言してください）" });
  }
  return items;
}


export async function parentTurn(context) {
  const config = context.config;
  const capabilities = requireCapabilities(config);
  const parent = (await readParent(context.layout)) ?? {
    sessionId: null,
    turns: 0,
    noOperationStreak: 0,
    lastOperationIds: [],
    createdAt: new Date().toISOString(),
  };
  const turn = Number(parent.turns ?? 0) + 1;
  // 提示する revision は「このプロンプトを作った時点」に固定する。
  // プロンプト作成後に記録するイベントは revision を進めるが、親が提案に使う値は presented である。
  const presented = context.run.snapshotRevision;
  context.presentedRevision = presented;
  const attention = parentAttention(context);
  const promptText = buildParentPrompt(context, presented, attention);
  // 完了の宣言は親に一度だけ尋ねる。次のステップで同じ問いを繰り返さない。
  if (attention.some((item) => item.kind === "finish")) parent.finishAsked = true;
  // 親セッションの cwd はリポジトリ本体なので、読める場所に置く。
  // 台帳側には同じ内容を記録として残す。
  const parentPromptDir = path.join(config.cwd, ".agent-run");
  await fs.mkdir(parentPromptDir, { recursive: true });
  await ensureReportIgnored(config.cwd);
  const promptFile = path.join(parentPromptDir, `parent-prompt-${turn}.md`);
  await fs.writeFile(promptFile, promptText, "utf8");
  const archivedPrompt = path.join(context.layout.base, `parent-prompt-${turn}.md`);
  await fs.writeFile(archivedPrompt, promptText, "utf8");

  const resume = parent.sessionId !== null;
  const sessionId = parent.sessionId ?? crypto.randomUUID();
  let args;
  try {
    args = buildArgs(capabilities, {
      promptReference: promptReference(promptFile),
      sessionId: resume ? null : sessionId,
      resumeSessionId: resume ? sessionId : null,
      allowTools: config.parentAllowTools,
      denyTools: config.parentDenyTools,
      model: config.parentModel,
      effort: config.effort,
    });
  } catch (error) {
    const detail = error instanceof CapabilityError ? TASK_DETAIL.SESSION_LOST : TASK_DETAIL.LAUNCH_FAILED;
    await stopRun(context, detail, error.message);
    return { turn, stopped: true, detail, message: error.message };
  }

  const logFile = path.join(context.layout.logs, `parent-${turn}.log`);
  await record(context, { type: "parent-session-started", turn, resume, sessionId, presentedRevision: presented, promptFile, archivedPrompt });
  const result = await runSession({
    command: config.command,
    args: [...config.commandArgs, ...args],
    cwd: config.cwd,
    logFile,
    timeoutMs: config.timeoutMinutes * 60_000,
    registry: context.registry,
    attemptId: `parent-${turn}`,
  });

  const parsed = parseOperationBlocksFromOutput(result.stdout);
  const detected = extractSessionId(result.stdout) ?? sessionId;
  const outcomes = [];
  for (const candidate of parsed.operations) {
    const validation = validateOperation(candidate, { knownTaskIds: context.tasks.map((task) => task.taskId) });
    if (!validation.ok) {
      await record(context, {
        type: "operation-rejected",
        kind: candidate?.kind ?? null,
        operationId: typeof candidate?.operationId === "string" ? candidate.operationId : null,
        detail: validation.detail,
        message: validation.message,
        body: JSON.stringify(candidate).slice(0, 400),
      });
      outcomes.push({ status: "rejected", detail: validation.detail, message: validation.message });
      continue;
    }
    const outcome = await applyOperation(context, validation.operation);
    outcomes.push({ ...outcome, kind: validation.operation.kind, operationId: validation.operation.operationId, description: describeOperation(validation.operation) });
  }
  for (const error of parsed.errors) {
    await record(context, { type: "operation-rejected", detail: TASK_DETAIL.OPERATION_INVALID, message: error.message, body: error.body });
  }

  const applied = outcomes.filter((outcome) => outcome.status === "applied").length;
  const noOperationStreak = applied > 0 ? 0 : Number(parent.noOperationStreak ?? 0) + 1;
  const saved = await writeParent(context.layout, {
    ...parent,
    sessionId: detected,
    turns: turn,
    noOperationStreak,
    lastOperationIds: outcomes.filter((outcome) => outcome.status === "applied" && outcome.operationId).map((outcome) => outcome.operationId),
    lastRevision: presented,
    lastExitCode: result.exitCode,
    lastEndedAt: result.endedAt,
  });
  context.parent = saved;
  await record(context, {
    type: "parent-session-finished",
    turn,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    operationBlocks: parsed.operations.length,
    parseErrors: parsed.errors.length,
    applied,
    rejected: outcomes.length - applied,
    source: parsed.source,
  });

  // 再開できていないのに「再開成功」にしない。
  if (resume && result.exitCode !== 0 && parsed.operations.length === 0) {
    await stopRun(context, TASK_DETAIL.SESSION_LOST, `親セッション ${sessionId} を再開できませんでした（終了コード ${result.exitCode}）。`);
    return { turn, stopped: true, detail: TASK_DETAIL.SESSION_LOST, outcomes };
  }
  if (noOperationStreak >= config.noOperationLimit) {
    await stopRun(
      context,
      TASK_DETAIL.NO_OPERATION,
      `親セッションが ${noOperationStreak} 回続けて操作を提案しませんでした。現在の状態を添えて停止します。`,
    );
    return { turn, stopped: true, detail: TASK_DETAIL.NO_OPERATION, outcomes };
  }
  return { turn, stopped: false, applied, rejected: outcomes.length - applied, parent: saved };
}

/* ------------------------------------------------------------------ ループ */
