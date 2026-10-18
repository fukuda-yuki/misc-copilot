import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { TASK_DETAIL, TASK_STATE } from "./state.mjs";

export const AGENT_RUN_DIR = ".agent-run";
export const REPORT_RELATIVE_PATH = `${AGENT_RUN_DIR}/report.json`;
export const REPORT_STATE = Object.freeze({
  DONE: "DONE",
  QUESTION: "QUESTION",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
});

// 担当（責任者）が回すワークフロー名。実装・検証・レビュー・提出コミットは
// このワークフローが行い、driver はその結果ファイルだけを読む。
export const TASK_WORKFLOW_NAME = "task-pipeline";
export const WORKFLOW_STATE = Object.freeze({
  SUBMITTED: "SUBMITTED",
  NEEDS_PARENT: "NEEDS_PARENT",
});

// 出力本文からの推測。状態判定の根拠には使わず、理由の補助にだけ使う。
// 実測（copilot 1.0.99-2 / --output-format=json）で拒否は次の形で出る:
//   {"type":"tool.execution_complete","data":{"success":false,
//    "error":{"message":"Permission to run this tool was denied due to the following rules: `shell(node:*)`","code":"denied"},
//    "toolTelemetry":{"properties":{"shell_error_category":"permission_denied"}}}}
const PERMISSION_PATTERNS = [
  /permission denied/i,
  /not permitted/i,
  /denied by policy/i,
  /approval (?:is )?required/i,
  /requires approval/i,
  /tool .* (?:denied|blocked)/i,
  /permission to run this tool was denied/i,
  /"code"\s*:\s*"denied"/i,
  /permission_denied/,
  /許可されていません/,
  /権限がありません/,
];

export function looksLikePermissionDenial(text) {
  const source = String(text ?? "");
  return PERMISSION_PATTERNS.some((pattern) => pattern.test(source));
}

export function reportPath(worktreePath) {
  return path.join(worktreePath, REPORT_RELATIVE_PATH);
}

/** 担当（責任者）へ渡す task-pipeline の引数ファイル。driver が書く。 */
export function workflowArgsPath(worktreePath, attemptId) {
  return path.join(worktreePath, AGENT_RUN_DIR, `${attemptId}.task.json`);
}

/** task-pipeline が書く結果ファイル。driver はこれを読んで提出を判定する。 */
export function workflowResultPath(worktreePath, attemptId) {
  return path.join(worktreePath, AGENT_RUN_DIR, `${attemptId}.task-result.json`);
}

/**
 * 結果ファイルを読む。無ければ present=false、壊れていれば parseError を返す。
 * 存在しないことと壊れていることを区別する（未実施を成功扱いしない）。
 */
export async function readWorkflowResult(worktreePath, attemptId) {
  const file = workflowResultPath(worktreePath, attemptId);
  let rawText = null;
  try {
    rawText = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { present: false, file, value: null, rawText: null, parseError: null };
    throw error;
  }
  try {
    return { present: true, file, value: JSON.parse(rawText), rawText, parseError: null };
  } catch (error) {
    return { present: true, file, value: null, rawText, parseError: error.message };
  }
}

/** 結果ファイルの verify.results を、報告の tests と同じ形へ寄せる。 */
export function workflowTests(value) {
  const results = value?.verify?.results;
  if (!Array.isArray(results)) return [];
  return results.map((entry) => {
    const parts = [entry?.command, ...(Array.isArray(entry?.args) ? entry.args : [])].filter((part) => typeof part === "string" && part !== "");
    return {
      command: parts.length > 0 ? parts.join(" ") : String(entry?.name ?? "unknown"),
      exitCode: Number.isInteger(entry?.code) ? entry.code : null,
      name: typeof entry?.name === "string" ? entry.name : null,
    };
  });
}

export async function readReport(worktreePath) {
  const file = reportPath(worktreePath);
  let rawText = null;
  try {
    rawText = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { present: false, file, value: null, rawText: null, hash: null };
    throw error;
  }
  const hash = crypto.createHash("sha256").update(rawText, "utf8").digest("hex");
  try {
    return { present: true, file, value: JSON.parse(rawText), rawText, hash };
  } catch (error) {
    return { present: true, file, value: null, rawText, hash, parseError: error.message };
  }
}

/**
 * 提出の申告（submittedHead）と Git の実測を突き合わせる。
 * 申告は報告ファイルからでも結果ファイルからでもよい。
 */
function classifySubmission(context, declaredHead, tests) {
  const { git } = context;
  if (declaredHead === "") {
    return { state: TASK_STATE.NEEDS_HUMAN, detail: TASK_DETAIL.SUBMITTED_HEAD_MISSING, message: "報告に submittedHead がありません。" };
  }
  if (git.head === null) {
    return { state: TASK_STATE.NEEDS_HUMAN, detail: TASK_DETAIL.WORKTREE_MISSING, message: "作業ツリーが見つかりません。" };
  }
  if (declaredHead !== git.head) {
    return {
      state: TASK_STATE.NEEDS_HUMAN,
      detail: TASK_DETAIL.SUBMITTED_HEAD_MISMATCH,
      message: `報告の submittedHead (${declaredHead}) と作業ツリーの HEAD (${git.head}) が一致しません。`,
    };
  }
  if (git.clean === false) {
    return { state: TASK_STATE.NEEDS_HUMAN, detail: TASK_DETAIL.WORKTREE_DIRTY, message: "追跡ファイルに未コミットの変更が残っています。" };
  }
  if (git.head === git.baseCommit) {
    return { state: TASK_STATE.NEEDS_HUMAN, detail: TASK_DETAIL.NO_NEW_COMMITS, message: "ベースから新しいコミットがありません。" };
  }
  const failed = tests.filter((entry) => Number(entry?.exitCode ?? 0) !== 0);
  if (failed.length > 0) {
    return {
      state: TASK_STATE.BLOCKED,
      detail: TASK_DETAIL.TASK_FAILED,
      message: `報告に失敗したテストがあります: ${failed.map((entry) => String(entry.command ?? "unknown")).join(", ")}`,
    };
  }
  return {
    state: TASK_STATE.SUBMITTED,
    detail: null,
    message: "提出を受け取りました。統合の検証は未実施です。",
    submittedHead: declaredHead,
  };
}

/**
 * 結果ファイル（task-pipeline）からの分類。無ければ null。
 * 実装・検証・レビューはワークフローが済ませているので、driver は
 * 申告された提出コミットを Git の実測と突き合わせるだけでよい。
 */
function classifyFromWorkflow(context, workflow) {
  if (!workflow.present) return null;
  if (workflow.value === null) {
    return {
      state: TASK_STATE.NEEDS_HUMAN,
      detail: TASK_DETAIL.REPORT_INVALID,
      message: `結果ファイルを JSON として読めません: ${workflow.parseError ?? "unknown"}`,
    };
  }
  const state = workflow.value.state;
  if (state === WORKFLOW_STATE.SUBMITTED) {
    const declaredHead = typeof workflow.value.submittedHead === "string" ? workflow.value.submittedHead.trim() : "";
    const declared = context.report.value;
    const reportHead = typeof declared?.submittedHead === "string" ? declared.submittedHead.trim() : "";
    if (declared?.state === REPORT_STATE.DONE && reportHead !== "" && reportHead !== declaredHead) {
      return {
        state: TASK_STATE.NEEDS_HUMAN,
        detail: TASK_DETAIL.SUBMITTED_HEAD_MISMATCH,
        message: `報告の submittedHead (${reportHead}) と結果ファイルの submittedHead (${declaredHead}) が一致しません。`,
      };
    }
    return classifySubmission(context, declaredHead, workflowTests(workflow.value));
  }
  if (state === WORKFLOW_STATE.NEEDS_PARENT) {
    const detail = typeof workflow.value.detail === "string" ? workflow.value.detail : "unknown";
    const message = typeof workflow.value.message === "string" ? workflow.value.message.trim() : "";
    return {
      state: TASK_STATE.NEEDS_PARENT,
      detail: TASK_DETAIL.QUESTION,
      message: "task-pipeline が親の判断を求めています。",
      question: [`task-pipeline が親の判断を求めています（${detail}）。`, message].filter((line) => line !== "").join("\n"),
    };
  }
  return {
    state: TASK_STATE.NEEDS_HUMAN,
    detail: TASK_DETAIL.REPORT_INVALID,
    message: `結果ファイルの state が不正です: ${String(state)}`,
  };
}

/**
 * 試行の結果を分類する。終了コード 0 を成功として扱わない。
 * 判断材料は結果ファイル・報告ファイルと Git の実測だけで、出力本文は補助に留める。
 * 責任者が回した task-pipeline の結果ファイルがあれば、そちらを優先する。
 */
export function classifyAttempt(context) {
  const { attempt, report, git, outputText = "", workflow = null } = context;
  const permissionHint = looksLikePermissionDenial(outputText);
  const workflowValue = workflow?.value ?? null;
  const reportTests = Array.isArray(report.value?.tests) ? report.value.tests : [];
  const base = {
    attemptId: attempt.attemptId,
    taskId: attempt.taskId,
    exitCode: attempt.exitCode ?? null,
    timedOut: attempt.timedOut === true,
    permissionHint,
    reportHash: report.hash ?? null,
    reportFile: report.file ?? null,
    workflowFile: workflow?.file ?? null,
    workflowState: typeof workflowValue?.state === "string" ? workflowValue.state : null,
    workflowDetail: typeof workflowValue?.detail === "string" ? workflowValue.detail : null,
    workflowRunId: typeof workflowValue?.runId === "string" ? workflowValue.runId : null,
    workflowEvidenceRef: typeof workflowValue?.evidenceRef === "string" ? workflowValue.evidenceRef : null,
    workflowVerify: workflowValue?.verify ?? null,
    workflowReview: workflowValue?.review ?? null,
    tests: workflowValue === null ? reportTests : workflowTests(workflowValue),
    summary: typeof report.value?.summary === "string" ? report.value.summary : null,
  };

  if (attempt.timedOut === true) {
    return { ...base, state: TASK_STATE.INTERRUPTED, detail: TASK_DETAIL.TIMEOUT, message: "制限時間を超えたため停止しました。提出は未確認です。" };
  }
  const fromWorkflow = workflow === null ? null : classifyFromWorkflow(context, workflow);
  if (fromWorkflow !== null) return { ...base, ...fromWorkflow };
  if (!report.present) {
    if (attempt.exitCode === 0) {
      return {
        ...base,
        state: TASK_STATE.NEEDS_HUMAN,
        detail: TASK_DETAIL.UNCLASSIFIED_OUTPUT,
        message: "終了コードは 0 ですが、報告ファイルと結果ファイルがありません。成功とは扱いません。",
      };
    }
    return {
      ...base,
      state: TASK_STATE.BLOCKED,
      detail: permissionHint ? TASK_DETAIL.PERMISSION_DENIED : TASK_DETAIL.EXIT_NONZERO,
      message: `担当プロセスが終了コード ${attempt.exitCode} で終わり、報告ファイルもありません。`,
    };
  }
  if (report.value === null) {
    return { ...base, state: TASK_STATE.NEEDS_HUMAN, detail: TASK_DETAIL.REPORT_INVALID, message: `報告ファイルを JSON として読めません: ${report.parseError ?? "unknown"}` };
  }
  const declared = report.value;
  if (declared.taskId !== undefined && declared.taskId !== attempt.taskId) {
    return { ...base, state: TASK_STATE.NEEDS_HUMAN, detail: TASK_DETAIL.REPORT_INVALID, message: `報告の taskId (${declared.taskId}) が担当と一致しません。` };
  }

  switch (declared.state) {
    case REPORT_STATE.DONE: {
      const declaredHead = typeof declared.submittedHead === "string" ? declared.submittedHead.trim() : "";
      return { ...base, ...classifySubmission(context, declaredHead, reportTests) };
    }
    case REPORT_STATE.QUESTION: {
      const question = typeof declared.question === "string" ? declared.question.trim() : "";
      if (question === "") {
        return { ...base, state: TASK_STATE.NEEDS_HUMAN, detail: TASK_DETAIL.REPORT_INVALID, message: "質問の本文が空です。" };
      }
      return { ...base, state: TASK_STATE.NEEDS_PARENT, detail: TASK_DETAIL.QUESTION, message: "担当が判断を求めています。", question };
    }
    case REPORT_STATE.BLOCKED: {
      const reason = typeof declared.blockedReason === "string" ? declared.blockedReason : "";
      const denied = permissionHint || looksLikePermissionDenial(reason);
      return {
        ...base,
        state: TASK_STATE.BLOCKED,
        detail: denied ? TASK_DETAIL.PERMISSION_DENIED : TASK_DETAIL.TASK_FAILED,
        message: reason === "" ? "担当が作業を続けられないと報告しました。" : reason,
      };
    }
    case REPORT_STATE.FAILED:
      return { ...base, state: TASK_STATE.BLOCKED, detail: TASK_DETAIL.TASK_FAILED, message: "担当が失敗を報告しました。" };
    default:
      return { ...base, state: TASK_STATE.NEEDS_HUMAN, detail: TASK_DETAIL.REPORT_INVALID, message: `報告の state が不正です: ${String(declared.state)}` };
  }
}

/** 担当プロンプトに必ず入れる報告契約。 */
export function reportInstructions(options = {}) {
  const { taskId, attemptId } = options;
  return [
    "## 終了時の報告（必須）",
    "",
    "作業が終わったら、次のファイルを必ず作成してください。",
    "",
    `- パス: ${REPORT_RELATIVE_PATH}（作業ツリーの直下からの相対パス）`,
    "- 形式: JSON",
    "",
    "```json",
    "{",
    `  "taskId": "${taskId}",`,
    `  "attemptId": "${attemptId}",`,
    '  "state": "DONE",',
    '  "summary": "何をしたか",',
    '  "submittedHead": "<提出コミットの完全 SHA>",',
    '  "tests": [{ "command": "実行したコマンド", "exitCode": 0 }],',
    '  "notes": "補足"',
    "}",
    "```",
    "",
    "state の意味:",
    "- DONE: 作業を終え、コミットまで済んだ。submittedHead は必須。",
    "- QUESTION: 判断が必要。question に質問を書く。",
    "- BLOCKED: 続行できない。blockedReason に理由を書く。",
    "- FAILED: 作業が失敗した。",
    "",
    "注意:",
    "- コミットしていない変更を残したまま DONE にしないでください。",
    "- submittedHead は作業ツリーの HEAD と一致させてください。",
    "- 実行していないテストを合格として書かないでください。",
    "- 報告ファイルはコミットしないでください（未追跡のままで構いません）。",
  ].join("\n");
}
