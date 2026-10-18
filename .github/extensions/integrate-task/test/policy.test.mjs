import assert from "node:assert/strict";
import test from "node:test";

import { POLICY_PATH, PolicyError, guardPathsTouched, matchesGuardPath, parsePolicy, readPolicyAtRef, readPolicyFromDir } from "../core/policy.mjs";
import { createFixture, defaultPolicy } from "./helpers.mjs";

test("policy: verify が空、version 違い、command 欠落を拒否する", () => {
  assert.throws(() => parsePolicy(JSON.stringify({ version: 1, verify: [], guardPaths: [] })), PolicyError);
  assert.throws(() => parsePolicy(JSON.stringify({ version: 2, verify: [{ name: "a", command: "node" }], guardPaths: [] })), /version/);
  assert.throws(() => parsePolicy(JSON.stringify({ version: 1, verify: [{ name: "a" }], guardPaths: [] })), /command/);
  assert.throws(() => parsePolicy(JSON.stringify({ version: 1, verify: [{ name: "a", command: "node", args: [1] }], guardPaths: [] })), /args/);
  assert.throws(() => parsePolicy(JSON.stringify({ version: 1, verify: [{ name: "a", command: "node", timeoutSeconds: 0 }], guardPaths: [] })), /timeoutSeconds/);
  assert.throws(() => parsePolicy("not json"), /JSON/);
  assert.throws(() => parsePolicy(JSON.stringify({ version: 1, verify: [{ name: "a", command: "node" }], guardPaths: [1] })), /guardPaths/);
});

test("policy: 既定値と明示値を読み分ける", () => {
  const parsed = parsePolicy(JSON.stringify({ version: 1, verify: [{ name: "a", command: "node", args: ["-e", "0"] }], guardPaths: [] }));
  assert.equal(parsed.lock.waitSeconds, 30);
  assert.equal(parsed.lock.staleMinutes, 30);
  assert.equal(parsed.verify[0].timeoutSeconds, 600);
  const explicit = parsePolicy(JSON.stringify({ version: 1, lock: { waitSeconds: 0, staleMinutes: 5 }, verify: [{ name: "a", command: "node" }], guardPaths: ["src/"] }));
  assert.equal(explicit.lock.waitSeconds, 0);
  assert.equal(explicit.lock.staleMinutes, 5);
});

test("policy: guardPaths の照合は * と ** を区別する", () => {
  assert.equal(matchesGuardPath("src/guarded.txt", "src/guarded.txt"), true);
  assert.equal(matchesGuardPath("src/guarded.txt", "src/other.txt"), false);
  assert.equal(matchesGuardPath("src/*.txt", "src/a.txt"), true);
  assert.equal(matchesGuardPath("src/*.txt", "src/nested/a.txt"), false);
  assert.equal(matchesGuardPath("src/**", "src/nested/a.txt"), true);
  assert.equal(matchesGuardPath(".github/extensions/integrate-task/", ".github/extensions/integrate-task/lib/state.mjs"), true);
  assert.equal(matchesGuardPath(".github/extensions/integrate-task/", ".github/extensions/other/x.mjs"), false);
  assert.equal(matchesGuardPath("**/policy.json", "a/b/policy.json"), true);

  const touched = guardPathsTouched(["src/guarded.txt", "docs/**"], ["src/guarded.txt", "src/base.txt", "docs/a/b.md"]);
  assert.deepEqual(touched, [
    { file: "src/guarded.txt", pattern: "src/guarded.txt" },
    { file: "docs/a/b.md", pattern: "docs/**" },
  ]);
});

test("policy: コミット済みポリシーのハッシュは生バイトで一致する", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());

  const fromRef = await readPolicyAtRef(fixture.repoRoot, fixture.expectedTargetHead);
  const fromDir = await readPolicyFromDir(fixture.repoRoot);
  assert.equal(fromRef.present, true);
  assert.equal(fromRef.hash, fromDir.hash);
  assert.deepEqual(fromRef.policy, parsePolicy(JSON.stringify(defaultPolicy())));
  assert.deepEqual(fromRef.policy, fromDir.policy);

  const onChild = await readPolicyAtRef(fixture.repoRoot, "refs/heads/child");
  assert.equal(onChild.present, true);
  assert.equal(onChild.hash, fromRef.hash);

  const onUnborn = await readPolicyAtRef(fixture.repoRoot, "0000000000000000000000000000000000000000");
  assert.equal(onUnborn.present, false);
  assert.equal(POLICY_PATH, ".github/integrate-task.policy.json");
});
