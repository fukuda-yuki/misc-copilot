import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { acquireLock, releaseLock } from "../core/lock.mjs";
import { DETAIL, LEDGER_STATE, STATE } from "../core/state.mjs";
import { ensureHome, homeLayout, resolveHome } from "../core/store.mjs";
import { readOperation, updateOperation } from "../integrate/ledger.mjs";
import { readRegisteredOperation, registerOperation, removeOperation } from "../integrate/ports.mjs";
import { FAIL_COMMAND, MUTATE_COMMAND, commitAll, createFixture, defaultPolicy, runWorkflow } from "./helpers.mjs";

test("apply: merge --no-ff の履歴を保って統合する", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  await fixture.register("op-apply");

  const outcome = await runWorkflow(fixture, "op-apply", "apply");
  assert.equal(outcome.state, STATE.INTEGRATED);
  assert.equal(outcome.detail, "integrated");
  assert.equal(outcome.operationId, "op-apply");
  assert.equal(outcome.mode, "apply");
  assert.equal(outcome.evidenceRef, path.join("evidence", "op-apply", "000"));

  const head = await fixture.head();
  assert.equal(head, outcome.candidateHead);
  assert.deepEqual((await fixture.parents(head)).sort(), [fixture.expectedTargetHead, fixture.submittedHead].sort());
  assert.equal(await fixture.isAncestor(fixture.submittedHead, head), true);
  assert.equal(await fixture.isAncestor(fixture.expectedTargetHead, head), true);
  assert.equal(await fixture.head("refs/heads/child"), fixture.submittedHead);
  assert.equal(existsSync(path.join(fixture.home, outcome.evidenceRef, "verify-summary.json")), true);

  const record = await readRegisteredOperation("op-apply", { env: fixture.env });
  assert.equal(record.state, STATE.INTEGRATED);
  assert.equal(record.integrationCommit, head);
  assert.ok(record.integratedAt);
  assert.ok(record.evidenceRef);
});

test("check: 候補を作って検証し、ターゲットは動かさない", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  await fixture.register("op-check");

  const outcome = await runWorkflow(fixture, "op-check", "check");
  assert.equal(outcome.state, STATE.VERIFIED_NOT_PUBLISHED);
  assert.equal(outcome.detail, DETAIL.CHECK_ONLY);
  assert.equal(outcome.mode, "check");
  assert.equal(await fixture.head(), fixture.expectedTargetHead);
  assert.equal((await fixture.parents(outcome.candidateHead)).length, 2);
  assert.equal(await fixture.isAncestor(fixture.submittedHead, outcome.candidateHead), true);
  assert.equal(await fixture.isAncestor(fixture.expectedTargetHead, outcome.candidateHead), true);

  const record = await readRegisteredOperation("op-check", { env: fixture.env });
  assert.equal(record.state, STATE.VERIFIED_NOT_PUBLISHED);
  assert.equal(record.candidateHead, outcome.candidateHead);
  assert.equal(record.candidateWorktree, path.join(fixture.home, "worktrees", "op-check"));
  assert.equal(existsSync(record.candidateWorktree), true);
});

test("apply: 二重実行は already-integrated で HEAD を動かさない", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  await fixture.register("op-twice");

  const first = await runWorkflow(fixture, "op-twice", "apply");
  assert.equal(first.state, STATE.INTEGRATED);
  const merged = await fixture.head();

  const second = await runWorkflow(fixture, "op-twice", "apply");
  assert.equal(second.state, STATE.INTEGRATED);
  assert.equal(second.detail, DETAIL.ALREADY_INTEGRATED);
  assert.equal(await fixture.head(), merged);
  assert.equal(second.candidateHead, merged);
  assert.equal((await fixture.parents(merged)).length, 2);
});

test("apply: 検証失敗は NEEDS_PARENT / verify-failed で反映しない", async (t) => {
  const fixture = await createFixture({ policy: defaultPolicy({ verify: [FAIL_COMMAND] }) });
  t.after(() => fixture.dispose());
  await fixture.register("op-fail");

  const outcome = await runWorkflow(fixture, "op-fail", "apply");
  assert.equal(outcome.state, STATE.NEEDS_PARENT);
  assert.equal(outcome.detail, DETAIL.VERIFY_FAILED);
  assert.equal(await fixture.head(), fixture.expectedTargetHead);
  assert.deepEqual(outcome.failed.map((entry) => entry.name), ["fail"]);
  assert.equal(outcome.failed[0].passed, false);
  assert.equal(outcome.failed[0].code, 3);
  assert.ok(outcome.evidenceRef);
  assert.equal(existsSync(path.join(fixture.home, outcome.evidenceRef, "verify-summary.json")), true);

  const record = await readRegisteredOperation("op-fail", { env: fixture.env });
  assert.equal(record.candidateHead, outcome.candidateHead);
  assert.equal(record.state, STATE.NEEDS_PARENT);
  assert.equal(record.detail, DETAIL.VERIFY_FAILED);
});

test("verify: ワークツリーを書き換える検証は不合格にする", async (t) => {
  const fixture = await createFixture({ policy: defaultPolicy({ verify: [MUTATE_COMMAND] }) });
  t.after(() => fixture.dispose());
  await fixture.register("op-mutate");

  const outcome = await runWorkflow(fixture, "op-mutate", "apply");
  assert.equal(outcome.state, STATE.NEEDS_PARENT);
  assert.equal(outcome.detail, DETAIL.VERIFY_MUTATED_WORKTREE);
  assert.equal(await fixture.head(), fixture.expectedTargetHead);
});

test("conflict: 競合は候補と競合状態を残して親の解消を待つ", async (t) => {
  const fixture = await createFixture({
    childFiles: { "src/child.txt": "child\n", "src/base.txt": "child side\n" },
    mainFiles: { "src/base.txt": "main side\n" },
  });
  t.after(() => fixture.dispose());
  await fixture.register("op-conflict");

  const outcome = await runWorkflow(fixture, "op-conflict", "apply");
  assert.equal(outcome.state, STATE.NEEDS_PARENT);
  assert.equal(outcome.detail, DETAIL.MERGE_CONFLICT);
  assert.deepEqual(outcome.conflictedFiles, ["src/base.txt"]);
  assert.equal(await fixture.head(), fixture.expectedTargetHead);

  const candidate = path.join(fixture.home, "worktrees", "op-conflict");
  assert.equal(existsSync(path.join(candidate, "src", "base.txt")), true);
  assert.equal(existsSync(path.join(fixture.repoRoot, ".git", "worktrees", "op-conflict", "MERGE_HEAD")), true);
});

test("conflict: 親が解消してコミットすれば次の実行で統合できる", async (t) => {
  const fixture = await createFixture({
    childFiles: { "src/child.txt": "child\n", "src/base.txt": "child side\n" },
    mainFiles: { "src/base.txt": "main side\n" },
  });
  t.after(() => fixture.dispose());
  await fixture.register("op-resolve");

  const conflicted = await runWorkflow(fixture, "op-resolve", "apply");
  assert.equal(conflicted.detail, DETAIL.MERGE_CONFLICT);

  const candidate = path.join(fixture.home, "worktrees", "op-resolve");
  await fs.writeFile(path.join(candidate, "src", "base.txt"), "resolved\n", "utf8");
  await fs.writeFile(path.join(candidate, "src", "parent-note.txt"), "parent resolution\n", "utf8");
  const resolvedHead = await commitAll(candidate, "resolve conflict");

  const outcome = await runWorkflow(fixture, "op-resolve", "apply");
  assert.equal(outcome.state, STATE.INTEGRATED);
  assert.equal(outcome.candidateHead, resolvedHead);
  assert.equal(await fixture.head(), resolvedHead);
  assert.deepEqual((await fixture.parents(resolvedHead)).sort(), [fixture.expectedTargetHead, fixture.submittedHead].sort());
  assert.equal(await fs.readFile(path.join(fixture.repoRoot, "src", "base.txt"), "utf8"), "resolved\n");
  assert.equal(existsSync(path.join(fixture.repoRoot, "src", "parent-note.txt")), true);
});

test("stale: ターゲットが進んでいたら STALE_TARGET で再受付を求める", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  await fixture.register("op-stale");

  const newHead = await fixture.commitOnMain({ "src/main-note.txt": "main moved\n" });
  const outcome = await runWorkflow(fixture, "op-stale", "apply");
  assert.equal(outcome.state, STATE.STALE_TARGET);
  assert.equal(outcome.detail, DETAIL.TARGET_MOVED);
  assert.equal(outcome.targetHead, newHead);
  assert.equal(await fixture.head(), newHead);
  assert.equal(existsSync(path.join(fixture.home, "worktrees", "op-stale")), false);
});

test("recovery: 反映済みで記録がない受付は記録を復旧して二重マージしない", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  await fixture.register("op-recovery");

  const first = await runWorkflow(fixture, "op-recovery", "apply");
  assert.equal(first.state, STATE.INTEGRATED);
  const merged = await fixture.head();

  const layout = await ensureHome(homeLayout(resolveHome(fixture.env)).home);
  await updateOperation(layout, "op-recovery", { state: LEDGER_STATE.REGISTERED, detail: null, integration: null, integratedAt: null });

  const second = await runWorkflow(fixture, "op-recovery", "apply");
  assert.equal(second.state, STATE.INTEGRATED);
  assert.equal(second.detail, DETAIL.RECOVERED_AFTER_PUBLISH);
  assert.equal(await fixture.head(), merged);
  assert.equal((await fixture.parents(merged)).length, 2);

  const record = await readRegisteredOperation("op-recovery", { env: fixture.env });
  assert.equal(record.integrationCommit, merged);
  assert.ok(record.integratedAt);
});

test("dependency: 未統合の依存があるうちは BLOCKED、統合後の再受付で通る", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  await fixture.register("op-dep-a");
  const submittedB = await fixture.advanceChild({ "src/child-b.txt": "child b\n" }, "child work b");
  await registerOperation(
    {
      operationId: "op-dep-b",
      submittedHead: submittedB,
      repoPath: fixture.repoRoot,
      targetBranch: "main",
      targetWorktree: fixture.repoRoot,
      expectedTargetHead: fixture.expectedTargetHead,
      dependsOn: ["op-dep-a"],
    },
    { env: fixture.env },
  );

  const blocked = await runWorkflow(fixture, "op-dep-b", "apply");
  assert.equal(blocked.state, STATE.BLOCKED);
  assert.equal(blocked.detail, DETAIL.DEPENDENCY_NOT_INTEGRATED);
  assert.deepEqual(blocked.pendingDependencies, [{ operationId: "op-dep-a", found: true, state: LEDGER_STATE.REGISTERED }]);
  assert.equal(await fixture.head(), fixture.expectedTargetHead);

  const first = await runWorkflow(fixture, "op-dep-a", "apply");
  assert.equal(first.state, STATE.INTEGRATED);
  const afterFirst = await fixture.head();

  const stale = await runWorkflow(fixture, "op-dep-b", "apply");
  assert.equal(stale.state, STATE.STALE_TARGET);

  await removeOperation("op-dep-b", { env: fixture.env });
  await registerOperation(
    {
      operationId: "op-dep-b",
      submittedHead: submittedB,
      repoPath: fixture.repoRoot,
      targetBranch: "main",
      targetWorktree: fixture.repoRoot,
      expectedTargetHead: afterFirst,
      dependsOn: ["op-dep-a"],
    },
    { env: fixture.env },
  );
  const second = await runWorkflow(fixture, "op-dep-b", "apply");
  assert.equal(second.state, STATE.INTEGRATED);
  assert.equal(await fixture.isAncestor(submittedB, await fixture.head()), true);
  assert.equal(await fixture.isAncestor(afterFirst, await fixture.head()), true);
});

test("guard: 親の判断が必要なパスを変更した提出は受け付けない", async (t) => {
  const fixture = await createFixture({
    policy: defaultPolicy({ guardPaths: [".github/integrate-task.policy.json", "src/guarded.txt"] }),
    childFiles: { "src/guarded.txt": "child changed guarded\n" },
  });
  t.after(() => fixture.dispose());
  await fixture.register("op-guard");

  const outcome = await runWorkflow(fixture, "op-guard", "apply");
  assert.equal(outcome.state, STATE.NEEDS_PARENT);
  assert.equal(outcome.detail, DETAIL.GUARD_PATH_TOUCHED);
  assert.deepEqual(outcome.touched, [{ file: "src/guarded.txt", pattern: "src/guarded.txt" }]);
  assert.equal(await fixture.head(), fixture.expectedTargetHead);
});

test("policy: 受付後に検証条件が変わっていたら再受付を求める", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  await fixture.register("op-policy");

  const layout = await ensureHome(homeLayout(resolveHome(fixture.env)).home);
  await updateOperation(layout, "op-policy", { policyHash: "0".repeat(64) });

  const outcome = await runWorkflow(fixture, "op-policy", "apply");
  assert.equal(outcome.state, STATE.NEEDS_PARENT);
  assert.equal(outcome.detail, DETAIL.POLICY_CHANGED);
  assert.equal(outcome.registeredPolicyHash, "0".repeat(64));
  assert.equal(outcome.currentPolicyHash.length, 64);
  assert.equal(await fixture.head(), fixture.expectedTargetHead);
});

test("request: 未登録の operationId と不正な引数は NEEDS_PARENT で戻す", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());

  const missing = await runWorkflow(fixture, "op-unknown", "apply");
  assert.equal(missing.state, STATE.NEEDS_PARENT);
  assert.equal(missing.detail, "operation-not-found");
  assert.equal(missing.operationId, "op-unknown");
  assert.equal(await fixture.head(), fixture.expectedTargetHead);

  const invalid = await runWorkflow(fixture, "bad id", "apply");
  assert.equal(invalid.state, STATE.NEEDS_PARENT);
  assert.equal(invalid.detail, "invalid-arguments");

  await fixture.register("op-duplicate");
  await assert.rejects(() => fixture.register("op-duplicate"), /登録済み/);
});

test("busy: ロック中のターゲットは target-busy で待機を促す", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  await fixture.register("op-busy");

  const layout = await ensureHome(homeLayout(resolveHome(fixture.env)).home);
  const record = await readOperation(layout, "op-busy");
  const held = await acquireLock(layout, {
    commonDir: record.commonDir,
    targetRef: record.targetRef,
    operationId: "op-holder",
    waitSeconds: 0,
    staleMinutes: 30,
  });
  assert.equal(held.acquired, true);

  const blocked = await runWorkflow(fixture, "op-busy", "apply");
  assert.equal(blocked.state, STATE.NEEDS_PARENT);
  assert.equal(blocked.detail, DETAIL.TARGET_BUSY);
  assert.equal(blocked.lockOwner.operationId, "op-holder");
  assert.equal(await fixture.head(), fixture.expectedTargetHead);

  assert.equal(await releaseLock(layout, record.commonDir, record.targetRef, "op-holder"), true);
  const outcome = await runWorkflow(fixture, "op-busy", "apply");
  assert.equal(outcome.state, STATE.INTEGRATED);
});

test("dirty: ターゲットに未コミットの変更があれば親の対応を求める", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  await fixture.register("op-dirty");

  await fs.writeFile(path.join(fixture.repoRoot, "src/base.txt"), "uncommitted\n", "utf8");
  const outcome = await runWorkflow(fixture, "op-dirty", "apply");
  assert.equal(outcome.state, STATE.NEEDS_PARENT);
  assert.equal(outcome.detail, DETAIL.TARGET_DIRTY);
  assert.equal(await fixture.head(), fixture.expectedTargetHead);
});
