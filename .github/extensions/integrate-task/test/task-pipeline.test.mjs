import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runVerifyCommands } from "../core/verify.mjs";
import { createTaskPipelineRun } from "../task/engine.mjs";
import { validateTaskArgs } from "../task/state.mjs";
import { createTaskPorts } from "../task/ports.mjs";
import { FAIL_COMMAND, MUTATE_COMMAND, createFixture, defaultPolicy, runGit, writeFile } from "./helpers.mjs";

// 1 回目の検証だけ失敗させたいので、実装役が作るファイルの有無で結果を変える。
const GATE_COMMAND = {
  name: "gate",
  command: "node",
  args: ["-e", "process.exit(require('fs').existsSync('src/gate.txt') ? 0 : 3)"],
  timeoutSeconds: 120,
};

async function runPipeline(fixture, args, onAgent) {
  const calls = [];
  const ctx = {
    args,
    log: () => {},
    phase: () => {},
    signal: undefined,
    async agent(prompt, options) {
      calls.push({ prompt, options });
      return onAgent({ prompt, options, index: calls.length });
    },
  };
  const ports = createTaskPorts({ cwd: fixture.repoRoot, env: fixture.env });
  const result = await createTaskPipelineRun(ports)(ctx);
  return { result, calls };
}

function approve() {
  return { verdict: "approve", findings: [], summary: "受入条件を満たしています。" };
}

test("task-pipeline: 実装→検証→レビューが通ると提出コミットを作る", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());

  const { result, calls } = await runPipeline(
    fixture,
    { taskId: "T-1", title: "実装を追加する", prompt: "src/impl.txt を作る" },
    async ({ options }) => {
      if (options.label.startsWith("review:")) return approve();
      await writeFile(fixture.repoRoot, "src/impl.txt", "implemented\n");
      return "src/impl.txt を作成しました。";
    },
  );

  assert.equal(result.state, "SUBMITTED");
  assert.equal(result.detail, "submitted");
  assert.equal(result.attempts, 1);
  assert.equal(result.maxAttempts, 3);
  assert.equal(result.verifySource, "policy");
  assert.equal(result.verify.ok, true);
  assert.equal(result.verify.mutated, false);
  assert.equal(result.review.verdict, "approve");
  assert.equal(result.mainCheckout, true);
  assert.equal(result.committedByWorkflow, true);
  assert.deepEqual(result.files, ["src/impl.txt"]);
  assert.notEqual(result.submittedHead, result.baseCommit);

  assert.deepEqual(
    calls.map((call) => call.options.label),
    ["implement:T-1:1", "review:T-1:1"],
  );
  assert.ok(calls[0].prompt.includes(fixture.repoRoot), "実装プロンプトに作業ツリーの絶対パスが入る");
  assert.ok(calls[0].prompt.includes("コミットしないでください"), "実装役にはコミットさせない");
  assert.equal(calls[0].options.schema, undefined);

  const message = await runGit(["-C", fixture.repoRoot, "log", "-1", "--pretty=%s"], fixture.repoRoot);
  assert.equal(message, "T-1: 実装を追加する");
  assert.equal(await runGit(["-C", fixture.repoRoot, "status", "--porcelain"], fixture.repoRoot), "");

  const evidenceDir = path.join(fixture.home, result.evidenceRef);
  assert.deepEqual((await fs.readdir(evidenceDir)).sort(), [
    "result.json",
    "review-1.json",
    "start.json",
    "verify-1-pass.stderr.txt",
    "verify-1-pass.stdout.txt",
    "verify-1.json",
    "verify-summary.json",
  ]);
  const start = JSON.parse(await fs.readFile(path.join(evidenceDir, "start.json"), "utf8"));
  assert.equal(start.baseCommit, result.baseCommit);
  assert.equal(start.commands.length, 1);
});

test("task-pipeline: 検証が失敗したら修正役へ渡し、通れば提出する", async (t) => {
  const fixture = await createFixture({ policy: defaultPolicy({ verify: [GATE_COMMAND] }) });
  t.after(() => fixture.dispose());

  const { result, calls } = await runPipeline(
    fixture,
    { taskId: "T-2", title: "検証を通す", prompt: "src/gate.txt を用意する" },
    async ({ options }) => {
      if (options.label.startsWith("review:")) return approve();
      if (options.label.startsWith("fix:")) {
        await writeFile(fixture.repoRoot, "src/gate.txt", "ok\n");
        return "gate.txt を追加しました。";
      }
      await writeFile(fixture.repoRoot, "src/impl.txt", "implemented\n");
      return "src/impl.txt を作成しました。";
    },
  );

  assert.equal(result.state, "SUBMITTED");
  assert.equal(result.attempts, 2);
  assert.deepEqual(
    calls.map((call) => call.options.label),
    ["implement:T-2:1", "fix:T-2:2", "review:T-2:2"],
  );
  assert.ok(calls[1].prompt.includes("gate"), "修正プロンプトに失敗した検証コマンドが入る");
  assert.ok(calls[1].prompt.includes("終了コード 3"), "修正プロンプトに終了コードが入る");
  assert.equal(result.verify.ok, true);

  const evidenceDir = path.join(fixture.home, result.evidenceRef);
  const first = JSON.parse(await fs.readFile(path.join(evidenceDir, "verify-1.json"), "utf8"));
  assert.equal(first.ok, false);
  assert.equal(first.results[0].code, 3);
  assert.deepEqual(first.failures, [{ name: "gate", code: 3 }]);
});

test("task-pipeline: レビューが差し戻したら修正して再レビューする", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());

  const { result, calls } = await runPipeline(
    fixture,
    { taskId: "T-3", title: "レビュー指摘を直す", prompt: "src/impl.txt に本文を書く" },
    async ({ options }) => {
      if (options.label === "review:T-3:1") {
        return { verdict: "revise", findings: ["src/impl.txt が空です"], summary: "本文が必要です。" };
      }
      if (options.label === "review:T-3:2") return approve();
      await writeFile(fixture.repoRoot, "src/impl.txt", options.label.startsWith("fix:") ? "body\n" : "");
      return "src/impl.txt を更新しました。";
    },
  );

  assert.equal(result.state, "SUBMITTED");
  assert.equal(result.attempts, 2);
  assert.deepEqual(
    calls.map((call) => call.options.label),
    ["implement:T-3:1", "review:T-3:1", "fix:T-3:2", "review:T-3:2"],
  );
  assert.ok(calls[2].prompt.includes("src/impl.txt が空です"), "修正プロンプトにレビューの指摘が入る");
  assert.equal(result.review.verdict, "approve");
  assert.deepEqual(result.review.findings, []);
});

test("task-pipeline: 検証が通らないまま再試行を使い切ると親へ返す", async (t) => {
  const fixture = await createFixture({ policy: defaultPolicy({ verify: [FAIL_COMMAND] }) });
  t.after(() => fixture.dispose());

  const { result, calls } = await runPipeline(
    fixture,
    { taskId: "T-4", title: "通らない検証", prompt: "何かする", maxReworks: 1 },
    async () => "何もしませんでした。",
  );

  assert.equal(result.state, "NEEDS_PARENT");
  assert.equal(result.detail, "rework-exhausted");
  assert.equal(result.attempts, 2);
  assert.equal(result.maxAttempts, 2);
  assert.equal(result.verify.ok, false);
  assert.equal(result.review, null);
  assert.deepEqual(
    calls.map((call) => call.options.label),
    ["implement:T-4:1", "fix:T-4:2"],
  );
});

test("task-pipeline: 検証が作業ツリーを書き換えたら不合格にする", async (t) => {
  const fixture = await createFixture({ policy: defaultPolicy({ verify: [MUTATE_COMMAND] }) });
  t.after(() => fixture.dispose());

  const { result } = await runPipeline(
    fixture,
    { taskId: "T-5", title: "検証が汚す", prompt: "何かする", maxReworks: 0 },
    async () => "何もしませんでした。",
  );

  assert.equal(result.state, "NEEDS_PARENT");
  assert.equal(result.detail, "rework-exhausted");
  assert.equal(result.verify.mutated, true);
  assert.equal(result.verify.ok, false);
});

test("task-pipeline: verify 引数でポリシーの検証コマンドを置き換えられる", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());

  const { result } = await runPipeline(
    fixture,
    { taskId: "T-6", title: "検証を差し替える", prompt: "何かする", maxReworks: 0, verify: [FAIL_COMMAND] },
    async () => "何もしませんでした。",
  );

  assert.equal(result.state, "NEEDS_PARENT");
  assert.equal(result.detail, "rework-exhausted");
  assert.equal(result.verifySource, "args");
  assert.equal(result.verify.results[0].name, "fail");
});

test("task-pipeline: レビュー役が結果を返さなければ親へ返す", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());

  const { result, calls } = await runPipeline(
    fixture,
    { taskId: "T-7", title: "レビューが落ちる", prompt: "src/impl.txt を作る", maxReworks: 0 },
    async ({ options }) => {
      if (options.label.startsWith("review:")) return null;
      await writeFile(fixture.repoRoot, "src/impl.txt", "implemented\n");
      return "作成しました。";
    },
  );

  assert.equal(result.state, "NEEDS_PARENT");
  assert.equal(result.detail, "review-unavailable");
  assert.equal(result.attempts, 1);
  assert.equal(calls.length, 2);
  const evidenceDir = path.join(fixture.home, result.evidenceRef);
  assert.equal(await fs.readFile(path.join(evidenceDir, "review-1.json"), "utf8"), "null\n");
});

test("task-pipeline: 変更がなければ提出コミットを作らない", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());

  const { result } = await runPipeline(
    fixture,
    { taskId: "T-8", title: "何も変えない", prompt: "変更しない" },
    async ({ options }) => (options.label.startsWith("review:") ? approve() : "変更は不要でした。"),
  );

  assert.equal(result.state, "NEEDS_PARENT");
  assert.equal(result.detail, "nothing-to-submit");
  assert.equal(result.submittedHead, null);
  assert.deepEqual(result.pending, []);
  assert.equal(await runGit(["-C", fixture.repoRoot, "log", "-1", "--pretty=%s"], fixture.repoRoot), "initial");
});

test("task-pipeline: 作業ツリーが汚れていれば subagent を起動しない", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  await writeFile(fixture.repoRoot, "src/dirty.txt", "dirty\n");

  const { result, calls } = await runPipeline(
    fixture,
    { taskId: "T-9", title: "汚れた作業ツリー", prompt: "何かする" },
    async () => "呼ばれないはずです。",
  );

  assert.equal(result.state, "NEEDS_PARENT");
  assert.equal(result.detail, "worktree-dirty");
  assert.equal(calls.length, 0);
  assert.deepEqual(result.status, ["?? src/dirty.txt"]);
});

test("task-pipeline: 引数が不正なら subagent を起動しない", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());

  const { result, calls } = await runPipeline(
    fixture,
    { taskId: "T-10", title: "未知の引数", prompt: "何かする", unknownKey: 1 },
    async () => "呼ばれないはずです。",
  );

  assert.equal(result.state, "NEEDS_PARENT");
  assert.equal(result.detail, "invalid-arguments");
  assert.match(result.message, /未知の引数/);
  assert.equal(calls.length, 0);
});

test("task-pipeline: 引数の検証", () => {
  assert.throws(() => validateTaskArgs(null), /オブジェクト/);
  assert.throws(() => validateTaskArgs({ taskId: "-x", title: "t", prompt: "p" }), /taskId/);
  assert.throws(() => validateTaskArgs({ taskId: "x", title: " ", prompt: "p" }), /title/);
  assert.throws(() => validateTaskArgs({ taskId: "x", title: "t", prompt: " " }), /prompt/);
  assert.throws(() => validateTaskArgs({ taskId: "x", title: "t", prompt: "p", roles: { tester: {} } }), /未知の役割/);
  assert.throws(() => validateTaskArgs({ taskId: "x", title: "t", prompt: "p", roles: { reviewer: { effort: "high" } } }), /未知のキー/);
  assert.throws(() => validateTaskArgs({ taskId: "x", title: "t", prompt: "p", maxReworks: 9 }), /maxReworks/);
  assert.throws(() => validateTaskArgs({ taskId: "x", title: "t", prompt: "p", verify: [] }), /verify/);
  assert.throws(() => validateTaskArgs({ taskId: "x", title: "t", prompt: "p", verify: [{ name: "a" }] }), /command/);

  const args = validateTaskArgs({
    taskId: "T-11",
    title: "t",
    prompt: "p",
    roles: { reviewer: { reasoningEffort: "high" } },
    verify: [{ name: "lint", command: "npm", args: ["run", "lint"] }],
  });
  assert.deepEqual(args.roles, { implementer: {}, reviewer: { reasoningEffort: "high" } });
  assert.equal(args.maxReworks, 2);
  assert.equal(args.commitMessage, null);
  assert.deepEqual(args.verify, [{ name: "lint", command: "npm", args: ["run", "lint"], timeoutSeconds: 600 }]);
});

test("task-pipeline: captureOutput は失敗した検証の出力末尾を返す", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const evidenceDir = path.join(fixture.home, "manual-evidence");
  await fs.mkdir(evidenceDir, { recursive: true });

  const outcome = await runVerifyCommands({
    worktree: fixture.repoRoot,
    policy: {
      verify: [{ name: "noisy", command: "node", args: ["-e", "console.error('boom'); process.exit(4)"], timeoutSeconds: 120 }],
    },
    evidenceDir,
    captureOutput: true,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.failed[0].code, 4);
  assert.equal(outcome.failed[0].stdout, "");
  assert.ok(outcome.failed[0].stderr.includes("boom"));
  const withoutCapture = await runVerifyCommands({
    worktree: fixture.repoRoot,
    policy: {
      verify: [{ name: "noisy", command: "node", args: ["-e", "console.error('boom'); process.exit(4)"], timeoutSeconds: 120 }],
    },
    evidenceDir,
  });
  assert.equal(withoutCapture.failed[0].stderr, undefined, "既定では出力を持ち回らない");
});
