# .github/ai — AI向けの指示書

このディレクトリは、**AIセッションに渡す指示書だけ**を置く場所です。
学習者向けの説明（`README.md`、`docs/`）には、AIセッション・run番号・並列開発の話を書きません。

| ファイル | 内容 |
| --- | --- |
| `START-MODERNIZE.md` | 移行を実施するAIセッション（実装者）へ渡す指示書。段階1〜4、ブランチ、記録、成果物 |
| `START-ORCHESTRATE.md` | 親セッション（オーケストレーター）へ渡す指示書。作業単位の分割と統合の進め方 |
| `runs/` | run単位の作業記録の置き場所 |

関連する AI向けの指示は、このリポジトリの次の場所にもあります。

- `AGENTS.md`（リポジトリ直下）: 目的・作業範囲・参照してはいけないもの・記録の原則。
- `.github/copilot-instructions.md`: GitHub Copilot を使う場合の共通ルール。
- `.github/skills/parallel-dev-orchestration/SKILL.md`: 並列開発の手順の正本。
- `.github/integrate-task.policy.json` と `.github/extensions/integrate-task/`: 統合の道具立て。

## 開始地点のツリーとの違い（重要）

移行の開始地点（`demo/00-legacy-v2` / `demo/start-v2` = `cb90026f0a7692241544ea7c106cec5327ade630`）は固定です。
**そのツリーでは、文書は `docs/demo/` にあります。**

| 現在の `main` | 開始地点のツリー |
| --- | --- |
| `docs/BASELINE.md` | `docs/demo/BASELINE.md` |
| `docs/ACCEPTANCE.md` | `docs/demo/ACCEPTANCE.md` |
| `.github/ai/START-MODERNIZE.md` | `docs/demo/START-MODERNIZE.md` |
| `.github/ai/START-ORCHESTRATE.md` | `docs/demo/START-ORCHESTRATE.md` |

受入条件の本文（26条件）は同じです。開始地点のツリーには、このディレクトリ（`.github/ai/`）と
`docs/LEARNING-PATH.md` はありません。旧版アプリのソース（`shared-legacy-app/`）は、どちらも同一です
（実測：`git diff --stat demo/00-legacy-v2 main -- shared-legacy-app` が差分なし）。
