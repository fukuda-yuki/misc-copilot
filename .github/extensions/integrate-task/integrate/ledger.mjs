import path from "node:path";

import { LEDGER_STATE } from "../core/state.mjs";
import { listJsonRecords, nextNumberedDir, readJson, writeJsonAtomic } from "../core/store.mjs";

export const LEDGER_VERSION = 1;

export function operationPath(layout, operationId) {
  return path.join(layout.operations, `${operationId}.json`);
}

export function createOperationRecord(input) {
  const now = new Date().toISOString();
  return {
    version: LEDGER_VERSION,
    operationId: input.operationId,
    repoPath: input.repoPath,
    commonDir: input.commonDir,
    targetBranch: input.targetBranch,
    targetRef: input.targetRef,
    targetWorktree: input.targetWorktree,
    submittedHead: input.submittedHead,
    expectedTargetHead: input.expectedTargetHead,
    dependsOn: [...(input.dependsOn ?? [])],
    childSessionId: input.childSessionId ?? null,
    taskUrl: input.taskUrl ?? null,
    policyPath: input.policyPath,
    policyHash: input.policyHash,
    state: LEDGER_STATE.REGISTERED,
    detail: null,
    message: "受け付けを登録しました。",
    candidateHead: null,
    candidateWorktree: null,
    evidenceRef: null,
    integrationCommit: null,
    check: null,
    integration: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function readOperation(layout, operationId) {
  return readJson(operationPath(layout, operationId));
}

export async function writeOperation(layout, record) {
  const next = { ...record, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(operationPath(layout, record.operationId), next);
  return next;
}

export async function updateOperation(layout, operationId, patch) {
  const current = await readOperation(layout, operationId);
  if (current === null) throw new Error(`operation が見つかりません: ${operationId}`);
  return writeOperation(layout, { ...current, ...patch });
}

export async function listOperations(layout) {
  const records = await listJsonRecords(layout.operations);
  records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return records;
}

export async function nextEvidenceDir(layout, operationId) {
  const { dir, name } = await nextNumberedDir(path.join(layout.evidence, operationId));
  return { dir, ref: path.join("evidence", operationId, name) };
}
