// 担当の終了結果の分類。終了コード 0 を成功として扱わないことを固定する。
// 拒否の形は実測（copilot 1.0.99-2 / --output-format=json）に合わせる。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REPORT_RELATIVE_PATH,
  classifyAttempt,
  looksLikePermissionDenial,
  readReport,
  reportInstructions,
  reportPath,
} from "../driver/events.mjs";
import { TASK_DETAIL, TASK_STATE } from "../driver/state.mjs";

// 実測した拒否 JSONL（1 行）。
const DENIED_LINE =
  '{"type":"tool.execution_complete","data":{"success":false,"error":{"message":"Permission to run this tool was denied due to the following rules: `shell(node:*)`","code":"denied"},"toolTelemetry":{"properties":{"shell_error_category":"permission_denied"}}}}';

const HEAD = "1111111111111111111111111111111111111111";
const BASE = "0000000000000000000000000000000000000000";

function attempt(overrides = {}) {
  return { attemptId: "a1", taskId: "t1", exitCode: 0, timedOut: false, ...overrides };
}

function report(value, overrides = {}) {
  return { present: true, file: "report.json", value, rawText: JSON.stringify(value), hash: "deadbeef", ...overrides };
}

function git(overrides = {}) {
  return { head: HEAD, clean: true, baseCommit: BASE, ...overrides };
}

function doneReport(overrides = {}) {
  return { taskId: "t1", state: "DONE", summary: "作業しました", submittedHead: HEAD, tests: [{ command: "node --test", exitCode: 0 }], ...overrides };
}

test("looksLikePermissionDenial は実測した拒否の形を捉える", () => {
  assert.equal(looksLikePermissionDenial(DENIED_LINE), true);
  assert.equal(looksLikePermissionDenial("Permission to run this tool was denied"), true);
  assert.equal(looksLikePermissionDenial("許可されていません"), true);
  assert.equal(looksLikePermissionDenial("作業を完了しました。"), false);
  assert.equal(looksLikePermissionDenial(""), false);
  assert.equal(looksLikePermissionDenial(undefined), false);
});

test("readReport は報告が無いとき present=false を返す", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "it-report-"));
  try {
    const result = await readReport(dir);
    assert.equal(result.present, false);
    assert.equal(result.value, null);
    assert.equal(result.hash, null);
    assert.equal(result.file, reportPath(dir));
    assert.ok(result.file.endsWith(path.join(".agent-run", "report.json")));
    assert.equal(REPORT_RELATIVE_PATH, ".agent-run/report.json");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readReport は本文のハッシュを返し、壊れた JSON でも hash を残す", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "it-report-"));
  try {
    await fs.mkdir(path.join(dir, ".agent-run"), { recursive: true });
    await fs.writeFile(path.join(dir, REPORT_RELATIVE_PATH), '{ "state": "DONE" }\n', "utf8");
    const ok = await readReport(dir);
    assert.equal(ok.present, true);
    assert.equal(ok.value.state, "DONE");
    assert.match(ok.hash, /^[0-9a-f]{64}$/);

    await fs.writeFile(path.join(dir, REPORT_RELATIVE_PATH), "{ 壊れている ", "utf8");
    const broken = await readReport(dir);
    assert.equal(broken.present, true);
    assert.equal(broken.value, null);
    assert.match(broken.hash, /^[0-9a-f]{64}$/);
    assert.ok(typeof broken.parseError === "string" && broken.parseError.length > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("classifyAttempt は制限時間超過を中断として扱う", () => {
  const result = classifyAttempt({ attempt: attempt({ timedOut: true, exitCode: null }), report: report(null, { present: false }), git: git(), outputText: "" });
  assert.equal(result.state, TASK_STATE.INTERRUPTED);
  assert.equal(result.detail, TASK_DETAIL.TIMEOUT);
  assert.equal(result.timedOut, true);
});

test("classifyAttempt は終了コード 0 でも報告が無ければ成功にしない", () => {
  const result = classifyAttempt({ attempt: attempt({ exitCode: 0 }), report: report(null, { present: false }), git: git(), outputText: "完了しました" });
  assert.equal(result.state, TASK_STATE.NEEDS_HUMAN);
  assert.equal(result.detail, TASK_DETAIL.UNCLASSIFIED_OUTPUT);
  assert.equal(result.exitCode, 0);
});

test("classifyAttempt は報告なしの異常終了を拒否の有無で分ける", () => {
  const denied = classifyAttempt({ attempt: attempt({ exitCode: 3 }), report: report(null, { present: false }), git: git(), outputText: DENIED_LINE });
  assert.equal(denied.state, TASK_STATE.BLOCKED);
  assert.equal(denied.detail, TASK_DETAIL.PERMISSION_DENIED);
  assert.equal(denied.permissionHint, true);

  const plain = classifyAttempt({ attempt: attempt({ exitCode: 3 }), report: report(null, { present: false }), git: git(), outputText: "エラーで終了" });
  assert.equal(plain.detail, TASK_DETAIL.EXIT_NONZERO);
  assert.equal(plain.permissionHint, false);
});

test("classifyAttempt は読めない報告と taskId 不一致を人間の判断に回す", () => {
  const broken = classifyAttempt({ attempt: attempt(), report: report(null, { parseError: "Unexpected token" }), git: git(), outputText: "" });
  assert.equal(broken.state, TASK_STATE.NEEDS_HUMAN);
  assert.equal(broken.detail, TASK_DETAIL.REPORT_INVALID);
  assert.match(broken.message, /Unexpected token/);

  const mismatch = classifyAttempt({ attempt: attempt(), report: report(doneReport({ taskId: "t9" })), git: git(), outputText: "" });
  assert.equal(mismatch.detail, TASK_DETAIL.REPORT_INVALID);
  assert.match(mismatch.message, /t9/);
});

test("classifyAttempt は DONE でも証拠が揃わなければ提出にしない", () => {
  const missing = classifyAttempt({ attempt: attempt(), report: report(doneReport({ submittedHead: "  " })), git: git(), outputText: "" });
  assert.equal(missing.detail, TASK_DETAIL.SUBMITTED_HEAD_MISSING);

  const mismatch = classifyAttempt({ attempt: attempt(), report: report(doneReport({ submittedHead: "2222222222222222222222222222222222222222" })), git: git(), outputText: "" });
  assert.equal(mismatch.detail, TASK_DETAIL.SUBMITTED_HEAD_MISMATCH);
  assert.match(mismatch.message, /2222222222222222222222222222222222222222/);

  const missingWorktree = classifyAttempt({ attempt: attempt(), report: report(doneReport()), git: git({ head: null }), outputText: "" });
  assert.equal(missingWorktree.detail, TASK_DETAIL.WORKTREE_MISSING);

  const dirty = classifyAttempt({ attempt: attempt(), report: report(doneReport()), git: git({ clean: false }), outputText: "" });
  assert.equal(dirty.detail, TASK_DETAIL.WORKTREE_DIRTY);

  const sameHead = classifyAttempt({ attempt: attempt(), report: report(doneReport()), git: git({ baseCommit: HEAD }), outputText: "" });
  assert.equal(sameHead.detail, TASK_DETAIL.NO_NEW_COMMITS);
});

test("classifyAttempt は報告のテスト失敗を差し戻しにする", () => {
  const result = classifyAttempt({
    attempt: attempt(),
    report: report(doneReport({ tests: [{ command: "node --test", exitCode: 0 }, { command: "npm run lint", exitCode: 1 }] })),
    git: git(),
    outputText: "",
  });
  assert.equal(result.state, TASK_STATE.BLOCKED);
  assert.equal(result.detail, TASK_DETAIL.TASK_FAILED);
  assert.match(result.message, /npm run lint/);
  assert.equal(result.tests.length, 2);
});

test("classifyAttempt は証拠が揃った DONE だけを提出にする", () => {
  const result = classifyAttempt({ attempt: attempt(), report: report(doneReport()), git: git(), outputText: "" });
  assert.equal(result.state, TASK_STATE.SUBMITTED);
  assert.equal(result.detail, null);
  assert.equal(result.submittedHead, HEAD);
  assert.equal(result.reportHash, "deadbeef");
  assert.equal(result.summary, "作業しました");
  assert.equal(result.taskId, "t1");
  assert.equal(result.attemptId, "a1");
});

test("classifyAttempt は質問を親の判断に回す", () => {
  const result = classifyAttempt({
    attempt: attempt(),
    report: report({ taskId: "t1", state: "QUESTION", question: "  どちらの名前で作りますか。 " }),
    git: git(),
    outputText: "",
  });
  assert.equal(result.state, TASK_STATE.NEEDS_PARENT);
  assert.equal(result.detail, TASK_DETAIL.QUESTION);
  assert.equal(result.question, "どちらの名前で作りますか。");

  const empty = classifyAttempt({ attempt: attempt(), report: report({ taskId: "t1", state: "QUESTION", question: " " }), git: git(), outputText: "" });
  assert.equal(empty.state, TASK_STATE.NEEDS_HUMAN);
  assert.equal(empty.detail, TASK_DETAIL.REPORT_INVALID);
});

test("classifyAttempt は BLOCKED の理由から権限拒否を見分ける", () => {
  const denied = classifyAttempt({
    attempt: attempt(),
    report: report({ taskId: "t1", state: "BLOCKED", blockedReason: "ツールの実行が許可されていません。" }),
    git: git(),
    outputText: "",
  });
  assert.equal(denied.state, TASK_STATE.BLOCKED);
  assert.equal(denied.detail, TASK_DETAIL.PERMISSION_DENIED);
  assert.match(denied.message, /許可されていません/);

  const plain = classifyAttempt({
    attempt: attempt(),
    report: report({ taskId: "t1", state: "BLOCKED", blockedReason: "必要なファイルがありません。" }),
    git: git(),
    outputText: "",
  });
  assert.equal(plain.detail, TASK_DETAIL.TASK_FAILED);

  const noReason = classifyAttempt({ attempt: attempt(), report: report({ taskId: "t1", state: "BLOCKED" }), git: git(), outputText: "" });
  assert.equal(noReason.detail, TASK_DETAIL.TASK_FAILED);
  assert.match(noReason.message, /続けられない/);
});

test("classifyAttempt は FAILED と未知の state を分ける", () => {
  const failed = classifyAttempt({ attempt: attempt(), report: report({ taskId: "t1", state: "FAILED" }), git: git(), outputText: "" });
  assert.equal(failed.state, TASK_STATE.BLOCKED);
  assert.equal(failed.detail, TASK_DETAIL.TASK_FAILED);

  const unknown = classifyAttempt({ attempt: attempt(), report: report({ taskId: "t1", state: "MAYBE" }), git: git(), outputText: "" });
  assert.equal(unknown.state, TASK_STATE.NEEDS_HUMAN);
  assert.equal(unknown.detail, TASK_DETAIL.REPORT_INVALID);
  assert.match(unknown.message, /MAYBE/);
});

test("reportInstructions は提出ヘッドの一致と未実施テストの扱いを明示する", () => {
  const text = reportInstructions({ taskId: "t1", attemptId: "a1" });
  assert.match(text, /\.agent-run\/report\.json/);
  assert.match(text, /"taskId": "t1"/);
  assert.match(text, /"attemptId": "a1"/);
  assert.match(text, /submittedHead は作業ツリーの HEAD と一致させてください。/);
  assert.match(text, /実行していないテストを合格として書かないでください。/);
  assert.match(text, /報告ファイルはコミットしないでください/);
});
