// 子セッションの工程で subagent に渡す文面。判断（engine）と実測（ports）から切り離しておく。

export const REVIEW_SCHEMA = {
  type: "object",
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "revise"] },
    findings: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
};

const COMMON_RULES = `## 守ること
- 変更はコミットしないでください。提出コミットはワークフローが作ります。
- 作業ツリーの外（別の worktree、リポジトリ本体、台帳）を触らないでください。
- 一時ファイル・生成物・ログを作業ツリーに残さないでください。
- テストや検証を弱めて通すことは禁止です（削除・スキップ・検証条件の緩和は差し戻し対象）。
- リポジトリの指示（AGENTS.md、.github/copilot-instructions.md）に従ってください。`;

function header({ worktree, taskId, title, role }) {
  return `あなたは作業単位 ${taskId}「${title}」の${role}です。
対象の作業ツリー: ${worktree}
このディレクトリの中だけを変更してください。`;
}

export function buildImplementPrompt({ worktree, taskId, title, prompt }) {
  return `${header({ worktree, taskId, title, role: "実装役" })}

## 作業指示（受入条件）
${prompt}

${COMMON_RULES}
- コンパイル確認など軽い確認はしてかまいませんが、正式な検証はワークフローが実行します。

## 返すもの
変更したファイルの一覧と、何をどう変えたかの短い要約（日本語）。`;
}

export function buildFixPrompt({ worktree, taskId, title, prompt, reworkNumber, verifyFailures, mutated, findings }) {
  const failureLines = verifyFailures.length === 0
    ? ["（検証コマンドの失敗はありません）"]
    : verifyFailures.map((entry) => {
      const lines = [`- ${entry.name}: \`${entry.command}\` が終了コード ${entry.code}${entry.timedOut ? "（タイムアウト）" : ""} で失敗`];
      if (entry.stdout) lines.push(`  stdout(末尾):\n${indent(entry.stdout)}`);
      if (entry.stderr) lines.push(`  stderr(末尾):\n${indent(entry.stderr)}`);
      return lines.join("\n");
    });
  const findingLines = findings.length === 0 ? ["（レビューの指摘はありません）"] : findings.map((item) => `- ${item}`);

  return `${header({ worktree, taskId, title, role: `修正役（修正 ${reworkNumber} 回目）` })}

## 元の作業指示（受入条件）
${prompt}

## 検証の結果
${failureLines.join("\n")}
${mutated ? "- 検証が作業ツリーを書き換えたため不合格になっています。検証コマンドが作業ツリーを汚さないように直してください。" : ""}

## レビューの指摘
${findingLines.join("\n")}

${COMMON_RULES}
- 指摘と失敗に直接対応してください。指摘を消すためにテストや検証を弱めないでください。
- 修正できない指摘があるときは、勝手に受入条件を変えず、できなかった理由を返してください。

## 返すもの
直した内容と、直せなかった点があればその理由（日本語）。`;
}

export function buildReviewPrompt({ worktree, taskId, title, prompt, attempt, baseCommit, verifySummary }) {
  return `あなたは作業単位 ${taskId}「${title}」のレビュー役です（レビュー ${attempt} 回目）。
対象の作業ツリー: ${worktree}
基準コミット: ${baseCommit}

## 作業指示（受入条件）
${prompt}

## ワークフローが実行した検証
${verifySummary}

## 見ること
- 受入条件を満たしているか（未達・取りこぼし・指示と違う解釈）
- 変更がこの作業単位の範囲に収まっているか（関係ない変更が混ざっていないか）
- テストや検証を弱めていないか
- 明らかな欠陥（例外、境界値、null、リソースの後始末）

差分と未追跡ファイルは作業ツリーで確認してください（\`git status\`、\`git diff HEAD\`、必要ならファイルを読む）。

## 返すもの
JSON オブジェクトだけを返してください。
- verdict: "approve"（受入条件を満たし、差し戻す理由がない）または "revise"
- findings: revise のときの具体的な指摘（実装役がそのまま直せる粒度）。approve のときは空配列。
- summary: 1〜2 文の要約（日本語）。`;
}

function indent(text) {
  return text
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join("\n");
}
