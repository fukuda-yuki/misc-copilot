# integrate-task 拡張 / CLI 限定並列開発 driver

子セッションが提出したコミットを、親セッションの受け付け（受付 = operation）に従って検証し、
ターゲットブランチへ **履歴を保ったまま** 統合するためのツールです。

入口は 3 つあり、**判断と実測の中核は共有** します。違うのは「誰が何を担当するか」だけです。

| 入口 | 実行するもの | 担当 |
| --- | --- | --- |
| Copilot App（親セッション＝オーケストレーター） | スキル `.github/skills/parallel-dev-orchestration/SKILL.md` とワークフロー `integrate-task` | 作業単位を決め、子セッションへ割り当て、提出を 1 件ずつ統合し、最終レビューと PR まで進める |
| Copilot App（子セッション） | `.github/extensions/integrate-task/extension.mjs`（ワークフロー `task-pipeline`） | 専用 worktree／専用ブランチで 実装 → 検証 → レビュー → 修正 → 提出コミット |
| CLI | `driver/cli.mjs`（AI を呼ばない常駐 driver） | 非対話で起動した親セッション（`--prompt` + `--output-format=json`）が提案する操作の適用。担当（子）は**責任者**として `copilot workflow run task-pipeline` を回す |

- 実装: プレーンな ESM（`.mjs`）。ビルドも npm 依存もありません。
- 統合の判断（受付の検証・候補の作成・ff-only 公開）は `integrate/engine.mjs` が正本で、
  App のワークフローと driver の両方が同じコードを通ります。
- このリポジトリ自身の `.github/integrate-task.policy.json` は、セルフホスト用の例として
  拡張のテスト（`node --test`）を検証コマンドに指定しています。

## 何をするか（統合の判断）

1. 台帳から受付（`operationId`）を読み、依存する受付がすべて統合済みか確認する（`BLOCKED`）。
2. 受付時に固定したポリシーのハッシュと、`expectedTargetHead` のブロブにあるポリシーを比較する
   （`policy-changed`）。
3. ターゲット参照の排他ロックを取得する（`target-busy`）。
4. ターゲット worktree を解決し、進行中の Git 操作（`TARGET_GIT_OPERATION`）と
   未コミットの追跡ファイル変更（`target-dirty`）を確認する。
5. ターゲット HEAD が受付時と違えば `STALE_TARGET`（`target-moved`）で再受付を求める。
6. `guardPaths` に触れる提出は `guard-path-touched` で親の判断へ戻す。
7. 一時 worktree（`<home>/worktrees/<operationId>`）で `merge --no-ff --no-commit` → 候補コミットを作る。
   競合したら候補と `MERGE_HEAD` を残して `merge-conflict` を返す（親が解消してコミットすれば次の実行で続行）。
8. ポリシーの検証コマンドを実行する。検証の前後でワークツリーが変わったら `verify-mutated-worktree`。
9. `mode=check` はここで `VERIFIED_NOT_PUBLISHED` を返して停止する。
   `mode=apply` は `merge --ff-only` でターゲットを候補まで進め、`INTEGRATED` を返す。

`ctx.step` はジャーナル再生で副作用が再実行され得るため使っていません。Git 操作はすべて
`integrate/ports.mjs` に集約し、`integrate/engine.mjs` は判断の順序だけを持ちます。

## CLI 限定の driver がすること

driver（`driver/`）は AI を呼びません。担当セッションの起動と回収、状態の記録、
親から届いた操作提案の適用だけを行います。

- 担当（task）: 1 タスク = 1 作業ツリー。`driver` が作業ツリーの作成・削除を一括して持ちます。
  担当（子セッション）は **責任者** として、自分の作業ツリーで `copilot workflow run task-pipeline` を回し、
  実装 → 検証 → レビュー → 修正ループ → 提出コミットまでを工程（`task/`）に任せます。工程は CLI 用に
  複製しません。driver は args ファイル `<worktree>/.agent-run/<attemptId>.task.json` とプロンプト
  `<worktree>/.agent-run/<attemptId>.prompt.md` を置き、責任者に
  `copilot workflow run task-pipeline --args @<args> --result-file <worktree>/.agent-run/<attemptId>.task-result.json --silent --output-format json`
  を実行させます。実装役・レビュー役は `--implementer-model` / `--implementer-effort` / `--reviewer-model` /
  `--reviewer-effort` が既定になり、親の DISPATCH の `roles` / `verify` が優先します。args は実行前に
  `argsSchema` で検査し、合わなければ担当を起こさずに止めます。
- 回収: 終了コード 0 を成功とみなしません。結果ファイル（workflow result）の `state` / `submittedHead` を
  先に読み、無ければ `.agent-run/report.json`、最後に終了コードの順で分類します。報告の `submittedHead` と
  作業ツリー HEAD の一致、未コミット変更の有無、ベースからの新規コミット、検証コマンドの終了コードを
  個別に確認し、分類できない出力は `NEEDS_PARENT` / `NEEDS_HUMAN`（`unclassified-output`）へ回します。
- 親: 非対話 CLI（`-p` / `--output-format=json` / `--no-ask-user`）として 1 ターンずつ起動し、
  返答中の ```agent-operation フェンスの JSON だけを受け付けます（文章中のコマンドは実行しません）。
  操作は `DISPATCH` / `ANSWER` / `REWORK` / `CHECK_MERGE` / `APPLY_MERGE` / `REQUEST_HUMAN` / `FINISH` です。
- 枠: 担当実行枠・重い検証枠・統合枠を分けて数えます（既定 `2,1,1`）。
- 停止: 未統合のタスクが残っている `FINISH` は受け付けません。`stop` は実行中の担当を止めてから止まります。
- セッション消失: 同じ UUID で空セッションを作り直して「再開成功」にはしません。
  `--resume` が使えない場合は `NEEDS_HUMAN`（`session-lost`）へ回します。

### 責任者を CLI で回すときの制約（実測）

責任者 + `task-pipeline` の経路は実装・テスト済みですが、実 copilot での実走では**提出まで到達しません**。
原因は driver ではなく CLI の権限モデルです（実測は「実測したこと」の段階 D）。
実走は `NEEDS_PARENT` → `REWORK` → `NEEDS_PARENT` → `request-human` と進み、driver は
`state=STOPPED` / `stopDetail=human-requested`（終了コード 3）で停止しました。

- `task-pipeline` の実装役は `ctx.agent` が起こす subagent で、**ファイルを書くツールを持ちません**
  （実測: subagent 自身の報告「Write/apply_patch tool is not exposed in this subagent」、
  そのセッションに `apply_patch` の要求が 0 件）。
- 実装役がシェルで書こうとすると拒否されます（実測: `node -e` での書き込み、`git hash-object -w --stdin`、
  `git checkout-index --all`、`git cat-file -e` が `denied-no-approval-rule-and-could-not-request-from-user`）。
  `copilot help permissions` は `write(path?)` が「シェルツールの起動を除く」ファイル変更ツールに一致すること、
  シェルリダイレクトを許可するには `--allow-all-tools` が要ることを明記しています。
- 参考（同じ `task-pipeline` を対話セッションの文脈で実行した probe、`%TEMP%\integrate-task-probe`）: 実装役は
  まず `Set-Content -Path '.\probe.txt' …` を試して拒否され（段階 D と同じ `denied-no-approval-rule-…`）、
  次に `[System.IO.File]::WriteAllText(...)` を実行しています。こちらは `permission.requested` が発生せず
  （`hook.start` → `tool.execution_complete success=true` のみ）そのまま通り、`SUBMITTED` に到達しました。
  つまり「シェルだから常に拒否」ではなく、コマンドごとの分類で結果が変わります（`Set-Content` /
  `node -e …writeFileSync` / `git hash-object -w --stdin` は拒否、`WriteAllText` は素通り）。
  この差は実行状況と CLI の分類に依存するため、実装役が書けることを前提にした設計は避けています。
- したがって `--allow-all` を使わない方針のままでは、実装役はファイルを作れません。許可を広げれば
  任意のコマンドが通るため、`--deny-tool` の `git push` などをすり抜ける余地が生まれます（**未検証**）。
  driver は既定で許可を広げず、実装役のプロンプトに「この実行で使えるツール」を書いて止めます。
  `docs/CLI-ENTRY.md` の段階 5（実 copilot 実走）はこの実測で止まっています。

## ファイル構成

```
extension.mjs         App 入口。defineWorkflow + joinSession で 2 つのワークフローを登録する
core/                 SDK 非依存・プロセス非依存の共通部分
  state.mjs           状態 enum・理由コード・引数検証・戻り値の形
  git.mjs             git の薄いラッパ（シェル不使用・cwd 指定・配列引数）
  lock.mjs            排他ロック（ターゲット参照ごと／汎用スコープ）
  policy.mjs          ポリシーの読み取り・検証・ref 上の生バイトのハッシュ・guardPaths の照合
  verify.mjs          検証コマンドの実行と証拠の保存
  store.mjs           台帳ホームの解決と原子的書き込み（直列化・置換リトライ）
integrate/            統合の判断と実測（App と driver が共有する）
  engine.mjs          判断の順序（createIntegrationRun(ports)）
  ports.mjs           ProjectPorts の実装（git・ファイル・プロセスの実測）と registerOperation
  ledger.mjs          受付の台帳（原子的書き込み・証拠ディレクトリの採番）
  cli.mjs             受付の登録・一覧・単体実行（1 受付ずつ動かす入口）
task/                 子セッションの工程（App の 2 つ目のワークフロー）
  engine.mjs          判断の順序（createTaskPipelineRun(ports)）: 実装 → 検証 → レビュー → 修正ループ → 提出
  ports.mjs           作業ツリー・ポリシー・検証・提出コミットの実測（cwd を注入できる）
  prompts.mjs         実装役・修正役・レビュー役のプロンプトと REVIEW_SCHEMA
  state.mjs           TASK_STATE / TASK_DETAIL / validateTaskArgs
driver/               CLI 限定の常駐 driver（プロセス起動・イベント・台帳・枠）
  cli.mjs             人間と CI の入口（doctor / run / resume / status / tasks / events /
                      operations / logs / parent / stop / recover / check / apply /
                      answer / rework / request-human）
  run.mjs             設定・起動・1 ステップの判断・ループ
  journal.mjs         状態遷移・イベント記録・停止と完了・停止要求
  attempts.mjs        担当の起動と回収（作業ツリー・プロンプト・分類）
  merge.mjs           提出の検証と統合（integrate/ への橋渡し）
  operations.mjs      親から届いた操作の適用（版・重複・状態の検証）
  parent.mjs          親セッションの 1 ターン（プロンプト・起動・提案の受理）
  protocol.mjs        操作提案の書式・検証・抽出と、親に渡す手順文
  session.mjs         copilot の能力検出・引数組み立て・プロセス起動と停止
  events.mjs          報告ファイルの読み取りと、出力からの状態分類
  pools.mjs           実行枠と依存関係から、次に起こす担当を決める
  state.mjs           driver の状態 enum・遷移・taskId の検証
  store.mjs           実行レイアウトと run/task/attempt の記録（書き込みは直列化）
docs/
  CLI-ENTRY.md        CLI 入口で子の工程（task-pipeline）を回す実装の指示書（実装済み。実走は権限モデルで停止）
test/                 一時リポジトリと fake copilot を使ったテスト
  fake-copilot.mjs    実測した JSONL をまねる差し替え用 copilot（担当 14 種・親 17 種の振る舞い）
```

依存の向きは `driver/ → integrate/ → core/`、`task/ → core/` の一方向です。`core/` と `integrate/` は
Copilot の SDK にも `copilot` コマンドにも依存しません（SDK に依存するのは `extension.mjs` だけです）。
`task/` も SDK に依存せず、`ctx` を引数で受け取る形にしてテストから直接呼べるようにしています。

## 使い方（CLI）

`<repo>` は対象リポジトリ、`<child-commit>` は子セッションの提出コミットです。

```powershell
# 1. 親が受付を登録する（ポリシーのハッシュをここで固定する）
node .github/extensions/integrate-task/integrate/cli.mjs register `
  --operation-id op-2026-10-16-01 `
  --submitted <child-commit> `
  --repo <repo> `
  --target-branch main

# 2. 検証だけ行う（ターゲットは動かない）
node .github/extensions/integrate-task/integrate/cli.mjs run --operation-id op-2026-10-16-01 --mode check --expect VERIFIED_NOT_PUBLISHED

# 3. 検証に通った候補を反映する
node .github/extensions/integrate-task/integrate/cli.mjs run --operation-id op-2026-10-16-01 --mode apply --expect INTEGRATED

# 後片付け
node .github/extensions/integrate-task/integrate/cli.mjs cleanup --operation-id op-2026-10-16-01
node .github/extensions/integrate-task/integrate/cli.mjs unregister --operation-id op-2026-10-16-01
```

`--expect` は期待する `state` と違えば終了コード 3 を返すので、CI やスクリプトの判定に使えます。
`list` / `show` / `policy` で台帳とポリシーを確認できます。

## アプリからの実行

拡張を読み込むと `integrate-task` ワークフローが登録されます。

```
run_dynamic_workflow({ name: "integrate-task", args: { operationId: "op-2026-10-16-01", mode: "apply" } })
```

同じ拡張が、子セッション側の工程として `task-pipeline` も登録します。対象は**このワークフローが動いている
作業ツリー**（子セッションの worktree）で、実装 → 検証 → レビュー → 修正ループ → 提出コミットまでを 1 回で行います。

```
run_dynamic_workflow({
  name: "task-pipeline",
  args: {
    taskId: "T1",
    title: "プロジェクトの net10.0 化",
    prompt: "受入条件。何を作り、何を満たせば完了かを具体的に書く。",
    roles: { implementer: { reasoningEffort: "medium" }, reviewer: { reasoningEffort: "high" } },
    maxReworks: 2,
  },
})
```

| args | 必須 | 意味 |
| --- | --- | --- |
| `taskId` | ○ | 英数字で始まる 1〜100 文字の `[A-Za-z0-9._-]`。証拠ディレクトリと subagent のラベルに使う |
| `title` | ○ | 短い名前（1〜200 文字）。既定の提出コミットメッセージにも使う |
| `prompt` | ○ | 受入条件。実装役とレビュー役の**両方**に渡る |
| `roles` | | `implementer` / `reviewer` の `{ model, reasoningEffort }`。省略するとこのセッションの既定を使う |
| `verify` | | ポリシーの `verify` を置き換える（`{ name, command, args, timeoutSeconds }` の配列、1 件以上） |
| `maxReworks` | | 実装 → 検証 → レビューの再試行回数（0〜5、既定 2） |
| `commitMessage` | | 提出コミットのメッセージ |

- 実装役の subagent には**コミットさせません**。変更を検証し、レビューが承認したら、ワークフロー自身が
  `git add -A` と提出コミットを作ります（`user.name=task-pipeline` / `commit.gpgsign=false`）。
- subagent は cwd を持てないため、作業ツリーの絶対パスをプロンプトで渡します。
- 証拠は**作業ツリーの外**（`<home>/evidence/task/<taskId>/<連番>/`）に残します。作業ツリーを汚しません。
- 戻り値には `state` / `detail` / `message` / `submittedHead` / `evidenceRef` のほか、
  `worktree` / `branch` / `baseCommit` / `attempts` / `verify`（`ok` と各コマンドの終了コード）/ `review`（`verdict` と `findings`）/
  `files` / `durationMs` が入ります。親はこれをそのまま統合待ちキューへ渡せます。

| state | 意味 | 主な detail |
| --- | --- | --- |
| `SUBMITTED` | 提出コミットを作った。親の統合待ちキューへ登録する | `submitted` |
| `NEEDS_PARENT` | 親の判断・作業が必要 | `invalid-arguments`, `not-a-repository`, `worktree-dirty`, `worktree-git-operation`, `policy-missing`, `implement-failed`, `review-unavailable`, `rework-exhausted`, `nothing-to-submit`, `submit-failed` |

## CLI 限定の driver の使い方

`driver/cli.mjs` は AI を呼ばない常駐 driver です。`--repo` に対象リポジトリ、
`--cwd` に driver 自身の作業ディレクトリ（既定は現在のディレクトリ。親のプロンプトの置き場所）を指定します。

```powershell
# 能力の確認（copilot のパスと使えるオプションを実測して表示する）
node .github/extensions/integrate-task/driver/cli.mjs doctor --cwd <repo> --json

# 開始する（親セッションを 1 ターン起こし、届いた操作を適用する）
node .github/extensions/integrate-task/driver/cli.mjs run --repo <repo> --pools 2,1,1

# 開始時の依頼文をファイルで渡す（親の最初のプロンプトに含まれる）
node .github/extensions/integrate-task/driver/cli.mjs run --repo <repo> --request-file request.md

# 状態の確認
node .github/extensions/integrate-task/driver/cli.mjs status --run <runId> --json
node .github/extensions/integrate-task/driver/cli.mjs tasks --run <runId> --json
node .github/extensions/integrate-task/driver/cli.mjs events --run <runId> --json
node .github/extensions/integrate-task/driver/cli.mjs operations --run <runId> --json
node .github/extensions/integrate-task/driver/cli.mjs logs --run <runId> --task task-001
node .github/extensions/integrate-task/driver/cli.mjs parent --run <runId> --json

# 人間が判断を差し込む
node .github/extensions/integrate-task/driver/cli.mjs answer --run <runId> --task task-001 --answer "方針は A で進めてください"
node .github/extensions/integrate-task/driver/cli.mjs rework --run <runId> --task task-001 --instruction "テストを追加してください"
node .github/extensions/integrate-task/driver/cli.mjs request-human --run <runId> --task task-001 --note "判断を仰ぎます"

# 提出の検証と統合を、親を介さずに直接行う
node .github/extensions/integrate-task/driver/cli.mjs check --run <runId> --task task-001
node .github/extensions/integrate-task/driver/cli.mjs apply --run <runId> --task task-001

# 止める・復旧する
node .github/extensions/integrate-task/driver/cli.mjs stop --run <runId> --reason "打ち切り"
node .github/extensions/integrate-task/driver/cli.mjs recover --run <runId>
```

- `resume --run <runId>` は保存済みの設定で同じ実行を続けます（`--max-steps` などの上書き可）。
- `run` は `--repo --target <branch> --worktree <dir> --base <commit> --request <text> --request-file <path>` も取ります。
- `run` / `resume` は 1 ステップごとに `step: <action> {...}` を stderr に出します。
  `--once` で 1 ステップだけ進めて状態を返します（`--max-steps <n>` で上限を決められます）。
- 終了コード: `0` は正常終了（`RUNNING` / `FINISHED`）、`3` は `STOPPED`、その他は引数や能力の不足による失敗です。
- `--json` を付けると結果を JSON で出力します（`status` などは既定でも JSON）。
- 共通オプションは `--home --command --command-args --pools --timeout --poll --max-reworks
  --model --parent-model --task-model --effort --task-allow-tool --task-deny-tool
  --parent-allow-tool --parent-deny-tool --no-default-deny --json` です。
- `--command-args` は `copilot` に渡す追加引数で、差し替え用の copilot（テスト用）を挟むために使います。
- `--effort` は、実測した copilot 1.0.99-2 に該当オプションが無いため、能力検出で
  `effort` が無い場合は組み立て時に落とします。

### driver の state

| state | 意味 |
| --- | --- |
| `RUNNING` | 実行中（担当・親・統合のいずれかが動いている） |
| `FINISHED` | 親が `FINISH` を出し、未統合のタスクが残っていない |
| `STOPPED` | `stop` の要求、試行の失敗、枠の枯渇などで停止した（`stopMessage` に理由） |

タスクは `PLANNED` → `RUNNING` → `SUBMITTED` → `VERIFYING` → `INTEGRATED` のほか、
`NEEDS_PARENT` / `NEEDS_HUMAN` / `BLOCKED` / `INTERRUPTED` / `STALE_TARGET` を取ります
（`REWORK` は再び `PLANNED` からやり直します）。

## ポリシー

`.github/integrate-task.policy.json`（パスは固定）をターゲットブランチにコミットしておきます。

```json
{
  "version": 1,
  "lock": { "waitSeconds": 30, "staleMinutes": 30 },
  "verify": [
    { "name": "unit-tests", "command": "node", "args": ["--test", "test/*.test.mjs"], "timeoutSeconds": 600 }
  ],
  "guardPaths": [".github/integrate-task.policy.json", "AGENTS.md"]
}
```

- `verify` は必須で 1 件以上。`command` と `args` はシェルを介さず `execFile` で実行します。
  Windows では `.exe` のみ解決されるため、`npm` などは `npm.cmd` を明示してください。
- `guardPaths` は `*`（セグメント内）と `**`（階層横断）、末尾 `/`（配下全体）を解釈します。
- 既定値: `waitSeconds=30`、`staleMinutes=30`、`timeoutSeconds=600`。

## state と detail

| state | 意味 | 主な detail |
| --- | --- | --- |
| `NEEDS_PARENT` | 親の判断・作業が必要 | `operation-not-found`, `invalid-arguments`, `policy-changed`, `guard-path-touched`, `merge-conflict`, `verify-failed`, `verify-mutated-worktree`, `target-busy`, `target-dirty`, `target-worktree-missing`, `target-worktree-mismatch`, `target-git-operation` |
| `STALE_TARGET` | ターゲット HEAD が受付時から動いた | `target-moved` |
| `BLOCKED` | 依存する受付が未統合 | `dependency-not-integrated` |
| `VERIFIED_NOT_PUBLISHED` | 検証に通ったが未反映（`check`） | `check-only` |
| `INTEGRATED` | 反映済み | `integrated`, `already-integrated`, `recovered-after-publish` |

`STALE_TARGET` は「統合でターゲットが進んだ」ことを意味するので、積み重ねた受付は
`unregister` → `register`（`expectedTargetHead` を新しい HEAD に）で再受付してください。

## 台帳と証拠の保存先

`INTEGRATE_TASK_HOME` があればその下、なければ `~/.integrate-task/` です。

```
<home>/operations/<operationId>.json   受付と結果の台帳
<home>/evidence/<operationId>/<連番>/  検証ログ・result.json・timeline.json
<home>/worktrees/<operationId>/        候補の一時 worktree
<home>/locks/                          ターゲット参照ごとのロック
```

driver は同じホームの下に実行ごとの記録を置きます（`--home` で切り替えられます。`--home` を指定すると
統合側の `INTEGRATE_TASK_HOME` も同じ値になるので、台帳・証拠・候補 worktree は 1 か所にそろいます）。

```
<home>/agent-runs/<runId>/run.json           run の状態・親セッション・設定
<home>/agent-runs/<runId>/tasks/<taskId>.json
<home>/agent-runs/<runId>/attempts/<attemptId>.json
<home>/agent-runs/<runId>/events.jsonl       操作と状態遷移の記録（追記のみ）
<home>/agent-runs/<runId>/operations/<operationId>.json
<home>/agent-runs/<runId>/logs/              親と担当の生ログ
<home>/agent-runs/<runId>/reports/           担当の報告の写し
<home>/agent-runs/<runId>/parent.json        親セッションのターン数・最後の revision
<home>/agent-runs/<runId>/parent-prompt-<n>.md
<home>/agent-runs/<runId>/stop-request.json  stop の要求
```

- 担当のプロンプトは `<worktree>/.agent-run/<attemptId>.prompt.md`、親のプロンプトは
  `<cwd>/.agent-run/parent-prompt-<n>.md` に置き、台帳側にも写しを残します。
- 担当の報告は `<worktree>/.agent-run/report.json`（`submittedHead` を書く）です。
  `.agent-run/` は `git info/exclude` に追記するので、提出コミットには入りません。
- 検証の証拠は `integrate/` が保存し、driver は受付 ID で紐づけて記録します。

## 実測したこと（この環境）

- 環境: Windows / node v24.15.0 / npm 11.13.0 / git 2.53.0.windows.4 / copilot 1.0.99-2
  （実走時点）。1.0.100-1 でも `doctor` の判定（下表の能力）は変わらないことを確認しています。
- 段階 A（実 CLI の能力確認）: `driver/cli.mjs doctor --json` を実走。`--prompt` / `--resume` /
  `--session-id` / `--output-format` / `--no-ask-user` / `--allow-tool` / `--deny-tool` / `--model` を
  検出し、`--effort` は存在しないと判定した（`effort: null`）。`--allow-all` は存在しますが使いません。
- 段階 B（実 copilot での実走・1 タスク）: 一時リポジトリ（`main` に 1 コミット）で `run` を実行し、
  実 copilot の親セッションが `agent-operation` フェンスで DISPATCH → REWORK → CHECK_MERGE →
  APPLY_MERGE → FINISH を順に提案、driver がすべて適用した。結果は `state=FINISHED`、`main` に候補
  `ca5b2fa`（`integrate-task: int-task-001 を main へ統合`）が入り、作業ツリーは clean、
  `src/greeting.txt` は `hello` の 1 行。担当の 2 回目の試行は 1 回目と同じセッションを `--resume` で
  再開した。1 回目の実行が `--max-steps` で切れた後、`resume` が試行を `INTERRUPTED` として記録し、
  親が REWORK を出して復帰した（復旧の実測）。
- 段階 C（CLI からのワークフロー実行）: `copilot workflow run` は CLI のコマンドとして存在し（`list` は無い）、
  **CLI 単体でも `.github/extensions/` のワークフローを実行できる**ことを実走で確認した。
  `copilot workflow run integrate-task --args '{"operationId":"probe-nonexistent","mode":"check"}' --result-file <path> --silent --output-format json`
  は stdout に `workflow.result`（runId・status）を出し、result ファイルに `{"state":"NEEDS_PARENT","detail":"operation-not-found"}` を書いた。
  `task-pipeline` に必須引数を欠いた args を渡すと、宣言した `argsSchema` で実行前に拒否された（result ファイルは作られない）。
- 段階 D（責任者 + `task-pipeline` の実走、2026-10-18）: 一時リポジトリ（runId `72f5691a-4a68-4ba2-8856-3ae89b12eedc`）で
  driver を実走した。子セッション（責任者）は `copilot workflow run task-pipeline` を実行し、`ctx.agent` が実装役の subagent
  （`agentType: general-purpose`、`executionMode: background`）を起動した。`roles: {}` と `commitMessage: null`
  を含む args は CLI の事前検査で拒否された（exit 2）ため、driver は空の役割を落として組み立て直し、
  実行前検査（`checkWorkflowArgs`）を追加した。実装役はファイルを作成できず、試行 `task-001-a1` は
  `NEEDS_PARENT` / `question`（提出コミット無し・作業ツリーは変更なし）で終わり、親は `REWORK` を出した。
  2 回目の試行 `task-001-a2` も同じ理由で `NEEDS_PARENT` / `question` となり、親は
  `request-human` を出し、driver は `state=STOPPED` / `stopDetail=human-requested`（終了コード 3）で停止した。
  driver は各試行を回収し、責任者の結果ファイルから `state` を読んで分類した。
  原因は上記「責任者を CLI で回すときの制約（実測）」。実走の生ログは `files/phase5-evidence/`（セッション記録）に退避した。
- 未実施（この環境で実測していないこと）:
  - CLI 入口での**提出までの完走**（実走は行ったが、上記の権限モデルで `SUBMITTED` に至っていない）。
    受入条件は弱めず、未達のまま記録している（`.github/extensions/integrate-task/docs/CLI-ENTRY.md` の段階5）。
  - 実 copilot での 2 タスク同時実行と、質問待ち（ANSWER）からの再開。
  - 実 copilot での異常系（権限拒否・時間切れ・セッション消失）。
    これらは差し替え用 copilot を使ったテストで確認している（下記）。
  - より広い許可（`--task-allow-tool shell` や `--allow-all-tools`）で実装役が書けるかどうか。
    方針として使わないため、driver のテストでも確認していない。
  - 子セッションの worktree で `extensions_reload` が効くかどうか（未検証）。

## テスト

```powershell
node --test .github/extensions/integrate-task/test/*.test.mjs
```

一時リポジトリと、実測した JSONL をまねる差し替え用 copilot（`test/fake-copilot.mjs`）で
実際にプロセスを起動して検証します。テストは `copilot` 本体を呼びません。
110 件 pass（46.6 秒、Windows / node v24.15.0、2026-10-18 実測）を確認しています。
内訳は `task-pipeline`（`ctx` を差し替えて呼ぶ 12 件）と、責任者 + `task-pipeline` の経路
（args ファイル・結果ファイルの受け渡しと分類）の `test/driver-workflow.test.mjs` 9 件を含みます。

## 注意

- このツールは `orchestrate`（セッションの起動・メッセージング）の代替ではありません。
  受け付けたコミットを検証して統合する部分だけを担当します。
- ターゲットブランチをチェックアウトしている worktree が必要です。
- `task-pipeline` は子セッションの worktree（このワークフローが動いている作業ツリー）を対象にします。
  子の worktree は既定ブランチから作られるため、この拡張とスキルが**既定ブランチにコミット済み**でないと
  子は `task-pipeline` を実行できません。子が統合ブランチから作業ブランチを切る手順は
  `.github/skills/parallel-dev-orchestration/SKILL.md` にあります。
- `task-pipeline` は統合しません。提出コミットを統合待ちキュー（`integrate-task`）へ登録するのは親の仕事です。
- 排他はマシン内のファイルロックです。同じ台帳ディレクトリを共有する別マシンとは排他しません。
- 確認済みの環境: Windows / node v24.15.0 / git 2.53.0.windows.4 / copilot 1.0.99-2。
- driver は `copilot` の `--allow-all`（`--yolo`）を使いません。使えないツールを検出した場合は
  `BLOCKED_PERMISSION` として記録し、黙って許可を広げません。
