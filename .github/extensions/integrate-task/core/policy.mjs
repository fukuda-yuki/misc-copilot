import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { runCommand } from "./git.mjs";

export const POLICY_PATH = ".github/integrate-task.policy.json";
export const POLICY_VERSION = 1;

export class PolicyError extends Error {
  constructor(message, code = "policy-invalid") {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

export function sha256Hex(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function parsePolicy(text, source = POLICY_PATH) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PolicyError(`${source} を JSON として読めません: ${error.message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PolicyError(`${source} はオブジェクトである必要があります。`);
  }
  if (raw.version !== POLICY_VERSION) {
    throw new PolicyError(`${source} の version は ${POLICY_VERSION} である必要があります。`);
  }
  const lock = raw.lock ?? {};
  const lockPolicy = {
    waitSeconds: Number.isInteger(lock.waitSeconds) ? lock.waitSeconds : 30,
    staleMinutes: Number.isInteger(lock.staleMinutes) ? lock.staleMinutes : 30,
  };
  if (lockPolicy.waitSeconds < 0 || lockPolicy.staleMinutes < 1) {
    throw new PolicyError(`${source} の lock 設定が不正です。`);
  }
  if (!Array.isArray(raw.verify) || raw.verify.length === 0) {
    throw new PolicyError(`${source} の verify は 1 件以上必要です。`);
  }
  const verify = raw.verify.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PolicyError(`${source} の verify[${index}] はオブジェクトである必要があります。`);
    }
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      throw new PolicyError(`${source} の verify[${index}].name が必要です。`);
    }
    if (typeof entry.command !== "string" || entry.command.trim() === "") {
      throw new PolicyError(`${source} の verify[${index}].command が必要です。`);
    }
    const args = entry.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new PolicyError(`${source} の verify[${index}].args は文字列の配列である必要があります。`);
    }
    const timeoutSeconds = Number.isInteger(entry.timeoutSeconds) ? entry.timeoutSeconds : 600;
    if (timeoutSeconds < 1) {
      throw new PolicyError(`${source} の verify[${index}].timeoutSeconds は 1 以上である必要があります。`);
    }
    return { name: entry.name, command: entry.command, args: [...args], timeoutSeconds };
  });
  const guardPaths = raw.guardPaths ?? [];
  if (!Array.isArray(guardPaths) || guardPaths.some((value) => typeof value !== "string" || value === "")) {
    throw new PolicyError(`${source} の guardPaths は空でない文字列の配列である必要があります。`);
  }
  return { version: POLICY_VERSION, lock: lockPolicy, verify, guardPaths: [...guardPaths] };
}

export async function readPolicyFromDir(dir) {
  const file = path.join(dir, POLICY_PATH);
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") throw new PolicyError(`${POLICY_PATH} がありません。`, "policy-missing");
    throw error;
  }
  return { policy: parsePolicy(bytes.toString("utf8")), hash: sha256Hex(bytes), file };
}

/**
 * 受付時に固定した「レビュー済みターゲット」のポリシーを取得する。
 * ハッシュは生バイトで計算し、比較時に再計算のずれが生じないようにする。
 */
export async function readPolicyAtRef(repoPath, ref) {
  const outcome = await runCommand("git", ["-C", repoPath, "show", `${ref}:${POLICY_PATH}`], { encoding: "buffer" });
  if (outcome.code !== 0) {
    return { present: false, hash: null, policy: null };
  }
  const bytes = Buffer.isBuffer(outcome.stdout) ? outcome.stdout : Buffer.from(String(outcome.stdout), "utf8");
  return { present: true, hash: sha256Hex(bytes), policy: parsePolicy(bytes.toString("utf8"), `${ref}:${POLICY_PATH}`) };
}

function globToRegExp(pattern) {
  const normalized = pattern.replace(/\\/g, "/");
  const effective = normalized.endsWith("/") ? `${normalized}**` : normalized;
  let out = "^";
  for (let index = 0; index < effective.length; index += 1) {
    const char = effective[index];
    if (char === "*") {
      if (effective[index + 1] === "*") {
        index += 1;
        if (effective[index + 1] === "/") {
          index += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`${out}$`);
}

export function matchesGuardPath(pattern, filePath) {
  return globToRegExp(pattern).test(filePath.replace(/\\/g, "/"));
}

export function guardPathsTouched(guardPaths, files) {
  const touched = [];
  for (const file of files) {
    for (const pattern of guardPaths) {
      if (matchesGuardPath(pattern, file)) {
        touched.push({ file, pattern });
        break;
      }
    }
  }
  return touched;
}
