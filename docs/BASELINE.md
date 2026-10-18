# BASELINE — 移行の開始地点

この文書は、BookCatalog 移行サンドボックスの**開始地点（baseline）**の短い記録です。
旧版コードの取り込みと要求文書の作成を終えた時点の状態を示します。

- 「実測」と書いてあるものは、実際にコマンドを実行して確認した内容です。
  「ソース読解」はコードを読んで分かった内容であり、**動作を実行して確認したものではありません**。
- 開始地点のrefは次のとおりです（実測：`git show-ref` / `git rev-parse`）。

  | ref | 種類 | 指すコミット |
  | --- | --- | --- |
  | `demo/00-legacy-v2` | ブランチ | `cb90026f0a7692241544ea7c106cec5327ade630` |
  | `demo/start-v2` | タグ（注釈付き） | `cb90026f0a7692241544ea7c106cec5327ade630` |

## 1. 開始地点

| 項目 | 値 |
| --- | --- |
| 対象リポジトリ | https://github.com/fukuda-yuki/misc-copilot |
| 開始ブランチ | `demo/00-legacy-v2` |
| 開始タグ（注釈付き） | `demo/start-v2` |
| 開始コミット | `cb90026f0a7692241544ea7c106cec5327ade630` |
| 対象ソリューション | `shared-legacy-app/BookCatalog.sln` |
| 対象Webプロジェクト | `shared-legacy-app/src/BookCatalog.Web/BookCatalog.Web.csproj` |

開始ブランチと開始タグは**同じコミット**を指します。そのコミットが移行の開始地点です。
開始地点は固定であり、動かしません。

## 2. 取り込み元

| 項目 | 値 |
| --- | --- |
| 上流リポジトリ | https://github.com/microsoft/dotnet-modernization-for-beginners |
| 固定コミット | `82585e280fe00d0c56a075bf623dad1622c15911` |
| 取得日 | 2026-10-17（日本時間） |
| 取得方法 | GitHub API でメタデータのみ取得し、必要なファイルを blob 単位で個別取得（受信したバイト列をそのまま保存） |

上流リポジトリ全体の clone / fork / mirror / 全体ZIP取得は行っていません。
上流のGit履歴・タグ・その他の refs は、このリポジトリへ取り込んでいません。
出典・ライセンス・取り込んでいないものの詳細は [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) に記録しています。

## 3. 取り込んだ範囲

- `shared-legacy-app/BookCatalog.sln`
- `shared-legacy-app/NuGet.Config`
- `shared-legacy-app/global.json`
- `shared-legacy-app/src/BookCatalog.Web/` 配下の全ファイル（20ファイル）
- 上流ルートの `LICENSE`

取り込みは独立したコミットとして記録しています。

## 4. 無改変確認の結果

**方法（実測）**：上流コミットの各ファイルの blob SHA を GitHub API で取得し、取り込んだファイルについて
`git hash-object` の結果と、コミット後の `git ls-tree -r HEAD` のオブジェクトIDが、
上流の blob SHA と一致することを確認しました。

**結果（実測）**：取り込み対象 **24ファイルすべてで一致（不一致 0 件）**。
ファイル単位の確認結果は [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) に記録しています。

**注意（改行コード）**：この環境の Git は `core.autocrlf=true` のため、clone し直したときの作業ツリーは
CRLF になる場合がありますが、**コミットされている blob は上流と同一**です。
無改変の判定は blob（Gitオブジェクト）で行っています。

## 5. 旧版の技術構成（ソース読解）

- .NET Framework 4.8 / ASP.NET MVC 5 / Entity Framework 6 の、**非SDK形式**のクラシックなWebアプリケーションプロジェクト。
  依存関係は `packages.config` で管理し、`HintPath` で `packages/` 配下を直接参照している。
- ルーティング、グローバルフィルタ、データベースの初期化は `Global.asax` / `App_Start/` で行う。
- データベースは **SQL Server LocalDB の `BookCatalog.mdf`**（`|DataDirectory|`）を使う構成で、
  接続文字列と Entity Framework 6 の設定は `Web.config` にある。
- 画面は Razor（`Views/`）で、共通レイアウトと `Content/Site.css` を使う。
  書籍の一覧・詳細・追加・編集・削除がある。

この技術構成の**詳しい分析（各操作の分岐、依存パッケージの一覧、DB初期化と seed の方法など）は、
この文書には記載していません**。移行に必要な範囲は、旧版ソースを読んで自分で調べてください。

## 6. 未確認事項

- **旧版アプリのビルド・起動・画面操作は、すべて未実施**です（動作確認はしていません）。
  第5節の内容はすべてソース読解であり、実測ではありません。
- 旧版は Windows / IIS Express / SQL Server LocalDB を前提とするため、このサンドボックスでは起動しない選択をしました。
  移行にあたって、旧版の起動を前提にしないでください。
- この文書には、作業環境のツール構成（.NET SDK・ランタイム・移行ツールの有無）の実測値を記載していません。
  使えるものは、**作業を始めるときに自分で実測**してください。
- 上流リポジトリの他のファイル・他の章は取得していないため未確認です。

## 7. この開始地点に含まれないもの

- 移行の実装（SDK形式への変換、`net10.0` 化、ASP.NET Core 化、EF Core / SQLite 化）。
- 移行の調査・計画・タスク分解の文書。
- 移行後の完成コード、完成版向けテスト。
