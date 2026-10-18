import { DETAIL, STATE, result, validateArgs } from "../core/state.mjs";

export const INTEGRATION_WORKFLOW_NAME = "integrate-task";

export const integrationMeta = {
  name: INTEGRATION_WORKFLOW_NAME,
  description:
    "子セッションの提出コミットを、親が受け付けた内容（operationId）に従って検証し、ターゲットブランチへ履歴を保ったまま統合する。" +
    " mode=check は候補の作成と検証までで停止し、apply は検証に通った候補だけを反映する。" +
    " 戻り値の state は NEEDS_PARENT / STALE_TARGET / BLOCKED / VERIFIED_NOT_PUBLISHED / INTEGRATED のいずれか。",
  argsSchema: {
    type: "object",
    required: ["operationId", "mode"],
    properties: {
      operationId: {
        type: "string",
        description: "cli.mjs register で登録済みの受付 ID（英数字で始まる 1〜100 文字の [A-Za-z0-9._-]）。",
      },
      mode: {
        type: "string",
        enum: ["check", "apply"],
        description: "check は検証まで、apply は検証済み候補の反映まで実行する。",
      },
    },
  },
  phases: [
    { title: "受付を読み込む", detail: "台帳から operationId の受付内容と依存を読む" },
    { title: "ターゲットを検査する", detail: "排他を取得し、ポリシー・ガード・HEAD を確認する" },
    { title: "候補を作る", detail: "一時 worktree で merge --no-ff の候補コミットを作る" },
    { title: "検証する", detail: "ポリシーの検証コマンドを実行し、証拠を保存する" },
    { title: "反映する", detail: "apply のときだけ ff-only でターゲットへ反映する" },
  ],
};

function nowIso() {
  return new Date().toISOString();
}

/**
 * 判断の順序はここに固定し、git・ファイル・プロセスの実測は ports（ProjectPorts）に任せる。
 * この関数は SDK に依存しないため、record 相当の ports を渡せばテストから直接実行できる。
 */
export function createIntegrationRun(ports) {
  return async function run(ctx) {
    const signal = ctx?.signal;
    const log = (message) => ctx?.log?.(message);
    const phase = (title) => ctx?.phase?.(title);
    const started = Date.now();

    let args;
    try {
      args = validateArgs(ctx?.args);
    } catch (error) {
      return result(STATE.NEEDS_PARENT, "invalid-arguments", {
        message: error.message,
        extra: { operationId: null, mode: null, durationMs: Date.now() - started },
      });
    }
    const { operationId, mode } = args;

    phase("受付を読み込む");
    const operation = await ports.loadRegisteredOperation({ operationId });
    if (operation === null) {
      return result(STATE.NEEDS_PARENT, "operation-not-found", {
        message: `受付 ${operationId} は台帳にありません。cli.mjs register で先に登録してください。`,
        extra: { operationId, mode, durationMs: Date.now() - started },
      });
    }

    const evidence = await ports.createEvidence({ operationId });
    const evidenceRef = evidence.ref;
    let current = operation;

    const finish = async (state, detail, options = {}) => {
      const { message = "", candidateHead = null, extra = {}, patch = {} } = options;
      const checkedAt = nowIso();
      await ports.writeRunRecord({
        evidenceDir: evidence.dir,
        name: "result",
        value: { operationId, mode, state, detail, message, extra, checkedAt, durationMs: Date.now() - started },
      });
      current = await ports.recordOutcome({
        operationId,
        evidenceRef,
        patch: {
          state,
          detail,
          message,
          candidateHead: candidateHead ?? current.candidateHead,
          checkedAt,
          ...(state === STATE.INTEGRATED ? { integratedAt: checkedAt } : {}),
          ...patch,
        },
      });
      log(`${state} / ${detail}`);
      return result(state, detail, {
        message,
        candidateHead: candidateHead ?? current.candidateHead,
        evidenceRef,
        extra: { operationId, mode, durationMs: Date.now() - started, ...extra },
      });
    };

    const pendingDependencies = [];
    for (const dependency of operation.dependsOn) {
      const status = await ports.isDependencyIntegrated({ operationId: dependency });
      if (!status.integrated) pendingDependencies.push({ operationId: dependency, found: status.found, state: status.state });
    }
    if (pendingDependencies.length > 0) {
      return finish(STATE.BLOCKED, DETAIL.DEPENDENCY_NOT_INTEGRATED, {
        message: "依存する受付がまだ統合されていません。",
        extra: { pendingDependencies },
      });
    }

    const policyResult = await ports.loadPolicy({ operation });
    if (!policyResult.ok) {
      return finish(STATE.NEEDS_PARENT, policyResult.detail, {
        message: policyResult.message,
        extra: policyResult.extra ?? {},
      });
    }
    const policy = policyResult.policy;

    phase("ターゲットを検査する");
    const lock = await ports.acquireTargetLock({ operation, policy, signal });
    if (!lock.acquired) {
      return finish(STATE.NEEDS_PARENT, lock.detail, {
        message: `ターゲット ${operation.targetRef} は他の受付が処理中です。時間をおいて再実行してください。`,
        extra: { lockOwner: lock.owner, lockAgeMinutes: lock.ageMinutes },
      });
    }

    try {
      const located = await ports.resolveTargetWorktree({ operation });
      if (!located.ok) {
        return await finish(STATE.NEEDS_PARENT, located.detail, { message: located.message, extra: located.extra ?? {} });
      }
      const worktree = located.worktree;

      const inspected = await ports.inspectTarget({ operation, worktree });
      if (!inspected.ok) {
        return await finish(STATE.NEEDS_PARENT, inspected.detail, { message: inspected.message, extra: inspected.extra ?? {} });
      }
      const targetHead = inspected.head;

      if (operation.state === STATE.INTEGRATED) {
        const recovered = await ports.recoverPublished({ operation, worktree });
        if (!recovered.recovered) {
          return await finish(STATE.NEEDS_PARENT, recovered.detail, { message: recovered.message, extra: recovered.extra ?? {} });
        }
        return await finish(STATE.INTEGRATED, DETAIL.ALREADY_INTEGRATED, {
          message: `受付 ${operationId} は反映済みです。`,
          candidateHead: recovered.targetHead,
          extra: { targetHead: recovered.targetHead },
        });
      }

      if (operation.candidateHead !== null && targetHead === operation.candidateHead) {
        return await finish(STATE.INTEGRATED, DETAIL.RECOVERED_AFTER_PUBLISH, {
          message: "反映は完了していましたが台帳に記録がありませんでした。記録を復旧しました。",
          candidateHead: targetHead,
          patch: { integrationCommit: targetHead, integratedAt: nowIso() },
          extra: { targetHead },
        });
      }

      if (targetHead !== operation.expectedTargetHead) {
        return await finish(STATE.STALE_TARGET, DETAIL.TARGET_MOVED, {
          message: `ターゲットが受付時の ${operation.expectedTargetHead.slice(0, 12)} から ${targetHead.slice(0, 12)} へ進んでいます。再受付してください。`,
          extra: { targetHead, expectedTargetHead: operation.expectedTargetHead },
        });
      }

      const guards = await ports.checkGuardPaths({ operation, policy });
      if (!guards.ok) {
        return await finish(STATE.NEEDS_PARENT, guards.detail, { message: guards.message, extra: guards.extra ?? {} });
      }

      if (await ports.isIntegratedAlready({ operation, targetHead })) {
        return await finish(STATE.INTEGRATED, DETAIL.ALREADY_INTEGRATED, {
          message: "提出コミットは既にターゲットへ取り込まれています。",
          candidateHead: targetHead,
          patch: { integrationCommit: targetHead, integratedAt: nowIso() },
          extra: { targetHead },
        });
      }

      phase("候補を作る");
      const candidate = await ports.prepareOrInspectCandidate({ operation, evidenceDir: evidence.dir });
      if (!candidate.ok) {
        return await finish(STATE.NEEDS_PARENT, candidate.detail, {
          message: candidate.message,
          candidateHead: candidate.candidateHead ?? null,
          patch: { candidateWorktree: candidate.candidateWorktree ?? null },
          extra: candidate.extra ?? {},
        });
      }
      current = await ports.recordOutcome({
        operationId,
        evidenceRef,
        patch: { candidateHead: candidate.candidateHead, candidateWorktree: candidate.candidateWorktree },
      });

      phase("検証する");
      const verified = await ports.verifyCandidate({ operation, candidate, policy, evidenceDir: evidence.dir, signal });
      if (!verified.ok) {
        return await finish(STATE.NEEDS_PARENT, verified.detail, {
          message: verified.message,
          candidateHead: candidate.candidateHead,
          extra: verified.extra ?? {},
        });
      }

      if (mode === "check") {
        return await finish(STATE.VERIFIED_NOT_PUBLISHED, DETAIL.CHECK_ONLY, {
          message: "候補は検証に通りました。反映は行っていません。",
          candidateHead: candidate.candidateHead,
          extra: {
            candidateWorktree: candidate.candidateWorktree,
            reusedCandidate: candidate.reused === true,
            verifyResults: verified.results ?? [],
          },
        });
      }

      phase("反映する");
      const published = await ports.publishCandidate({ operation, worktree, candidate, evidenceDir: evidence.dir });
      if (!published.ok) {
        const state = published.detail === DETAIL.TARGET_MOVED ? STATE.STALE_TARGET : STATE.NEEDS_PARENT;
        return await finish(state, published.detail, {
          message: published.message,
          candidateHead: candidate.candidateHead,
          extra: published.extra ?? {},
        });
      }
      return await finish(STATE.INTEGRATED, "integrated", {
        message: "ターゲットへ統合しました。",
        candidateHead: published.targetHead,
        patch: { integrationCommit: published.targetHead, integratedAt: nowIso() },
        extra: { targetHead: published.targetHead, verifyResults: verified.results ?? [] },
      });
    } finally {
      await lock.release();
      await ports.writeRunRecord({
        evidenceDir: evidence.dir,
        name: "timeline",
        value: { operationId, mode, durationMs: Date.now() - started, finishedAt: nowIso() },
      });
    }
  };
}
