import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  appendJsonLine,
  ensureHome,
  listJsonRecords,
  readJson,
  readJsonLines,
  resolveHome,
  writeJsonAtomic,
} from "../core/store.mjs";

export const RUN_VERSION = 1;
export const RUNS_DIR = "agent-runs";

export function driverRoot(home = resolveHome()) {
  return path.join(home, RUNS_DIR);
}

export function runLayout(runId, home = resolveHome()) {
  const base = path.join(driverRoot(home), runId);
  return {
    home,
    runId,
    base,
    run: path.join(base, "run.json"),
    parent: path.join(base, "parent.json"),
    events: path.join(base, "events.jsonl"),
    tasks: path.join(base, "tasks"),
    attempts: path.join(base, "attempts"),
    operations: path.join(base, "operations"),
    logs: path.join(base, "logs"),
    reports: path.join(base, "reports"),
    // 検証枠などのスコープロック。統合先 ref のロックは台帳側で共有する。
    locks: path.join(base, "locks"),
  };
}

export async function ensureRunLayout(runId, home = resolveHome()) {
  await ensureHome(home);
  const layout = runLayout(runId, home);
  for (const dir of [layout.tasks, layout.attempts, layout.operations, layout.logs, layout.reports, layout.locks]) {
    await fs.mkdir(dir, { recursive: true });
  }
  return layout;
}

export function newRunId() {
  return crypto.randomUUID();
}

/** 作業用 worktree はリポジトリの隣に置き、リポジトリの作業ツリーを汚さない。 */
export function worktreesRoot(repoPath) {
  const resolved = path.resolve(repoPath);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}.worktrees`);
}

export async function readRun(layout) {
  return readJson(layout.run);
}

const runWriteQueues = new Map();

/**
 * run.json は read-modify-write なので、同じ run への書き込みをプロセス内で直列化する。
 * 並行に書くと eventId と snapshotRevision が重複する。
 */
function serializeRunWrite(layout, task) {
  const key = layout.run;
  const previous = runWriteQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  runWriteQueues.set(
    key,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

async function writeRunNow(layout, record) {
  const next = { ...record, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(layout.run, next);
  return next;
}

export function writeRun(layout, record) {
  return serializeRunWrite(layout, () => writeRunNow(layout, record));
}

export function updateRun(layout, patch) {
  return serializeRunWrite(layout, async () => {
    const current = await readRun(layout);
    if (current === null) throw new Error(`run が見つかりません: ${layout.runId}`);
    return writeRunNow(layout, { ...current, ...patch });
  });
}

export async function listRuns(home = resolveHome()) {
  const root = driverRoot(home);
  let names;
  try {
    names = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const runs = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const record = await readJson(path.join(root, entry.name, "run.json"));
    if (record !== null) runs.push(record);
  }
  runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return runs;
}

function recordPath(dir, id) {
  return path.join(dir, `${id}.json`);
}

export async function readTask(layout, taskId) {
  return readJson(recordPath(layout.tasks, taskId));
}

export async function writeTask(layout, record) {
  const next = { ...record, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(recordPath(layout.tasks, record.taskId), next);
  return next;
}

export async function listTasks(layout) {
  const records = await listJsonRecords(layout.tasks);
  records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return records;
}

export async function readAttempt(layout, attemptId) {
  return readJson(recordPath(layout.attempts, attemptId));
}

export async function writeAttempt(layout, record) {
  const next = { ...record, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(recordPath(layout.attempts, record.attemptId), next);
  return next;
}

export async function listAttempts(layout, taskId = null) {
  const records = await listJsonRecords(layout.attempts);
  const filtered = taskId === null ? records : records.filter((record) => record.taskId === taskId);
  filtered.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  return filtered;
}

export async function readParent(layout) {
  return readJson(layout.parent);
}

export async function writeParent(layout, record) {
  const next = { ...record, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(layout.parent, next);
  return next;
}

/**
 * イベントは追記のみ。eventId は run の連番で、再起動後も重複しない。
 */
export function appendEvent(layout, event) {
  return serializeRunWrite(layout, async () => {
    const run = await readRun(layout);
    if (run === null) throw new Error(`run が見つかりません: ${layout.runId}`);
    const eventId = Number.isInteger(run.nextEventId) ? run.nextEventId : 1;
    const record = { eventId, at: new Date().toISOString(), ...event };
    await writeRunNow(layout, { ...run, nextEventId: eventId + 1, snapshotRevision: incrementRevision(run, event) });
    await appendJsonLine(layout.events, record);
    return record;
  });
}

function incrementRevision(run, event) {
  const revision = Number.isInteger(run.snapshotRevision) ? run.snapshotRevision : 0;
  return event.bumpsRevision === false ? revision : revision + 1;
}

export async function readEvents(layout, options = {}) {
  const since = Number.isInteger(options.since) ? options.since : 0;
  const events = await readJsonLines(layout.events);
  return events.filter((event) => Number(event.eventId ?? 0) > since);
}

export async function readOperationRecord(layout, operationId) {
  return readJson(recordPath(layout.operations, operationId));
}

export async function writeOperationRecord(layout, record) {
  const next = { ...record, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(recordPath(layout.operations, record.operationId), next);
  return next;
}

export async function listOperationRecords(layout) {
  const records = await listJsonRecords(layout.operations);
  records.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  return records;
}

/** 生ログは上書きせず追記する。停止や再開の証拠として残す。 */
export async function appendAttemptLog(layout, attemptId, text) {
  const file = path.join(layout.logs, `${attemptId}.log`);
  if (text === "" || text === null || text === undefined) return file;
  await appendTextFile(file, text);
  return file;
}

async function appendTextFile(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, text, "utf8");
}

export async function archiveReport(layout, attemptId, payload, rawText) {
  const file = path.join(layout.reports, `${attemptId}.json`);
  await fs.mkdir(layout.reports, { recursive: true });
  await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  if (typeof rawText === "string") {
    await fs.writeFile(`${file}.raw.txt`, rawText, "utf8");
  }
  return file;
}

export async function removeRunTree(layout) {
  await fs.rm(layout.base, { recursive: true, force: true });
}
