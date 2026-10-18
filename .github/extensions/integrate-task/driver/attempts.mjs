// 担当（試行）の起動と回収。作業ツリーの用意、プロンプト、プロセス起動、
// 終了後の分類と記録まで。

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { addWorktree, gitDirOf, isClean, resolveCommit, revParseOrNull } from "../core/git.mjs";
import { classifyAttempt, readReport, reportInstructions } from "./events.mjs";
import { record, setTaskState } from "./journal.mjs";
import { extractSessionId } from "./protocol.mjs";
import { buildArgs, promptReference, requireCapabilities, runSession, writePromptFile } from "./session.mjs";
import { ATTEMPT_STATE, TASK_DETAIL, TASK_STATE } from "./state.mjs";
import { archiveReport, readAttempt, worktreesRoot, writeAttempt } from "./store.mjs";

const ATTEMPT_TO_TASK_STATE = Object.freeze({
  [TASK_STATE.SUBMITTED]: ATTEMPT_STATE.DONE,
  [TASK_STATE.NEEDS_PARENT]: ATTEMPT_STATE.QUESTION,
  [TASK_STATE.BLOCKED]: ATTEMPT_STATE.BLOCKED,
  [TASK_STATE.INTERRUPTED]: ATTEMPT_STATE.INTERRUPTED,
  [TASK_STATE.NEEDS_HUMAN]: ATTEMPT_STATE.UNKNOWN,
});


export async function ensureReportIgnored(worktree) {
  try {
    const gitDir = await gitDirOf(worktree);
    if (gitDir === null || gitDir === "") return false;
    const file = path.join(gitDir, "info", "exclude");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const current = await fs.readFile(file, "utf8").catch(() => "");
    if (current.includes(".agent-run")) return true;
    await fs.appendFile(file, `${current.endsWith("\n") || current === "" ? "" : "\n"}.agent-run/\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function buildTaskPrompt(context, task, attempt, options = {}) {
  const run = context.run;
  const lines = [];
  lines.push(`# 担当タスク: ${task.title}（taskId: ${task.taskId}）`);
  lines.push("");
  lines.push("## 作業場所");
  lines.push("");
  lines.push(`- 作業ツリー: ${attempt.worktree}`);
  lines.push(`- ブランチ: ${attempt.branch}`);
  lines.push(`- 起点コミット: ${attempt.baseCommit}`);
  lines.push(`- 統合先: ${run.targetBranch}（あなたは統合しない。driver が行う）`);
  lines.push("");
  if ((task.dependsOn ?? []).length > 0) {
    lines.push("## 前提");
    lines.push("");
    for (const dependency of task.dependsOn) {
      const record = context.findTask(dependency);
      lines.push(`- ${dependency} は ${record?.state ?? "不明"} です（統合済みの内容が起点に入っています）。`);
    }
    lines.push("");
  }
  lines.push("## 依頼");
  lines.push("");
  lines.push(task.prompt);
  lines.push("");
  if (options.answer !== undefined) {
    lines.push("## driver からの回答");
    lines.push("");
    lines.push(options.answer);
    lines.push("");
  }
  if (options.instruction !== undefined) {
    lines.push("## driver からの差し戻し指示");
    lines.push("");
    lines.push(options.instruction);
    lines.push("");
  }
  lines.push("## 守ること");
  lines.push("");
  lines.push("- 変更は必ずこの作業ツリーの中でコミットまで済ませてください。");
  lines.push("- リポジトリ本体の作業ツリーや、他の担当の作業ツリーを変更しないでください。");
  lines.push("- ターゲットブランチへの merge・push・rebase はしないでください。");
  lines.push("- 実行していないテストを合格として報告しないでください。");
  lines.push("");
  lines.push(reportInstructions({ taskId: task.taskId, attemptId: attempt.attemptId }));
  return lines.join("\n");
}

export async function startAttempt(context, task, options = {}) {
  const config = context.config;
  const run = context.run;
  const capabilities = requireCapabilities(config);
  const kind = options.kind ?? "initial";
  const index = Number(task.attemptCount ?? 0) + 1;
  const attemptId = `${task.taskId}-a${index}`;
  const shortRun = String(run.runId).slice(0, 8);
  const reuseWorktree = options.reuseWorktree === true && typeof task.worktree === "string" && task.worktree !== "";
  const worktree = reuseWorktree ? task.worktree : path.join(worktreesRoot(run.repoPath), `${shortRun}-${task.taskId}-a${index}`);
  const branch = reuseWorktree ? task.branch : `agent-task/${shortRun}/${task.taskId}-a${index}`;
  const baseCommit = reuseWorktree
    ? task.baseCommit
    : await resolveDispatchBase(context, task, options);

  const resumeSessionId = options.resumeSessionId ?? null;
  const sessionId = resumeSessionId ?? crypto.randomUUID();
  if (resumeSessionId !== null && capabilities.resume === null) {
    await setTaskState(context, task, TASK_STATE.NEEDS_HUMAN, TASK_DETAIL.SESSION_LOST, "この copilot には --resume がありません。再開できません。");
    return { started: false, detail: TASK_DETAIL.SESSION_LOST };
  }

  if (!reuseWorktree) {
    try {
      await addWorktree(run.repoPath, worktree, { newBranch: branch, base: baseCommit });
    } catch (error) {
      await setTaskState(context, task, TASK_STATE.NEEDS_HUMAN, TASK_DETAIL.WORKTREE_MISSING, `作業ツリーを作れません: ${error.message}`);
      return { started: false, detail: TASK_DETAIL.WORKTREE_MISSING };
    }
    await ensureReportIgnored(worktree);
  }

  const attempt = {
    attemptId,
    taskId: task.taskId,
    index,
    kind,
    state: ATTEMPT_STATE.RUNNING,
    worktree,
    branch,
    baseCommit,
    sessionId,
    resumedFrom: resumeSessionId,
    driverPid: process.pid,
    pid: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    timedOut: false,
    logFile: path.join(context.layout.logs, `${attemptId}.log`),
    promptFile: null,
    classification: null,
  };

  const promptText = buildTaskPrompt(context, task, attempt, options);
  attempt.promptFile = await writePromptFile(worktree, promptText, `${attemptId}.prompt.md`);

  let args;
  try {
    args = buildArgs(capabilities, {
      promptReference: promptReference(attempt.promptFile),
      sessionId: resumeSessionId === null ? sessionId : null,
      resumeSessionId,
      allowTools: config.taskAllowTools,
      denyTools: config.taskDenyTools,
      model: config.taskModel,
      effort: config.effort,
    });
  } catch (error) {
    await writeAttempt(context.layout, attempt);
    await setTaskState(context, task, TASK_STATE.NEEDS_HUMAN, TASK_DETAIL.LAUNCH_FAILED, error.message);
    return { started: false, detail: TASK_DETAIL.LAUNCH_FAILED };
  }
  attempt.args = args;
  const spawnArgs = [...config.commandArgs, ...args];

  await writeAttempt(context.layout, attempt);
  await setTaskState(context, task, TASK_STATE.RUNNING, null, `試行 ${index} を起動しました。`, {
    attemptCount: index,
    currentAttemptId: attemptId,
    worktree,
    branch,
    baseCommit,
    sessionId,
    question: null,
  });

  const entry = { attemptId, taskId: task.taskId, attempt, settled: null, startedAt: attempt.startedAt };
  const promise = runSession({
    command: config.command,
    args: spawnArgs,
    cwd: worktree,
    logFile: attempt.logFile,
    timeoutMs: config.timeoutMinutes * 60_000,
    registry: context.registry,
    attemptId,
    onSpawn: async (spawned) => {
      entry.attempt.pid = spawned.pid;
      const saved = await writeAttempt(context.layout, { ...attempt, pid: spawned.pid });
      await record(context, { type: "attempt-spawned", attemptId, taskId: task.taskId, pid: spawned.pid, startedAt: saved.startedAt });
    },
  }).then(
    (result) => {
      entry.settled = { ok: true, result };
    },
    (error) => {
      entry.settled = { ok: false, error };
    },
  );
  entry.promise = promise;
  context.live.set(attemptId, entry);

  await record(context, {
    type: "attempt-started",
    attemptId,
    taskId: task.taskId,
    kind,
    worktree,
    branch,
    baseCommit,
    sessionId,
    resumedFrom: resumeSessionId,
    pid: null,
  });
  return { started: true, attemptId, worktree, branch, baseCommit, sessionId };
}

async function resolveDispatchBase(context, task, options) {
  if (typeof task.base === "string" && task.base !== "") {
    const pinned = await resolveCommit(context.run.repoPath, task.base);
    if (pinned === null) throw new Error(`task.base ${task.base} をコミットとして解決できません。`);
    return pinned;
  }
  if (typeof options.baseCommit === "string" && options.baseCommit !== "") return options.baseCommit;
  const head = await revParseOrNull(context.run.targetWorktree, "HEAD");
  if (head !== null) return head;
  const fallback = await revParseOrNull(context.run.repoPath, context.run.targetRef);
  if (fallback !== null) return fallback;
  return context.run.baseCommit;
}


export async function reap(context) {
  const finished = [];
  for (const [attemptId, entry] of [...context.live.entries()]) {
    if (entry.settled === null) continue;
    context.live.delete(attemptId);
    finished.push(await collectAttempt(context, entry));
  }
  return finished;
}

async function collectAttempt(context, entry) {
  const layout = context.layout;
  const task = context.findTask(entry.taskId);
  const attempt = (await readAttempt(layout, entry.attemptId)) ?? entry.attempt;

  if (!entry.settled.ok) {
    const message = entry.settled.error?.message ?? "起動できませんでした。";
    await writeAttempt(layout, { ...attempt, state: ATTEMPT_STATE.UNKNOWN, endedAt: new Date().toISOString(), error: message });
    if (task !== null) await setTaskState(context, task, TASK_STATE.NEEDS_HUMAN, TASK_DETAIL.LAUNCH_FAILED, message);
    await record(context, { type: "attempt-finished", attemptId: attempt.attemptId, taskId: attempt.taskId, state: TASK_STATE.NEEDS_HUMAN, detail: TASK_DETAIL.LAUNCH_FAILED, message });
    return { attemptId: attempt.attemptId, taskId: attempt.taskId, state: TASK_STATE.NEEDS_HUMAN, detail: TASK_DETAIL.LAUNCH_FAILED };
  }

  const result = entry.settled.result;
  const report = await readReport(attempt.worktree);
  const head = await revParseOrNull(attempt.worktree, "HEAD");
  let clean = null;
  try {
    clean = await isClean(attempt.worktree);
  } catch {
    clean = null;
  }
  const classification = classifyAttempt({
    attempt: { ...attempt, exitCode: result.exitCode, timedOut: result.timedOut },
    report,
    git: { head, clean, baseCommit: attempt.baseCommit },
    outputText: `${result.stdout}\n${result.stderr}`,
  });

  const sessionId = extractSessionId(result.stdout) ?? attempt.sessionId;
  const saved = await writeAttempt(layout, {
    ...attempt,
    state: ATTEMPT_TO_TASK_STATE[classification.state] ?? ATTEMPT_STATE.UNKNOWN,
    pid: result.pid,
    endedAt: result.endedAt,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    sessionId,
    classification,
    stdoutBytes: result.stdout.length,
    stderrBytes: result.stderr.length,
  });
  await archiveReport(layout, attempt.attemptId, { attempt: saved, classification, report: report.value }, report.rawText ?? "");

  await record(context, {
    type: "attempt-finished",
    attemptId: attempt.attemptId,
    taskId: attempt.taskId,
    state: classification.state,
    detail: classification.detail,
    message: classification.message,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    permissionHint: classification.permissionHint,
    reportHash: classification.reportHash,
    submittedHead: classification.submittedHead ?? null,
  });

  if (task !== null) {
    await setTaskState(context, task, classification.state, classification.detail, classification.message, {
      lastAttemptId: attempt.attemptId,
      sessionId,
      submittedHead: classification.submittedHead ?? task.submittedHead ?? null,
      question: classification.question ?? null,
      tests: classification.tests,
    });
  }
  return {
    attemptId: attempt.attemptId,
    taskId: attempt.taskId,
    state: classification.state,
    detail: classification.detail,
    message: classification.message,
  };
}
