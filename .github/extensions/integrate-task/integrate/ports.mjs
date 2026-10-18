import fs from "node:fs/promises";
import path from "node:path";

import {
  changedFiles,
  commitExists,
  currentBranch,
  detectInProgressGitOperation,
  exists,
  git,
  gitText,
  gitTry,
  headOf,
  isAncestor,
  listWorktrees,
  resolveCommit,
  resolveRepoContext,
  statusPorcelain,
} from "../core/git.mjs";
import {
  createOperationRecord,
  listOperations,
  nextEvidenceDir,
  readOperation,
  writeOperation,
} from "./ledger.mjs";
import { acquireLock, releaseLock } from "../core/lock.mjs";
import { POLICY_PATH, parsePolicy, readPolicyAtRef, readPolicyFromDir, sha256Hex, guardPathsTouched } from "../core/policy.mjs";
import { assertOperationId, DETAIL, LEDGER_STATE, STATE } from "../core/state.mjs";
import { ensureHome, homeLayout, resolveHome, writeEvidenceFile } from "../core/store.mjs";
import { runVerifyCommands } from "../core/verify.mjs";

export const CANDIDATE_BRANCH_PREFIX = "integrate-task/";

function candidateBranch(operationId) {
  return `${CANDIDATE_BRANCH_PREFIX}${operationId}`;
}

function normalizeList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${label} は文字列の配列で指定してください。`);
  }
  return [...value];
}

/**
 * 受付（register）: 子セッションの提出コミットと、レビュー済みターゲットを台帳に固定する。
 * ポリシーのハッシュをここで記録し、以後の実行でポリシー差し替えを検出する。
 */
export async function registerOperation(input, options = {}) {
  const env = options.env ?? process.env;
  const layout = await ensureHome(resolveHome(env));
  const operationId = assertOperationId(input.operationId);
  const startDir = path.resolve(input.repoPath ?? options.cwd ?? process.cwd());
  const { repoPath, commonDir } = await resolveRepoContext(startDir);

  if (await readOperation(layout, operationId)) {
    throw new Error(`operationId ${operationId} は登録済みです。別の ID を使うか、先に解除してください。`);
  }

  const targetBranch = input.targetBranch ?? (await currentBranch(repoPath));
  if (typeof targetBranch !== "string" || targetBranch.trim() === "") {
    throw new Error("targetBranch を特定できません。明示してください。");
  }
  const targetRef = input.targetRef ?? `refs/heads/${targetBranch}`;

  const worktrees = await listWorktrees(repoPath);
  const byPath = input.targetWorktree === undefined ? null : worktrees.find((entry) => path.resolve(entry.path) === path.resolve(input.targetWorktree));
  const byBranch = worktrees.find((entry) => entry.branch === targetRef);
  const selected = byPath ?? byBranch ?? null;
  if (selected === null) {
    throw new Error(`${targetRef} をチェックアウトしている worktree が見つかりません。`);
  }
  if (selected.branch !== targetRef) {
    throw new Error(`${selected.path} は ${selected.branch ?? "(detached)"} をチェックアウトしています。${targetRef} を指定してください。`);
  }
  const targetWorktree = selected.path;

  const submittedHead = await resolveCommit(repoPath, input.submittedHead);
  if (submittedHead === null) {
    throw new Error(`submittedHead ${input.submittedHead} をコミットとして解決できません。`);
  }
  const expectedTargetHead = await resolveCommit(repoPath, input.expectedTargetHead ?? targetRef);
  if (expectedTargetHead === null) {
    throw new Error(`expectedTargetHead ${input.expectedTargetHead ?? targetRef} をコミットとして解決できません。`);
  }

  const policyAtRef = await readPolicyAtRef(repoPath, expectedTargetHead);
  if (!policyAtRef.present) {
    throw new Error(`${expectedTargetHead} に ${POLICY_PATH} がありません。先にポリシーをコミットしてください。`);
  }

  const record = createOperationRecord({
    operationId,
    repoPath,
    commonDir,
    targetBranch,
    targetRef,
    targetWorktree,
    submittedHead,
    expectedTargetHead,
    dependsOn: normalizeList(input.dependsOn, "dependsOn"),
    childSessionId: input.childSessionId ?? null,
    taskUrl: input.taskUrl ?? null,
    policyPath: POLICY_PATH,
    policyHash: policyAtRef.hash,
  });
  return writeOperation(layout, record);
}

export async function readRegisteredOperation(operationId, options = {}) {
  const env = options.env ?? process.env;
  const layout = homeLayout(resolveHome(env));
  return readOperation(layout, assertOperationId(operationId));
}

export async function listRegisteredOperations(options = {}) {
  const env = options.env ?? process.env;
  const layout = await ensureHome(resolveHome(env));
  return listOperations(layout);
}

/**
 * ProjectPorts の実装。判断は呼び出し側（workflow.mjs）に残し、
 * ここは git・ファイルシステム・ポリシーの実測結果だけを返す。
 */
export function createProjectPorts(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.log ?? (() => {});
  let layoutPromise = null;
  const getLayout = () => {
    if (layoutPromise === null) {
      layoutPromise = ensureHome(resolveHome(env));
    }
    return layoutPromise;
  };

  async function evidenceStep(evidenceDir, name, payload) {
    if (!evidenceDir) return;
    await writeEvidenceFile(evidenceDir, `${name}.json`, `${JSON.stringify(payload, null, 2)}\n`);
  }

  return {
    async loadRegisteredOperation({ operationId }) {
      return readOperation(await getLayout(), operationId);
    },

    async isDependencyIntegrated({ operationId }) {
      const record = await readOperation(await getLayout(), operationId);
      return { found: record !== null, integrated: record !== null && record.state === STATE.INTEGRATED, state: record?.state ?? null };
    },

    /** 提出コミットがすでにターゲットへ取り込まれているか（二重マージ防止の一次判定）。 */
    async isIntegratedAlready({ operation, targetHead }) {
      return isAncestor(operation.repoPath, operation.submittedHead, targetHead);
    },

    /**
     * ターゲット参照ごとの排他。待機上限を超えたら占有者情報を返し、呼び出し側が NEEDS_PARENT を決める。
     */
    async acquireTargetLock({ operation, policy, signal }) {
      const release = async () => {
        const released = await releaseLock(await getLayout(), operation.commonDir, operation.targetRef, operation.operationId);
        if (released) logger(`lock released: ${operation.targetRef}`);
      };
      const outcome = await acquireLock(await getLayout(), {
        commonDir: operation.commonDir,
        targetRef: operation.targetRef,
        operationId: operation.operationId,
        waitSeconds: policy?.lock?.waitSeconds ?? 30,
        staleMinutes: policy?.lock?.staleMinutes ?? 30,
        signal,
      });
      if (outcome.acquired) {
        logger(`lock acquired: ${operation.targetRef}`);
        return { acquired: true, release };
      }
      return {
        acquired: false,
        release: async () => {},
        detail: DETAIL.TARGET_BUSY,
        owner: outcome.owner ?? null,
        ageMinutes: outcome.ageMinutes ?? null,
      };
    },

    async resolveTargetWorktree({ operation }) {
      const worktrees = await listWorktrees(operation.repoPath);
      const byPath =
        operation.targetWorktree === null
          ? null
          : worktrees.find((entry) => path.resolve(entry.path) === path.resolve(operation.targetWorktree));
      const byBranch = worktrees.find((entry) => entry.branch === operation.targetRef);
      let chosen = null;
      if (byPath !== null && byPath.branch === operation.targetRef) {
        chosen = byPath;
      } else if (byBranch !== undefined) {
        chosen = byBranch;
      } else if (byPath !== null) {
        return { ok: false, detail: DETAIL.TARGET_WORKTREE_MISMATCH, message: `${byPath.path} は ${byPath.branch ?? "(detached)"} をチェックアウトしています。` };
      } else {
        return { ok: false, detail: DETAIL.TARGET_WORKTREE_MISSING, message: `${operation.targetRef} をチェックアウトしている worktree がありません。` };
      }
      if (!(await exists(chosen.path))) {
        return { ok: false, detail: DETAIL.TARGET_WORKTREE_MISSING, message: `${chosen.path} が存在しません。` };
      }
      return { ok: true, worktree: chosen.path };
    },

    async inspectTarget({ operation, worktree }) {
      const inProgress = await detectInProgressGitOperation(worktree);
      if (inProgress !== null) {
        return { ok: false, detail: DETAIL.TARGET_GIT_OPERATION, message: `${worktree} で ${inProgress} が進行中です。` };
      }
      const tracked = await statusPorcelain(worktree, { includeUntracked: false });
      if (tracked !== "") {
        return { ok: false, detail: DETAIL.TARGET_DIRTY, message: `${worktree} に未コミットの変更があります。`, extra: { status: tracked } };
      }
      const head = await headOf(worktree);
      return { ok: true, head };
    },

    async loadPolicy({ operation }) {
      const atRef = await readPolicyAtRef(operation.repoPath, operation.expectedTargetHead);
      if (!atRef.present) {
        return { ok: false, detail: DETAIL.POLICY_MISSING, message: `${operation.expectedTargetHead} に ${POLICY_PATH} がありません。` };
      }
      if (atRef.hash !== operation.policyHash) {
        return {
          ok: false,
          detail: DETAIL.POLICY_CHANGED,
          message: "受付時と検証条件が変わっています。再受付してください。",
          extra: { registeredPolicyHash: operation.policyHash, currentPolicyHash: atRef.hash },
        };
      }
      return { ok: true, policy: atRef.policy, hash: atRef.hash };
    },

    async checkGuardPaths({ operation, policy }) {
      if (policy.guardPaths.length === 0) return { ok: true, touched: [] };
      const files = await changedFiles(operation.repoPath, operation.expectedTargetHead, operation.submittedHead);
      const touched = guardPathsTouched(policy.guardPaths, files);
      if (touched.length > 0) {
        return {
          ok: false,
          detail: DETAIL.GUARD_PATH_TOUCHED,
          message: "親の判断が必要なパスが変更されています。",
          extra: { touched, files },
        };
      }
      return { ok: true, touched: [] };
    },

    /**
     * 候補を作る。既存候補があり、親が競合を解消してコミット済みならそれを再利用する。
     */
    async prepareOrInspectCandidate({ operation, evidenceDir }) {
      const layout = await getLayout();
      const branch = candidateBranch(operation.operationId);
      const candidatePath = path.join(layout.worktrees, operation.operationId);
      const branchExists = await commitExists(operation.repoPath, `refs/heads/${branch}`);
      const worktreeExists = await exists(candidatePath);

      if (branchExists && worktreeExists) {
        const existingHead = await headOf(candidatePath);
        const inProgress = await detectInProgressGitOperation(candidatePath);
        const dirty = await statusPorcelain(candidatePath);
        const resolvable =
          inProgress === null &&
          dirty === "" &&
          existingHead !== operation.expectedTargetHead &&
          (await isAncestor(operation.repoPath, operation.submittedHead, existingHead)) &&
          (await isAncestor(operation.repoPath, operation.expectedTargetHead, existingHead));
        if (resolvable) {
          logger(`reuse candidate ${existingHead}`);
          return { ok: true, reused: true, candidateHead: existingHead, candidateWorktree: candidatePath, branch };
        }
        if (inProgress !== null || dirty !== "") {
          await evidenceStep(evidenceDir, "candidate-in-progress", { candidatePath, inProgress, status: dirty });
          return {
            ok: false,
            detail: DETAIL.MERGE_CONFLICT,
            message: `${candidatePath} に未コミットの解消作業が残っています。コミットするか破棄してください。`,
            candidateWorktree: candidatePath,
            extra: { candidatePath, inProgress: inProgress ?? "dirty" },
          };
        }
      }

      await removeCandidate(operation, branch, candidatePath, layout);
      const added = await gitTry([
        "-C",
        operation.repoPath,
        "worktree",
        "add",
        "-b",
        branch,
        candidatePath,
        operation.expectedTargetHead,
      ]);
      if (added.code !== 0) {
        return {
          ok: false,
          detail: DETAIL.MERGE_FAILED,
          message: `候補ワークツリーを作成できません: ${String(added.stderr).trim()}`,
        };
      }

      const merge = await gitTry(["-C", candidatePath, "merge", "--no-ff", "--no-commit", operation.submittedHead]);
      if (evidenceDir && merge.stdout !== "") {
        await writeEvidenceFile(evidenceDir, `merge-${operation.operationId}.stdout.txt`, merge.stdout);
      }
      if (merge.code !== 0) {
        const conflicted = await gitText(["-C", candidatePath, "diff", "--name-only", "--diff-filter=U"]).catch(() => "");
        const conflictedFiles = conflicted === "" ? [] : conflicted.split(/\r?\n/).filter((line) => line !== "");
        if (evidenceDir) {
          await writeEvidenceFile(evidenceDir, "merge-conflict.txt", `exit=${merge.code}\n\n${merge.stdout}\n${merge.stderr}\n`);
        }
        logger(`merge conflict: ${conflictedFiles.join(", ")}`);
        return {
          ok: false,
          detail: conflictedFiles.length > 0 ? DETAIL.MERGE_CONFLICT : DETAIL.MERGE_FAILED,
          message: conflictedFiles.length > 0
            ? `マージが競合しました。${candidatePath} で解消してコミットしてください。`
            : `マージに失敗しました: ${String(merge.stderr).trim()}`,
          candidateWorktree: candidatePath,
          extra: { candidatePath, conflictedFiles, exitCode: merge.code },
        };
      }

      const committed = await gitTry(
        [
          "-C",
          candidatePath,
          "-c",
          `user.name=${options.committerName ?? "integrate-task"}`,
          "-c",
          `user.email=${options.committerEmail ?? "integrate-task@localhost"}`,
          "commit",
          "-m",
          `integrate-task: ${operation.operationId} を ${operation.targetBranch} へ統合`,
        ],
        { env },
      );
      if (committed.code !== 0) {
        await evidenceStep(evidenceDir, "candidate-commit-failed", { exitCode: committed.code, stderr: committed.stderr });
        return {
          ok: false,
          detail: DETAIL.MERGE_FAILED,
          message: `候補コミットを作成できません: ${String(committed.stderr).trim()}`,
          candidateWorktree: candidatePath,
        };
      }
      const candidateHead = await headOf(candidatePath);
      logger(`candidate created ${candidateHead}`);
      return { ok: true, reused: false, candidateHead, candidateWorktree: candidatePath, branch };
    },

    async verifyCandidate({ operation, candidate, policy, evidenceDir, signal }) {
      const submittedIsAncestor = await isAncestor(operation.repoPath, operation.submittedHead, candidate.candidateHead);
      const targetIsAncestor = await isAncestor(operation.repoPath, operation.expectedTargetHead, candidate.candidateHead);
      if (!submittedIsAncestor || !targetIsAncestor) {
        return {
          ok: false,
          detail: DETAIL.CANDIDATE_SHAPE_MISMATCH,
          message: "候補が必要な 2 つの祖先を含んでいません。",
          extra: { submittedIsAncestor, targetIsAncestor },
        };
      }
      const outcome = await runVerifyCommands({
        worktree: candidate.candidateWorktree,
        policy,
        evidenceDir,
        signal,
        env,
      });
      if (outcome.mutated) {
        return {
          ok: false,
          detail: DETAIL.VERIFY_MUTATED_WORKTREE,
          message: "検証がワークツリーを書き換えたため、受入の根拠にできません。",
          extra: { results: outcome.results },
        };
      }
      if (!outcome.ok) {
        return {
          ok: false,
          detail: DETAIL.VERIFY_FAILED,
          message: `検証に失敗しました: ${outcome.failed.map((entry) => entry.name).join(", ")}`,
          extra: { results: outcome.results, failed: outcome.failed },
        };
      }
      return { ok: true, results: outcome.results };
    },

    async publishCandidate({ operation, worktree, candidate, evidenceDir }) {
      const pushed = await gitTry(["-C", worktree, "merge", "--ff-only", candidate.candidateHead]);
      const head = await headOf(worktree);
      if (evidenceDir) {
        await writeEvidenceFile(evidenceDir, "publish.txt", `exit=${pushed.code}\n\n${pushed.stdout}\n${pushed.stderr}\n`);
      }
      if (pushed.code === 0 && head === candidate.candidateHead) {
        logger(`published ${head}`);
        return { ok: true, targetHead: head };
      }
      const moved = head !== operation.expectedTargetHead;
      return {
        ok: false,
        detail: moved ? DETAIL.TARGET_MOVED : DETAIL.PUBLISH_FAILED,
        message: pushed.code === 0
          ? `反映後の HEAD が候補と一致しません (${head})。`
          : `反映に失敗しました: ${String(pushed.stderr).trim()}`,
        extra: { targetHead: head, exitCode: pushed.code },
      };
    },

    /**
     * 反映済みの取りこぼしを台帳へ戻す。再通知で二重マージしないための経路。
     */
    async recoverPublished({ operation, worktree }) {
      const head = await headOf(worktree);
      if (operation.candidateHead !== null && head === operation.candidateHead) {
        return { recovered: true, targetHead: head };
      }
      if (operation.integration !== null && head === operation.integration.integrationCommit) {
        return { recovered: true, targetHead: head };
      }
      return {
        recovered: false,
        detail: DETAIL.INTEGRATION_RECORD_INCONSISTENT,
        message: `台帳は ${STATE.INTEGRATED} ですが、HEAD (${head}) が記録した統合コミットと一致しません。`,
        extra: { targetHead: head, candidateHead: operation.candidateHead, integration: operation.integration },
      };
    },

    async recordOutcome({ operationId, patch, evidenceRef }) {
      const layout = await getLayout();
      const current = await readOperation(layout, operationId);
      if (current === null) return null;
      const next = {
        ...current,
        ...patch,
        evidenceRef: evidenceRef ?? current.evidenceRef,
      };
      return writeOperation(layout, next);
    },

    async createEvidence({ operationId }) {
      const layout = await getLayout();
      const { dir, ref } = await nextEvidenceDir(layout, operationId);
      return { dir, ref };
    },

    async writeRunRecord({ evidenceDir, name, value }) {
      await evidenceStep(evidenceDir, name, value);
    },
  };
}

async function removeCandidate(operation, branch, candidatePath, layout) {
  const worktrees = await listWorktrees(operation.repoPath);
  if (worktrees.some((entry) => path.resolve(entry.path) === path.resolve(candidatePath))) {
    await gitTry(["-C", operation.repoPath, "worktree", "remove", "--force", candidatePath]);
  }
  await gitTry(["-C", operation.repoPath, "worktree", "prune"]);
  if (await commitExists(operation.repoPath, `refs/heads/${branch}`)) {
    await gitTry(["-C", operation.repoPath, "branch", "-D", branch]);
  }
  await fs.rm(candidatePath, { recursive: true, force: true }).catch(() => {});
}

export async function cleanupCandidate(operation, options = {}) {
  const env = options.env ?? process.env;
  const layout = homeLayout(resolveHome(env));
  const branch = candidateBranch(operation.operationId);
  const candidatePath = path.join(layout.worktrees, operation.operationId);
  await removeCandidate(operation, branch, candidatePath, layout);
  return { branch, candidatePath };
}

export async function readLocalPolicy(dir) {
  return readPolicyFromDir(dir);
}

export async function localPolicyHash(file) {
  const bytes = await fs.readFile(file);
  return { hash: sha256Hex(bytes), policy: parsePolicy(bytes.toString("utf8"), file) };
}

export async function removeOperation(operationId, options = {}) {
  const env = options.env ?? process.env;
  const layout = await ensureHome(resolveHome(env));
  const file = path.join(layout.operations, `${assertOperationId(operationId)}.json`);
  try {
    await fs.unlink(file);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return true;
}

export { LEDGER_STATE };
