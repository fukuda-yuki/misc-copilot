// 親セッションからの操作提案。文章中のコマンドを実行せず、JSON ブロックだけを検証して受け付ける。

import { OPERATION_ID_PATTERN } from "../core/state.mjs";
import { assertTaskId } from "./state.mjs";

export const OPERATION_KIND = Object.freeze({
  DISPATCH: "DISPATCH",
  ANSWER: "ANSWER",
  REWORK: "REWORK",
  CHECK_MERGE: "CHECK_MERGE",
  APPLY_MERGE: "APPLY_MERGE",
  REQUEST_HUMAN: "REQUEST_HUMAN",
  FINISH: "FINISH",
});

export const OPERATION_BLOCK_INFO = "agent-operation";

const BLOCK_PATTERN = /```agent-operation[^\n]*\r?\n([\s\S]*?)```/g;

/** 親の返答から agent-operation ブロックをすべて取り出す。壊れた JSON も記録して返す。 */
export function parseOperationBlocks(text) {
  const source = typeof text === "string" ? text : "";
  const operations = [];
  const errors = [];
  BLOCK_PATTERN.lastIndex = 0;
  for (;;) {
    const match = BLOCK_PATTERN.exec(source);
    if (match === null) break;
    const body = match[1].trim();
    try {
      operations.push(JSON.parse(body));
    } catch (error) {
      errors.push({ reason: "invalid-json", message: error.message, body: body.slice(0, 400) });
    }
  }
  return { operations, errors };
}

function requireString(value, label, options = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} は空でない文字列で指定してください。`);
  }
  const max = options.max ?? 20000;
  if (value.length > max) throw new Error(`${label} が長すぎます（上限 ${max} 文字）。`);
  return value;
}

function optionalString(value, label, max = 20000) {
  if (value === undefined || value === null) return null;
  return requireString(value, label, { max });
}

export function validateOperation(value, options = {}) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("操作は 1 つの JSON オブジェクトで指定してください。");
    }
    const { operationId, snapshotRevision, kind, payload } = value;
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
      throw new Error("operationId は英数字で始まる 1〜100 文字の [A-Za-z0-9._-] で指定してください。");
    }
    if (!Number.isInteger(snapshotRevision) || snapshotRevision < 0) {
      throw new Error("snapshotRevision は 0 以上の整数で指定してください。");
    }
    if (typeof kind !== "string" || OPERATION_KIND[kind] === undefined) {
      throw new Error(`未知の操作種別です: ${String(kind)}`);
    }
    if (payload !== undefined && payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
      throw new Error("payload はオブジェクトで指定してください。");
    }
    const body = payload ?? {};
    const normalized = { operationId, snapshotRevision, kind, taskId: null, payload: {} };

    switch (kind) {
      case OPERATION_KIND.DISPATCH: {
        normalized.taskId = body.taskId === undefined ? null : assertTaskId(body.taskId);
        normalized.payload = {
          title: requireString(body.title, "payload.title", { max: 200 }),
          prompt: requireString(body.prompt, "payload.prompt"),
          dependsOn: Array.isArray(body.dependsOn) ? body.dependsOn.map((item) => assertTaskId(item)) : [],
          base: optionalString(body.base, "payload.base", 200),
        };
        break;
      }
      case OPERATION_KIND.ANSWER: {
        normalized.taskId = assertTaskId(body.taskId);
        normalized.payload = { answer: requireString(body.answer, "payload.answer") };
        break;
      }
      case OPERATION_KIND.REWORK: {
        normalized.taskId = assertTaskId(body.taskId);
        normalized.payload = {
          instruction: requireString(body.instruction, "payload.instruction"),
          resetWorktree: body.resetWorktree === true,
        };
        break;
      }
      case OPERATION_KIND.CHECK_MERGE:
      case OPERATION_KIND.APPLY_MERGE: {
        normalized.taskId = assertTaskId(body.taskId);
        normalized.payload = { note: optionalString(body.note, "payload.note", 2000) };
        break;
      }
      case OPERATION_KIND.REQUEST_HUMAN: {
        normalized.taskId = body.taskId === undefined ? null : assertTaskId(body.taskId);
        normalized.payload = { reason: requireString(body.reason, "payload.reason") };
        break;
      }
      case OPERATION_KIND.FINISH: {
        normalized.payload = { summary: optionalString(body.summary, "payload.summary") };
        break;
      }
      default: {
        throw new Error(`未対応の操作種別です: ${kind}`);
      }
    }

    if (Array.isArray(options.knownTaskIds) && normalized.taskId !== null && !options.knownTaskIds.includes(normalized.taskId) && kind !== OPERATION_KIND.DISPATCH) {
      throw new Error(`未知の taskId です: ${normalized.taskId}`);
    }
    return { ok: true, operation: normalized };
  } catch (error) {
    return { ok: false, detail: "operation-invalid", message: error.message };
  }
}

export function describeOperation(operation) {
  const task = operation.taskId === null ? "" : ` task=${operation.taskId}`;
  return `${operation.kind}${task} rev=${operation.snapshotRevision} op=${operation.operationId}`;
}

function collectStrings(value, out, depth) {
  if (depth > 6 || out.length > 400) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  }
}

/** 検査用: JSONL の各行から、モデル本文以外の文字列をすべて集める。 */
export function collectAllStrings(raw) {
  const strings = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) continue;
    try {
      collectStrings(JSON.parse(trimmed), strings, 0);
    } catch {
      // JSON 行でない行は無視する。
    }
  }
  return strings;
}

/**
 * 子プロセスの出力から操作提案を探す。
 * `--output-format=json` は JSONL なので、まず「モデル自身の返答本文」
 * （assistant.message の content）だけを対象にする。tool 引数や tool 結果には
 * プロンプトの例文がそのまま入るため、そこから提案を拾ってはいけない。
 * 生テキスト（--output-format=text）の場合は行単位でフェンスを探す。
 */
export function parseOperationBlocksFromOutput(stdout) {
  const raw = String(stdout ?? "");
  const fromJsonl = parseOperationBlocksFromMessages(raw);
  if (fromJsonl !== null && fromJsonl.operations.length > 0) {
    return { ...fromJsonl, source: "jsonl" };
  }
  const direct = parseOperationBlocks(raw);
  if (direct.operations.length > 0) {
    return { ...direct, source: "raw", errors: [...(fromJsonl?.errors ?? []), ...direct.errors] };
  }
  if (fromJsonl !== null) {
    return { ...fromJsonl, source: "jsonl", errors: [...fromJsonl.errors, ...direct.errors] };
  }
  return { ...direct, source: "raw" };
}

/** JSONL の assistant メッセージ本文だけを連結する。JSONL でなければ null。 */
function parseOperationBlocksFromMessages(raw) {
  const contents = [];
  let sawJsonLine = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    sawJsonLine = true;
    const type = typeof parsed?.type === "string" ? parsed.type : "";
    if (type === "assistant.message" && typeof parsed?.data?.content === "string") {
      contents.push(parsed.data.content);
    }
  }
  if (!sawJsonLine || contents.length === 0) return null;
  return parseOperationBlocks(contents.join("\n"));
}

export function extractSessionId(stdout) {
  const raw = String(stdout ?? "");
  let fallback = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const candidates = [
      parsed?.sessionId,
      parsed?.session_id,
      parsed?.sessionID,
      parsed?.data?.sessionId,
      parsed?.data?.session_id,
    ];
    for (const value of candidates) {
      if (typeof value !== "string" || value.trim() === "") continue;
      // 最終行の result イベントが最も確実なので、それを優先して返す。
      if (parsed?.type === "result") return value.trim();
      fallback ??= value.trim();
    }
  }
  return fallback;
}

/**
 * 親セッションへ渡す操作プロトコルの説明。プロンプトに毎回入れる。
 */
export function protocolInstructions(options = {}) {
  const { snapshotRevision = 0, taskIds = [], integrationCommand = "node .github/extensions/integrate-task/integrate/cli.mjs" } = options;
  return [
    "## driver への操作提案",
    "",
    `現在の snapshotRevision は ${snapshotRevision} です。`,
    taskIds.length === 0 ? "タスクはまだありません。" : `既知の taskId: ${taskIds.join(", ")}`,
    "",
    "返答の最後に、次の形の JSON ブロックを 1 つだけ置いてください。",
    "複数の操作が必要なら、その回数だけブロックを並べてください。",
    "",
    "```jsonc",
    "{",
    '  "operationId": "<この提案だけの一意な ID>",',
    '  "snapshotRevision": <上の値>',
    '  "kind": "<kind>",',
    '  "payload": { }',
    "}",
    "```",
    "",
    "実際に提案するときは、フェンスの名前を agent-operation にしてください。",
    "driver は agent-operation 以外のフェンスを提案として読みません。",
    "",
    "kind は次のいずれかです。",
    "- DISPATCH: 新しい担当を起動する。payload.title, payload.prompt が必須。payload.dependsOn に先行 taskId を並べる。",
    "- ANSWER: 質問待ちの担当へ回答して再開する。payload.taskId, payload.answer が必須。",
    "- REWORK: 提出を差し戻して作り直させる。payload.taskId, payload.instruction が必須。",
    "- CHECK_MERGE: 提出を検証する（統合候補の作成と検証まで）。payload.taskId が必須。",
    "- APPLY_MERGE: 検証済みの候補を元ブランチへ反映する。payload.taskId が必須。",
    "- REQUEST_HUMAN: 人間の判断を求めて driver を止める。payload.reason が必須。",
    "- FINISH: 実行を終了する。payload.summary は任意。",
    "",
    "注意: driver は文章中のコマンドを実行しません。JSON として妥当で、",
    `snapshotRevision が現在の値と一致し、taskId が既知のものだけを受け付けます。`,
    "古い revision の提案は拒否され、driver は現在の状態を再提示します。",
    "統合の実体は driver が実行します。あなたが git merge や git push を実行しないでください。",
    `統合の状態確認は ${integrationCommand} list / show で行えます。`,
  ].join("\n");
}
