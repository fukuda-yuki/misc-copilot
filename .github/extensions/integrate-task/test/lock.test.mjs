import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { acquireLock, lockPath, readLock, releaseLock } from "../core/lock.mjs";
import { ensureHome, homeLayout } from "../core/store.mjs";
import { createFixture } from "./helpers.mjs";

test("lock: 同じターゲット参照の同時取得を拒否し、解放後に許可する", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const layout = await ensureHome(homeLayout(fixture.home).home);
  const commonDir = await fs.realpath(fixture.home);
  const targetRef = "refs/heads/main";
  const options = { commonDir, targetRef, operationId: "op-1", waitSeconds: 0, staleMinutes: 30 };

  const first = await acquireLock(layout, options);
  assert.equal(first.acquired, true);
  const observed = await readLock(layout, commonDir, targetRef);
  assert.equal(observed.present, true);
  assert.equal(observed.payload.operationId, "op-1");
  assert.equal(observed.stale, false);

  const second = await acquireLock(layout, { ...options, operationId: "op-2" });
  assert.equal(second.acquired, false);
  assert.equal(second.owner.operationId, "op-1");

  assert.equal(await releaseLock(layout, commonDir, targetRef, "op-2"), false);
  assert.equal(await releaseLock(layout, commonDir, targetRef, "op-1"), true);

  const third = await acquireLock(layout, { ...options, operationId: "op-3" });
  assert.equal(third.acquired, true);
  assert.equal(await releaseLock(layout, commonDir, targetRef, "op-3"), true);
  assert.equal(await readLock(layout, commonDir, targetRef), null);
  assert.equal(lockPath(layout, commonDir, targetRef).endsWith(".lock"), true);
});

test("lock: 古い lock は奪取できる", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const layout = await ensureHome(homeLayout(fixture.home).home);
  const commonDir = await fs.realpath(fixture.home);
  const targetRef = "refs/heads/main";
  const file = lockPath(layout, commonDir, targetRef);

  await fs.writeFile(file, `${JSON.stringify({ pid: 999999999, operationId: "dead", targetRef, commonDir }, null, 2)}\n`, "utf8");
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await fs.utimes(file, old, old);

  const outcome = await acquireLock(layout, { commonDir, targetRef, operationId: "op-fresh", waitSeconds: 0, staleMinutes: 5 });
  assert.equal(outcome.acquired, true);
  assert.equal(await releaseLock(layout, commonDir, targetRef, "op-fresh"), true);
});
