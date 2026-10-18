import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * ロック名はスコープ文字列から作る。ターゲット ref（commonDir + ref）も、
 * driver のセッション所有権や実行枠も、同じ規則で別ファイルになる。
 */
export function scopeLockKey(scope) {
  const digest = crypto.createHash("sha256").update(scope).digest("hex").slice(0, 12);
  const sanitized = scope.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return `${sanitized}-${digest}.lock`;
}

export function lockKey(commonDir, targetRef) {
  const digest = crypto.createHash("sha256").update(`${commonDir}\u0000${targetRef}`).digest("hex").slice(0, 12);
  const sanitized = targetRef.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${sanitized}-${digest}.lock`;
}

export function lockPath(layout, commonDir, targetRef) {
  return path.join(layout.locks, lockKey(commonDir, targetRef));
}

export function scopeLockPath(layout, scope) {
  return path.join(layout.locks, scopeLockKey(scope));
}

async function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function inspectLock(file, staleMinutes) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error.code === "ENOENT") return { present: false };
    throw error;
  }
  let payload = null;
  try {
    payload = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    payload = null;
  }
  const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
  const alive = payload === null ? true : await isProcessAlive(payload.pid);
  const stale = ageMinutes >= staleMinutes || (payload !== null && !alive && ageMinutes >= 1);
  return { present: true, payload, ageMinutes, alive, stale, mtimeMs: stat.mtimeMs };
}

/**
 * ロックファイルの排他的作成で排他を取る。待機中はロックを保持しないため、待ち行列がデッドロックにならない。
 */
async function acquireLockFile(file, options) {
  const { payload, waitSeconds = 30, staleMinutes = 30, signal } = options;
  const deadline = Date.now() + waitSeconds * 1000;
  let lastObserved = null;

  for (;;) {
    let handle = null;
    try {
      handle = await fs.open(file, "wx");
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await handle.close();
      return { acquired: true, file };
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => {});
      if (error.code !== "EEXIST") throw error;
    }

    const observed = await inspectLock(file, staleMinutes);
    if (!observed.present) continue;
    lastObserved = observed;
    if (observed.stale) {
      await fs.unlink(file).catch(() => {});
      continue;
    }
    if (Date.now() >= deadline) {
      return { acquired: false, file, owner: observed.payload, ageMinutes: observed.ageMinutes };
    }
    await sleep(Math.min(250, Math.max(25, deadline - Date.now())), signal);
  }
}

export async function acquireLock(layout, options) {
  const { commonDir, targetRef, operationId, waitSeconds = 30, staleMinutes = 30, signal } = options;
  return acquireLockFile(lockPath(layout, commonDir, targetRef), {
    waitSeconds,
    staleMinutes,
    signal,
    payload: {
      pid: process.pid,
      operationId,
      targetRef,
      commonDir,
      startedAt: new Date().toISOString(),
    },
  });
}

/** driver 用の一般スコープ。owner はセッション ID や実行枠の名前など、解放時に照合する値。 */
export async function acquireScopeLock(layout, scope, options = {}) {
  const { owner = null, purpose = null, waitSeconds = 30, staleMinutes = 30, signal, extra = {} } = options;
  return acquireLockFile(scopeLockPath(layout, scope), {
    waitSeconds,
    staleMinutes,
    signal,
    payload: {
      pid: process.pid,
      owner,
      purpose,
      scope,
      startedAt: new Date().toISOString(),
      ...extra,
    },
  });
}

export async function readLock(layout, commonDir, targetRef) {
  const file = lockPath(layout, commonDir, targetRef);
  const observed = await inspectLock(file, Number.POSITIVE_INFINITY);
  return observed.present ? { file, ...observed } : null;
}

/** スコープのロックを、古さの判定を固定せずに読む。所有権の判断は呼び出し側が行う。 */
export async function readScopeLock(layout, scope) {
  const file = scopeLockPath(layout, scope);
  const observed = await inspectLock(file, Number.POSITIVE_INFINITY);
  if (!observed.present) return null;
  return { file, holding: !observed.stale, ...observed };
}

export async function releaseScopeLock(layout, scope, owner) {
  const file = scopeLockPath(layout, scope);
  try {
    const payload = JSON.parse(await fs.readFile(file, "utf8"));
    if (owner !== undefined && owner !== null && payload.owner !== owner) return false;
  } catch {
    return false;
  }
  await fs.unlink(file).catch(() => {});
  return true;
}

export async function releaseLock(layout, commonDir, targetRef, operationId) {
  const file = lockPath(layout, commonDir, targetRef);
  try {
    const payload = JSON.parse(await fs.readFile(file, "utf8"));
    if (operationId !== undefined && payload.operationId !== operationId) return false;
  } catch {
    return false;
  }
  await fs.unlink(file).catch(() => {});
  return true;
}
