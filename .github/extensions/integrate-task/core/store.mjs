import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 台帳の共通部分。App 用の統合レコードも CLI 用の driver レコードも、この書き込み契約を使う。
export function resolveHome(env = process.env) {
  const override = env.INTEGRATE_TASK_HOME;
  if (typeof override === "string" && override.trim() !== "") {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".integrate-task");
}

export function homeLayout(home = resolveHome()) {
  return {
    home,
    operations: path.join(home, "operations"),
    evidence: path.join(home, "evidence"),
    worktrees: path.join(home, "worktrees"),
    locks: path.join(home, "locks"),
  };
}

export async function ensureHome(home = resolveHome()) {
  const layout = homeLayout(home);
  for (const dir of [layout.operations, layout.evidence, layout.worktrees, layout.locks]) {
    await fs.mkdir(dir, { recursive: true });
  }
  return layout;
}

const writeQueues = new Map();

/**
 * 同じファイルへの書き込みを直列化する。Windows では、別の書き手が開いている最中の
 * rename が EPERM で落ちる。書き込みの順番を守れば、同じ台帳への並行書き込みでも壊れない。
 */
function serializeWrite(file, task) {
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeQueues.set(
    file,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 一時ファイルへ書いてから置き換える。ウイルス対策ソフトなどが一時ファイルを掴んでいても
 * 諦めずに数回試す。最後まで失敗したら一時ファイルを残さずに投げる。
 */
async function replaceFile(tmp, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (error) {
      const retriable = error.code === "EPERM" || error.code === "EBUSY" || error.code === "EACCES";
      if (!retriable || attempt >= 5) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
      await sleep(20 * (attempt + 1));
    }
  }
}

export function writeJsonAtomic(file, value) {
  return serializeWrite(file, async () => {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await replaceFile(tmp, file);
  });
}

export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** 追記専用のイベントログ。途中で切れた行は読み飛ばし、1行の破損で全体を失わない。 */
export async function appendJsonLine(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

export async function readJsonLines(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const lines = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // 破損行は捨てる。
    }
  }
  return lines;
}

export async function listJsonRecords(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readJson(path.join(dir, name));
    if (record !== null) records.push(record);
  }
  return records;
}

/** 連番ディレクトリ。証拠もイベントも「上書きしない」ため連番で積む。 */
export async function nextNumberedDir(base) {
  await fs.mkdir(base, { recursive: true });
  const entries = await fs.readdir(base);
  const used = entries
    .map((name) => Number.parseInt(name, 10))
    .filter((value) => Number.isInteger(value) && value >= 0);
  const next = used.length === 0 ? 0 : Math.max(...used) + 1;
  const name = String(next).padStart(3, "0");
  const dir = path.join(base, name);
  await fs.mkdir(dir, { recursive: true });
  return { dir, name };
}

export async function writeEvidenceFile(dir, name, content) {
  const file = path.join(dir, name);
  await fs.writeFile(file, typeof content === "string" ? content : String(content), "utf8");
  return file;
}
