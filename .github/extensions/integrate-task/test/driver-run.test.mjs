// driver（CLI 限定並列開発）の実走テスト。
// 実 copilot の代わりに test/fake-copilot.mjs を commandArgs で差し替え、
// ループ・操作の適用・証拠の判定を実走で確かめる。
// ここで確かめているのは driver の振る舞いであり、実 copilot の振る舞いではない。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFixture, makeTempDir, removeTree, runGit } from "./helpers.mjs";
import { detectCapabilities, isProcessAlive } from "../driver/session.mjs";
import { ATTEMPT_STATE, RUN_STATE, TASK_DETAIL, TASK_STATE } from "../driver/state.mjs";
import { listAttempts, writeAttempt, writeTask } from "../driver/store.mjs";
import {
  applyOperation,
  defaultConfig,
  initRun,
  loadContext,
  operationsOf,
  recover,
  runLoop,
  statusSnapshot,
} from "../driver/run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_COPILOT = path.join(HERE, "fake-copilot.mjs");

// 実測した copilot 1.0.99-2 の help と同じ検出結果になる文面。
const FAKE_HELP = [
  "-p, --prompt <text>",
  "-r, --resume [<value>]",
  "--session-id <id>",
  "--output-format <format>",
  "--no-ask-user",
  "--allow-tool [<tools>...]",
  "--deny-tool [<tools>...]",
  "--model <model>",
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

async function drive(context, maxSteps = 80) {
  return runLoop(context, { maxSteps });
}

async function dispose(fixture) {
  // 停止直後の子プロセスが作業ディレクトリを掴んだままのことがあるため、後片付けは数回試す。
  await removeTree(`${fixture.repoRoot}.worktrees`);
  await fixture.dispose();
}

function eventsOfType(context, type) {
  return context.events.filter((event) => event.type === type);
}

function attemptsOf(context, taskId) {
  return listAttempts(context.layout, taskId);
}

/** 同時に走っていた試行の最大数。枠（tasks）の実効を確かめる。 */
function maxConcurrency(attempts) {
  const points = [];
  for (const attempt of attempts) {
    if (typeof attempt.startedAt !== "string" || typeof attempt.endedAt !== "string") continue;
    points.push({ at: attempt.startedAt, delta: 1 });
    points.push({ at: attempt.endedAt, delta: -1 });
  }
  points.sort((a, b) => (a.at === b.at ? a.delta - b.delta : a.at.localeCompare(b.at)));
  let current = 0;
  let peak = 0;
  for (const point of points) {
    current += point.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function makeTaskRecord(overrides = {}) {
  const at = new Date().toISOString();
  return {
    taskId: "t1",
    title: "復旧テスト",
    prompt: "作業してください。",
    dependsOn: [],
    base: null,
    state: TASK_STATE.RUNNING,
    detail: null,
    message: null,
    attemptCount: 1,
    reworkCount: 0,
    currentAttemptId: "a1",
    lastAttemptId: null,
    submittedHead: null,
    sessionId: "sess-1",
    worktree: "C:\\worktree",
    branch: "agent/t1",
    baseCommit: "0000000",
    integrationId: null,
    integration: null,
    question: null,
    createdAt: at,
    ...overrides,
  };
}

function makeAttemptRecord(overrides = {}) {
  const at = new Date().toISOString();
  return {
    attemptId: "a1",
    taskId: "t1",
    index: 1,
    kind: "dispatch",
    state: ATTEMPT_STATE.RUNNING,
    pid: 0,
    driverPid: 0,
    sessionId: "sess-1",
    worktree: "C:\\worktree",
    branch: "agent/t1",
    baseCommit: "0000000",
    resumedFrom: null,
    args: [],
    startedAt: at,
    endedAt: null,
    note: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ 正常系 */

test("2 つの担当を波に分けて統合し、FINISH で終わる", async () => {
  const fixture = await createFixture();
  try {
    const request = "小さな変更を 2 つ入れる。 [[parent=1:dispatch-two-waves]] [[parent=check-apply]]";
    const { context } = await startRun(fixture, request);
    const { steps, history } = await drive(context);

    assert.equal(context.run.state, RUN_STATE.FINISHED);
    assert.equal(context.run.stopDetail, null);
    assert.equal(steps, history.length);
    assert.equal(history.at(-1).action, "finished");

    // 2 つの担当がどちらも統合されている。
    assert.deepEqual(
      context.tasks.map((task) => task.taskId),
      ["t1", "t2"],
    );
    for (const task of context.tasks) {
      assert.equal(task.state, TASK_STATE.INTEGRATED, `${task.taskId} が統合されていない`);
      assert.equal(task.integration.state, "INTEGRATED");
      assert.equal(task.attemptCount, 1);
    }

    // 波の指定どおり、t2 は t1 の統合後に作業を始めている。
    const [first] = await attemptsOf(context, "t1");
    const [second] = await attemptsOf(context, "t2");
    assert.ok(second.startedAt >= first.endedAt, "t2 が t1 の統合前に始まっている");
    assert.ok(second.baseCommit !== first.baseCommit, "t2 が t1 の統合前の地点から始まっている");

    // 統合先の履歴に 2 つのマージコミットが入っている。
    const mainHead = await fixture.head();
    const parents = await fixture.parents(mainHead);
    assert.equal(parents.length, 2);
    for (const task of context.tasks) {
      assert.equal(await fixture.isAncestor(task.submittedHead, mainHead), true, `${task.taskId} のコミットが統合先に無い`);
    }
    // 証拠ファイル（報告）は統合先のツリーに入れない。
    const tree = await runGit(["-C", fixture.repoRoot, "ls-tree", "-r", "--name-only", mainHead]);
    assert.equal(tree.split(/\r?\n/).some((line) => line.startsWith(".agent-run")), false);

    // 台帳とイベントに流れが残っている。
    const applied = eventsOfType(context, "operation-applied");
    assert.ok(applied.some((event) => event.kind === "DISPATCH" && event.taskId === "t1"));
    assert.ok(applied.some((event) => event.kind === "CHECK_MERGE" && event.taskId === "t1"));
    assert.ok(applied.some((event) => event.kind === "APPLY_MERGE" && event.taskId === "t1"));
    const integrations = eventsOfType(context, "integration-result");
    // CHECK_MERGE と APPLY_MERGE が 2 タスク分。検証済みと公開済みを区別して数える。
    assert.equal(integrations.length, 4);
    assert.equal(integrations.filter((event) => event.state === "VERIFIED_NOT_PUBLISHED").length, 2);
    assert.equal(integrations.filter((event) => event.state === "INTEGRATED").length, 2);
    assert.ok(eventsOfType(context, "run-finished").length === 1);

    const records = await operationsOf(context);
    assert.equal(records.filter((record) => record.status === "applied").length, records.length);
    assert.equal(records.filter((record) => record.kind === "FINISH").length, 1);

    const snapshot = statusSnapshot(context);
    assert.deepEqual(snapshot.summary, { INTEGRATED: 2 });
    assert.equal(snapshot.snapshotRevision, context.run.snapshotRevision);
    assert.ok(snapshot.snapshotRevision > 0);
    assert.equal(snapshot.parent.turns >= 4, true, "親ターンが足りない");
  } finally {
    await dispose(fixture);
  }
});

test("driver の home を統合の側（証拠と候補 worktree）にも使う", async () => {
  const fixture = await createFixture();
  // 環境変数側に別の home を入れておき、driver の home が優先されることを確かめる。
  const stray = await makeTempDir("integrate-task-home-");
  try {
    const request = "1 つの変更を入れる。 [[parent=1:dispatch-done]] [[parent=check-apply]]";
    const { config, context } = await startRun(fixture, request, {
      env: { ...fixture.env, INTEGRATE_TASK_HOME: stray },
    });
    assert.equal(config.env.INTEGRATE_TASK_HOME, fixture.home);

    await drive(context);
    assert.equal(context.run.state, RUN_STATE.FINISHED);
    assert.equal(context.tasks[0].state, TASK_STATE.INTEGRATED);

    // 検証の証拠は driver の home の下だけにある。
    const evidence = await fs.readdir(path.join(fixture.home, "evidence"));
    assert.equal(evidence.length, 1, "証拠が driver の home に無い");
    assert.equal(evidence[0], `int-${context.tasks[0].taskId}`);
    assert.equal(
      await fs.stat(path.join(stray, "evidence")).then(() => true, () => false),
      false,
      "証拠が環境変数の home に書かれている",
    );
  } finally {
    await dispose(fixture);
    await fs.rm(stray, { recursive: true, force: true }).catch(() => {});
  }
});

test("質問で止まった担当は ANSWER で同じセッションを再開して統合する", async () => {
  const fixture = await createFixture();
  try {
    const request = "判断が要る作業。 [[parent=1:dispatch-question]] [[parent=2:answer]] [[parent=check-apply]]";
    const { context } = await startRun(fixture, request);
    await drive(context);

    const task = context.findTask("t1");
    assert.equal(task.state, TASK_STATE.INTEGRATED);

    const attempts = await attemptsOf(context, "t1");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].state, ATTEMPT_STATE.QUESTION);
    assert.match(attempts[0].sessionId, /^[0-9a-f-]{36}$/, "セッション ID が記録されていない");
    // 再開は同じセッション ID を指している。新しい空セッションを作らない。
    assert.equal(attempts[1].kind, "answer");
    assert.equal(attempts[1].resumedFrom, attempts[0].sessionId);
    assert.ok(
      attempts[1].args.includes(`--resume=${attempts[0].sessionId}`),
      `--resume が渡っていない: ${attempts[1].args.join(" ")}`,
    );
    assert.equal(attempts[1].sessionId, attempts[0].sessionId);
    assert.equal(attempts[1].worktree, attempts[0].worktree);

    const applied = eventsOfType(context, "operation-applied");
    assert.ok(applied.some((event) => event.kind === "ANSWER" && event.taskId === "t1"));
    assert.equal(eventsOfType(context, "operation-rejected").length, 0);
  } finally {
    await dispose(fixture);
  }
});

test("行き詰まった担当は REWORK で同じ作業ツリーを続けて統合する", async () => {
  const fixture = await createFixture();
  try {
    const request = "行き詰まりから復帰する。 [[parent=1:dispatch-blocked]] [[parent=2:rework]] [[parent=3:check-apply]] [[parent=4:check-apply]]";
    const { context } = await startRun(fixture, request);
    await drive(context);

    const task = context.findTask("t1");
    assert.equal(task.state, TASK_STATE.INTEGRATED);
    assert.equal(task.reworkCount, 1);

    const attempts = await attemptsOf(context, "t1");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].state, ATTEMPT_STATE.BLOCKED);
    assert.equal(attempts[1].kind, "rework");
    assert.equal(attempts[1].resumedFrom, attempts[0].sessionId);
    assert.equal(attempts[1].worktree, attempts[0].worktree, "差し戻しで作業ツリーを作り直している");

    const rework = eventsOfType(context, "operation-applied").find((event) => event.kind === "REWORK");
    assert.equal(rework.resetWorktree, false);
    assert.equal(task.integration.state, "INTEGRATED");
  } finally {
    await dispose(fixture);
  }
});

test("tasks の枠が 1 なら担当は同時に走らない", async () => {
  const fixture = await createFixture();
  try {
    const request = "独立した 2 つ。 [[parent=1:dispatch-independent]] [[parent=check-apply]]";
    const { context } = await startRun(fixture, request, { pools: { tasks: 1, verify: 1, integration: 1 } });
    await drive(context);

    const attempts = [...(await attemptsOf(context, "t1")), ...(await attemptsOf(context, "t2"))];
    assert.equal(maxConcurrency(attempts), 1, "枠を超えて同時に走っている");
    assert.equal(context.findTask("t1").state, TASK_STATE.INTEGRATED);
    assert.equal(context.findTask("t2").state, TASK_STATE.INTEGRATED);
  } finally {
    await dispose(fixture);
  }
});

/* ------------------------------------------------------- 担当の異常終了の扱い */

test("提出の証拠が足りない担当は統合せず人間の判断に回す", async () => {
  const cases = [
    ["dirty", TASK_DETAIL.WORKTREE_DIRTY],
    ["nocommit", TASK_DETAIL.NO_NEW_COMMITS],
    ["nohead", TASK_DETAIL.SUBMITTED_HEAD_MISSING],
    ["done-then-extra", TASK_DETAIL.SUBMITTED_HEAD_MISMATCH],
  ];
  for (const [mode, detail] of cases) {
    const fixture = await createFixture();
    try {
      const request = `証拠が足りない作業。 [[parent=1:dispatch-any]] [[task=${mode}]]`;
      const { context } = await startRun(fixture, request);
      await drive(context);

      assert.equal(context.run.state, RUN_STATE.STOPPED, `${mode}: 停止していない`);
      assert.equal(context.run.stopDetail, TASK_DETAIL.HUMAN_REQUESTED, `${mode}: 停止理由が違う`);

      const task = context.findTask("t1");
      assert.equal(task.state, TASK_STATE.NEEDS_HUMAN, `${mode}: 人間の判断に回っていない`);
      assert.equal(task.detail, detail, `${mode}: 詳細が違う`);
      assert.equal(task.submittedHead, null, `${mode}: 提出コミットを記録している`);

      // 提出として扱っていないので、統合は一度も走っていない。
      assert.equal(eventsOfType(context, "integration-result").length, 0);
      assert.equal((await fixture.head()), fixture.expectedTargetHead, `${mode}: 統合先が動いている`);
    } finally {
      await dispose(fixture);
    }
  }
});

test("報告の無い終了コード 0 は成功として扱わない", async () => {
  const fixture = await createFixture();
  try {
    const request = "報告を書かない担当。 [[parent=1:dispatch-any]] [[task=noreport]]";
    const { context } = await startRun(fixture, request);
    await drive(context);

    assert.equal(context.run.state, RUN_STATE.STOPPED);
    assert.equal(context.run.stopDetail, TASK_DETAIL.HUMAN_REQUESTED);
    const task = context.findTask("t1");
    assert.equal(task.state, TASK_STATE.NEEDS_HUMAN);
    assert.equal(task.detail, TASK_DETAIL.UNCLASSIFIED_OUTPUT);

    const [attempt] = await attemptsOf(context, "t1");
    assert.equal(attempt.exitCode, 0);
    assert.equal(attempt.classification.state, TASK_STATE.NEEDS_HUMAN);
    // 報告が無く成功と言えないので、試行の結果は「分類不能」として残す。
    assert.equal(attempt.state, ATTEMPT_STATE.UNKNOWN);
    assert.equal(attempt.classification.detail, TASK_DETAIL.UNCLASSIFIED_OUTPUT);
    assert.equal(await fixture.head(), fixture.expectedTargetHead);
  } finally {
    await dispose(fixture);
  }
});

test("報告もコミットも無い異常終了は人間の判断に回す", async () => {
  const fixture = await createFixture();
  try {
    const request = "異常終了する担当。 [[parent=1:dispatch-any]] [[task=exit3]] [[parent=request-human]]";
    const { context } = await startRun(fixture, request);
    await drive(context);

    const task = context.findTask("t1");
    assert.equal(task.state, TASK_STATE.NEEDS_HUMAN);
    assert.equal(task.detail, TASK_DETAIL.HUMAN_REQUESTED);
    assert.equal(context.run.state, RUN_STATE.STOPPED);
    assert.equal(context.run.stopDetail, TASK_DETAIL.HUMAN_REQUESTED);

    const [attempt] = await attemptsOf(context, "t1");
    assert.equal(attempt.exitCode, 3);
    assert.equal(attempt.classification.state, ATTEMPT_STATE.BLOCKED);
    assert.equal(attempt.classification.detail, TASK_DETAIL.EXIT_NONZERO);
    // 親が REQUEST_HUMAN を出すまでの間、タスクは差し戻し可能な状態に置かれる。
    const states = eventsOfType(context, "task-state").map((event) => event.state);
    assert.ok(states.includes(TASK_STATE.BLOCKED));
    assert.ok(eventsOfType(context, "operation-applied").some((event) => event.kind === "REQUEST_HUMAN"));
  } finally {
    await dispose(fixture);
  }
});

test("権限拒否は BLOCKED として記録し、人間の判断に回す", async () => {
  const fixture = await createFixture();
  try {
    const request = "権限が足りない担当。 [[parent=1:dispatch-any]] [[task=permission-blocked]] [[parent=request-human]]";
    const { context } = await startRun(fixture, request);
    await drive(context);

    const [attempt] = await attemptsOf(context, "t1");
    assert.equal(attempt.classification.state, ATTEMPT_STATE.BLOCKED);
    assert.equal(attempt.classification.detail, TASK_DETAIL.PERMISSION_DENIED);
    assert.equal(attempt.classification.permissionHint, true);

    const task = context.findTask("t1");
    assert.equal(task.state, TASK_STATE.NEEDS_HUMAN);
    assert.equal(context.run.stopDetail, TASK_DETAIL.HUMAN_REQUESTED);
    assert.equal(await fixture.head(), fixture.expectedTargetHead);
  } finally {
    await dispose(fixture);
  }
});

test("許可されていないツールの拒否も権限拒否として拾う", async () => {
  const fixture = await createFixture();
  try {
    const request = "拒否された担当。 [[parent=1:dispatch-any]] [[task=denied-noreport]]";
    const { context } = await startRun(fixture, request);
    await drive(context);

    const [attempt] = await attemptsOf(context, "t1");
    assert.equal(attempt.classification.detail, TASK_DETAIL.UNCLASSIFIED_OUTPUT);
    assert.equal(attempt.classification.permissionHint, true, "拒否の記録を拾えていない");
    assert.equal(context.findTask("t1").state, TASK_STATE.NEEDS_HUMAN);
  } finally {
    await dispose(fixture);
  }
});

test("時間切れの担当は INTERRUPTED として記録し、REWORK で復帰できる", async () => {
  const fixture = await createFixture();
  try {
    const request =
      "終わらない担当。 [[parent=1:dispatch-any]] [[parent=rework]] [[parent=3:check-apply]] [[parent=4:check-apply]] [[task=sleep]]";
    const { context } = await startRun(fixture, request, { timeoutMinutes: 0.01 });
    await drive(context);

    const attempts = await attemptsOf(context, "t1");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].timedOut, true);
    assert.equal(attempts[0].state, ATTEMPT_STATE.INTERRUPTED);
    assert.equal(attempts[0].classification.detail, TASK_DETAIL.TIMEOUT);
    assert.equal(attempts[1].kind, "rework");
    assert.equal(context.findTask("t1").state, TASK_STATE.INTEGRATED);

    // 時間切れでも証拠（ログ）は残す。
    const log = await fs.readFile(path.join(context.layout.logs, `${attempts[0].attemptId}.log`), "utf8");
    assert.ok(log.length > 0);
  } finally {
    await dispose(fixture);
  }
});

/* --------------------------------------------------------- 親の操作の検証 */

test("操作を提案しない親は上限に達したら停止する", async () => {
  const fixture = await createFixture();
  try {
    const request = "提案のない親。 [[parent=echo-example]]";
    const { context } = await startRun(fixture, request);
    await drive(context);

    assert.equal(context.run.state, RUN_STATE.STOPPED);
    assert.equal(context.run.stopDetail, TASK_DETAIL.NO_OPERATION);
    assert.equal(context.tasks.length, 0, "例文のフェンスを提案として拾っている");
    assert.equal((await operationsOf(context)).length, 0);
    assert.equal(eventsOfType(context, "parent-session-started").length, 2);
  } finally {
    await dispose(fixture);
  }
});

test("古い snapshotRevision の提案は適用しない", async () => {
  const fixture = await createFixture();
  try {
    // 2 ターン目は何も提案しない。提案が無い状態が続けば NO_OPERATION で停止する。
    const request = "古い提案。 [[parent=1:stale]]";
    const { context } = await startRun(fixture, request);
    await drive(context);

    assert.equal(context.tasks.length, 0);
    assert.equal(context.run.state, RUN_STATE.STOPPED);
    assert.equal(context.run.stopDetail, TASK_DETAIL.NO_OPERATION);

    const rejected = eventsOfType(context, "operation-rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].detail, TASK_DETAIL.SNAPSHOT_STALE);
    const records = await operationsOf(context);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, "rejected");
    assert.equal(records[0].detail, TASK_DETAIL.SNAPSHOT_STALE);
    assert.ok(records[0].presentedRevision > records[0].snapshotRevision);
  } finally {
    await dispose(fixture);
  }
});

test("知らない操作種別と知らない taskId は適用しない", async () => {
  for (const mode of ["unknown-kind", "unknown-task"]) {
    const fixture = await createFixture();
    try {
      const request = `不正な提案。 [[parent=1:${mode}]]`;
      const { context } = await startRun(fixture, request);
      await drive(context);

      assert.equal(context.tasks.length, 0, `${mode}: タスクを作っている`);
      assert.equal(context.run.state, RUN_STATE.STOPPED, `${mode}: 停止していない`);
      assert.equal(context.run.stopDetail, TASK_DETAIL.NO_OPERATION, `${mode}: 停止の理由が違う`);

      const rejected = eventsOfType(context, "operation-rejected");
      assert.equal(rejected.length, 1, `${mode}: 拒否の記録が無い`);
      assert.equal(rejected[0].detail, TASK_DETAIL.OPERATION_INVALID, `${mode}: 拒否の理由が違う`);
      // 種別と taskId の検証は applyOperation の前段で落ちるので台帳には残さない。
      assert.equal((await operationsOf(context)).length, 0, `${mode}: 台帳に残している`);
    } finally {
      await dispose(fixture);
    }
  }
});

/* --------------------------------------------- applyOperation の単体の検証 */

test("同じ operationId と古い revision と不正な状態を拒否する", async () => {
  const fixture = await createFixture();
  try {
    const { context } = await startRun(fixture, "操作の検証。");
    const revision = context.run.snapshotRevision;

    const dispatch = {
      operationId: "op-1",
      snapshotRevision: revision,
      kind: "DISPATCH",
      taskId: "t1",
      payload: { title: "担当1", prompt: "作業してください。", dependsOn: [] },
    };
    assert.equal((await applyOperation(context, dispatch)).status, "applied");
    assert.equal(context.tasks.length, 1);
    assert.equal(context.tasks[0].state, TASK_STATE.PLANNED);

    // 同じ operationId は二重に適用しない。
    const duplicate = await applyOperation(context, { ...dispatch, snapshotRevision: context.run.snapshotRevision });
    assert.equal(duplicate.status, "rejected");
    assert.equal(duplicate.detail, TASK_DETAIL.OPERATION_DUPLICATE);
    assert.equal(context.tasks.length, 1);

    // 同じ taskId の再配送も拒否する。
    const again = await applyOperation(context, {
      ...dispatch,
      operationId: "op-2",
      snapshotRevision: context.run.snapshotRevision,
    });
    assert.equal(again.status, "rejected");
    assert.equal(again.detail, TASK_DETAIL.OPERATION_INVALID);

    // 提示した revision と違う提案は適用しない。
    const stale = await applyOperation(context, {
      operationId: "op-3",
      snapshotRevision: revision,
      kind: "DISPATCH",
      taskId: "t2",
      payload: { title: "担当2", prompt: "作業してください。", dependsOn: [] },
    });
    assert.equal(stale.status, "rejected");
    assert.equal(stale.detail, TASK_DETAIL.SNAPSHOT_STALE);
    assert.equal(context.tasks.length, 1);

    // 存在しない taskId。
    const missing = await applyOperation(context, {
      operationId: "op-4",
      snapshotRevision: context.run.snapshotRevision,
      kind: "CHECK_MERGE",
      taskId: "t9",
      payload: {},
    });
    assert.equal(missing.status, "rejected");
    assert.equal(missing.detail, TASK_DETAIL.TASK_NOT_FOUND);

    // 未対応の種別（検証をすり抜けた場合の最後の砦）。
    const unknown = await applyOperation(context, {
      operationId: "op-5",
      snapshotRevision: context.run.snapshotRevision,
      kind: "DEPLOY",
      taskId: null,
      payload: {},
    });
    assert.equal(unknown.status, "rejected");
    assert.equal(unknown.detail, TASK_DETAIL.OPERATION_INVALID);

    // 提出待ちでないタスクの検証と統合。
    for (const kind of ["CHECK_MERGE", "APPLY_MERGE"]) {
      const rejected = await applyOperation(context, {
        operationId: `op-${kind}`,
        snapshotRevision: context.run.snapshotRevision,
        kind,
        taskId: "t1",
        payload: {},
      });
      assert.equal(rejected.detail, TASK_DETAIL.TASK_STATE_INVALID, `${kind} を適用している`);
    }

    // 質問待ちでないタスクへの回答。
    const answer = await applyOperation(context, {
      operationId: "op-answer",
      snapshotRevision: context.run.snapshotRevision,
      kind: "ANSWER",
      taskId: "t1",
      payload: { answer: "進めてください。" },
    });
    assert.equal(answer.detail, TASK_DETAIL.TASK_STATE_INVALID);

    // 未統合のタスクが残っているうちは FINISH できない。
    const finish = await applyOperation(context, {
      operationId: "op-finish",
      snapshotRevision: context.run.snapshotRevision,
      kind: "FINISH",
      taskId: null,
      payload: { summary: "終わり" },
    });
    assert.equal(finish.detail, TASK_DETAIL.OPERATION_INVALID);
    assert.equal(context.run.state, RUN_STATE.RUNNING);

    const rejected = eventsOfType(context, "operation-rejected");
    assert.ok(rejected.length >= 8, `拒否の記録が足りない: ${rejected.length}`);
    assert.equal(context.run.snapshotRevision > revision, true, "revision が進んでいない");
  } finally {
    await dispose(fixture);
  }
});

test("再開するセッションが無い回答は人間の判断に回す", async () => {
  const fixture = await createFixture();
  try {
    const { context } = await startRun(fixture, "セッション消失。");
    await writeTask(context.layout, makeTaskRecord({ state: TASK_STATE.NEEDS_PARENT, sessionId: null, question: "どうしますか。" }));
    context.tasks = (await loadContext(context.config, context.run.runId, { recover: false })).tasks;

    const answer = await applyOperation(context, {
      operationId: "op-answer",
      snapshotRevision: context.run.snapshotRevision,
      kind: "ANSWER",
      taskId: "t1",
      payload: { answer: "進めてください。" },
    });
    assert.equal(answer.status, "rejected");
    assert.equal(answer.detail, TASK_DETAIL.SESSION_LOST);
    assert.equal(context.findTask("t1").state, TASK_STATE.NEEDS_HUMAN);
    assert.equal(context.findTask("t1").detail, TASK_DETAIL.SESSION_LOST);
  } finally {
    await dispose(fixture);
  }
});

test("差し戻しの上限を超えた REWORK は拒否する", async () => {
  const fixture = await createFixture();
  try {
    const { context } = await startRun(fixture, "差し戻しの上限。", { maxReworks: 1 });
    await writeTask(context.layout, makeTaskRecord({ state: TASK_STATE.BLOCKED, reworkCount: 1 }));
    const reloaded = await loadContext(context.config, context.run.runId, { recover: false });
    context.tasks = reloaded.tasks;

    const rework = await applyOperation(context, {
      operationId: "op-rework",
      snapshotRevision: context.run.snapshotRevision,
      kind: "REWORK",
      taskId: "t1",
      payload: { instruction: "やり直してください。" },
    });
    assert.equal(rework.status, "rejected");
    assert.equal(rework.detail, TASK_DETAIL.TASK_STATE_INVALID);
    assert.equal((await attemptsOf(context, "t1")).length, 0, "上限を超えて試行を起動している");
  } finally {
    await dispose(fixture);
  }
});

/* ------------------------------------------------------------------ 復旧 */

test("再起動時に所有権の分からない試行へ触らない", async () => {
  const fixture = await createFixture();
  try {
    const { context } = await startRun(fixture, "復旧。");
    const foreignPid = isProcessAlive(process.ppid) ? process.ppid : 4;

    await writeTask(context.layout, makeTaskRecord({ state: TASK_STATE.RUNNING }));
    // 生きている別の driver が所有している試行。
    await writeAttempt(context.layout, makeAttemptRecord({ driverPid: foreignPid, pid: foreignPid }));
    // 自分の driver が所有している試行（同じプロセスなので生きている扱い）。
    await writeAttempt(context.layout, makeAttemptRecord({ attemptId: "a2", index: 2, driverPid: process.pid, pid: process.pid }));
    // driver が消えた後も残っているプロセス。
    await writeAttempt(context.layout, makeAttemptRecord({ attemptId: "a3", index: 3, driverPid: 0, pid: foreignPid }));

    const changes = await recover(context);
    const attempts = await attemptsOf(context, "t1");
    assert.deepEqual(
      attempts.map((attempt) => attempt.state),
      [ATTEMPT_STATE.RUNNING, ATTEMPT_STATE.RUNNING, ATTEMPT_STATE.UNKNOWN],
    );
    assert.deepEqual(changes, [{ attemptId: "a3", action: "owner-unknown" }]);
    assert.equal(context.findTask("t1").state, TASK_STATE.NEEDS_HUMAN);
    assert.equal(context.findTask("t1").detail, TASK_DETAIL.OWNER_UNKNOWN);
    assert.equal(eventsOfType(context, "recovered").length, 1);
  } finally {
    await dispose(fixture);
  }
});

test("再起動時に終わっていた試行は INTERRUPTED として記録する", async () => {
  const fixture = await createFixture();
  try {
    const { context } = await startRun(fixture, "復旧。");
    await writeTask(context.layout, makeTaskRecord({ state: TASK_STATE.RUNNING }));
    await writeAttempt(context.layout, makeAttemptRecord({ driverPid: 0, pid: 0 }));

    const changes = await recover(context);
    const [attempt] = await attemptsOf(context, "t1");
    assert.equal(attempt.state, ATTEMPT_STATE.INTERRUPTED);
    assert.equal(changes[0].action, "interrupted");
    assert.equal(context.findTask("t1").state, TASK_STATE.INTERRUPTED);
    assert.equal(context.findTask("t1").detail, TASK_DETAIL.STOPPED);
  } finally {
    await dispose(fixture);
  }
});

test("検証の途中で落ちたタスクは提出待ちに戻して再検証させる", async () => {
  const fixture = await createFixture();
  try {
    const { context } = await startRun(fixture, "復旧。");
    await writeTask(
      context.layout,
      makeTaskRecord({
        state: TASK_STATE.VERIFYING,
        integrationId: "int-t1",
        submittedHead: fixture.submittedHead,
      }),
    );

    const changes = await recover(context);
    assert.equal(context.findTask("t1").state, TASK_STATE.SUBMITTED);
    assert.equal(context.findTask("t1").detail, TASK_DETAIL.INTEGRATION_FAILED);
    assert.equal(changes[0].action, "verify-interrupted");
    // 台帳の記録は消さない。検証をやり直すだけ。
    assert.equal(context.findTask("t1").integrationId, "int-t1");
  } finally {
    await dispose(fixture);
  }
});
