import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export class GitError extends Error {
  constructor(args, code, stderr) {
    super(`git ${args.join(" ")} が失敗しました (exit=${code}): ${String(stderr).trim()}`);
    this.name = "GitError";
    this.args = args;
    this.code = code;
    this.stderr = String(stderr);
  }
}

/**
 * シェルを介さず argv 配列でコマンドを実行する。
 * 終了コードは例外にせず返し、呼び出し側が証拠として扱えるようにする。
 */
export function runCommand(command, args, options = {}) {
  const { cwd, signal, timeoutMs = 0, encoding = "utf8" } = options;
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        signal,
        encoding,
        windowsHide: true,
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: timeoutMs > 0 ? timeoutMs : 0,
        killSignal: "SIGTERM",
      },
      (error, stdout, stderr) => {
        if (error === null || error === undefined) {
          resolve({ code: 0, timedOut: false, stdout, stderr });
          return;
        }
        if (error.name === "AbortError") {
          reject(error);
          return;
        }
        if (typeof error.code === "number") {
          resolve({ code: error.code, timedOut: false, stdout, stderr });
          return;
        }
        if (error.killed === true || typeof error.signal === "string") {
          resolve({ code: null, timedOut: true, stdout: stdout ?? "", stderr: stderr ?? "" });
          return;
        }
        reject(new Error(`${command} を実行できません: ${error.message}`));
      },
    );
  });
}

export async function git(args, options = {}) {
  const outcome = await runCommand("git", args, options);
  if (outcome.code !== 0) {
    throw new GitError(args, outcome.code, outcome.stderr ?? "");
  }
  return outcome;
}

export function gitTry(args, options = {}) {
  return runCommand("git", args, options);
}

export async function gitText(args, options = {}) {
  const outcome = await git(args, options);
  return String(outcome.stdout ?? "").trim();
}

export async function gitTryText(args, options = {}) {
  const outcome = await gitTry(args, options);
  return outcome.code === 0 ? String(outcome.stdout ?? "").trim() : null;
}

export async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRepoContext(dir) {
  const repoPath = await gitText(["-C", dir, "rev-parse", "--show-toplevel"]);
  return { repoPath, commonDir: await gitCommonDir(repoPath) };
}

export async function gitCommonDir(repoPath) {
  try {
    return await gitText(["-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  } catch {
    return path.resolve(repoPath, await gitText(["-C", repoPath, "rev-parse", "--git-common-dir"]));
  }
}

export async function gitDirOf(worktree) {
  try {
    return await gitText(["-C", worktree, "rev-parse", "--path-format=absolute", "--git-dir"]);
  } catch {
    return path.resolve(worktree, await gitText(["-C", worktree, "rev-parse", "--git-dir"]));
  }
}

export async function isAncestor(repoPath, ancestor, descendant) {
  const outcome = await gitTry(["-C", repoPath, "merge-base", "--is-ancestor", ancestor, descendant]);
  if (outcome.code === 0) return true;
  if (outcome.code === 1) return false;
  throw new GitError(["-C", repoPath, "merge-base", "--is-ancestor", ancestor, descendant], outcome.code, outcome.stderr ?? "");
}

export async function commitExists(repoPath, rev) {
  const outcome = await gitTry(["-C", repoPath, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  return outcome.code === 0;
}

export async function resolveCommit(repoPath, rev) {
  const outcome = await gitTry(["-C", repoPath, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  return outcome.code === 0 ? String(outcome.stdout).trim() : null;
}

export function currentBranch(worktree) {
  return gitTryText(["-C", worktree, "symbolic-ref", "--short", "-q", "HEAD"]);
}

export function headOf(worktree) {
  return gitText(["-C", worktree, "rev-parse", "HEAD"]);
}

export async function statusPorcelain(worktree, options = {}) {
  const args = ["-C", worktree, "status", "--porcelain"];
  if (options.includeUntracked === false) args.push("--untracked-files=no");
  return gitText(args);
}

export async function changedFiles(repoPath, from, to) {
  const text = await gitText(["-C", repoPath, "diff", "--name-only", from, to]);
  return text === "" ? [] : text.split(/\r?\n/).filter((line) => line !== "");
}

export async function parentsOf(repoPath, rev) {
  const text = await gitText(["-C", repoPath, "rev-list", "--parents", "-n", "1", rev]);
  const parts = text.split(/\s+/).filter((part) => part !== "");
  return parts.slice(1);
}

export async function detectInProgressGitOperation(worktree) {
  const dir = await gitDirOf(worktree);
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
    if (await exists(path.join(dir, marker))) return marker;
  }
  for (const marker of ["rebase-merge", "rebase-apply"]) {
    if (await exists(path.join(dir, marker))) return marker;
  }
  return null;
}

export async function listWorktrees(repoPath) {
  const text = await gitText(["-C", repoPath, "worktree", "list", "--porcelain"]);
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null, head: null };
      entries.push(current);
    } else if (current !== null && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current !== null && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  return entries;
}

export async function gitVersion() {
  const outcome = await gitTry(["--version"]);
  return outcome.code === 0 ? String(outcome.stdout).trim() : "unknown";
}

/** 追跡ファイルに変更がないか。未追跡（報告ファイルなど）は無視する。 */
export async function isClean(worktree) {
  return (await statusPorcelain(worktree, { includeUntracked: false })) === "";
}

export async function addWorktree(repoPath, worktreePath, options = {}) {
  const args = ["-C", repoPath, "worktree", "add"];
  if (options.force === true) args.push("--force");
  if (typeof options.newBranch === "string") {
    args.push("-b", options.newBranch, worktreePath, options.base ?? "HEAD");
  } else {
    args.push(worktreePath);
    if (typeof options.base === "string") args.push(options.base);
  }
  await git(args);
  return worktreePath;
}

export async function removeWorktree(repoPath, worktreePath, options = {}) {
  const args = ["-C", repoPath, "worktree", "remove"];
  if (options.force !== false) args.push("--force");
  args.push(worktreePath);
  const outcome = await gitTry(args);
  await gitTry(["-C", repoPath, "worktree", "prune"]);
  return outcome.code === 0 ? { removed: true, stderr: "" } : { removed: false, stderr: String(outcome.stderr ?? "") };
}

export async function deleteBranch(repoPath, branch, options = {}) {
  const outcome = await gitTry(["-C", repoPath, "branch", options.force === false ? "-d" : "-D", branch]);
  return outcome.code === 0;
}

export async function commitAll(worktree, message) {
  await git(["-C", worktree, "add", "-A"]);
  await git(["-C", worktree, "commit", "-m", message]);
  return headOf(worktree);
}

export async function revParseOrNull(repoPath, rev) {
  const outcome = await gitTry(["-C", repoPath, "rev-parse", "--verify", "--quiet", rev]);
  return outcome.code === 0 ? String(outcome.stdout).trim() : null;
}
