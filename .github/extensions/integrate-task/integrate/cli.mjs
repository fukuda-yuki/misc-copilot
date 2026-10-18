#!/usr/bin/env node
import path from "node:path";
import process from "node:process";

import {
  cleanupCandidate,
  createProjectPorts,
  listRegisteredOperations,
  readRegisteredOperation,
  registerOperation,
  removeOperation,
} from "./ports.mjs";
import { createIntegrationRun } from "./engine.mjs";
import { POLICY_PATH, readPolicyAtRef } from "../core/policy.mjs";
import { currentBranch, resolveRepoContext } from "../core/git.mjs";

const USAGE = `integrate-task CLI

  node .github/extensions/integrate-task/integrate/cli.mjs <command> [options]

commands
  register    受付を台帳に登録する（ポリシーのハッシュを固定する）
  list        台帳の受付を一覧する
  show        受付の内容を表示する
  run         ワークフロー本体を CLI から実行する（アプリと同じ経路）
  cleanup     候補ワークツリーと候補ブランチを削除する
  unregister  受付を台帳から削除する
  policy      ターゲット ref のポリシーを表示する

register options
  --operation-id <id>          必須。英数字で始まる 1〜100 文字の [A-Za-z0-9._-]
  --submitted <rev>            必須。子セッションの提出コミット
  --repo <path>                既定: 現在のディレクトリ
  --target-branch <name>       既定: 現在のブランチ
  --target-worktree <path>     既定: ターゲットブランチをチェックアウトしている worktree
  --expected-target-head <rev> 既定: ターゲットブランチの現在の HEAD
  --depends-on <id,id>         先に INTEGRATED になっている必要がある受付 ID
  --child-session <id>         記録用
  --task-url <url>             記録用

run options
  --operation-id <id>  必須
  --mode check|apply   必須。check は検証まで、apply は反映まで
  --expect <state>     期待する state と違えば終了コード 3
`;

function parseArgv(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        parsed[key] = true;
      } else {
        parsed[key] = next;
        index += 1;
      }
    } else {
      parsed._.push(token);
    }
  }
  return parsed;
}

function required(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${key} は必須です。`);
  }
  return value;
}

function splitList(value) {
  if (value === undefined) return [];
  if (typeof value !== "string") throw new Error("--depends-on はカンマ区切りの文字列で指定してください。");
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function commandRegister(parsed) {
  const record = await registerOperation({
    operationId: required(parsed, "operation-id"),
    submittedHead: required(parsed, "submitted"),
    repoPath: parsed.repo ?? process.cwd(),
    targetBranch: typeof parsed["target-branch"] === "string" ? parsed["target-branch"] : undefined,
    targetWorktree: typeof parsed["target-worktree"] === "string" ? parsed["target-worktree"] : undefined,
    expectedTargetHead: typeof parsed["expected-target-head"] === "string" ? parsed["expected-target-head"] : undefined,
    dependsOn: splitList(parsed["depends-on"]),
    childSessionId: typeof parsed["child-session"] === "string" ? parsed["child-session"] : null,
    taskUrl: typeof parsed["task-url"] === "string" ? parsed["task-url"] : null,
  });
  printJson(record);
}

async function commandList() {
  const records = await listRegisteredOperations();
  printJson(
    records.map((record) => ({
      operationId: record.operationId,
      state: record.state,
      detail: record.detail,
      targetBranch: record.targetBranch,
      targetWorktree: record.targetWorktree,
      submittedHead: record.submittedHead,
      expectedTargetHead: record.expectedTargetHead,
      dependsOn: record.dependsOn,
      candidateHead: record.candidateHead,
      evidenceRef: record.evidenceRef,
      updatedAt: record.updatedAt,
    })),
  );
}

async function commandShow(parsed) {
  const record = await readRegisteredOperation(required(parsed, "operation-id"));
  if (record === null) throw new Error("受付が見つかりません。");
  printJson(record);
}

async function commandRun(parsed) {
  const operationId = required(parsed, "operation-id");
  const mode = required(parsed, "mode");
  const ports = createProjectPorts({ log: (message) => process.stderr.write(`[integrate-task] ${message}\n`) });
  const run = createIntegrationRun(ports);
  const outcome = await run({ args: { operationId, mode }, log: (message) => process.stderr.write(`[integrate-task] ${message}\n`) });
  printJson(outcome);
  if (typeof parsed.expect === "string" && parsed.expect !== outcome.state) {
    process.exitCode = 3;
  }
}

async function commandCleanup(parsed) {
  const record = await readRegisteredOperation(required(parsed, "operation-id"));
  if (record === null) throw new Error("受付が見つかりません。");
  const removed = await cleanupCandidate(record);
  printJson(removed);
}

async function commandUnregister(parsed) {
  const removed = await removeOperation(required(parsed, "operation-id"));
  printJson({ removed });
}

async function commandPolicy(parsed) {
  const startDir = path.resolve(parsed.repo ?? process.cwd());
  const { repoPath } = await resolveRepoContext(startDir);
  const branch = typeof parsed.ref === "string" ? parsed.ref : await currentBranch(repoPath);
  const atRef = await readPolicyAtRef(repoPath, branch);
  if (!atRef.present) {
    throw new Error(`${branch} に ${POLICY_PATH} がありません。`);
  }
  printJson({ ref: branch, repoPath, policyPath: POLICY_PATH, policyHash: atRef.hash, policy: atRef.policy });
}

const commands = {
  register: commandRegister,
  list: commandList,
  show: commandShow,
  run: commandRun,
  cleanup: commandCleanup,
  unregister: commandUnregister,
  policy: commandPolicy,
};

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  const command = parsed._[0];
  if (command === undefined || command === "help" || parsed.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const handler = commands[command];
  if (handler === undefined) throw new Error(`未知のコマンドです: ${command}`);
  await handler(parsed);
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
});
