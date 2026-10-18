import path from "node:path";

import {
  changedFiles,
  currentBranch,
  detectInProgressGitOperation,
  gitTry,
  headOf,
  listWorktrees,
  resolveRepoContext,
  statusPorcelain,
} from "../core/git.mjs";
import { readPolicyFromDir } from "../core/policy.mjs";
import { ensureHome, nextNumberedDir, resolveHome, writeEvidenceFile } from "../core/store.mjs";
import { runVerifyCommands } from "../core/verify.mjs";
import { TASK_DETAIL } from "./state.mjs";

const COMMITTER_NAME = "task-pipeline";
const COMMITTER_EMAIL = "task-pipeline@localhost";

/**
 * 子セッションの工程（task-pipeline）の実測担当。
 * 判断は engine.mjs に残し、ここは git・ファイルシステム・プロセスの結果だけを返す。
 * 対象は、この拡張が動いているセッションの cwd（子セッションの worktree）。
 */
export function createTaskPorts(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.log ?? (() => {});
  const resolveWorktree = () => path.resolve(options.cwd ?? process.cwd());
  let layoutPromise = null;
  const getLayout = () => {
    if (layoutPromise === null) {
      layoutPromise = ensureHome(resolveHome(env));
    }
    return layoutPromise;
  };

  async function isMainCheckout(repoPath, worktree) {
    const entries = await listWorktrees(repoPath);
    if (entries.length === 0) return null;
    const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
    return same(entries[0].path, worktree);
  }

  return {
    async readWorktreeState() {
      const worktree = resolveWorktree();
      let repo;
      try {
        repo = await resolveRepoContext(worktree);
      } catch (error) {
        return {
          ok: false,
          detail: TASK_DETAIL.NOT_A_REPOSITORY,
          message: `${worktree} を git リポジトリとして解決できません: ${error.message}`,
          extra: { worktree },
        };
      }
      const inProgress = await detectInProgressGitOperation(worktree);
      if (inProgress !== null) {
        return {
          ok: false,
          detail: TASK_DETAIL.WORKTREE_GIT_OPERATION,
          message: `${worktree} で ${inProgress} が進行中です。解消してから実行してください。`,
          extra: { worktree, inProgress },
        };
      }
      const head = await headOf(worktree);
      const branch = await currentBranch(worktree);
      const status = await statusPorcelain(worktree);
      if (status !== "") {
        return {
          ok: false,
          detail: TASK_DETAIL.WORKTREE_DIRTY,
          message: "作業ツリーに未コミットの変更があります。コミットするか破棄してから実行してください。",
          extra: { worktree, branch, baseCommit: head, status: status.split(/\r?\n/).filter((line) => line !== "") },
        };
      }
      return { ok: true, worktree, head, branch, status, mainCheckout: await isMainCheckout(repo.repoPath, worktree) };
    },

    async readPolicy() {
      const at = await readPolicyFromDir(resolveWorktree());
      return { policy: at.policy, hash: at.hash, file: at.file };
    },

    /** 証拠は作業ツリーの外（台帳の home）へ積む。作業ツリーを汚さないため。 */
    async createEvidence({ taskId }) {
      const layout = await getLayout();
      const { dir, name } = await nextNumberedDir(path.join(layout.evidence, "task", taskId));
      return { dir, ref: path.join("evidence", "task", taskId, name) };
    },

    async writeRecord({ evidenceDir, name, value }) {
      if (!evidenceDir) return null;
      return writeEvidenceFile(evidenceDir, `${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
    },

    async verify({ commands, evidenceDir, signal }) {
      return runVerifyCommands({
        worktree: resolveWorktree(),
        policy: { verify: commands },
        evidenceDir,
        signal,
        env,
        captureOutput: true,
      });
    },

    /** 未コミットの変更を提出コミットにする。変更がなければ提出しない。 */
    async submit({ baseHead, message }) {
      const worktree = resolveWorktree();
      const inProgress = await detectInProgressGitOperation(worktree);
      if (inProgress !== null) {
        return {
          ok: false,
          detail: TASK_DETAIL.WORKTREE_GIT_OPERATION,
          message: `${worktree} で ${inProgress} が進行中です。`,
          extra: { inProgress },
        };
      }
      const status = await statusPorcelain(worktree);
      const pending = status.split(/\r?\n/).filter((line) => line !== "");
      let committed = false;
      if (pending.length > 0) {
        const added = await gitTry(["-C", worktree, "add", "-A"]);
        if (added.code !== 0) {
          return {
            ok: false,
            detail: TASK_DETAIL.SUBMIT_FAILED,
            message: `変更を stage できません: ${String(added.stderr ?? "").trim()}`,
            extra: { pending },
          };
        }
        const outcome = await gitTry([
          "-C",
          worktree,
          "-c",
          `user.name=${COMMITTER_NAME}`,
          "-c",
          `user.email=${COMMITTER_EMAIL}`,
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          message,
        ]);
        if (outcome.code !== 0) {
          return {
            ok: false,
            detail: TASK_DETAIL.SUBMIT_FAILED,
            message: `提出コミットを作成できません: ${String(outcome.stderr ?? "").trim()}`,
            extra: { pending },
          };
        }
        committed = true;
      }
      const submittedHead = await headOf(worktree);
      if (submittedHead === baseHead) {
        return {
          ok: false,
          detail: TASK_DETAIL.NOTHING_TO_SUBMIT,
          message: "作業ツリーに変更がなく、提出するコミットもありません。",
          extra: { pending },
        };
      }
      const files = await changedFiles(worktree, baseHead, submittedHead);
      const branch = await currentBranch(worktree);
      logger(`submitted ${submittedHead} on ${branch ?? "(detached)"}`);
      return { ok: true, submittedHead, branch, files, committed, pending };
    },
  };
}
