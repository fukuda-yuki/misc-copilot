import assert from "node:assert/strict";
import test from "node:test";

import { DETAIL, LEDGER_STATE, OPERATION_ID_PATTERN, STATE, assertOperationId, result, validateArgs } from "../core/state.mjs";

test("state: 状態と理由コードは設計資料の enum を保つ", () => {
  assert.deepEqual(Object.keys(STATE).sort(), ["BLOCKED", "INTEGRATED", "NEEDS_PARENT", "STALE_TARGET", "VERIFIED_NOT_PUBLISHED"]);
  assert.equal(STATE.INTEGRATED, "INTEGRATED");
  assert.equal(DETAIL.MERGE_CONFLICT, "merge-conflict");
  assert.equal(DETAIL.TARGET_BUSY, "target-busy");
  assert.equal(LEDGER_STATE.REGISTERED, "REGISTERED");
});

test("state: operationId の書式を検証する", () => {
  for (const valid of ["a", "op-1", "2026.10.16_run", "A".repeat(100)]) {
    assert.equal(assertOperationId(valid), valid);
  }
  for (const invalid of ["", "-op", ".op", "_op", "op 1", "A".repeat(101), "op/1", null, undefined, 42]) {
    assert.throws(() => assertOperationId(invalid), /operationId/);
  }
  assert.equal(OPERATION_ID_PATTERN.test("op-1"), true);
});

test("state: validateArgs は未知の引数と不正な mode を拒否する", () => {
  assert.deepEqual(validateArgs({ operationId: "op-1", mode: "check" }), { operationId: "op-1", mode: "check" });
  assert.deepEqual(validateArgs({ operationId: "op-1", mode: "apply" }), { operationId: "op-1", mode: "apply" });
  assert.throws(() => validateArgs({ operationId: "op-1", mode: "run" }), /mode/);
  assert.throws(() => validateArgs({ operationId: "op-1" }), /mode/);
  assert.throws(() => validateArgs({ operationId: "op-1", mode: "check", extra: 1 }), /未知の引数/);
  assert.throws(() => validateArgs(null), /オブジェクト/);
  assert.throws(() => validateArgs([]), /オブジェクト/);
});

test("state: result は設計資料の戻り値の形を保つ", () => {
  const value = result(STATE.NEEDS_PARENT, DETAIL.TARGET_BUSY, { message: "busy", extra: { owner: "op-2" } });
  assert.equal(value.state, STATE.NEEDS_PARENT);
  assert.equal(value.detail, DETAIL.TARGET_BUSY);
  assert.equal(value.message, "busy");
  assert.equal(value.candidateHead, null);
  assert.equal(value.evidenceRef, null);
  assert.equal(value.owner, "op-2");
});
