// 親セッションからの操作提案の読み取りと検証。
// JSONL の形は実測（copilot 1.0.99-2 / --output-format=json）に合わせる。

import assert from "node:assert/strict";
import test from "node:test";

import {
  OPERATION_KIND,
  collectAllStrings,
  describeOperation,
  extractSessionId,
  parseOperationBlocks,
  parseOperationBlocksFromOutput,
  protocolInstructions,
  validateOperation,
} from "../driver/protocol.mjs";

function jsonLine(value) {
  return JSON.stringify(value);
}

function assistantLine(content) {
  return jsonLine({ type: "assistant.message", data: { content, toolRequests: [] } });
}

function toolResultLine(content) {
  return jsonLine({ type: "tool.execution_complete", data: { success: true, result: { content } } });
}

function resultLine(sessionId, exitCode = 0) {
  return jsonLine({ type: "result", sessionId, exitCode, usage: { premiumRequests: 0 } });
}

const DISPATCH_BODY = JSON.stringify({
  operationId: "op-1",
  snapshotRevision: 7,
  kind: "DISPATCH",
  payload: { taskId: "t1", title: "担当1", prompt: "作業", dependsOn: [] },
});

function fence(body) {
  return `提案します。\n\n\`\`\`agent-operation\n${body}\n\`\`\`\n`;
}

test("生テキストからはフェンスの JSON を取り出す", () => {
  const parsed = parseOperationBlocks(`前置き\n${fence(DISPATCH_BODY)}\n後書き`);
  assert.equal(parsed.operations.length, 1);
  assert.equal(parsed.operations[0].operationId, "op-1");
  assert.equal(parsed.errors.length, 0);
});

test("壊れた JSON はエラーとして記録し、提案としては捨てる", () => {
  const parsed = parseOperationBlocks(fence("{ this is not json }"));
  assert.equal(parsed.operations.length, 0);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].reason, "invalid-json");
  assert.match(parsed.errors[0].body, /this is not json/);
});

test("agent-operation 以外のフェンスは提案として読まない", () => {
  const parsed = parseOperationBlocks("```jsonc\n{ \"kind\": \"FINISH\" }\n```\n");
  assert.equal(parsed.operations.length, 0);
});

test("JSONL では assistant.message の本文から提案を読む", () => {
  const stdout = [assistantLine("調べます。"), assistantLine(fence(DISPATCH_BODY)), resultLine("11111111-1111-4111-8111-111111111111")].join("\n");
  const parsed = parseOperationBlocksFromOutput(stdout);
  assert.equal(parsed.source, "jsonl");
  assert.equal(parsed.operations.length, 1);
  assert.equal(parsed.operations[0].payload.taskId, "t1");
});

test("JSONL の tool 結果に入った例文を提案として拾わない", () => {
  // 実測した拒否・結果の形では、プロンプトの例文がそのまま tool 結果に入り得る。
  const stdout = [
    toolResultLine(`読んだ内容:\n${fence(DISPATCH_BODY)}`),
    assistantLine("提案はありません。"),
    resultLine("22222222-2222-4222-8222-222222222222"),
  ].join("\n");
  const parsed = parseOperationBlocksFromOutput(stdout);
  assert.equal(parsed.operations.length, 0);
  assert.equal(parsed.errors.length, 0);
});

test("tool 結果と本文の両方にフェンスがあれば本文だけを採る", () => {
  const other = JSON.stringify({
    operationId: "op-tool",
    snapshotRevision: 7,
    kind: "FINISH",
    payload: { summary: "tool の例" },
  });
  const stdout = [toolResultLine(fence(other)), assistantLine(fence(DISPATCH_BODY)), resultLine("33333333-3333-4333-8333-333333333333")].join("\n");
  const parsed = parseOperationBlocksFromOutput(stdout);
  assert.equal(parsed.source, "jsonl");
  assert.equal(parsed.operations.length, 1);
  assert.equal(parsed.operations[0].operationId, "op-1");
});

test("JSONL でない出力は生テキストとして読む", () => {
  const parsed = parseOperationBlocksFromOutput(fence(DISPATCH_BODY));
  assert.equal(parsed.source, "raw");
  assert.equal(parsed.operations.length, 1);
});

test("collectAllStrings は入れ子の文字列をすべて集める（検査用）", () => {
  const found = collectAllStrings(JSON.stringify({ a: { b: ["x", { c: "y" }] } }));
  assert.ok(found.includes("y"));
});

test("extractSessionId は result 行の sessionId を優先する", () => {
  const stdout = [assistantLine("作業します。"), resultLine("44444444-4444-4444-8444-444444444444")].join("\n");
  assert.equal(extractSessionId(stdout), "44444444-4444-4444-8444-444444444444");
});

test("extractSessionId は result 行が無ければ data.sessionId を使う", () => {
  const stdout = jsonLine({ type: "session.start", data: { sessionId: "55555555-5555-4555-8555-555555555555" } });
  assert.equal(extractSessionId(stdout), "55555555-5555-4555-8555-555555555555");
});

test("extractSessionId は該当が無ければ null", () => {
  assert.equal(extractSessionId("本文だけ\n"), null);
  assert.equal(extractSessionId(""), null);
});

test("validateOperation は正常な DISPATCH を通す", () => {
  const outcome = validateOperation({
    operationId: "op-1",
    snapshotRevision: 0,
    kind: "DISPATCH",
    payload: { taskId: "t1", title: "担当1", prompt: "作業" },
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.operation.payload.dependsOn, []);
  assert.equal(outcome.operation.payload.base, null);
});

test("validateOperation は未知の種別を拒否する", () => {
  const outcome = validateOperation({ operationId: "op-1", snapshotRevision: 1, kind: "DEPLOY", payload: {} });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.detail, "operation-invalid");
  assert.match(outcome.message, /未知の操作種別/);
});

test("validateOperation は ID と revision の形を検査する", () => {
  assert.equal(validateOperation({ operationId: "op 1", snapshotRevision: 1, kind: "FINISH" }).ok, false);
  assert.equal(validateOperation({ operationId: "op-1", snapshotRevision: -1, kind: "FINISH" }).ok, false);
  assert.equal(validateOperation({ operationId: "op-1", snapshotRevision: 1.5, kind: "FINISH" }).ok, false);
  assert.equal(validateOperation({ operationId: "op-1", snapshotRevision: 1, kind: "FINISH" }).ok, true);
});

test("validateOperation は必須項目の欠落を拒否する", () => {
  assert.equal(validateOperation({ operationId: "op-1", snapshotRevision: 1, kind: "DISPATCH", payload: { prompt: "作業" } }).ok, false);
  assert.equal(validateOperation({ operationId: "op-1", snapshotRevision: 1, kind: "DISPATCH", payload: { title: "担当", prompt: "   " } }).ok, false);
  assert.equal(validateOperation({ operationId: "op-1", snapshotRevision: 1, kind: "ANSWER", payload: { taskId: "t1" } }).ok, false);
  assert.equal(validateOperation({ operationId: "op-1", snapshotRevision: 1, kind: "REQUEST_HUMAN", payload: {} }).ok, false);
});

test("validateOperation は既知でない taskId を拒否する（DISPATCH は新規なので通す）", () => {
  const known = { knownTaskIds: ["t1"] };
  assert.equal(validateOperation({ operationId: "op-1", snapshotRevision: 1, kind: "CHECK_MERGE", payload: { taskId: "t9" } }, known).ok, false);
  assert.equal(validateOperation({ operationId: "op-1", snapshotRevision: 1, kind: "CHECK_MERGE", payload: { taskId: "t1" } }, known).ok, true);
  assert.equal(validateOperation({ operationId: "op-1", snapshotRevision: 1, kind: "DISPATCH", payload: { taskId: "t9", title: "x", prompt: "y" } }, known).ok, true);
});

test("validateOperation は payload の形を正規化する", () => {
  const rework = validateOperation({ operationId: "op-1", snapshotRevision: 2, kind: "REWORK", payload: { taskId: "t1", instruction: "やり直し" } });
  assert.equal(rework.ok, true);
  assert.equal(rework.operation.payload.resetWorktree, false);
  const human = validateOperation({ operationId: "op-2", snapshotRevision: 2, kind: "REQUEST_HUMAN", payload: { reason: "確認" } });
  assert.equal(human.operation.taskId, null);
  const finish = validateOperation({ operationId: "op-3", snapshotRevision: 2, kind: "FINISH" });
  assert.equal(finish.ok, true);
  assert.equal(finish.operation.payload.summary, null);
  assert.equal(finish.operation.taskId, null);
});

test("describeOperation は 1 行にまとめる", () => {
  assert.equal(describeOperation({ kind: "CHECK_MERGE", taskId: "t1", snapshotRevision: 3, operationId: "op-9" }), "CHECK_MERGE task=t1 rev=3 op=op-9");
  assert.equal(describeOperation({ kind: "FINISH", taskId: null, snapshotRevision: 0, operationId: "op-0" }), "FINISH rev=0 op=op-0");
});

test("protocolInstructions は提案として読まれるフェンスを自分で出さない", () => {
  const text = protocolInstructions({ snapshotRevision: 4, taskIds: ["t1", "t2"] });
  // 例文のフェンスを agent-operation にすると、親が例文を返しただけで提案として受理されてしまう。
  assert.equal(parseOperationBlocks(text).operations.length, 0);
  assert.match(text, /現在の snapshotRevision は 4 です。/);
  assert.match(text, /既知の taskId: t1, t2/);
  assert.match(text, /フェンスの名前を agent-operation にしてください/);
  for (const kind of Object.values(OPERATION_KIND)) assert.ok(text.includes(kind), `${kind} の説明がある`);
});

test("protocolInstructions はタスクが無いときの文面を変える", () => {
  const text = protocolInstructions({ snapshotRevision: 0, taskIds: [] });
  assert.match(text, /タスクはまだありません。/);
});
