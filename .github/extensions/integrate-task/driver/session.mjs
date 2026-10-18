import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../core/git.mjs";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export class CapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "CapabilityError";
  }
}

/**
 * 既定のツール許可。`--allow-all` / `--yolo` は使わないので、
 * 必要なものだけを名前で許可する（実測: `write` は apply_patch、`shell(node:*)` は
 * shell ツールの node 実行を許可し、それ以外は `code: "denied"` で拒否される）。
 * 統合先への push / merge / rebase / reset は担当にも親にも許可しない。
 * `shell(copilot:*)` は担当（責任者）が `copilot workflow run task-pipeline` を
 * 実行するために必要（実測: これが無いと CLI 実行が拒否される）。
 */
export const DEFAULT_TASK_ALLOW_TOOLS = Object.freeze(["write", "shell(git:*)", "shell(node:*)", "shell(npm:*)", "shell(copilot:*)"]);
export const DEFAULT_PARENT_ALLOW_TOOLS = Object.freeze(["shell(git:*)"]);
export const DEFAULT_DENY_TOOLS = Object.freeze([
  "shell(git push)",
  "shell(git merge)",
  "shell(git rebase)",
  "shell(git reset)",
  "shell(git checkout)",
  "shell(git switch)",
]);

/**
 * `copilot --help` の文面から使えるスイッチを拾う。
 * 実測していないスイッチを前提にしないため、未検出は null にして呼び出し側で止める。
 */
export function detectCapabilities(helpText) {
  const text = String(helpText ?? "");
  const found = (flag) => text.includes(flag);
  const prompt = found("--prompt") ? "--prompt" : found("-p") ? "-p" : null;
  return {
    prompt,
    resume: found("--resume") ? "--resume" : null,
    sessionId: found("--session-id") ? "--session-id" : null,
    outputFormat: found("--output-format") ? "--output-format" : null,
    noAskUser: found("--no-ask-user") ? "--no-ask-user" : null,
    allowTool: found("--allow-tool") ? "--allow-tool" : null,
    denyTool: found("--deny-tool") ? "--deny-tool" : null,
    effort: found("--effort") ? "--effort" : null,
    model: found("--model") ? "--model" : null,
    allowAllPresent: found("--allow-all") || found("--yolo"),
  };
}

export function missingCapabilities(capabilities, required) {
  return required.filter((name) => capabilities[name] === null || capabilities[name] === undefined);
}

export async function probeCapabilities(options = {}) {
  const command = options.command ?? "copilot";
  const commandArgs = options.commandArgs ?? [];
  const cwd = options.cwd ?? process.cwd();
  const version = await runCommand(command, [...commandArgs, "--version"], { cwd, timeoutMs: 30000 });
  const help = await runCommand(command, [...commandArgs, "--help"], { cwd, timeoutMs: 30000 });
  const helpText = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
  return {
    command,
    versionExitCode: version.code,
    versionText: String(version.stdout ?? version.stderr ?? "").trim(),
    helpExitCode: help.code,
    helpText,
    capabilities: detectCapabilities(helpText),
  };
}

/**
 * 引数の組み立て。`--allow-all` / `--yolo` は使わない。
 * プロンプトはファイルに置き、argv には短い参照だけを渡す（Windows の引数長を避ける）。
 * 値付きスイッチは `--flag=value` 形式にする。`--resume` と `--allow-tool` は
 * 実測した help 上で値が任意（`[<value>]`）なので、空白区切りでは値が渡らない。
 */
export function buildArgs(capabilities, options = {}) {
  const {
    promptReference,
    sessionId = null,
    resumeSessionId = null,
    allowTools = [],
    denyTools = [],
    noAskUser = true,
    outputFormat = "json",
    model = null,
    effort = null,
    extraArgs = [],
  } = options;

  if (capabilities.prompt === null) {
    throw new CapabilityError("この copilot では非対話プロンプト用のスイッチ（--prompt / -p）が見つかりません。");
  }
  const args = [capabilities.prompt, promptReference];

  if (resumeSessionId !== null) {
    if (capabilities.resume === null) {
      throw new CapabilityError("この copilot では --resume が見つかりません。セッションを再開できません。");
    }
    args.push(`${capabilities.resume}=${resumeSessionId}`);
  } else if (sessionId !== null && capabilities.sessionId !== null) {
    args.push(`${capabilities.sessionId}=${sessionId}`);
  }

  if (outputFormat !== null && capabilities.outputFormat !== null) {
    args.push(`${capabilities.outputFormat}=${outputFormat}`);
  }
  if (noAskUser && capabilities.noAskUser !== null) {
    args.push(capabilities.noAskUser);
  }
  if (model !== null && capabilities.model !== null) {
    args.push(`${capabilities.model}=${model}`);
  }
  if (effort !== null && capabilities.effort !== null) {
    args.push(`${capabilities.effort}=${effort}`);
  }
  for (const tool of allowTools) {
    if (capabilities.allowTool === null) {
      throw new CapabilityError("ツール許可のスイッチ（--allow-tool）が見つかりません。全許可へは切り替えません。");
    }
    args.push(`${capabilities.allowTool}=${tool}`);
  }
  for (const tool of denyTools) {
    if (capabilities.denyTool !== null) args.push(`${capabilities.denyTool}=${tool}`);
  }
  for (const extra of extraArgs) args.push(extra);
  return args;
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 起動した担当プロセスの台帳。停止は「この driver が起動した PID」だけを対象にする。
 * 別プロセスが残した PID は停止対象にしない（PID 再利用で無関係なプロセスを殺さない）。
 */
export function createSessionRegistry() {
  const live = new Map();
  return {
    register(entry) {
      live.set(entry.pid, entry);
      return entry;
    },
    get(pid) {
      return live.get(pid) ?? null;
    },
    entries() {
      return [...live.values()];
    },
    forget(pid) {
      live.delete(pid);
    },
  };
}

export async function runSession(options) {
  const {
    command = "copilot",
    args,
    cwd,
    env = process.env,
    logFile = null,
    timeoutMs = 0,
    registry = null,
    attemptId = null,
    input = null,
    onSpawn = null,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...env, NO_COLOR: "1" },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const startedAt = new Date().toISOString();
    const entry = { pid: child.pid, attemptId, startedAt, command, cwd };
    registry?.register(entry);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let logHandle = null;
    const pendingWrites = [];

    if (typeof onSpawn === "function") {
      try {
        const recorded = onSpawn(entry);
        if (recorded !== undefined && recorded !== null && typeof recorded.then === "function") {
          pendingWrites.push(recorded.catch(() => {}));
        }
      } catch {
        // 起動記録の失敗でセッションを止めない。
      }
    }

    if (logFile !== null) {
      logHandle = fs.open(logFile, "a").then((handle) => {
        pendingWrites.push(handle.writeFile(`\n=== ${startedAt} ${command} ${args.join(" ")}\n`));
        return handle;
      });
    }

    const appendLog = (chunk) => {
      if (logHandle === null) return;
      pendingWrites.push(
        logHandle.then((handle) => handle.writeFile(chunk)).catch(() => {}),
      );
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += text;
      appendLog(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += text;
      appendLog(text);
    });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // 既に終了している。
        }
      }, timeoutMs);
    }

    child.on("error", (error) => {
      if (timer !== null) clearTimeout(timer);
      registry?.forget(child.pid);
      reject(new Error(`${command} を起動できません: ${error.message}`));
    });

    if (input !== null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }

    child.on("close", async (exitCode, signal) => {
      if (timer !== null) clearTimeout(timer);
      registry?.forget(child.pid);
      try {
        await Promise.all(pendingWrites);
        if (logHandle !== null) {
          const handle = await logHandle;
          await handle.close();
        }
      } catch {
        // ログの後始末に失敗しても結果は返す。
      }
      resolve({
        pid: child.pid,
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * 起動した PID だけを止める。生存確認と、この driver が起動したかの確認を行う。
 * 強制終了は明示指定がなければ行わない。
 */
export async function stopSession(registry, attempt, options = {}) {
  const { waitMs = 5000, force = false } = options;
  const pid = attempt?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { stopped: false, reason: "no-pid" };
  }
  const owned = registry?.get(pid) ?? null;
  if (owned === null) {
    return { stopped: false, reason: "not-owned-by-this-driver" };
  }
  if (!isProcessAlive(pid)) {
    return { stopped: false, reason: "not-alive" };
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    return { stopped: false, reason: `kill-failed:${error.code ?? error.message}` };
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return { stopped: true, reason: force ? "sigkill" : "sigterm" };
    await sleep(100);
  }
  return { stopped: false, reason: "still-alive" };
}

/** プロンプト本文は作業ツリーに置き、argv には短い参照だけを渡す。 */
export async function writePromptFile(worktreePath, promptText, name = "prompt.md") {
  const dir = path.join(worktreePath, ".agent-run");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, promptText, "utf8");
  return file;
}

export function promptReference(promptFile) {
  return `次のファイルを読み、その指示に従ってください: ${promptFile}`;
}

export function requireCapabilities(config) {
  if (config.capabilities === null) {
    throw new CapabilityError("copilot の能力検出が済んでいません。driver/cli.mjs doctor で確認してください。");
  }
  if (config.capabilities.prompt === null) {
    throw new CapabilityError("非対話プロンプトのスイッチが見つかりません。driver は起動できません。");
  }
  return config.capabilities;
}
