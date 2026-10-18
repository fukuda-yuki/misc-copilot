import { REVIEW_SCHEMA, buildFixPrompt, buildImplementPrompt, buildReviewPrompt } from "./prompts.mjs";
import { TASK_DETAIL, TASK_STATE, taskResult, validateTaskArgs } from "./state.mjs";

export const TASK_PIPELINE_WORKFLOW_NAME = "task-pipeline";

export const taskPipelineMeta = {
  name: TASK_PIPELINE_WORKFLOW_NAME,
  description:
    "子セッションの工程を 1 回転させる。実装（subagent）→ 検証（ポリシーのスクリプト・テスト）→ レビュー（subagent）→ 修正ループ → 提出コミットまで。" +
    " 対象はこのワークフローが動いている作業ツリー（子セッションの worktree）。" +
    " 統合は行わない。提出コミットを親の統合待ちキュー（integrate-task）へ登録するのは親の仕事。" +
    " 戻り値の state は SUBMITTED / NEEDS_PARENT のいずれか。",
  argsSchema: {
    type: "object",
    required: ["taskId", "title", "prompt"],
    properties: {
      taskId: {
        type: "string",
        description: "作業単位の ID（英数字で始まる 1〜100 文字の [A-Za-z0-9._-]）。提出コミットのメッセージにも使う。",
      },
      title: { type: "string", description: "作業単位の短い名前（1〜200 文字）。" },
      prompt: {
        type: "string",
        description: "実装役とレビュー役の両方に渡す受入条件。何を作り、何を満たせば完了かを具体的に書く。",
      },
      roles: {
        type: "object",
        description: "役割ごとのモデル・推論強度。省略するとこのセッションの既定を使う。",
        properties: {
          implementer: {
            type: "object",
            properties: {
              model: { type: "string", description: "実装役のモデル。" },
              reasoningEffort: { type: "string", description: "実装役の推論強度。" },
            },
          },
          reviewer: {
            type: "object",
            properties: {
              model: { type: "string", description: "レビュー役のモデル。" },
              reasoningEffort: { type: "string", description: "レビュー役の推論強度。" },
            },
          },
        },
      },
      verify: {
        type: "array",
        description: "検証コマンド。省略すると .github/integrate-task.policy.json の verify を使う。",
        items: {
          type: "object",
          required: ["name", "command"],
          properties: {
            name: { type: "string" },
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            timeoutSeconds: { type: "integer" },
          },
        },
      },
      maxReworks: { type: "integer", description: "実装→検証→レビューの再試行回数（0〜5、既定 2）。" },
      commitMessage: { type: "string", description: "提出コミットのメッセージ。省略すると taskId と title から作る。" },
    },
  },
  phases: [
    { title: "足元を確認する", detail: "作業ツリー・ポリシー・基準コミットを固定する" },
    { title: "実装する", detail: "実装役の subagent が作業ツリーを変更する" },
    { title: "検証する", detail: "ポリシーの検証コマンドを実行し、証拠を保存する" },
    { title: "レビューする", detail: "レビュー役の subagent が受入条件と照合する" },
    { title: "修正する", detail: "検証失敗・レビュー指摘を修正役へ返す" },
    { title: "提出する", detail: "未コミットの変更を提出コミットにする" },
  ],
};

function spawnOptions({ label, model, reasoningEffort, schema }) {
  const options = { label };
  if (typeof model === "string") options.model = model;
  if (typeof reasoningEffort === "string") options.reasoningEffort = reasoningEffort;
  if (schema !== undefined) options.schema = schema;
  return options;
}

function summarizeVerify(verified) {
  return {
    ok: verified.ok,
    mutated: verified.mutated,
    results: verified.results.map((entry) => ({
      name: entry.name,
      command: entry.command,
      args: entry.args,
      code: entry.code,
      timedOut: entry.timedOut === true,
      durationMs: entry.durationMs,
      passed: entry.passed === true,
      failedToStart: entry.failedToStart ?? null,
    })),
  };
}

function describeVerify(summary) {
  const lines = summary.results.map((entry) => {
    const status = entry.passed ? "合格" : "不合格";
    return `- ${entry.name}: 終了コード ${entry.code}${entry.timedOut ? "（タイムアウト）" : ""} / ${entry.durationMs}ms → ${status}`;
  });
  lines.push(summary.mutated ? "- 注意: 検証が作業ツリーを書き換えました。" : "- 検証は作業ツリーを書き換えていません。");
  return lines.join("\n");
}

function describeFailures(verified) {
  return verified.failed.map((entry) => ({
    name: entry.name,
    command: [entry.command, ...(entry.args ?? [])].join(" "),
    code: entry.code,
    timedOut: entry.timedOut === true,
    stdout: entry.stdout ?? "",
    stderr: entry.failedToStart ?? entry.stderr ?? "",
  }));
}

/**
 * 子セッションの工程。判断はここに集約し、外とのやり取りは ports 経由にする。
 * subagent（ctx.agent）は cwd を持てないため、作業ツリーの絶対パスをプロンプトで渡す。
 */
export function createTaskPipelineRun(ports) {
  return async function run(ctx) {
    const startedAt = Date.now();
    const log = (message) => ctx?.log?.(message);
    const phase = (title) => ctx?.phase?.(title);
    const spawn = typeof ctx?.agent === "function" ? ctx.agent.bind(ctx) : null;
    const signal = ctx?.signal;

    const facts = {
      taskId: null,
      title: null,
      attempts: 0,
      maxAttempts: 0,
      worktree: null,
      branch: null,
      baseCommit: null,
      mainCheckout: null,
      policyHash: null,
      evidenceRef: null,
      verifySource: null,
      verify: null,
      review: null,
    };
    const report = (state, detail, message, extra = {}) => {
      log(`${state} / ${detail}`);
      const { submittedHead = null, ...rest } = extra;
      return taskResult(state, detail, {
        message,
        submittedHead,
        evidenceRef: facts.evidenceRef,
        extra: { ...facts, ...rest, durationMs: Date.now() - startedAt },
      });
    };

    if (spawn === null) {
      return report(TASK_STATE.NEEDS_PARENT, TASK_DETAIL.IMPLEMENT_FAILED, "subagent を起動できない実行環境です（ctx.agent がありません）。");
    }

    let args;
    try {
      args = validateTaskArgs(ctx?.args);
    } catch (error) {
      return report(TASK_STATE.NEEDS_PARENT, TASK_DETAIL.INVALID_ARGUMENTS, error.message);
    }
    const { taskId, title, prompt, roles, verify, maxReworks, commitMessage } = args;
    facts.taskId = taskId;
    facts.title = title;

    phase("足元を確認する");
    const worktreeState = await ports.readWorktreeState();
    if (worktreeState.ok !== true) {
      return report(TASK_STATE.NEEDS_PARENT, worktreeState.detail, worktreeState.message, worktreeState.extra ?? {});
    }
    facts.worktree = worktreeState.worktree;
    facts.branch = worktreeState.branch;
    facts.baseCommit = worktreeState.head;
    facts.mainCheckout = worktreeState.mainCheckout;

    let policy;
    try {
      policy = await ports.readPolicy();
    } catch (error) {
      return report(TASK_STATE.NEEDS_PARENT, TASK_DETAIL.POLICY_MISSING, `検証コマンドを決められません: ${error.message}`);
    }
    facts.policyHash = policy.hash;
    facts.verifySource = verify === null ? "policy" : "args";
    const commands = verify ?? policy.policy.verify;
    const maxAttempts = 1 + maxReworks;
    facts.maxAttempts = maxAttempts;

    const evidence = await ports.createEvidence({ taskId });
    facts.evidenceRef = evidence.ref;
    await ports.writeRecord({
      evidenceDir: evidence.dir,
      name: "start",
      value: {
        taskId,
        title,
        baseCommit: facts.baseCommit,
        branch: facts.branch,
        mainCheckout: facts.mainCheckout,
        policyHash: policy.hash,
        policyPath: policy.file,
        verifySource: facts.verifySource,
        commands,
        roles,
        maxReworks,
        commitMessage,
      },
    });

    let attempt = 0;
    let lastVerify = null;
    let lastReview = null;
    let lastFailures = [];

    while (attempt < maxAttempts) {
      attempt += 1;
      facts.attempts = attempt;
      const first = attempt === 1;

      phase(first ? "実装する" : "修正する");
      const instruction = first
        ? buildImplementPrompt({ worktree: facts.worktree, taskId, title, prompt })
        : buildFixPrompt({
          worktree: facts.worktree,
          taskId,
          title,
          prompt,
          reworkNumber: attempt - 1,
          verifyFailures: lastFailures,
          mutated: lastVerify?.mutated === true,
          findings: Array.isArray(lastReview?.findings) ? lastReview.findings : [],
        });
      const produced = await spawn(
        instruction,
        spawnOptions({
          label: `${first ? "implement" : "fix"}:${taskId}:${attempt}`,
          model: roles.implementer.model,
          reasoningEffort: roles.implementer.reasoningEffort,
        }),
      );
      if (produced === null || produced === undefined) {
        return report(
          TASK_STATE.NEEDS_PARENT,
          TASK_DETAIL.IMPLEMENT_FAILED,
          `${first ? "実装役" : "修正役"}の subagent が結果を返しませんでした（${attempt} 回目）。`,
        );
      }

      phase("検証する");
      const verified = await ports.verify({ commands, evidenceDir: evidence.dir, signal });
      lastVerify = verified;
      lastReview = null;
      lastFailures = describeFailures(verified);
      facts.verify = summarizeVerify(verified);
      await ports.writeRecord({
        evidenceDir: evidence.dir,
        name: `verify-${attempt}`,
        value: { attempt, ...facts.verify, failures: lastFailures.map((entry) => ({ name: entry.name, code: entry.code })) },
      });
      log(`verify attempt ${attempt}: ok=${facts.verify.ok} mutated=${facts.verify.mutated}`);

      if (facts.verify.ok !== true) {
        if (attempt >= maxAttempts) {
          return report(
            TASK_STATE.NEEDS_PARENT,
            TASK_DETAIL.REWORK_EXHAUSTED,
            `検証が通りませんでした（${attempt} 回試行）。親が判断してください。`,
          );
        }
        continue;
      }

      phase("レビューする");
      const review = await spawn(
        buildReviewPrompt({
          worktree: facts.worktree,
          taskId,
          title,
          prompt,
          attempt,
          baseCommit: facts.baseCommit,
          verifySummary: describeVerify(facts.verify),
        }),
        spawnOptions({
          label: `review:${taskId}:${attempt}`,
          schema: REVIEW_SCHEMA,
          model: roles.reviewer.model,
          reasoningEffort: roles.reviewer.reasoningEffort,
        }),
      );
      await ports.writeRecord({ evidenceDir: evidence.dir, name: `review-${attempt}`, value: review ?? null });
      if (review === null || review === undefined) {
        return report(
          TASK_STATE.NEEDS_PARENT,
          TASK_DETAIL.REVIEW_UNAVAILABLE,
          `レビュー役の subagent が結果を返しませんでした（${attempt} 回目）。`,
        );
      }
      lastReview = review;
      facts.review = {
        verdict: typeof review.verdict === "string" ? review.verdict : null,
        findings: Array.isArray(review.findings) ? review.findings : [],
        summary: typeof review.summary === "string" ? review.summary : "",
      };
      log(`review attempt ${attempt}: ${facts.review.verdict}`);
      if (facts.review.verdict === "approve") break;
      if (attempt >= maxAttempts) {
        return report(
          TASK_STATE.NEEDS_PARENT,
          TASK_DETAIL.REWORK_EXHAUSTED,
          `レビューが承認しませんでした（${attempt} 回試行）。親が判断してください。`,
        );
      }
    }

    phase("提出する");
    const submitted = await ports.submit({ baseHead: facts.baseCommit, message: commitMessage ?? `${taskId}: ${title}` });
    if (submitted.ok !== true) {
      return report(TASK_STATE.NEEDS_PARENT, submitted.detail, submitted.message, submitted.extra ?? {});
    }
    await ports.writeRecord({
      evidenceDir: evidence.dir,
      name: "result",
      value: {
        state: TASK_STATE.SUBMITTED,
        taskId,
        submittedHead: submitted.submittedHead,
        branch: submitted.branch,
        files: submitted.files,
        attempts: attempt,
        verify: facts.verify,
        review: facts.review,
      },
    });
    return report(
      TASK_STATE.SUBMITTED,
      TASK_DETAIL.SUBMITTED,
      `提出コミット ${submitted.submittedHead.slice(0, 12)} を ${submitted.branch ?? "(detached)"} に作りました。親の統合待ちキューへ登録してください。`,
      {
        submittedHead: submitted.submittedHead,
        files: submitted.files,
        committedByWorkflow: submitted.committed,
        pending: submitted.pending,
      },
    );
  };
}
