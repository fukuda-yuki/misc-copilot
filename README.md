# misc-copilot

このリポジトリは、小さな書籍管理Webアプリ **BookCatalog** を題材にして、
AIが「古いC#のWebアプリ」を調査し、計画を立て、現在の.NETへ移行する過程を見せるデモです。
書籍の一覧・詳細・追加・編集・削除を行うアプリを、.NET Framework 4.8 から .NET 10 + SQLite へ移行します。

> 既存の内容（このリポジトリ名の見出し）はそのまま残しています。

## このリポジトリの目的

- 移行前の教材（旧版コードと、公開された要求・受入条件）を、誰でも同じ条件で再現できる形で固定する。
- その固定した開始地点から、別のAIセッションが .NET 10 への移行と SQLite 対応を実施する。
- 調査・計画・実装・動作確認の各時点を、Gitのブランチとタグで後から見られるようにする。

## 2つの段階があること

| 段階 | 担当 | 内容 | 成果物 |
| --- | --- | --- | --- |
| 準備（この段階） | 準備担当AI | 旧版コードの取り込みと、要求・受入条件・実行手順の文書化 | `shared-legacy-app/` の旧版コード、`docs/demo/` の文書、開始ブランチと開始タグ |
| 移行（次の段階） | 実行AI（新しいセッション） | 旧版アプリを .NET 10 / ASP.NET Core MVC / EF Core SQLite へ移行し、動作を確認 | 移行後のアプリ、`RUNBOOK.md`、段階ごとの記録と検証結果 |

準備段階では**移行の実装を始めません**。assessment（調査記録）、plan（計画）、.NET 10 の完成コードも、
準備段階では作りません。理由は、公開する「要求」と、AIが後で考える「解決方法」を分けるためです。

## 旧版（legacy）は「入力コード」です

- `shared-legacy-app/` 配下のコードは、Microsoftが公開している教材から、**指定したコミットのまま無改変で**取り込んだ入力コードです。
- 取り込んだだけであり、**動作確認済みではありません**。この準備段階では旧版アプリのビルドも起動も実施していません。
  （旧版はWindows / IIS Express / SQL Server LocalDB を前提とするため、起動しない選択をしています。）
- 旧版にSQL Server向けの接続文字列や Entity Framework 6 のコードが含まれているのは、移行対象として正常です。
- 旧版の取り込み元・範囲・無改変確認の結果は [docs/demo/BASELINE.md](docs/demo/BASELINE.md) と
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) に記録しています。

## 完成時の要求（要約）

完成したアプリは次の状態で動くことを目指します。細かな受入条件は
[docs/demo/ACCEPTANCE.md](docs/demo/ACCEPTANCE.md) に定義しています。

- C# / .NET 10（`TargetFramework` は `net10.0`）。
- ASP.NET Core MVC のWebアプリ。
- Entity Framework Core の SQLite provider を使い、データはローカルのSQLiteファイルへ保存する。
- 書籍管理の画面（一覧・詳細・追加・編集・削除）と主要な動作を保つ。
- ローカルで起動し、自由に追加・編集・削除できる。

**使わないもの**：Docker、コンテナー、SQL Server、SQL Server LocalDB、Azure。
インメモリDBだけで動かして完成とはしません。

## 開始地点と、次のAIへの指示

- 開始ブランチ：`demo/00-legacy`
- 開始タグ：`demo/start-v1`（注釈付きタグ）
- 実行用の指示書：[docs/demo/START-MODERNIZE.md](docs/demo/START-MODERNIZE.md)

新しいAIセッション（前の会話を引き継がないセッション）へは、次の短い指示だけを渡します。

> このリポジトリの docs/demo/START-MODERNIZE.md を読み、記載された移行を実施してください。

開始地点は固定です。開始ブランチを checkout して直接作業を続けたり、
開始タグを新しいコミットへ動かしたりしません。

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [docs/demo/BASELINE.md](docs/demo/BASELINE.md) | 開始地点の説明。取り込み元コミット、無改変確認の方法と結果、旧版の技術と依存関係、実測した環境、未確認事項 |
| [docs/demo/ACCEPTANCE.md](docs/demo/ACCEPTANCE.md) | 移行後の公開受入条件。旧版ソースから読み取った既存動作と、今回追加した要求を区別して記載 |
| [docs/demo/START-MODERNIZE.md](docs/demo/START-MODERNIZE.md) | 新しい実行AI向けの指示書（移行の目的・範囲・進め方・記録・成果物） |
| [AGENTS.md](AGENTS.md) | このリポジトリで作業するAI向けの短い共通指示 |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | 第三者コードの出典、固定コミット、取得日、ライセンスの場所 |

## このデモで行わないこと

- Docker / コンテナー / SQL Server / LocalDB / Azure の利用。
- 旧版の画面と移行後の画面を同時に起動して比較する準備（今回の担当範囲に含みません）。
- 旧SQL Serverのデータを移行後のアプリへ移送すること。
- UIの刷新、Blazor / SPA 化、マイクロサービス化。

## 出典とライセンス

- 旧版の出典：Microsoft の公開教材
  [dotnet-modernization-for-beginners](https://github.com/microsoft/dotnet-modernization-for-beginners)
  の `shared-legacy-app`（コミット `82585e280fe00d0c56a075bf623dad1622c15911`）。
- 取り込んだコードは MIT ライセンス（Copyright (c) Microsoft Corporation.）です。
  ライセンス全文は [LICENSE](LICENSE) と
  [licenses/BookCatalog-Microsoft-LICENSE.txt](licenses/BookCatalog-Microsoft-LICENSE.txt) にあります。
- このリポジトリは**Microsoft教材を利用した独自のSQLite移行デモ**です。
  Microsoftがこのリポジトリを提供・保証しているものではありません。
