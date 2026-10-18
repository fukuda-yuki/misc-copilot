# misc-copilot — BookCatalog モダナイゼーション学習サンドボックス

古い .NET の業務Webアプリを、現在の .NET とローカルのデータベースへ移行する進め方を、
実際のコードを題材にして手を動かしながら学ぶためのリポジトリです。

題材は、書籍の一覧・詳細・追加・編集・削除を行う小さなWebアプリ **BookCatalog** です。
旧版は .NET Framework 4.8 / ASP.NET MVC 5 / Entity Framework 6 / SQL Server LocalDB で書かれており、
これを **.NET 10 / ASP.NET Core MVC / Entity Framework Core / ローカルSQLite** へ移行します。

## 学べること

- 移行の進め方：現状の把握 → 調査 → 計画 → 移行 → 受入確認。
- 旧版と現行の違い：非SDK形式のプロジェクト、`packages.config`、`Global.asax`、`System.Web`、
  Entity Framework 6、SQL Server LocalDB。
- 「動いた」と言うための確かめ方：受入条件、境界値、プロセスの再起動後もデータが残ること、記録の残し方。

## 対象読者と前提

- C# と ASP.NET MVC の基本（コントローラ・ビュー・モデル）を読める方。
- 次のツールを使います。

  | ツール | 確認コマンド | 目安 |
  | --- | --- | --- |
  | Git | `git --version` | 最近のバージョン |
  | .NET SDK | `dotnet --list-sdks` | .NET 10 のSDK |

- 移行後のデータはローカルのSQLiteファイルへ保存するため、データベースサーバーは用意しません。
- Windows / macOS / Linux のいずれでも進められます。

## 題材アプリ（旧版 BookCatalog）

| 画面 | 内容 |
| --- | --- |
| 一覧 | Active な書籍だけを Title の昇順で表示する |
| 詳細 | 1件の内容を表示する（非Activeの書籍もIDを指定すれば表示できる） |
| 追加 / 編集 | 入力して保存する（Title・Author は必須、ISBN・Published Year は任意） |
| 削除 | 確認したうえで削除する |

旧版の技術構成（`shared-legacy-app/` のソースを読んで確認した内容）:

- .NET Framework 4.8 / ASP.NET MVC 5 / Entity Framework 6 の、**非SDK形式**のWebアプリケーションプロジェクト。
  依存関係は `packages.config` と `HintPath` で管理している。
- ルーティング、グローバルフィルタ、データベースの初期化は `Global.asax` と `App_Start/` で行う。
- データベースは **SQL Server LocalDB の `BookCatalog.mdf`**（`|DataDirectory|`）。
  接続文字列と Entity Framework 6 の設定は `Web.config` にある。
- 起動時にテーブルを作成し、空であれば7件（Active 6件・非Active 1件）の初期データを投入する。

この旧版コードは、公開教材から指定したコミットのまま**無改変で取り込んだ入力コード**です。
このリポジトリではビルドも起動もしていません（Windows / IIS Express / SQL Server LocalDB を前提とするため）。
取り込み元・範囲・無改変の確認結果は [docs/BASELINE.md](docs/BASELINE.md)、
出典とライセンスは [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) にあります。

## リポジトリ構成

| パス | 内容 |
| --- | --- |
| `shared-legacy-app/` | 移行対象の旧版コード（無改変の入力コード） |
| [docs/LEARNING-PATH.md](docs/LEARNING-PATH.md) | 学習の道筋（段階の一覧・参照先・完了の目安） |
| [docs/BASELINE.md](docs/BASELINE.md) | 開始地点（ベースライン）の記録 |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | 完成条件（受入条件の正本・26条件） |
| [licenses/](licenses/) | 取り込んだコードのライセンス全文 |

## 学習の進め方

段階の一覧は [docs/LEARNING-PATH.md](docs/LEARNING-PATH.md) にあります。
読み進めるだけでも、実際に移行してみるのでも構いません。

## 完成条件

移行したアプリを「完成した」と言える条件は [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) にあります（26条件）。
受入条件は実装に合わせて黙って弱めません。矛盾を見つけたら、根拠を示してその部分だけを解決します。

## 始め方

1. リポジトリを clone（または fork）します。
2. 自分の作業用ブランチを作ります（例：`sandbox/<名前>`）。
3. [docs/LEARNING-PATH.md](docs/LEARNING-PATH.md) を開き、段階0から進めます。

開始地点は `demo/00-legacy-v2` ブランチと `demo/start-v2` タグ（注釈付きタグ）で固定しています。
`main` にも同じ旧版コードが入っています。開始地点のrefは動かしません。
学習や試行の結果は、自分のブランチに残します。

## このサンドボックスのスコープ外

- Docker・コンテナー・SQL Server・SQL Server LocalDB・Azure の利用。
  移行後のデータベースにはローカルのSQLiteファイルを使います。
- 旧版の画面と移行後の画面を同時に起動して比較するための準備。
- 旧SQL Serverのデータを移行後のアプリへ移送すること。
- UIの刷新、Blazor / SPA 化、マイクロサービス化。

## 参考資料

公式ドキュメント（Microsoft Learn）:

- [.NET への移植（.NET Framework からの移行）](https://learn.microsoft.com/dotnet/core/porting/)
- [プロジェクト SDK の概要](https://learn.microsoft.com/dotnet/core/project-sdk/overview)
- [ASP.NET Core MVC の概要](https://learn.microsoft.com/aspnet/core/mvc/overview)
- [Entity Framework Core](https://learn.microsoft.com/ef/core/)
- [EF Core の SQLite プロバイダー](https://learn.microsoft.com/ef/core/providers/sqlite/)
- [EF Core のマイグレーション](https://learn.microsoft.com/ef/core/managing-schemas/migrations/)

## 出典とライセンス

- 旧版の出典：Microsoft の公開教材
  [dotnet-modernization-for-beginners](https://github.com/microsoft/dotnet-modernization-for-beginners)
  の `shared-legacy-app`（コミット `82585e280fe00d0c56a075bf623dad1622c15911`）。
- 取り込んだコードは MIT ライセンス（Copyright (c) Microsoft Corporation.）です。
  ライセンス全文は [LICENSE](LICENSE) と
  [licenses/BookCatalog-Microsoft-LICENSE.txt](licenses/BookCatalog-Microsoft-LICENSE.txt) にあります。
- このリポジトリは**Microsoft教材を利用した独自の学習用サンドボックス**です。
  Microsoftがこのリポジトリを提供・保証しているものではありません。
