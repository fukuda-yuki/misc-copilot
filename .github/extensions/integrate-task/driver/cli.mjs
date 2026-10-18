#!/usr/bin/env node
// CLI 限定並列開発の入口。App 側の入口（extension.mjs）とは別で、
// 内部の判断と実測は integrate/ と core/ を共有する。

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { CapabilityError, probeCapabilities } from "./session.mjs";
import { OPERATION_KIND } from "./protocol.mjs";
import {
  applyOperation,
  defaultConfig,
  initRun,
  integrateTask,
  loadContext,
  operationsOf,
  recover,
  requestStop,
  runLoop,
  statusSnapshot,
} from "./run.mjs";
import { listRuns, readEvents, readParent, runLayout, listAttempts, listTasks } from "./store.mjs";

const USAGE = `使い方: node .github/extensions/integrate-task/driver/cli.mjs <command> [options]

driver は AI を呼ばずに担当セッションを起動・回収し、親セッションの操作提案だけを実行します。

  doctor                          copilot の実在と使えるスイッチを実測する
  run --repo <path> [--target <branch>] [--request <text> | --request-file <path>]
                                 新しい実行を始める（--once で 1 ステップだけ）
  resume --run <runId>           停止した実行を復旧して続ける
  status [--run <runId>] [--json] 実行の一覧または 1 件の詳細
  tasks --run <runId> [--json]   タスクの状態
  events --run <runId> [--since <n>] [--json]
                                 イベント（追記のみ）
  operations --run <runId> [--json]
                                 受け取った操作と採否
  answer --run <runId> --task <taskId> --text <回答>
                                 人間が回答して担当を再開する（NEEDS_PARENT / NEEDS_HUMAN）
  rework --run <runId> --task <taskId> --instruction <指示> [--reset]
                                 人間が差し戻す
  check --run <runId> --task <taskId>
                                 提出を検証する（統合候補の作成と検証まで）
  apply --run <runId> --task <taskId>
                                 検証済みの候補を反映する
  request-human --run <runId> --task <taskId> [--note <メモ>]
                                 人間の対応待ちにする
  logs --run <runId> [--task <taskId>] [--json]
                                 試行ごとのログとプロンプトの場所
  parent --run <runId> [--json]  親セッションの状態（ターン数・最後の revision）
  stop --run <runId> [--reason <理由>]
                                 実行中の driver へ停止を要求する
  recover --run <runId>          所有 driver が消えた試行を復旧する

共通オプション: --home <dir> --command <copilot> --command-args <arg> --pools <tasks,verify,integration>
                --timeout <minutes> --poll <seconds> --max-reworks <n>
                --model <model> --parent-model <model> --task-model <model> --effort <level>
                --task-allow-tool <tool> --task-deny-tool <tool>
                --parent-allow-tool <tool> --parent-deny-tool <tool>
                --no-default-deny --json

ツール許可は --allow-all / --yolo を使わず、名前で許可する。
既定は 担当: write, shell(git:*), shell(node:*), shell(npm:*)、親: shell(git:*)。
既定の拒否: git push / merge / rebase / reset / checkout / switch（統合は driver だけが行う）。`;

function parseArgv(argv) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      const value = next === undefined || next.startsWith("--") ? true : next;
      if (value !== true) index += 1;
      const previous = flags.get(key);
      if (previous === undefined) flags.set(key, value);
      else if (Array.isArray(previous)) previous.push(value);
      else flags.set(key, [previous, value]);
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

function flagValues(flags, name) {
  const value = flags.get(name);
  if (value === undefined || value === true) return [];
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}

function flagText(flags, name, fallback = null) {
  const values = flagValues(flags, name);
  if (values.length === 0) return fallback;
  // 同じスイッチを複数回指定した場合は最後の値を採用する。
  return values[values.length - 1];
}

function flagNumber(flags, name, fallback) {
  const text = flagText(flags, name, null);
  if (text === null) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`--${name} は数値で指定してください。`);
  return value;
}

function parsePools(flags) {
  const text = flagText(flags, "pools", null);
  if (text === null) return undefined;
  const parts = text.split(",").map((item) => Number(item.trim()));
  if (parts.length !== 3 || parts.some((item) => !Number.isInteger(item))) {
    throw new Error("--pools は tasks,verify,integration の 3 つの整数で指定してください。");
  }
  return { tasks: parts[0], verify: parts[1], integration: parts[2] };
}

function buildConfig(flags) {
  const home = flagText(flags, "home", null);
  const parentAllow = flagValues(flags, "parent-allow-tool");
  const parentDeny = flagValues(flags, "parent-deny-tool");
  const taskAllow = flagValues(flags, "task-allow-tool");
  const taskDeny = flagValues(flags, "task-deny-tool");
  const noDeny = flags.has("no-default-deny");
  return defaultConfig({
    home: home === null ? undefined : path.resolve(home),
    cwd: flagText(flags, "cwd", process.cwd()),
    command: flagText(flags, "command", "copilot"),
    commandArgs: flagValues(flags, "command-args"),
    pools: parsePools(flags),
    timeoutMinutes: flagNumber(flags, "timeout", 30),
    pollSeconds: flagNumber(flags, "poll", 2),
    maxReworks: flagNumber(flags, "max-reworks", 2),
    parentModel: flagText(flags, "parent-model", null),
    taskModel: flagText(flags, "task-model", null),
    effort: flagText(flags, "effort", null),
    parentAllowTools: parentAllow.length > 0 ? parentAllow : undefined,
    parentDenyTools: noDeny ? [] : parentDeny.length > 0 ? parentDeny : undefined,
    taskAllowTools: taskAllow.length > 0 ? taskAllow : undefined,
    taskDenyTools: noDeny ? [] : taskDeny.length > 0 ? taskDeny : undefined,
    log: (message) => process.stderr.write(`${message}\n`),
  });
}

function out(value, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${value}\n`);
}

async function ensureCapabilities(config) {
  if (config.capabilities !== null) return config.capabilities;
  const probe = await probeCapabilities({ command: config.command, commandArgs: config.commandArgs, cwd: config.cwd });
  config.capabilityProbe = probe;
  config.capabilities = probe.capabilities;
  return config.capabilities;
}

async function commandDoctor(flags) {
  const config = buildConfig(flags);
  const probe = await probeCapabilities({ command: config.command, commandArgs: config.commandArgs, cwd: config.cwd });
  const required = ["prompt", "sessionId", "outputFormat", "noAskUser"];
  const missing = required.filter((name) => probe.capabilities[name] === null);
  const report = {
    command: probe.command,
    versionExitCode: probe.versionExitCode,
    versionText: probe.versionText,
    helpExitCode: probe.helpExitCode,
    capabilities: probe.capabilities,
    required,
    missingRequired: missing,
    resumeAvailable: probe.capabilities.resume !== null,
    allowAllPresentButUnused: probe.capabilities.allowAllPresent,
  };
  out(report, flags.has("json") || !process.stdout.isTTY);
  if (missing.length > 0) {
    process.stderr.write(`必須のスイッチが見つかりません: ${missing.join(", ")}\n`);
    return 4;
  }
  if (probe.capabilities.resume === null) {
    process.stderr.write("注意: --resume が見つかりません。回答による再開はできません。\n");
  }
  return 0;
}

async function commandRun(flags) {
  const config = buildConfig(flags);
  await ensureCapabilities(config);
  const repoPath = path.resolve(flagText(flags, "repo", process.cwd()));
  let request = flagText(flags, "request", "");
  const requestFile = flagText(flags, "request-file", null);
  if (requestFile !== null) request = await fs.readFile(path.resolve(requestFile), "utf8");
  const created = await initRun(config, {
    repoPath,
    targetBranch: flagText(flags, "target", null),
    targetWorktree: flagText(flags, "worktree", null),
    baseCommit: flagText(flags, "base", null),
    request,
  });
  process.stderr.write(`run ${created.runId} を開始しました（home: ${config.home}）。\n`);
  return await driveRun(config, created.runId, flags);
}

async function commandResume(flags) {
  const config = buildConfig(flags);
  await ensureCapabilities(config);
  const runId = requireFlag(flags, "run");
  return await driveRun(config, runId, flags);
}

async function driveRun(config, runId, flags) {
  const context = await loadContext(config, runId);
  if (context.recovery.length > 0) {
    process.stderr.write(`復旧: ${JSON.stringify(context.recovery)}\n`);
  }
  const once = flags.has("once");
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const result = await runLoop(context, {
      maxSteps: once ? 1 : flagNumber(flags, "max-steps", Number.POSITIVE_INFINITY),
      signal: controller.signal,
      onStep: (outcome) => process.stderr.write(`step: ${outcome.action} ${JSON.stringify(outcome.detail ?? {})}\n`),
    });
    const snapshot = statusSnapshot(context);
    out(snapshot, true);
    if (snapshot.state === "STOPPED") return 3;
    return 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function requireFlag(flags, name) {
  const value = flagText(flags, name, null);
  if (value === null) throw new Error(`--${name} は必須です。`);
  return value;
}

async function withContext(flags, options = {}) {
  const config = buildConfig(flags);
  const runId = requireFlag(flags, "run");
  const context = await loadContext(config, runId, { recover: options.recover === true });
  return { config, context };
}

async function commandStatus(flags) {
  const config = buildConfig(flags);
  const runId = flagText(flags, "run", null);
  const asJson = flags.has("json");
  if (runId === null) {
    const runs = await listRuns(config.home);
    if (asJson) {
      out(runs, true);
      return 0;
    }
    if (runs.length === 0) {
      out("実行はありません。", false);
      return 0;
    }
    for (const run of runs) {
      const tasks = await listTasks(runLayout(run.runId, config.home));
      out(`${run.runId} ${run.state} ${run.targetBranch} tasks=${tasks.length} ${run.stopDetail ?? ""}`, false);
    }
    return 0;
  }
  const context = await loadContext(config, runId);
  const snapshot = statusSnapshot(context);
  if (asJson) {
    out(snapshot, true);
    return 0;
  }
  const lines = [];
  lines.push(`run ${snapshot.runId} state=${snapshot.state}`);
  lines.push(`  repo=${snapshot.repoPath} target=${snapshot.targetBranch} base=${String(snapshot.baseCommit).slice(0, 12)}`);
  lines.push(`  revision=${snapshot.snapshotRevision} driver=${snapshot.driverPid} alive=${snapshot.driverAlive}`);
  if (snapshot.stopDetail) lines.push(`  stop=${snapshot.stopDetail} ${snapshot.stopMessage ?? ""}`);
  lines.push(`  tasks=${JSON.stringify(snapshot.summary)}`);
  for (const task of snapshot.tasks) {
    lines.push(`  - ${task.taskId} [${task.state}] ${task.title} attempts=${task.attemptCount}${task.integrationState ? ` integration=${task.integrationState}` : ""}`);
    if (task.message) lines.push(`      ${task.message}`);
  }
  out(lines.join("\n"), false);
  return snapshot.state === "STOPPED" ? 3 : 0;
}

async function commandTasks(flags) {
  const { context } = await withContext(flags);
  const snapshot = statusSnapshot(context);
  if (flags.has("json")) {
    out(snapshot.tasks, true);
    return 0;
  }
  out(
    snapshot.tasks.map((task) => `${task.taskId}\t${task.state}\t${task.title}\t${task.detail ?? ""}`).join("\n") || "(タスクはありません)",
    false,
  );
  return 0;
}

async function commandEvents(flags) {
  const { context } = await withContext(flags);
  const since = flagNumber(flags, "since", 0);
  const events = await readEvents(context.layout, { since });
  if (flags.has("json")) {
    out(events, true);
    return 0;
  }
  out(events.map((event) => `${event.eventId}\t${event.at}\t${event.type}\t${JSON.stringify(event).slice(0, 300)}`).join("\n") || "(イベントはありません)", false);
  return 0;
}

async function commandOperations(flags) {
  const { context } = await withContext(flags);
  const records = await operationsOf(context);
  if (flags.has("json")) {
    out(records, true);
    return 0;
  }
  out(
    records.map((record) => `${record.operationId}\t${record.kind}\t${record.status}\t${record.detail ?? ""}\t${record.taskId ?? ""}`).join("\n") ||
      "(操作はありません)",
    false,
  );
  return 0;
}

async function commandLogs(flags) {
  const { context } = await withContext(flags);
  const taskId = flagText(flags, "task", null);
  const attempts = taskId === null ? await listAttempts(context.layout) : await listAttempts(context.layout, taskId);
  const entries = attempts.map((attempt) => ({
    attemptId: attempt.attemptId,
    taskId: attempt.taskId,
    state: attempt.state,
    pid: attempt.pid,
    driverPid: attempt.driverPid,
    logFile: attempt.logFile,
    promptFile: attempt.promptFile,
    exitCode: attempt.exitCode,
  }));
  out(entries, flags.has("json"));
  return 0;
}

async function commandHumanOperation(flags, kind) {
  const config = buildConfig(flags);
  const runId = requireFlag(flags, "run");
  const context = await loadContext(config, runId);
  const operationId = flagText(flags, "operation-id", `human-${kind.toLowerCase()}-${Date.now()}`);
  let payload;
  let taskId = null;
  if (kind === OPERATION_KIND.ANSWER) {
    taskId = requireFlag(flags, "task");
    payload = { taskId, answer: requireFlag(flags, "text") };
  } else if (kind === OPERATION_KIND.REWORK) {
    taskId = requireFlag(flags, "task");
    payload = { taskId, instruction: requireFlag(flags, "instruction"), resetWorktree: flags.has("reset") };
  } else {
    taskId = requireFlag(flags, "task");
    payload = { taskId, note: flagText(flags, "note", null) };
  }
  const operation = { operationId, snapshotRevision: context.run.snapshotRevision, kind, taskId, payload };
  const outcome = await applyOperation(context, operation);
  out({ operation, outcome, state: context.run.state }, true);
  return outcome.status === "applied" ? 0 : 3;
}

async function commandCheck(flags) {
  const config = buildConfig(flags);
  const runId = requireFlag(flags, "run");
  const context = await loadContext(config, runId);
  const taskId = requireFlag(flags, "task");
  const task = context.findTask(taskId);
  if (task === null) throw new Error(`taskId ${taskId} は存在しません。`);
  if (task.state !== "SUBMITTED") throw new Error(`taskId ${taskId} は ${task.state} です。提出待ちではありません。`);
  const outcome = await integrateTask(context, task, "check");
  out({ taskId, outcome, task: context.findTask(taskId) }, true);
  return outcome.state === "VERIFIED_NOT_PUBLISHED" || outcome.state === "INTEGRATED" ? 0 : 3;
}

async function commandApply(flags) {
  const config = buildConfig(flags);
  const runId = requireFlag(flags, "run");
  const context = await loadContext(config, runId);
  const taskId = requireFlag(flags, "task");
  const task = context.findTask(taskId);
  if (task === null) throw new Error(`taskId ${taskId} は存在しません。`);
  if (task.integration?.state !== "VERIFIED_NOT_PUBLISHED") {
    throw new Error(`taskId ${taskId} は検証済みではありません。先に check を実行してください。`);
  }
  const outcome = await integrateTask(context, task, "apply");
  out({ taskId, outcome, task: context.findTask(taskId) }, true);
  return outcome.state === "INTEGRATED" ? 0 : 3;
}

async function commandStop(flags) {
  const config = buildConfig(flags);
  const runId = requireFlag(flags, "run");
  const context = await loadContext(config, runId);
  const owner = context.run.driverPid;
  if (owner === process.pid) {
    out("このプロセスが所有している実行です。run の中断シグナルで停止してください。", false);
    return 2;
  }
  const payload = await requestStop(context, flagText(flags, "reason", "停止要求"));
  const alive = context.run.state === "RUNNING";
  out({ runId, ...payload, ownerDriverPid: owner, driverState: context.run.state, note: alive ? "所有 driver が次のステップで停止します。" : "実行は既に止まっています。" }, flags.has("json"));
  return 0;
}

async function commandRecover(flags) {
  const config = buildConfig(flags);
  const runId = requireFlag(flags, "run");
  const context = await loadContext(config, runId, { recover: false });
  const changes = await recover(context);
  const snapshot = statusSnapshot(context);
  out({ changes, run: snapshot }, true);
  return 0;
}

async function commandParent(flags) {
  const { context } = await withContext(flags);
  const parent = await readParent(context.layout);
  out(parent ?? { note: "親セッションはまだ起動していません。" }, true);
  return 0;
}

const COMMANDS = {
  doctor: commandDoctor,
  run: commandRun,
  resume: commandResume,
  status: commandStatus,
  tasks: commandTasks,
  events: commandEvents,
  operations: commandOperations,
  logs: commandLogs,
  parent: commandParent,
  stop: commandStop,
  recover: commandRecover,
  check: commandCheck,
  apply: commandApply,
  answer: (flags) => commandHumanOperation(flags, OPERATION_KIND.ANSWER),
  rework: (flags) => commandHumanOperation(flags, OPERATION_KIND.REWORK),
  "request-human": (flags) => commandHumanOperation(flags, OPERATION_KIND.REQUEST_HUMAN),
};

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positionals } = parseArgv(argv);
  const command = positionals[0] ?? (flags.has("help") ? "help" : null);
  if (command === null || command === "help" || flags.has("help")) {
    out(USAGE, false);
    return 0;
  }
  const handler = COMMANDS[command];
  if (handler === undefined) {
    process.stderr.write(`未知のコマンドです: ${command}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    return await handler(flags);
  } catch (error) {
    if (error instanceof CapabilityError) {
      process.stderr.write(`${error.message}\n`);
      return 4;
    }
    process.stderr.write(`エラー: ${error.message}\n`);
    if (flags.has("stack")) process.stderr.write(`${error.stack}\n`);
    return 1;
  }
}

process.exitCode = await main();
