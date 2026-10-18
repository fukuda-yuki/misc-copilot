import { headOf, runCommand, statusPorcelain } from "./git.mjs";
import { writeEvidenceFile } from "./store.mjs";

/**
 * 検証コマンドは argv 配列で実行する（シェルを介さない）。
 * 検証がワークツリーを書き換えた場合、その結果は受入の根拠にならないため不合格にする。
 */
export async function runVerifyCommands(options) {
  const { worktree, policy, evidenceDir, signal, env, captureOutput = false, maxOutputChars = 2000 } = options;
  const before = { head: await headOf(worktree), tracked: await statusPorcelain(worktree, { includeUntracked: false }) };
  const results = [];

  for (const entry of policy.verify) {
    let outcome;
    const startedAt = Date.now();
    try {
      outcome = await runCommand(entry.command, entry.args, {
        cwd: worktree,
        signal,
        timeoutMs: entry.timeoutSeconds * 1000,
        env,
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      results.push({
        name: entry.name,
        command: entry.command,
        args: entry.args,
        code: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        failedToStart: error.message,
        passed: false,
        ...(captureOutput ? { stderr: error.message } : {}),
      });
      break;
    }
    results.push({
      name: entry.name,
      command: entry.command,
      args: entry.args,
      code: outcome.code,
      timedOut: outcome.timedOut === true,
      durationMs: Date.now() - startedAt,
      passed: outcome.code === 0 && outcome.timedOut !== true,
      ...(captureOutput
        ? { stdout: tail(outcome.stdout ?? "", maxOutputChars), stderr: tail(outcome.stderr ?? "", maxOutputChars) }
        : {}),
    });
    if (evidenceDir !== undefined && evidenceDir !== null) {
      await writeEvidenceFile(evidenceDir, `verify-${results.length}-${sanitize(entry.name)}.stdout.txt`, outcome.stdout ?? "");
      await writeEvidenceFile(evidenceDir, `verify-${results.length}-${sanitize(entry.name)}.stderr.txt`, outcome.stderr ?? "");
    }
    if (!results.at(-1).passed) break;
  }

  const after = { head: await headOf(worktree), tracked: await statusPorcelain(worktree, { includeUntracked: false }) };
  const mutated = before.head !== after.head || before.tracked !== after.tracked;
  const failed = results.filter((entry) => entry.passed !== true);
  const ok = failed.length === 0 && !mutated;

  if (evidenceDir !== undefined && evidenceDir !== null) {
    await writeEvidenceFile(
      evidenceDir,
      "verify-summary.json",
      `${JSON.stringify({ worktree, mutated, before, after, results }, null, 2)}\n`,
    );
  }

  return { ok, mutated, results, failed, before, after };
}

function sanitize(name) {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
}

/** captureOutput のときだけ使う。失敗の原因を修正役へ渡すため、出力の末尾だけを切り出す。 */
function tail(text, limit) {
  const value = String(text);
  if (value.length <= limit) return value;
  return `...(先頭 ${value.length - limit} 文字を省略)\n${value.slice(-limit)}`;
}
