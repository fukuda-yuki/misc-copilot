// 責任者（task-pipeline を回す担当）を driver がどう扱うかの実走テスト。
// 実 copilot の代わりに test/fake-copilot.mjs を commandArgs で差し替え、
// 引数ファイル・結果ファイル・分類・親への回し方を確かめる。
// ここで確かめているのは driver の振る舞いであり、実 copilot の振る舞いではない。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFixture, removeTree } from "./helpers.mjs";
import { buildTaskArgs, checkWorkflowArgs } from "../driver/attempts.mjs";
import { detectCapabilities } from "../driver/session.mjs";
import { ATTEMPT_STATE, RUN_STATE, TASK_DETAIL, TASK_STATE } from "../driver/state.mjs";
import { listAttempts } from "../driver/store.mjs";
import { defaultConfig, initRun, loadContext, operationsOf, runLoop } from "../driver/run.mjs";
import { taskPipelineMeta } from "../task/engine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_COPILOT = path.join(HERE, "fake-copilot.mjs");

// 実測した copilot 1.0.99-2 の help と同じ検出結果になる文面（--effort も含める）。
const FAKE_HELP = [
  "-p, --prompt <text>",
  "-r, --resume [<value>]",
  "--session-id <id>",
  "--output-format <format>",
  "--no-ask-user",
  "--allow-tool [<tools>...]",
  "--deny-tool [<tools>...]",
  "--model <model>",
  "--effort <level>",
].join("\n");

function makeConfig(fixture, overrides = {}) {
  return defaultConfig({
    env: fixture.env,
    home: fixture.home,
    cwd: fixture.repoRoot,
    command: process.execPath,
    commandArgs: [FAKE_COPILOT],
    capabilities: detectCapabilities(FAKE_HELP),
    timeoutMinutes: 1,
    pollSeconds: 0.05,
    integrationWaitSeconds: 30,
    log: () => {},
    ...overrides,
  });
}

async function startRun(fixture, request, overrides = {}) {
  const config = makeConfig(fixture, overrides);
  const { runId, layout } = await initRun(config, {
    repoPath: fixture.repoRoot,
    targetBranch: "main",
    targetWorktree: fixture.repoRoot,
    request,
  });
  const context = await loadContext(config, runId, { recover: false });
  return { config, runId, layout, context };
}

async function dispose(fixture) {
  await removeTree(`${fixture.repoRoot}.worktrees`);
  await fixture.dispose();
}

function eventsOfType(context, type) {
  return context.events.filter((event) => event.type === type);
}

async function attemptsOf(context, taskId) {
  return listAttempts(context.layout, taskId);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

test("責任者の引数ファイルを driver が書き、提出は結果ファイルで受け取る", async () => {
  const fixture = await createFixture();
  try {
    const request = "責任者に任せる。 [[parent=1:dispatch-workflow]] [[task=workflow-submitted]] [[parent=check-apply]]";
    // 実装役のモデルだけ設定で与え、担当側の指定が優先されることを確かめる。
    const { context } = await startRun(fixture, request, { taskRoles: { implementer: { model: "config-model" } } });
    await runLoop(context, { maxSteps: 80 });

    assert.equal(context.run.state, RUN_STATE.FINISHED);
    const task = context.findTask("t1");
    assert.equal(task.state, TASK_STATE.INTEGRATED);

    // 担当の指定は DISPATCH の payload のまま記録する。
    assert.deepEqual(task.roles, {
      implementer: { reasoningEffort: "high" },
      reviewer: { model: "reviewer-model", reasoningEffort: "low" },
    });
    assert.deepEqual(task.verify, [{ name: "fake-verify", command: "node", args: ["-e", "0"], timeoutSeconds: 600 }]);

    const [attempt] = await attemptsOf(context, "t1");
    // 担当は `copilot workflow run task-pipeline` を回せる必要がある。
    assert.ok(attempt.args.includes("--allow-tool=shell(copilot:*)"), `許可が足りない: ${attempt.args.join(" ")}`);
    assert.equal(attempt.taskArgsFile, path.join(attempt.worktree, ".agent-run", "t1-a1.task.json"));
    assert.equal(attempt.workflowResultFile, path.join(attempt.worktree, ".agent-run", "t1-a1.task-result.json"));

    // 引数ファイル: 依頼・役割（設定と担当の指定を統合）・検証を渡している。
    const args = await readJson(attempt.taskArgsFile);
    assert.equal(args.taskId, "t1");
    assert.equal(args.title, "責任者1");
    assert.ok(args.prompt.includes("作業してください。[[mode=workflow-submitted]]"), `依頼が入っていない: ${args.prompt}`);
    assert.deepEqual(args.roles, {
      implementer: { model: "config-model", reasoningEffort: "high" },
      reviewer: { model: "reviewer-model", reasoningEffort: "low" },
    });
    assert.deepEqual(args.verify, [{ name: "fake-verify", command: "node", args: ["-e", "0"], timeoutSeconds: 600 }]);
    assert.equal(attempt.taskArgs.roles.implementer.model, "config-model");

    // プロンプト: 実行するコマンドと、守ること（コミット・統合をしない）を書いている。
    const prompt = await fs.readFile(attempt.promptFile, "utf8");
    assert.ok(prompt.includes("copilot workflow run task-pipeline --args @"), "コマンドが無い");
    assert.ok(prompt.includes(attempt.taskArgsFile), "引数ファイルのパスが無い");
    assert.ok(prompt.includes(attempt.workflowResultFile), "結果ファイルのパスが無い");
    assert.ok(prompt.includes("書き換えないでください"), "引数ファイルの保護が無い");
    assert.ok(prompt.includes("あなた自身はコードを変更しない・コミットしないでください"), "禁止が無い");
    assert.ok(prompt.includes("統合（merge）・push・PR 作成はしません"), "統合の禁止が無い");

    // 分類: 結果ファイルの state を根拠に提出として受け取り、証拠を残している。
    assert.equal(attempt.state, ATTEMPT_STATE.DONE);
    assert.equal(attempt.classification.workflowState, "SUBMITTED");
    assert.equal(attempt.classification.workflowRunId, "11111111-2222-4333-8444-555555555555");
    assert.equal(attempt.classification.workflowEvidenceRef, "evidence/task/t1/000");
    assert.equal(attempt.classification.workflowReview.verdict, "approve");
    assert.equal(attempt.classification.submittedHead, task.submittedHead);

    const [finished] = eventsOfType(context, "attempt-finished");
    assert.equal(finished.state, TASK_STATE.SUBMITTED);
    assert.equal(finished.workflowState, "SUBMITTED");
    assert.equal(finished.workflowEvidenceRef, "evidence/task/t1/000");
    assert.equal(finished.submittedHead, task.submittedHead);

    // 親のプロンプトにも役割と検証を出す。
    const parentPrompt = await fs.readFile(path.join(context.layout.base, "parent-prompt-2.md"), "utf8");
    assert.ok(parentPrompt.includes("役割=implementer=high reviewer=reviewer-model/low"), `役割が出ていない: ${parentPrompt}`);
    assert.ok(parentPrompt.includes("検証=fake-verify"), "検証が出ていない");

    // 統合は driver が行い、提出コミットが統合先に入っている。
    assert.equal(await fixture.isAncestor(task.submittedHead, await fixture.head()), true);
    const records = await operationsOf(context);
    assert.ok(records.some((record) => record.kind === "CHECK_MERGE" && record.status === "applied"));
    assert.ok(records.some((record) => record.kind === "APPLY_MERGE" && record.status === "applied"));

    // 結果ファイルと報告は生のまま証拠として残す。
    const archived = await readJson(path.join(context.layout.reports, "t1-a1.json"));
    assert.equal(archived.workflow.state, "SUBMITTED");
    assert.equal(archived.workflow.runId, "11111111-2222-4333-8444-555555555555");
    assert.equal(archived.report.state, "DONE");
    assert.ok(String(archived.workflowRawText).includes("SUBMITTED"), "生の結果ファイルを残していない");
  } finally {
    await dispose(fixture);
  }
});

test("結果ファイルだけで提出を受け取る（報告が無くてもよい）", async () => {
  const fixture = await createFixture();
  try {
    const request = "報告を書かない責任者。 [[parent=1:dispatch-workflow]] [[task=workflow-noreport]] [[parent=check-apply]]";
    const { context } = await startRun(fixture, request);
    await runLoop(context, { maxSteps: 80 });

    assert.equal(context.run.state, RUN_STATE.FINISHED);
    const task = context.findTask("t1");
    assert.equal(task.state, TASK_STATE.INTEGRATED);

    const [attempt] = await attemptsOf(context, "t1");
    assert.equal(attempt.classification.workflowState, "SUBMITTED");
    assert.equal(attempt.classification.workflowEvidenceRef, "evidence/task/t1/001");
    assert.equal(attempt.classification.submittedHead, task.submittedHead);
    assert.equal(attempt.state, ATTEMPT_STATE.DONE);
    assert.equal(await fixture.isAncestor(task.submittedHead, await fixture.head()), true);
  } finally {
    await dispose(fixture);
  }
});

test("結果ファイルが親待ちなら、報告が成功に見えても親へ回して回答で再開する", async () => {
  const fixture = await createFixture();
  try {
    const request = [
      "結果ファイルを優先する。",
      "[[parent=1:dispatch-workflow]] [[task=workflow-lying]]",
      "[[answer-mode=workflow-submitted]] [[parent=2:answer]] [[parent=check-apply]]",
    ].join(" ");
    const { context } = await startRun(fixture, request);
    await runLoop(context, { maxSteps: 80 });

    const task = context.findTask("t1");
    assert.equal(task.state, TASK_STATE.INTEGRATED);

    const attempts = await attemptsOf(context, "t1");
    assert.equal(attempts.length, 2);
    // 1 回目は報告が DONE でも、結果ファイルの NEEDS_PARENT を採る。
    assert.equal(attempts[0].state, ATTEMPT_STATE.QUESTION);
    assert.equal(attempts[0].classification.state, TASK_STATE.NEEDS_PARENT);
    assert.equal(attempts[0].classification.detail, TASK_DETAIL.QUESTION);
    assert.equal(attempts[0].classification.workflowState, "NEEDS_PARENT");
    assert.equal(attempts[0].classification.workflowDetail, "verify-failed");
    assert.ok(attempts[0].classification.question.includes("検証が通りません。"), "理由が伝わっていない");

    // 2 回目は同じセッションを再開し、回答を引数ファイルへ渡す。
    assert.equal(attempts[1].kind, "answer");
    assert.equal(attempts[1].resumedFrom, attempts[0].sessionId);
    const args = await readJson(attempts[1].taskArgsFile);
    assert.ok(args.prompt.includes("## driver からの回答"), "回答が入っていない");
    assert.ok(args.prompt.includes("[[mode=workflow-submitted]]"), `回答が入っていない: ${args.prompt}`);
    assert.equal(attempts[1].classification.workflowState, "SUBMITTED");
    assert.equal(await fixture.isAncestor(task.submittedHead, await fixture.head()), true);
  } finally {
    await dispose(fixture);
  }
});

test("結果ファイルの state が親待ちなら、回答が無ければ停止して親待ちのまま残す", async () => {
  const fixture = await createFixture();
  try {
    const request = "親待ちのまま放置する。 [[parent=1:dispatch-workflow]] [[task=workflow-needs-parent]]";
    const { context } = await startRun(fixture, request);
    await runLoop(context, { maxSteps: 80 });

    assert.equal(context.run.state, RUN_STATE.STOPPED);
    assert.equal(context.run.stopDetail, TASK_DETAIL.NO_OPERATION);
    const task = context.findTask("t1");
    assert.equal(task.state, TASK_STATE.NEEDS_PARENT);
    assert.equal(task.detail, TASK_DETAIL.QUESTION);
    assert.ok(task.question.includes("worktree-dirty"), `詳細が伝わっていない: ${task.question}`);
    assert.equal(task.submittedHead, null);

    const [attempt] = await attemptsOf(context, "t1");
    assert.equal(attempt.classification.workflowState, "NEEDS_PARENT");
    assert.equal(attempt.classification.workflowDetail, "worktree-dirty");
    assert.equal(attempt.state, ATTEMPT_STATE.QUESTION);

    // 提出として扱っていないので統合は一度も走らない。
    assert.equal(eventsOfType(context, "integration-result").length, 0);
    assert.equal(await fixture.head(), fixture.expectedTargetHead);
  } finally {
    await dispose(fixture);
  }
});

test("結果ファイルを読めない・state が不正なら成功として扱わない", async () => {
  const cases = [
    ["workflow-corrupt", "JSON として読めません"],
    ["workflow-unknown-state", "state が不正です: WEIRD"],
  ];
  for (const [mode, message] of cases) {
    const fixture = await createFixture();
    try {
      const request = `壊れた結果ファイル。 [[parent=1:dispatch-workflow]] [[task=${mode}]]`;
      const { context } = await startRun(fixture, request);
      await runLoop(context, { maxSteps: 80 });

      assert.equal(context.run.state, RUN_STATE.STOPPED, `${mode}: 停止していない`);
      assert.equal(context.run.stopDetail, TASK_DETAIL.HUMAN_REQUESTED, `${mode}: 停止理由が違う`);

      const task = context.findTask("t1");
      assert.equal(task.state, TASK_STATE.NEEDS_HUMAN, `${mode}: 人間の判断に回っていない`);
      assert.equal(task.detail, TASK_DETAIL.REPORT_INVALID, `${mode}: 詳細が違う`);
      assert.equal(task.submittedHead, null, `${mode}: 提出コミットを記録している`);

      const [attempt] = await attemptsOf(context, "t1");
      assert.ok(attempt.classification.message.includes(message), `${mode}: 理由が違う: ${attempt.classification.message}`);
      assert.equal(eventsOfType(context, "integration-result").length, 0, `${mode}: 統合している`);
      assert.equal(await fixture.head(), fixture.expectedTargetHead, `${mode}: 統合先が動いている`);
    } finally {
      await dispose(fixture);
    }
  }
});

test("結果ファイルと報告の submittedHead が食い違えば人間の判断に回す", async () => {
  const fixture = await createFixture();
  try {
    const request = "食い違う submittedHead。 [[parent=1:dispatch-workflow]] [[task=workflow-mismatch]]";
    const { context } = await startRun(fixture, request);
    await runLoop(context, { maxSteps: 80 });

    assert.equal(context.run.state, RUN_STATE.STOPPED);
    assert.equal(context.run.stopDetail, TASK_DETAIL.HUMAN_REQUESTED);
    const task = context.findTask("t1");
    assert.equal(task.state, TASK_STATE.NEEDS_HUMAN);
    assert.equal(task.detail, TASK_DETAIL.SUBMITTED_HEAD_MISMATCH);
    assert.equal(task.submittedHead, null);

    const [attempt] = await attemptsOf(context, "t1");
    assert.equal(attempt.classification.workflowState, "SUBMITTED");
    assert.equal(eventsOfType(context, "integration-result").length, 0);
    assert.equal(await fixture.head(), fixture.expectedTargetHead);
  } finally {
    await dispose(fixture);
  }
});

test("検証の失敗は結果ファイルの tests で判定する", async () => {
  const fixture = await createFixture();
  try {
    const request = "検証に落ちる責任者。 [[parent=1:dispatch-workflow]] [[task=workflow-tests-failed]]";
    const { context } = await startRun(fixture, request);
    await runLoop(context, { maxSteps: 80 });

    assert.equal(context.run.state, RUN_STATE.STOPPED);
    assert.equal(context.run.stopDetail, TASK_DETAIL.NO_OPERATION);
    const task = context.findTask("t1");
    assert.equal(task.state, TASK_STATE.BLOCKED);
    assert.equal(task.detail, TASK_DETAIL.TASK_FAILED);
    assert.equal(task.submittedHead, null);

    // 報告の tests は通っているが、結果ファイルの tests を採る。
    const [attempt] = await attemptsOf(context, "t1");
    assert.deepEqual(attempt.classification.tests, [{ command: "node -e 3", exitCode: 3, name: "fail" }]);
    assert.equal(eventsOfType(context, "integration-result").length, 0);
    assert.equal(await fixture.head(), fixture.expectedTargetHead);
  } finally {
    await dispose(fixture);
  }
});

test("task-pipeline の引数は argsSchema に通る形だけを書く", () => {
  const schema = taskPipelineMeta.argsSchema;

  // 指定が無い項目は載せない。実測では commitMessage: null や implementer: {} を渡すと
  // CLI が起動前に拒否する（maxReworks は task/state.mjs の既定 2 が入る）。
  const minimal = buildTaskArgs({ taskId: "t1", title: "題", prompt: "本文" });
  assert.deepEqual(minimal, { taskId: "t1", title: "題", prompt: "本文", maxReworks: 2 });
  assert.deepEqual(checkWorkflowArgs(minimal, schema), []);

  // 指定された役割・検証・回数の上限だけを、task/state.mjs の検証結果から載せる。
  const full = buildTaskArgs(
    {
      taskId: "t1",
      title: "題",
      prompt: "本文",
      roles: { implementer: {}, reviewer: { model: "reviewer-model" } },
      verify: [{ name: "v", command: "node", args: ["-e", "0"] }],
    },
    { taskRoles: { implementer: { reasoningEffort: "high" } }, maxReworks: 2 },
  );
  assert.deepEqual(full.roles, {
    implementer: { reasoningEffort: "high" },
    reviewer: { model: "reviewer-model" },
  });
  assert.deepEqual(full.verify, [{ name: "v", command: "node", args: ["-e", "0"], timeoutSeconds: 600 }]);
  assert.equal(full.maxReworks, 2);
  assert.deepEqual(checkWorkflowArgs(full, schema), []);

  // schema に合わない値は子を起こす前に見つける。
  assert.equal(checkWorkflowArgs({ ...minimal, commitMessage: null }, schema).length, 1);
  assert.match(checkWorkflowArgs({ ...minimal, maxReworks: "2" }, schema)[0], /maxReworks/);
  assert.match(checkWorkflowArgs({ taskId: "t1" }, schema)[0], /title/);
});

test("実装役の指示に、この実行で使えるツールを書く", () => {
  const task = { taskId: "t1", title: "題", prompt: "本文" };
  const allow = ["write", "shell(git:*)", "shell(node:*)", "shell(npm:*)", "shell(copilot:*)"];

  // 実測: 許可されていないシェルでのファイル作成は拒否される。許可されている手段を先に示す。
  const args = buildTaskArgs(task, { taskAllowTools: allow });
  assert.match(args.prompt, /ファイルの作成・変更は write ツール（apply_patch）で行ってください。/);
  assert.match(args.prompt, /シェルで実行できるのは git \/ node \/ npm \/ copilot です/);
  assert.match(args.prompt, /powershell \/ cmd \/ python \/ bash \/ sh など/);

  // 許可リストに無いものは書かない。
  const withPowerShell = buildTaskArgs(task, { taskAllowTools: ["shell(powershell:*)"] });
  assert.doesNotMatch(withPowerShell.prompt, /write ツール/);
  assert.match(withPowerShell.prompt, /シェルで実行できるのは powershell です。/);
  assert.doesNotMatch(withPowerShell.prompt, /powershell など/);

  // シェルが無ければそう書く。許可リストが分からないときは何も書かない。
  assert.match(buildTaskArgs(task, { taskAllowTools: ["write"] }).prompt, /シェルを実行できません/);
  assert.doesNotMatch(buildTaskArgs(task).prompt, /使えるツール/);
});
