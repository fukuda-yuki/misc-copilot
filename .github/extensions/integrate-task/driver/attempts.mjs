// 担当（試行）の起動と回収。作業ツリーの用意、プロンプト、プロセス起動、
// 終了後の分類と記録まで。

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { addWorktree, gitDirOf, isClean, resolveCommit, revParseOrNull } from "../core/git.mjs";
import { taskPipelineMeta } from "../task/engine.mjs";
import { validateTaskArgs } from "../task/state.mjs";
import { classifyAttempt, readReport, readWorkflowResult, reportInstructions, workflowArgsPath, workflowResultPath, TASK_WORKFLOW_NAME, WORKFLOW_STATE } from "./events.mjs";
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

/**
 * task-pipeline へ渡す引数を作る。検証は task-pipeline と同じ実装（task/state.mjs）で行い、
 * 不正な引数を子へ渡さない（結果ファイルが無いまま失敗するより手前で止める）。
 * `validateTaskArgs` の戻り値は未指定を null で埋めるが、task-pipeline の argsSchema は
 * null を受け付けない（実測: `commitMessage: null` を渡すと CLI が
 * `Invalid arguments for dynamic workflow "task-pipeline".` で起動前に拒否する）。
 * そのため、指定された項目だけを載せた形に組み直してから argsSchema と照合する。
 */
export function buildTaskArgs(task, config = {}, options = {}) {
  const roles = mergeRoles(task.roles, config.taskRoles);
  const hasVerify = Array.isArray(task.verify) && task.verify.length > 0;
  // 役割と検証は task-pipeline と同じ検証（task/state.mjs）に通してから載せる。
  const validated = validateTaskArgs({
    taskId: task.taskId,
    title: task.title,
    prompt: composeTaskPrompt(task, options, config),
    roles: roles ?? undefined,
    verify: hasVerify ? task.verify : undefined,
    maxReworks: config.maxReworks ?? undefined,
  });
  const value = {
    taskId: validated.taskId,
    title: validated.title,
    prompt: validated.prompt,
  };
  if (roles !== null) value.roles = validated.roles;
  if (hasVerify) value.verify = validated.verify;
  if (Number.isInteger(validated.maxReworks)) value.maxReworks = validated.maxReworks;
  if (typeof validated.commitMessage === "string") value.commitMessage = validated.commitMessage;
  const problems = checkWorkflowArgs(value, taskPipelineMeta.argsSchema);
  if (problems.length > 0) {
    throw new Error(`task-pipeline の引数が argsSchema に合いません: ${problems.join(" / ")}`);
  }
  return value;
}

/**
 * ワークフローの argsSchema のうち、task-pipeline が使う部分集合だけを見る検査。
 * CLI が起動前に拒否する条件を、子を起こす前に driver 側で見つけるために使う。
 */
export function checkWorkflowArgs(value, schema, pointer = "") {
  const at = pointer === "" ? "(root)" : pointer;
  if (schema === null || typeof schema !== "object") return [];
  const problems = [];
  const types = { object: "object", array: "array", string: "string", integer: "integer", number: "number", boolean: "boolean" };
  if (schema.type !== undefined && types[schema.type] !== undefined) {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const ok = schema.type === "integer" ? Number.isInteger(value) : actual === types[schema.type];
    if (!ok) {
      problems.push(`${at} は ${schema.type} である必要があります（実際は ${actual}）`);
      return problems;
    }
  }
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (value === null || typeof value !== "object" || value[key] === undefined) {
        problems.push(`${at}.${key} がありません`);
      }
    }
  }
  if (schema.properties !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (value[key] !== undefined) problems.push(...checkWorkflowArgs(value[key], child, `${at}.${key}`));
    }
  }
  if (schema.items !== undefined && Array.isArray(value)) {
    value.forEach((entry, index) => problems.push(...checkWorkflowArgs(entry, schema.items, `${at}[${index}]`)));
  }
  return problems;
}

function mergeRoles(taskRoles, configRoles) {
  const pick = (name) => {
    const fromTask = taskRoles?.[name];
    const fromConfig = configRoles?.[name];
    const merged = {};
    for (const source of [fromConfig, fromTask]) {
      if (source === null || typeof source !== "object") continue;
      for (const key of ["model", "reasoningEffort"]) {
        if (typeof source[key] === "string" && source[key].trim() !== "") merged[key] = source[key];
      }
    }
    return merged;
  };
  // 空の役割は載せない。指定が無い役割は argsSchema の properties 省略と同じ意味になる。
  const roles = {};
  for (const name of ["implementer", "reviewer"]) {
    const merged = pick(name);
    if (Object.keys(merged).length > 0) roles[name] = merged;
  }
  return Object.keys(roles).length > 0 ? roles : null;
}

/** 実装役へ渡す指示。差し戻しの指示や回答も同じプロンプトに混ぜて渡す。 */
function composeTaskPrompt(task, options = {}, config = {}) {
  const lines = [task.prompt];
  if (options.answer !== undefined) {
    lines.push("", "## driver からの回答", "", options.answer);
  }
  if (options.instruction !== undefined) {
    lines.push("", "## driver からの差し戻し指示", "", options.instruction);
  }
  const notes = toolNotes(config.taskAllowTools);
  if (notes.length > 0) {
    lines.push("", "## 使えるツール（driver の許可リスト）", "", ...notes);
  }
  return lines.join("\n");
}

/**
 * 許可リストを実装役向けの文面にする。実測では、許可されていないシェルでのファイル作成は
 * `denied-no-approval-rule-and-could-not-request-from-user` になり、実装役がファイルを
 * 作れないままレビューで差し戻された（許可リストに `write` があっても、実装役は
 * powershell などのシェルでの書き込みを先に試した）。許可リストに無いものは書かない。
 */
function toolNotes(allowTools) {
  if (!Array.isArray(allowTools) || allowTools.length === 0) return [];
  const notes = [];
  if (allowTools.includes("write")) {
    notes.push("- ファイルの作成・変更は write ツール（apply_patch）で行ってください。");
  }
  const shells = [];
  for (const rule of allowTools) {
    if (typeof rule !== "string") continue;
    const matched = /^shell\(([^:)]+)/.exec(rule);
    if (matched !== null) shells.push(matched[1]);
  }
  if (shells.length === 0) {
    notes.push("- この実行ではシェルを実行できません。");
    return notes;
  }
  const denied = ["powershell", "cmd", "python", "bash", "sh"].filter((name) => !shells.includes(name));
  const tail = denied.length > 0 ? `。それ以外（${denied.join(" / ")} など）は拒否されます` : "";
  notes.push(`- シェルで実行できるのは ${shells.join(" / ")} です${tail}。`);
  return notes;
}

/** 引数ファイルを書く。`.agent-run/` は exclude 済みなので提出コミットに入らない。 */
export async function writeTaskArgsFile(worktree, attemptId, args) {
  const file = workflowArgsPath(worktree, attemptId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(args, null, 2)}\n`, "utf8");
  return file;
}

/**
 * 担当（責任者）のプロンプト。担当は実装せず、task-pipeline を 1 回回して結果を報告する。
 * 実装・検証・レビュー・提出コミットの工程は task/ の実装をそのまま使う（複製しない）。
 */
function buildTaskPrompt(context, task, attempt, options = {}) {
  const run = context.run;
  const argsFile = workflowArgsPath(attempt.worktree, attempt.attemptId);
  const resultFile = workflowResultPath(attempt.worktree, attempt.attemptId);
  const lines = [];
  lines.push(`# 担当（責任者）: ${task.title}（taskId: ${task.taskId}）`);
  lines.push("");
  lines.push("## あなたの役割");
  lines.push("");
  lines.push("あなたはこの作業ツリーの責任者です。実装・検証・レビュー・修正・提出コミットは、");
  lines.push(`下のコマンドが回す \`${TASK_WORKFLOW_NAME}\` ワークフローが行います。`);
  lines.push("あなた自身はコードを変更せず、コミットも作りません。仕事は次の 2 つだけです。");
  lines.push("");
  lines.push("1. 下のコマンドを 1 回だけ実行する。");
  lines.push("2. その結果を報告ファイルに書く（下の「終了時の報告」）。");
  lines.push("");
  lines.push("統合（merge）・push・PR 作成はしません。driver が行います。");
  lines.push("");
  lines.push("## 作業場所");
  lines.push("");
  lines.push(`- 作業ツリー: ${attempt.worktree}（コマンドはこのディレクトリで実行する）`);
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
  lines.push("## 依頼（task-pipeline の実装役へ渡る内容）");
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
  lines.push("## 実行するコマンド");
  lines.push("");
  lines.push("```");
  lines.push(`copilot workflow run ${TASK_WORKFLOW_NAME} --args @${argsFile} --result-file ${resultFile} --silent --output-format json`);
  lines.push("```");
  lines.push("");
  lines.push(`- 引数ファイル ${argsFile} は driver が書いたものです。**書き換えないでください。**`);
  lines.push(`- 結果ファイルは ${resultFile} です。`);
  lines.push("- コマンドは 1 回だけ実行してください。失敗しても勝手に繰り返さず、結果を報告してください。");
  lines.push("");
  lines.push("## 結果の読み方");
  lines.push("");
  lines.push("コマンドが終わったら結果ファイルを読み、その `state` に従って報告してください。");
  lines.push("");
  lines.push(`- \`state\` が \`${WORKFLOW_STATE.SUBMITTED}\`: 報告を DONE にします。`);
  lines.push("  - `submittedHead` には結果ファイルの `submittedHead` をそのまま書く。");
  lines.push("  - `tests` には結果ファイルの `verify.results` から `{ \"command\": \"<command> <args>\", \"exitCode\": <code> }` を並べる。");
  lines.push("  - `notes` には `evidenceRef` と `review` の要点を書く。");
  lines.push(`- \`state\` が \`${WORKFLOW_STATE.NEEDS_PARENT}\`: 報告を QUESTION にし、\`question\` に「task-pipeline が親の判断を求めています（<detail>）: <message>」を書きます。`);
  lines.push("- 結果ファイルが無い・JSON として読めない・上記以外の state: 報告を FAILED にし、`notes` にコマンド出力の末尾を書きます。");
  lines.push("");
  lines.push("作業ツリーに未コミットの変更が残っていると、task-pipeline は NEEDS_PARENT（worktree-dirty）を返します。");
  lines.push("あなたが片付けようとせず、そのまま報告してください（片付けるかは driver が決めます）。");
  lines.push("");
  lines.push("## 守ること");
  lines.push("");
  lines.push("- あなた自身はコードを変更しない・コミットしないでください（提出コミットは task-pipeline が作ります）。");
  lines.push("- 引数ファイルを書き換えないでください。");
  lines.push("- ターゲットブランチへの merge・push・rebase・checkout・switch はしないでください。");
  lines.push("- リポジトリ本体の作業ツリーや、他の担当の作業ツリーを変更しないでください。");
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
    taskArgsFile: workflowArgsPath(worktree, attemptId),
    workflowResultFile: workflowResultPath(worktree, attemptId),
    classification: null,
  };

  let taskArgs;
  try {
    taskArgs = buildTaskArgs(task, config, options);
    await writeTaskArgsFile(worktree, attemptId, taskArgs);
  } catch (error) {
    await setTaskState(context, task, TASK_STATE.NEEDS_PARENT, TASK_DETAIL.OPERATION_INVALID, `task-pipeline へ渡す引数を作れません: ${error.message}`);
    return { started: false, detail: TASK_DETAIL.OPERATION_INVALID };
  }
  attempt.taskArgs = {
    taskId: taskArgs.taskId,
    title: taskArgs.title,
    roles: taskArgs.roles,
    verify: taskArgs.verify,
    maxReworks: taskArgs.maxReworks,
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
  const workflow = await readWorkflowResult(attempt.worktree, attempt.attemptId);
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
    workflow,
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
  await archiveReport(layout, attempt.attemptId, { attempt: saved, classification, report: report.value, workflow: workflow.value, workflowRawText: workflow.rawText ?? "" }, report.rawText ?? "");

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
    workflowState: classification.workflowState ?? null,
    workflowDetail: classification.workflowDetail ?? null,
    workflowRunId: classification.workflowRunId ?? null,
    workflowEvidenceRef: classification.workflowEvidenceRef ?? null,
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
