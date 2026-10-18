# START-ORCHESTRATE — 親セッション（オーケストレーター）へ渡す指示書

この文書は、**前の会話を引き継がない新しいAIセッション**を「全体のオーケストレーター」として起動するための指示書です。
読む人は、この文書・`docs/` の要求・リポジトリ内の道具立て・旧版コードだけを入力として作業してください。

依頼者が新しいセッションへ渡す短い指示：

> このリポジトリの `.github/ai/START-ORCHESTRATE.md` を読み、記載された並列開発を実施してください。
> 開始コミット：`cb90026f0a7692241544ea7c106cec5327ade630`

準備担当の会話ログや、参考となる完成版は渡されません。この文書に書かれていないことで分からないことは、
自分で調べて判断し、判断内容と根拠を記録してください。

---

## 1. 目的

`.github/ai/START-MODERNIZE.md` の移行を、**親セッション（オーケストレーター）と子セッションの並列開発**として実施します。

| 役割 | 誰が | 担当 |
| --- | --- | --- |
| 目的・制約・優先順位 | ユーザー | 会話 |
| 作業単位の決定、依存関係・共通ファイル・受入条件の整理、子への割り当て、統合待ちキュー、最終レビュー、PR | 親セッション（あなた） | 段階1・2・4 と統合・PR |
| 1 作業単位の実装〜提出（専用 worktree／専用ブランチ） | 子セッション | 段階3 の各単位。`task-pipeline` を実行する |

**詳しい手順の正本は、このリポジトリのプロジェクトスキル `.github/skills/parallel-dev-orchestration/SKILL.md` です。**
この文書は、そのスキルを**この移行**に適用するときの具体化です。矛盾したらスキルの手順に従い、差分を記録してください。

## 2. 正本（この文書は分担と順序だけを定める）

| 内容 | 正本 |
| --- | --- |
| 受入条件 | `docs/ACCEPTANCE.md`（**黙って弱めない**） |
| 移行の内容・段階・固定ブランチ・記録 | `.github/ai/START-MODERNIZE.md` |
| 開始状態の説明 | `docs/BASELINE.md` |
| 共通の短いルール | `AGENTS.md` |
| 並列開発の手順 | `.github/skills/parallel-dev-orchestration/SKILL.md` |

CLI 入口（driver の子プロセスを責任者にして `task-pipeline` を回す）は**実装済み**です
（`.github/extensions/integrate-task/docs/CLI-ENTRY.md`）。ただし実 copilot の実走は、実装役 subagent が
ファイルを書けない（CLI の権限モデル）ため**提出に到達していません**。未達のまま記録しています
（同文書の「8.1 実測の記録」と `.github/extensions/integrate-task/README.md`）。

## 3. 前提（着手前に実測して記録する）

| 項目 | 期待 | 実測方法 |
| --- | --- | --- |
| 統合ブランチ | `feat/modernize-run01` を `main` から切る | `git switch -c feat/modernize-run01` |
| 拡張の登録 | `task-pipeline` と `integrate-task` | `dynamic_workflows_manage` の `list` |
| ポリシー | `.github/integrate-task.policy.json` を**この実行用に更新**してある | `node .github/extensions/integrate-task/integrate/cli.mjs policy` |
| 道具立ての可視性 | 子の worktree に `.github/extensions/integrate-task/` と `.github/skills/` が入っている | 子の起動後に子の作業ツリーで確認 |
| 実行環境 | .NET SDK・ランタイム・移行ツールの実測 | `dotnet --version` など（準備環境の値を前提にしない） |

開始地点について、**この文書の作成時に実測した事実**：

- `git rev-parse demo/00-legacy-v2` = `cb90026f0a7692241544ea7c106cec5327ade630`（開始ブランチと開始タグ `demo/start-v2` は同じコミット）。
- `git diff --stat demo/00-legacy-v2 main -- shared-legacy-app` は**差分なし**（旧版アプリの内容は両者で同一）。
- `main` は `demo/00-legacy-v2` の子孫（`git merge-base --is-ancestor` が真）。差分は道具立て
  （`.github/extensions/integrate-task/`・`.github/integrate-task.policy.json`・`.github/skills/`）と文書
  （`docs/`・`.github/ai/`・`README.md`）で、旧版アプリのソースは変わっていない。
  実行時に `git rev-parse main` と `git diff --stat demo/00-legacy-v2 main` で現在の状態を実測して記録する。

子の worktree は既定ブランチから作られるため、**道具立てを含む `main` から統合ブランチを切ります**。
開始地点と内容が同一である根拠は上記の差分で、この判断と根拠を実行記録に残してください。

## 4. ポリシー（子を起動する前に親が更新する）

- `verify` は「統合後の状態で成立すべき検証」を書く。例：`dotnet build shared-legacy-app/BookCatalog.sln`（timeoutSeconds 600）。
  統合のたびにこの検証が走ります。
- 各作業単位の検証は `task-pipeline` の `verify` 引数で上書きできる。**単位ごとに意味のある検証**を書く。
- `guardPaths` に `docs/ACCEPTANCE.md`・`AGENTS.md`・`.github/` を入れる（子が受入条件や道具立てを書き換えられないようにする）。
- 更新は統合ブランチで**親が直接**コミットする。子には触らせない。

## 5. 進め方

### 5.1 段階1（調査）・段階2（計画）は親が担当する（並列化しない）

`.github/ai/START-MODERNIZE.md` の段階1・段階2 を親が行い、統合ブランチへコミットして `demo/run01/01-assessment`・`demo/run01/02-plan` を作ります。

### 5.2 段階3（実装）を作業単位に分けて子へ割り当てる

- 単位は「**独立して検証できる**」粒度にする。同じファイルを触る単位は直列化する。
- 各単位に次を決める：`taskId` / `title` / `prompt`（受入条件のうち何を満たすか）/ `verify` / 依存関係 / 触るファイル。
- **最初の単位は「ビルドが通る最小の移行」**（プロジェクトの `net10.0` 化・ホスト・EF Core SQLite 接続・コントローラの骨格）にする。
  以降の単位はその上に積む。**各単位は統合後の状態でポリシーの `verify` が通るように切る。**
- **作業単位の表をユーザーに見せ、承認を得てから子を起動する。**（この実行はテストであり、分解の妥当性を人間が確認する）
- 並列数は 2〜3 から始める。最初の 1 件は `mode: "interactive"` で流れを確認すると安全。
- 子の起動はスキルの kickoff テンプレートを使う（`create_session` / `workspace_type: "worktree"` / `notify_on_idle: "once"`）。
  子は自分の worktree で `git switch -c agent/<taskId> feat/modernize-run01` してから `task-pipeline` を実行する。

### 5.3 統合待ちキューへ 1 件ずつ取り込む

スキルの「6. 統合待ちキューへ 1 件ずつ取り込む」に従います（`register` → `check` → `apply`）。
`NEEDS_PARENT`・`BLOCKED`・`STALE_TARGET` は理由コードごとに親が解消してから再実行します。
**子に統合・push・PR をさせないこと。**

### 5.4 段階4（起動と受入確認）は親が担当する

- 受入確認は統合ブランチで親が実施し、`.github/ai/runs/run01/verification.md` に記録して `demo/run01/04-verified` を作る。
- **不明点や未実施項目があるまま `verified` という名前を付けない。**
- 検証後に対象を変更したら、新しいSHAを記録して影響する確認を再実施する。

### 5.5 最終レビューと PR

- 統合ブランチ全体を `docs/ACCEPTANCE.md` と突き合わせてレビューする。
- PR は**ユーザーに確認してから**作る：`gh pr create --base main --head feat/modernize-run01`
  （`.github/ai/START-MODERNIZE.md` は `demo/00-legacy-v2` を base にした Draft PR を挙げている。統合ブランチを `main` から切ったため、
  base を `main` にする判断と、その理由・差分を実行記録に残す）
- **マージはユーザーが承認した範囲でのみ**実行する。勝手にマージ・push しない。

## 6. 守ること（禁止）

- モダナイゼーション後のソースコード（上流の完成実装・完成版向けテスト・既成の移行計画・過去runのコード）を参照・コピーしない。
  出典リンクを手掛かりに完成例を開かない。
- `git fetch --all` や全refsの履歴探索をしない。開始地点より前の文書リビジョンを読まない。
- Docker / コンテナー / SQL Server / SQL Server LocalDB / Azure を使わない。インメモリDB（EF InMemory・`:memory:` のみ）で完成としない。
- 受入条件を実装に合わせて黙って弱めない。テストを通すために入力検証や antiforgery 保護を無効にしない。
- 子に統合・push・PR をさせない。子に受入条件を変更させない。
- 実測していないことを実測済みとして書かない（成功・失敗・未実施を区別する）。

## 7. 記録

- 実行記録は `.github/ai/runs/run01/` に置く（`assessment.md` / `plan.md` / `verification.md` などは実際の作業に合わせる）。
- 並列開発の記録（`orchestration.md` を推奨）：作業単位表、子セッションID、提出コミット、`integrate-task` の state 遷移、統合コミット、所要時間、失敗と対処。
- 使ったツールとバージョン、コマンド、作業場所、終了コード、URL、DBパスを残す。
- ログに認証情報や不要な個人情報を保存しない。

## 8. この文書に含まれないもの

- 作業単位の正解（何をどう分割するかは親が決める）。
- 実装方法・完成コード・完成版のファイル構成。
- 準備担当の会話履歴・完成版・上流実装。

## 9. 未検証（この実行で確かめる）

- 子セッションの完了通知（`create_session` の `notify_on_idle`）の到達。
- `run_dynamic_workflow` の完了通知（結果は `dynamic_workflows_manage` の `inspect-run` で読む。CLI の `copilot workflow run` は完了まで待てることを実測済み）。
- `create_session` の `base_branch` にローカルブランチを指定できるか（この手順では使わない）。
- 子が worktree 作成後に `extensions_reload` で拡張を読み直せるか（道具立てが既定ブランチに無い場合の回避策）。
- `task-pipeline` を実 copilot セッションから起動したときの所要時間と、`verify` 失敗時の修正ループの実挙動。
