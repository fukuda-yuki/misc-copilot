# 第三者コードの出典とライセンス

このリポジトリには、Microsoftが公開している教材のコードを、指定したコミットのまま無改変で取り込んでいます。

## 取り込み元

| 項目 | 内容 |
| --- | --- |
| 上流リポジトリ | https://github.com/microsoft/dotnet-modernization-for-beginners |
| 固定コミット | `82585e280fe00d0c56a075bf623dad1622c15911` |
| 固定コミットの日時 | 2026-09-28T20:50:40Z（上流コミットの committer date） |
| 上流コミットのルートtree | `9a547b5de18b581c359bca086a60d277c2124ebb` |
| 対象ディレクトリ | `shared-legacy-app`（tree `7e7c2cfa5dc834424fecb0eb8ed9db1b78d6c217`） |
| 取得日 | 2026-10-17（日本時間） |
| 取得方法 | GitHub API によるメタデータ取得と、blob 単位の個別取得（base64で受信してバイト列をそのまま保存） |

上流リポジトリ全体の clone / fork / mirror / 全体ZIPの取得は行っていません。
上流のGit履歴や remote refs をこのリポジトリへ取り込んでもいません（出典は本文書で追跡します）。

## 取り込んだ範囲

- `shared-legacy-app/BookCatalog.sln`
- `shared-legacy-app/NuGet.Config`
- `shared-legacy-app/global.json`
- `shared-legacy-app/src/BookCatalog.Web/` 配下の全ファイル（20ファイル。Views、Controllers、Models、Content、App_Start、Web.config、packages.config、Properties、Global.asax を含む）
- 上流ルートの `LICENSE`

取り込んだファイルは24件で、いずれも上流の blob SHA と一致することを確認しています
（確認方法は [docs/BASELINE.md](docs/BASELINE.md) の「無改変確認の結果」を参照）。

## 無改変確認（ファイル単位の結果）

準備段階で、ローカルの blob SHA（`git hash-object`、およびコミット後の `git ls-tree -r HEAD`）が、
上流コミットの blob SHA と一致することを実測で確認しました。**24ファイルすべてで一致（不一致 0 件）**です。
下表は、そのときに照合した blob SHA の記録です。

| # | パス | サイズ(byte) | blob SHA（上流 = ローカル） |
| --- | --- | --- | --- |
| 1 | `LICENSE` | 1073 | `48ea6616b5b8581df3401872996cecf1f8b08a0d` |
| 2 | `shared-legacy-app/BookCatalog.sln` | 1000 | `633e73933ae4428834e47211a80f311917f2c503` |
| 3 | `shared-legacy-app/NuGet.Config` | 276 | `e378787cee77ba706f09f8d857904b3061f60416` |
| 4 | `shared-legacy-app/global.json` | 109 | `6a288505a11a709fd0ce8be76e8018eac0c8c8fa` |
| 5 | `shared-legacy-app/src/BookCatalog.Web/App_Start/FilterConfig.cs` | 249 | `d306af69f55b5df06c31716f0919db341b9cdee3` |
| 6 | `shared-legacy-app/src/BookCatalog.Web/App_Start/RouteConfig.cs` | 498 | `458feaadb85b574973d57efb4345710fde5d06a0` |
| 7 | `shared-legacy-app/src/BookCatalog.Web/BookCatalog.Web.csproj` | 8774 | `8abd586007fe912451d45dbf553590f8cfb52836` |
| 8 | `shared-legacy-app/src/BookCatalog.Web/Content/Site.css` | 9154 | `cc4acda264b7e501fb2f0e8c46e12541821d11f8` |
| 9 | `shared-legacy-app/src/BookCatalog.Web/Controllers/BooksController.cs` | 3065 | `d6633a31c81a446d9d6a545dee6fc84dc828bbf8` |
| 10 | `shared-legacy-app/src/BookCatalog.Web/Global.asax` | 103 | `03c85715ba47d7323ba511b091aba3bb49c5c53c` |
| 11 | `shared-legacy-app/src/BookCatalog.Web/Global.asax.cs` | 993 | `c733101f07eaa51c18dce9372d0985049fa848c7` |
| 12 | `shared-legacy-app/src/BookCatalog.Web/Models/ApplicationDbContext.cs` | 2356 | `86cfd9c12a879a7a58d3fbd62cf4554e9821bbe2` |
| 13 | `shared-legacy-app/src/BookCatalog.Web/Models/Book.cs` | 779 | `f43354cf32bbc6a1c48353704121d5612d1ea15a` |
| 14 | `shared-legacy-app/src/BookCatalog.Web/Properties/AssemblyInfo.cs` | 596 | `8a5f65326d149742f93b74ec5663c409d27113cf` |
| 15 | `shared-legacy-app/src/BookCatalog.Web/Views/_ViewStart.cshtml` | 51 | `be4d4b4b3bd19125bfef4ea1f5b1455b55f6276d` |
| 16 | `shared-legacy-app/src/BookCatalog.Web/Views/Web.config` | 1838 | `bbdc568e456fe31ce27a5f05b80949a35330527c` |
| 17 | `shared-legacy-app/src/BookCatalog.Web/Views/Shared/_Layout.cshtml` | 1866 | `a89c39e387e976bddaca31973b3b1074983ee9c1` |
| 18 | `shared-legacy-app/src/BookCatalog.Web/Views/Books/Index.cshtml` | 2492 | `241a35d66eb5e5c1fe5178b75183aad00ff3f3a8` |
| 19 | `shared-legacy-app/src/BookCatalog.Web/Views/Books/Details.cshtml` | 1318 | `47f9a5d852c4dd6b5cee1fb1e049f8342662ce3b` |
| 20 | `shared-legacy-app/src/BookCatalog.Web/Views/Books/Create.cshtml` | 2752 | `8539042b13763e6bfee430f0b6e251252fdddbba` |
| 21 | `shared-legacy-app/src/BookCatalog.Web/Views/Books/Edit.cshtml` | 2777 | `4b480b84bb5241cf04a86f226980f7c18c204445` |
| 22 | `shared-legacy-app/src/BookCatalog.Web/Views/Books/Delete.cshtml` | 1531 | `6ce5399e840926ac8c2d1ff27730a883d8b31bd3` |
| 23 | `shared-legacy-app/src/BookCatalog.Web/Web.config` | 2862 | `d3fd3b7528eee8c5f15283b17c05c0e0999d9c21` |
| 24 | `shared-legacy-app/src/BookCatalog.Web/packages.config` | 548 | `e2692faff2d5cca17fedaef4cc78c0decb130ca7` |

**注意（改行コード）**：準備環境の Git は `core.autocrlf=true` です。clone し直したときの作業ツリーは
CRLF になる場合がありますが、コミットされている blob は上流と同一です。無改変の判定は blob で行っています。

## 取り込んでいないもの

- 上流の `shared-legacy-app/README.md` は、旧版の説明として参照しただけで、コピーしていません。
  また、そのREADMEから他の章・完成例へのリンクはたどっていません。
- 上流リポジトリの他の章、完成済み実装、完成版向けテスト、移行計画、レポートは取得していません。
- 上流のGit履歴、タグ、その他の refs は取得していません。

## ライセンス

取り込んだコードのライセンスは **MIT License**、著作権表示は
**Copyright (c) Microsoft Corporation.** です。ライセンス全文の場所は次のとおりです。

- [LICENSE](LICENSE)（上流ルートのライセンスを無改変で配置）
- [licenses/BookCatalog-Microsoft-LICENSE.txt](licenses/BookCatalog-Microsoft-LICENSE.txt)
  （上流ルートのライセンスと同一の全文。対象となる取り込みコードを明確にするための複製）

対象となる取り込みコードは、上記「取り込んだ範囲」に列挙した `shared-legacy-app/` 配下のファイルと `LICENSE` です。

## 免責

このリポジトリは、**Microsoft教材を利用した独自のSQLite移行デモ**です。
Microsoftがこの派生物を提供・保証・サポートしているものではありません。
移行後のコードは、このリポジトリの作業者が作成するものであり、上流の完成実装ではありません。
