// driver のテスト用に `copilot` を差し替えるスクリプト。
// 実測した copilot 1.0.99-2 の `--output-format=json`（JSONL）の形をまねる。
// 実際の LLM は呼ばない。指示はプロンプト本文の [[mode=...]] / [[parent=...]] から読む。
//
// 実測した出力の形（2026-10-18 / copilot 1.0.99-2）:
//   {"type":"assistant.message","data":{"content":"...","toolRequests":[]}}
//   {"type":"tool.execution_complete","data":{"success":false,"error":{"message":"...","code":"denied"},...}}
//   {"type":"result","sessionId":"<uuid>","exitCode":0,"usage":{...}}

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

// driver の能力検出（doctor）にも使えるよう、--help / --version だけは本物に合わせて返す。
const FAKE_HELP = [
  "GitHub Copilot CLI",
  "",
  "Options:",
  "  -p, --prompt <text>",
  "  -r, --resume [<value>]",
  "      --session-id <id>",
  "      --output-format <format>",
  "      --no-ask-user",
  "      --allow-tool [<tools>...]",
  "      --deny-tool [<tools>...]",
  "      --model <model>",
  "      --allow-all",
].join("\n");

if (argv.includes("--help")) {
  process.stdout.write(`${FAKE_HELP}\n`);
  process.exit(0);
}
if (argv.includes("--version")) {
  process.stdout.write("GitHub Copilot CLI 1.0.99-2 (fake)\n");
  process.exit(0);
}

function flagValue(names) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    for (const name of names) {
      if (token === name) return argv[index + 1] ?? null;
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
  }
  return null;
}

const PROMPT_PREFIX = "次のファイルを読み、その指示に従ってください: ";
const promptArg = flagValue(["-p", "--prompt"]);
const promptFile = promptArg === null ? null : (promptArg.startsWith(PROMPT_PREFIX) ? promptArg.slice(PROMPT_PREFIX.length) : promptArg).trim();
const promptText = promptFile === null || !fs.existsSync(promptFile) ? "" : fs.readFileSync(promptFile, "utf8");

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitMessage(content) {
  emitJson({ type: "assistant.message", data: { content, toolRequests: [] }, timestamp: new Date().toISOString() });
}

function emitDenial(rule) {
  emitJson({
    type: "tool.execution_complete",
    data: {
      success: false,
      error: { message: `Permission to run this tool was denied due to the following rules: \`${rule}\``, code: "denied" },
      toolTelemetry: { properties: { shell_error_category: "permission_denied" } },
    },
  });
}

function markerValues(text, name) {
  return [...text.matchAll(new RegExp(`\\[\\[${name}=([^\\]]*)\\]\\]`, "g"))].map((match) => match[1]);
}

/** 担当は最後の指定に従う（回答や差し戻しの指示が後ろに来るため）。 */
function marker(text, name) {
  const values = markerValues(text, name);
  return values.length === 0 ? null : values[values.length - 1];
}

function promptTurn() {
  const match = /parent-prompt-(\d+)\.md$/.exec(promptFile ?? "");
  return match === null ? 1 : Number(match[1]);
}

/** `[[parent=3:check-apply]]` は 3 ターン目だけ、`[[parent=check-apply]]` は既定。 */
function resolveParentMode() {
  const turn = promptTurn();
  let fallback = null;
  for (const value of markerValues(promptText, "parent")) {
    const parts = value.split(":");
    if (parts.length === 2 && Number(parts[0]) === turn) return parts[1];
    if (parts.length === 1) fallback = parts[0];
  }
  return fallback;
}

function taskIdOf() {
  const match = /taskId: ([A-Za-z0-9._-]+)/.exec(promptText);
  return match === null ? null : match[1];
}

function git(args) {
  return execFileSync(
    "git",
    ["-c", "user.name=Fake", "-c", "user.email=fake@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: process.cwd(), encoding: "utf8" },
  ).trim();
}

function writeReport(value) {
  const dir = path.join(process.cwd(), ".agent-run");
  fs.mkdirSync(dir, { recursive: true });
  const payload = { taskId: taskIdOf(), ...value };
  fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function finish(id) {
  emitJson({ type: "result", sessionId: id, exitCode: 0, usage: { premiumRequests: 0 } });
}

const sessionId = flagValue(["--resume", "--session-id"]) ?? "00000000-0000-4000-8000-000000000000";
const isParent = promptText.includes("# 並列開発の親セッション");
const parentMode = resolveParentMode();
const taskMode = marker(promptText, "mode");

function operationBlock(operation) {
  return `提案します。\n\n\`\`\`agent-operation\n${JSON.stringify(operation, null, 2)}\n\`\`\`\n`;
}

function presentedRevision() {
  const match = /現在の snapshotRevision は (\d+) です。/.exec(promptText);
  return match === null ? 0 : Number(match[1]);
}

function knownTaskIds() {
  const match = /既知の taskId: (.+)/.exec(promptText);
  if (match === null) return [];
  return match[1].split(",").map((item) => item.trim()).filter((item) => item !== "");
}

function taskLines() {
  const lines = new Map();
  for (const line of promptText.split(/\r?\n/)) {
    const match = /^- ([A-Za-z0-9][A-Za-z0-9._-]*) \[([A-Z_]+)\] (.*)$/.exec(line.trim());
    if (match !== null) lines.set(match[1], { state: match[2], rest: match[3] });
  }
  return lines;
}

if (isParent) {
  const revision = presentedRevision();
  const tasks = knownTaskIds();
  const lines = taskLines();
  switch (parentMode) {
    case "dispatch-done":
      emitMessage(operationBlock({
        operationId: "op-dispatch-1",
        snapshotRevision: revision,
        kind: "DISPATCH",
        payload: { taskId: "t1", title: "担当1", prompt: "ファイルを作ってください。[[mode=done]]", dependsOn: [] },
      }));
      break;
    case "dispatch-any": {
      // 担当の振る舞いは親プロンプトの [[task=...]] から読む。
      const mode = marker(promptText, "task") ?? "done";
      emitMessage(operationBlock({
        operationId: "op-dispatch-any",
        snapshotRevision: revision,
        kind: "DISPATCH",
        payload: { taskId: "t1", title: "担当1", prompt: `作業してください。[[mode=${mode}]]`, dependsOn: [] },
      }));
      break;
    }
    case "dispatch-question":
      emitMessage(operationBlock({
        operationId: "op-dispatch-q",
        snapshotRevision: revision,
        kind: "DISPATCH",
        payload: { taskId: "t1", title: "質問する担当", prompt: "判断を仰いでください。[[mode=question]]", dependsOn: [] },
      }));
      break;
    case "dispatch-two-waves":
      emitMessage(operationBlock({
        operationId: "op-dispatch-a",
        snapshotRevision: revision,
        kind: "DISPATCH",
        payload: { taskId: "t1", title: "担当1", prompt: "ファイルを作ってください。[[mode=done]]", dependsOn: [] },
      }));
      emitMessage(operationBlock({
        operationId: "op-dispatch-b",
        snapshotRevision: revision,
        kind: "DISPATCH",
        payload: { taskId: "t2", title: "担当2", prompt: "ファイルを作ってください。[[mode=done]]", dependsOn: ["t1"] },
      }));
      break;
    case "dispatch-independent":
      emitMessage(operationBlock({
        operationId: "op-dispatch-i1",
        snapshotRevision: revision,
        kind: "DISPATCH",
        payload: { taskId: "t1", title: "独立1", prompt: "ファイルを作ってください。[[mode=done]]", dependsOn: [] },
      }));
      emitMessage(operationBlock({
        operationId: "op-dispatch-i2",
        snapshotRevision: revision,
        kind: "DISPATCH",
        payload: { taskId: "t2", title: "独立2", prompt: "ファイルを作ってください。[[mode=done]]", dependsOn: [] },
      }));
      break;
    case "dispatch-blocked":
      emitMessage(operationBlock({
        operationId: "op-dispatch-blocked",
        snapshotRevision: revision,
        kind: "DISPATCH",
        payload: { taskId: "t1", title: "行き詰まる担当", prompt: "情報が足りないので止まってください。[[mode=blocked]]", dependsOn: [] },
      }));
      break;
    case "rework": {
      for (const taskId of tasks) {
        const info = lines.get(taskId);
        if (info === undefined) continue;
        if (!["BLOCKED", "INTERRUPTED", "STALE_TARGET", "NEEDS_PARENT"].includes(info.state)) continue;
        emitMessage(operationBlock({
          operationId: `op-rework-${taskId}`,
          snapshotRevision: revision,
          kind: "REWORK",
          payload: { taskId, instruction: "やり直してください。[[mode=done]]", resetWorktree: false },
        }));
      }
      break;
    }
    case "check-apply": {
      for (const taskId of tasks) {
        const info = lines.get(taskId);
        if (info === undefined) continue;
        if (info.rest.includes("統合=VERIFIED_NOT_PUBLISHED")) {
          emitMessage(operationBlock({
            operationId: `op-apply-${taskId}`,
            snapshotRevision: revision,
            kind: "APPLY_MERGE",
            payload: { taskId },
          }));
        } else if (info.state === "SUBMITTED") {
          emitMessage(operationBlock({
            operationId: `op-check-${taskId}`,
            snapshotRevision: revision,
            kind: "CHECK_MERGE",
            payload: { taskId },
          }));
        }
      }
      if (tasks.length > 0 && tasks.every((taskId) => lines.get(taskId)?.state === "INTEGRATED")) {
        emitMessage(operationBlock({
          operationId: "op-finish",
          snapshotRevision: revision,
          kind: "FINISH",
          payload: { summary: "全タスクを統合しました。" },
        }));
      }
      break;
    }
    case "check-only": {
      for (const taskId of tasks) {
        const info = lines.get(taskId);
        if (info?.state !== "SUBMITTED") continue;
        emitMessage(operationBlock({
          operationId: `op-check-${taskId}`,
          snapshotRevision: revision,
          kind: "CHECK_MERGE",
          payload: { taskId },
        }));
      }
      break;
    }
    case "answer": {
      for (const taskId of tasks) {
        const info = lines.get(taskId);
        if (info?.state !== "NEEDS_PARENT") continue;
        emitMessage(operationBlock({
          operationId: `op-answer-${taskId}`,
          snapshotRevision: revision,
          kind: "ANSWER",
          payload: { taskId, answer: "そのまま進めてください。[[mode=done]]" },
        }));
      }
      break;
    }
    case "stale":
      emitMessage(operationBlock({
        operationId: "op-stale",
        snapshotRevision: Math.max(0, revision - 1),
        kind: "DISPATCH",
        payload: { taskId: "t1", title: "古い提案", prompt: "[[mode=done]]", dependsOn: [] },
      }));
      break;
    case "duplicate":
      emitMessage(operationBlock({
        operationId: "op-dup",
        snapshotRevision: revision,
        kind: "DISPATCH",
        payload: { taskId: "t1", title: "重複提案", prompt: "[[mode=done]]", dependsOn: [] },
      }));
      emitMessage(operationBlock({
        operationId: "op-dup",
        snapshotRevision: revision,
        kind: "DISPATCH",
        payload: { taskId: "t1", title: "重複提案", prompt: "[[mode=done]]", dependsOn: [] },
      }));
      break;
    case "unknown-kind":
      emitMessage(operationBlock({ operationId: "op-unknown", snapshotRevision: revision, kind: "DEPLOY", payload: {} }));
      break;
    case "unknown-task":
      emitMessage(operationBlock({
        operationId: "op-unknown-task",
        snapshotRevision: revision,
        kind: "CHECK_MERGE",
        payload: { taskId: "no-such-task" },
      }));
      break;
    case "echo-example": {
      // ツール結果に「例」のブロックが混ざっても、提案として拾われないことを確かめる。
      emitJson({
        type: "tool.execution_complete",
        data: {
          success: true,
          result: {
            content: `例:\n\`\`\`agent-operation\n${JSON.stringify({ operationId: "op-example", snapshotRevision: revision, kind: "DISPATCH", payload: { taskId: "t9", title: "例", prompt: "例", dependsOn: [] } }, null, 2)}\n\`\`\``,
          },
        },
      });
      emitMessage("提案はありません。");
      break;
    }
    case "request-human": {
      // 名指しできるタスクがあるなら名指しする。無い場合は run 全体の停止になる。
      const [taskId] = knownTaskIds();
      emitMessage(operationBlock({
        operationId: "op-human",
        snapshotRevision: revision,
        kind: "REQUEST_HUMAN",
        payload: taskId === undefined ? { reason: "要件の確認が必要です。" } : { taskId, reason: "要件の確認が必要です。" },
      }));
      break;
    }
    case "finish":
      emitMessage(operationBlock({ operationId: "op-finish", snapshotRevision: revision, kind: "FINISH", payload: { summary: "完了" } }));
      break;
    default:
      emitMessage("操作はありません。");
      break;
  }
  finish(sessionId);
  process.exit(0);
}

// 担当としての振る舞い。
switch (taskMode) {
  case "done": {
    const name = `work-${process.pid}-${Date.now()}.txt`;
    fs.writeFileSync(path.join(process.cwd(), name), "done\n", "utf8");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "担当の作業"]);
    const head = git(["rev-parse", "HEAD"]);
    writeReport({ state: "DONE", summary: "作業しました", submittedHead: head, tests: [{ command: "node -e 0", exitCode: 0 }] });
    emitMessage(`作業を終えました。submittedHead=${head}`);
    break;
  }
  case "done-then-extra": {
    fs.writeFileSync(path.join(process.cwd(), "first.txt"), "first\n", "utf8");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "提出"]);
    const head = git(["rev-parse", "HEAD"]);
    writeReport({ state: "DONE", summary: "提出しました", submittedHead: head, tests: [] });
    fs.writeFileSync(path.join(process.cwd(), "second.txt"), "second\n", "utf8");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "提出後の追加コミット"]);
    emitMessage("提出後に追加のコミットをしました。");
    break;
  }
  case "dirty": {
    // 追跡ファイルを変更したまま、コミットせずに DONE を報告する。
    fs.appendFileSync(path.join(process.cwd(), "src", "base.txt"), "dirty\n", "utf8");
    const head = git(["rev-parse", "HEAD"]);
    writeReport({ state: "DONE", summary: "コミットし忘れ", submittedHead: head, tests: [] });
    emitMessage("追跡ファイルを変更したままコミットしていません。");
    break;
  }
  case "nocommit": {
    const head = git(["rev-parse", "HEAD"]);
    writeReport({ state: "DONE", summary: "変更なし", submittedHead: head, tests: [] });
    emitMessage("変更はありません。");
    break;
  }
  case "nohead": {
    writeReport({ state: "DONE", summary: "submittedHead なし", tests: [] });
    emitMessage("submittedHead を書き忘れました。");
    break;
  }
  case "tests-failed": {
    fs.writeFileSync(path.join(process.cwd(), "failed.txt"), "x\n", "utf8");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "失敗を含む提出"]);
    const head = git(["rev-parse", "HEAD"]);
    writeReport({ state: "DONE", summary: "テスト失敗", submittedHead: head, tests: [{ command: "node -e 3", exitCode: 3 }] });
    emitMessage("テストが失敗しました。");
    break;
  }
  case "question":
    writeReport({ state: "QUESTION", question: "どちらの案にしますか。" });
    emitMessage("判断をお願いします。");
    break;
  case "blocked":
    writeReport({ state: "BLOCKED", blockedReason: "必要な情報がありません。" });
    emitMessage("続行できません。");
    break;
  case "permission-blocked":
    emitDenial("shell(node:*)");
    writeReport({ state: "BLOCKED", blockedReason: "Permission to run this tool was denied" });
    emitMessage("権限が足りません。");
    break;
  case "noreport":
    emitMessage("終わりました。");
    break;
  case "denied-noreport":
    emitDenial("shell(node:*)");
    emitMessage("権限が足りません。");
    break;
  case "invalid-report":
    fs.mkdirSync(path.join(process.cwd(), ".agent-run"), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), ".agent-run", "report.json"), "{ this is not json", "utf8");
    emitMessage("壊れた報告を書きました。");
    break;
  case "exit3":
    emitMessage("失敗して終わります。");
    process.exit(3);
    break;
  case "sleep":
    // 時間切れを再現する。プロセスの終了はタイマーの後なので、ここでは終わらせない。
    setTimeout(() => {
      emitMessage("遅れて起きました。");
      finish(sessionId);
      process.exit(0);
    }, 30000);
    await new Promise(() => {});
    break;
  default:
    emitMessage(`未知の mode です: ${String(taskMode)}`);
    break;
}

finish(sessionId);
process.exit(0);
