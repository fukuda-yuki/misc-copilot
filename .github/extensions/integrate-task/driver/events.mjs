import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { TASK_DETAIL, TASK_STATE } from "./state.mjs";

export const REPORT_RELATIVE_PATH = ".agent-run/report.json";
export const REPORT_STATE = Object.freeze({
  DONE: "DONE",
  QUESTION: "QUESTION",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
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

function classifyDone(context) {
  const { report, git } = context;
  const declaredHead = typeof report.value.submittedHead === "string" ? report.value.submittedHead.trim() : "";
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
  const tests = Array.isArray(report.value.tests) ? report.value.tests : [];
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
 * 試行の結果を分類する。終了コード 0 を成功として扱わない。
 * 判断材料は報告ファイルと Git の実測だけで、出力本文は補助に留める。
 */
export function classifyAttempt(context) {
  const { attempt, report, git, outputText = "" } = context;
  const permissionHint = looksLikePermissionDenial(outputText);
  const base = {
    attemptId: attempt.attemptId,
    taskId: attempt.taskId,
    exitCode: attempt.exitCode ?? null,
    timedOut: attempt.timedOut === true,
    permissionHint,
    reportHash: report.hash ?? null,
    reportFile: report.file ?? null,
    tests: Array.isArray(report.value?.tests) ? report.value.tests : [],
    summary: typeof report.value?.summary === "string" ? report.value.summary : null,
  };

  if (attempt.timedOut === true) {
    return { ...base, state: TASK_STATE.INTERRUPTED, detail: TASK_DETAIL.TIMEOUT, message: "制限時間を超えたため停止しました。提出は未確認です。" };
  }
  if (!report.present) {
    if (attempt.exitCode === 0) {
      return {
        ...base,
        state: TASK_STATE.NEEDS_HUMAN,
        detail: TASK_DETAIL.UNCLASSIFIED_OUTPUT,
        message: "終了コードは 0 ですが、報告ファイルがありません。成功とは扱いません。",
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
    case REPORT_STATE.DONE:
      return { ...base, ...classifyDone(context) };
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
