# BASELINE — 移行デモの開始地点

この文書は、BookCatalog 移行デモの**開始地点（baseline）**を説明します。
準備担当AIが、旧版コードの取り込みと要求文書の作成を終えた時点の記録です。

- 開始コミットのSHAは、この文書を含むコミット自身のSHAになるため、**この文書には書きません**。
  最終的なSHAは、準備担当の引き継ぎ報告と準備PRの本文に記録しています。
- 「実測した」と書いてあるものは、この準備環境で実際にコマンドを実行して確認した内容です。
  「ソース読解」と書いてあるものは、コードを読んで分かった内容であり、動作を実行して確認したものではありません。

## 1. 対象リポジトリと開始地点

| 項目 | 値 |
| --- | --- |
| 対象リポジトリ | https://github.com/fukuda-yuki/misc-copilot |
| origin | `git@github.com:fukuda-yuki/misc-copilot.git`（取得・push とも同じ） |
| 既定ブランチ | `main` |
| 開始地点の基準 | `main` の初回コミット `05d35fc2df85e7758c82013d5a7f7471017cf1dd`（`README.md` のみ） |
| 準備ブランチ | `feat/prepare-modernize-demo` |
| 固定ブランチ（開始地点） | `demo/00-legacy` |
| 開始タグ（注釈付き） | `demo/start-v1` |
| 対象ソリューション | `shared-legacy-app/BookCatalog.sln` |
| 対象Webプロジェクト | `shared-legacy-app/src/BookCatalog.Web/BookCatalog.Web.csproj` |

`main` の既存ファイルである `README.md` は削除も初期化もしませんでした（内容は保ちながら追記・整理）。

同名の既存ブランチ・タグは確認した範囲ではありませんでした（準備時点で `origin` には `refs/heads/main` のみ）。
準備ブランチ、固定ブランチ、タグは既存と衝突しない名前として上記を選んでいます。

## 2. 取り込み元

| 項目 | 値 |
| --- | --- |
| 上流リポジトリ | https://github.com/microsoft/dotnet-modernization-for-beginners |
| 固定コミット | `82585e280fe00d0c56a075bf623dad1622c15911` |
| 上流コミットの存在確認 | 実測：GitHub API `GET /repos/microsoft/dotnet-modernization-for-beginners/commits/82585e28...` が成功（committer date 2026-09-28T20:50:40Z、ルートtree `9a547b5de18b581c359bca086a60d277c2124ebb`） |
| 取得日 | 2026-10-17（日本時間） |
| 取得方法 | GitHub API で必要なサブツリーのメタデータのみ取得し、必要なファイルを blob 単位で個別取得（base64で受信し、バイト列をそのまま保存） |

上流リポジトリ全体の clone / fork / mirror / 全体ZIP取得は行っていません。
上流のGit履歴・タグ・remote refs は、このリポジトリへ取り込んでいません（出典は文書で追跡）。
上流の `shared-legacy-app/README.md` は旧版の説明として読むだけにし、コピーせず、他の章・完成例へのリンクもたどっていません。

## 3. 取り込んだ範囲

- `shared-legacy-app/BookCatalog.sln`
- `shared-legacy-app/NuGet.Config`
- `shared-legacy-app/global.json`
- `shared-legacy-app/src/BookCatalog.Web/` 配下の全ファイル（20ファイル）
- 上流ルートの `LICENSE`

取り込みは最初の独立したコミットとして記録しています（コミットメッセージは「取込: 上流BookCatalog旧版を固定コミットから無改変で取り込む」）。

## 4. 無改変確認（方法と結果）

**方法**

1. 上流の該当コミットのツリーを GitHub API で取得し、各ファイルの blob SHA とサイズを記録する（メタデータのみ）。
2. ファイル本体は blob SHA を指定して個別に取得し、受信したバイト列をそのままディスクへ書き込む。
3. ローカルで `git hash-object <path>` を実行し、得られたハッシュが上流の blob SHA と一致することを確認する。
   `git hash-object` は Git のフィルタを適用せず生のバイト列をハッシュ化するため、内容一致の確認になる。
4. さらに、コミット後の `git ls-tree -r HEAD` のオブジェクトIDが上流 blob SHA と一致することを確認する。

**結果（実測）**

- 取り込み対象24ファイルすべてで、ローカルのハッシュが上流 blob SHA と一致（不一致 0 件）。
- コミット済みオブジェクトも上流 blob SHA と一致（`git ls-tree -r HEAD` で照合、不一致 0 件）。
- ローカル固有のファイルは既存の `README.md` のみ。

| # | パス | サイズ(byte) | 上流blob SHA = ローカルblob SHA |
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

**注意（改行コード）**：この環境の Git は `core.autocrlf=true` です。
そのため、将来 clone し直したときの作業ツリーは CRLF になる場合がありますが、
**コミットされているオブジェクト（blob）は上流と同一**です。
無改変の判定は blob（Gitオブジェクト）で行っています。

## 5. 旧版の技術と依存関係（ソース読解）

以下はすべて**ソースを読んで確認した事実**です。ビルドや起動による確認はしていません。

### プロジェクト形式とターゲット

- `BookCatalog.Web.csproj` は**非SDK形式**（`ToolsVersion="15.0"`、`xmlns="http://schemas.microsoft.com/developer/msbuild/2003"`）で、
  `<Import Project="$(VSToolsPath)\WebApplications\Microsoft.WebApplication.targets" ...>` を使うクラシックなWebアプリケーションプロジェクトです。
- `TargetFrameworkVersion` は `v4.8`、`LangVersion` は `7.3`、`OutputType` は `Library`。
- `ProjectTypeGuids` に Web アプリケーション（`{349c5851-65df-11da-9384-00065b846f21}`）が含まれます。
- IIS Express 前提の設定（`UseIISExpress`、`IISExpressSSLPort` 44300、`DevelopmentServerPort` 52000、`IISUrl` `http://localhost:52000/`）があります。
- `packages.config` による NuGet 管理で、参照は `..\..\packages\<package>\lib\net45\...` を `HintPath` で直接指しています。
- `App_Data\` フォルダを `Folder Include` で持っています（空フォルダ。ファイルは含まれません）。
- `BookCatalog.sln` は Visual Studio 17 形式で、プロジェクトは `src\BookCatalog.Web\BookCatalog.Web.csproj` の1つだけです。

### 依存パッケージ（`packages.config` と `HintPath` より）

| パッケージ | バージョン | targetFramework |
| --- | --- | --- |
| EntityFramework | 6.4.4 | net48 |
| Microsoft.AspNet.Mvc | 5.2.9 | net48 |
| Microsoft.AspNet.Razor | 3.2.9 | net48 |
| Microsoft.AspNet.WebPages | 3.2.9 | net48 |
| Microsoft.Web.Infrastructure | 2.0.0 | net48 |
| Newtonsoft.Json | 13.0.3 | net48 |

- `NuGet.Config` は `repositoryPath` を `packages` に設定し、パッケージソースは nuget.org（v3）です。
- `global.json` は SDK `10.0.100`、`rollForward: latestMajor`、`allowPrerelease: false` を指定しています。
  これは上流リポジトリ共通の設定で、旧版プロジェクト自体のターゲットフレームワークは `net48` のままです。

### Webホストとルーティング

- `Global.asax` / `Global.asax.cs` の `Application_Start` で、
  `AppDomain.CurrentDomain.GetData("DataDirectory")` のディレクトリを作成し、
  Entity Framework 6 の初期化戦略を設定し、DBを初期化してから、エリア登録・グローバルフィルタ登録・ルート登録を行います。
- `App_Start/RouteConfig.cs` の既定ルートは `{controller}/{action}/{id}`、既定は `Books` / `Index`。
- `App_Start/FilterConfig.cs` は `HandleErrorAttribute` をグローバル登録します。

### モデル（`Models/Book.cs`）

| プロパティ | 型 | 属性・備考（ソース読解） |
| --- | --- | --- |
| `Id` | `int` | 主キー |
| `Title` | `string` | `[Required]` `[StringLength(200)]` |
| `Author` | `string` | `[Required]` `[StringLength(100)]` |
| `ISBN` | `string` | `[StringLength(13)]` のみ。13桁・数字のみ・チェックディジットの検証は無い |
| `PublishedYear` | `int?` | `[Range(1800, 2100)]`、`[Display(Name = "Published Year")]` |
| `IsActive` | `bool` | `[Display(Name = "Active")]` |
| `CreatedDate` | `DateTime` | コンストラクタで `DateTime.Now` を設定 |

### コントローラと画面の動作（`Controllers/BooksController.cs`、Views のソース読解）

- `Index`：`IsActive == true` の書籍だけを `Title` 昇順で取得して表示します。
  併せて `HttpContext.Request.UserAgent` を `ViewBag` に入れ、画面下部に表示します。
- `Details` / `Edit`(GET) / `Delete`(GET)：`Find(id)` で取得し、見つからなければ `HttpNotFound()`（404）を返します。
- `Create`(POST)：`ModelState.IsValid` のとき `CreatedDate = DateTime.Now` を設定して追加し、`Index` へリダイレクトします。
  無効なときは同じ View を再表示します。`[ValidateAntiForgeryToken]` があります。
- `Edit`(POST)：既存レコードを取得し、`Title` / `Author` / `ISBN` / `PublishedYear` / `IsActive` をコピーします。
  **`CreatedDate` はコピーしない**ため、編集しても既存の値が残ります。存在しないIDでは `HttpNotFound()`。`[ValidateAntiForgeryToken]` があります。
- `Delete`(POST, `ActionName("Delete")`)：レコードが見つかれば削除し、**見つからなくても `Index` へリダイレクト**します（404にはしません）。`[ValidateAntiForgeryToken]` があります。
- 画面は `Views/Books/` の Index / Details / Create / Edit / Delete と、共通レイアウト `Views/Shared/_Layout.cshtml`、
  スタイル `Content/Site.css` で構成されます。レイアウトと各画面は `Site.css` のクラス（`classic-table`、`btn-classic`、`badge-active` など）を使います。
- 追加・編集のフォームは Title に `required` と `maxlength=200`、Author に `required` と `maxlength=100`、ISBN に `maxlength=13`、
  PublishedYear に `type=number` `min=1800` `max=2100` を付けています（クライアント側の補助）。
- 削除画面は確認用のGET画面で、POSTで削除します。`@Html.AntiForgeryToken()` を含みます。

### データベース接続と初期化（`Web.config`、`Models/ApplicationDbContext.cs`、`Global.asax.cs` のソース読解）

- 接続文字列名は `BookCatalogContext`。接続文字列は
  `Data Source=(LocalDB)\MSSQLLocalDB;AttachDbFilename=|DataDirectory|\BookCatalog.mdf;Integrated Security=True`、
  provider は `System.Data.SqlClient` です（**SQL Server LocalDB と MDF ファイル**を使う構成）。
- `ApplicationDbContext` は Entity Framework 6 の `DbContext` で、`DbSet<Book> Books` を持ちます。
- 初期化戦略は `DropCreateDatabaseIfModelChanges<ApplicationDbContext>`（**モデル変更時にDBを作り直す**）。
- seed は7件（Active 6件、非Active 1件）。非Activeは "The Matrix: The Shooting Script" です。
  seed の `CreatedDate` は固定日付です。
- `Application_Start` では、DB初期化のあと **`db.Books.Any()` が false なら seed を再投入**します。
  つまり旧版は「Books が空だと起動時に7件を入れ直す」動作です。
- `Web.config` の `entityFramework` セクションは `System.Data.SqlClient` のプロバイダを登録しています。
- `Views/Web.config` は Razor（System.Web.WebPages.Razor 3.0.0.0、System.Web.Mvc 5.2.9.0）の設定です。

## 6. 実測した環境情報

2026-10-17（日本時間）に、この準備環境で実際に実行して確認した内容です。
**予想や推測は書いていません。確認していないものは「未確認」と明記します。**

| 項目 | 実測値 |
| --- | --- |
| OS | Windows NT 10.0.26300.0（x64）。`Win32_OperatingSystem` の参照はアクセス拒否のため、エディション名は未確認 |
| シェル | PowerShell 7.6.6 |
| Git | 2.54.0.windows.1 |
| .NET SDK | `10.0.401`、`8.0.426`（`dotnet --list-sdks`） |
| .NET ランタイム | `Microsoft.NETCore.App` 8.0.31 / 8.0.32 / 10.0.12、`Microsoft.AspNetCore.App` 8.0.31 / 8.0.32 / 10.0.12、`Microsoft.WindowsDesktop.App` 8.0.31 / 8.0.32 / 10.0.12 |
| `dotnet --info` | SDK・ランタイムの一覧は表示されたが、ワークロード情報の取得中に `System.TypeInitializationException`（`Win32Exception: アクセスが拒否されました`）で例外。`dotnet workload list` も同じ例外で失敗（**ワークロード構成は未確認**） |
| .NET Framework 参照アセンブリ（ターゲティングパック） | `C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework` に v4.0 / v4.5 / v4.5.1 / v4.5.2 / v4.6 / v4.6.1 / v4.7.2 / **v4.8** / v4.X が存在 |
| .NET Framework ランタイム | `HKLM\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full` が Version 4.8.10008、Release 534296 |
| Visual Studio | **Visual Studio Build Tools 2026 18.10.4**（installationVersion 18.10.12306.391、productId `Microsoft.VisualStudio.Product.BuildTools`）のみ。フルIDE（devenv）は未導入 |
| MSBuild | `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\MSBuild.exe`（`vswhere -latest -requires Microsoft.Component.MSBuild -find` で確認）。PATH上には無い |
| IIS Express | `C:\Program Files (x86)\IIS Express\iisexpress.exe` のバージョン 10.0.26013.1000 |
| SQL Server LocalDB | `sqllocaldb info` がインスタンス名 `MSSQLLocalDB` を返す（インスタンス名の存在のみ確認。接続・DB作成は未実施） |
| GitHub CLI | 2.100.0。`fukuda-yuki` としてログイン済み（token scopes: `admin:public_key`, `gist`, `project`, `read:org`, `repo`）。`gh api` によるGitHubアクセスは成功 |
| GitHubへのHTTPS接続 | PowerShell（`Invoke-WebRequest`）と `curl.exe` は TLS 接続に失敗（`schannel: SEC_E_NO_CREDENTIALS`）。**gh 経由では成功**。この失敗は環境側の制約であり、GitHub側の可用性とは無関係 |
| 対象リポジトリの権限 | `permissions.push = true`、`permissions.admin = true`（GitHub API 実測） |
| `main` のブランチ保護 | **未設定**（`GET /branches/main/protection` が `Branch not protected` を返す） |
| Modernize製品 | `modernize` は PATH 上に無い。Visual Studio フルIDE未導入のためVS拡張の有無は確認できない。VS Code の拡張一覧（`code --list-extensions`）に Modernize / GitHub Copilot 系の拡張は見当たらない。**Modernize製品の利用可否は未確認**（この環境では未導入の可能性が高い） |
| .NET グローバルツール | `aspire.cli` 13.4.2、`csharp-ls` 0.28.0 のみ |
| GitHub Copilot CLI | `gh copilot --version` が `GitHub Copilot CLI 1.0.95-3` を返す（利用可能） |
| VS Code | `code` コマンドが `C:\Users\mwam0\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd` に存在 |
| 旧版アプリのNuGet復元 | **未実施** |
| 旧版アプリのビルド | **未実施** |
| 旧版アプリの起動 | **未実施** |

## 7. 旧版の実行状態と未確認事項

**旧版アプリは、ビルドも起動もしていません。**

理由：

- このセッションの担当は「移行前の教材と、次のAIへ渡す指示を作ること」であり、移行実装や旧版の起動確認は担当範囲ではありません。
- 旧版は Windows / IIS Express / SQL Server LocalDB を前提とするクラシックなWebアプリで、
  起動には NuGet 復元（`packages.config` 形式）と旧形式のビルド環境が必要です。
- 今回の受入対象は**移行後アプリ**であり、旧版の起動は必須とされていません。

したがって、**旧版の画面・動作は実測していません**。
第5節の「ソース読解」に書いた内容は、コードから読み取った仕様であり、
実際に動かして確認した結果ではありません。

主な未確認事項：

- 旧版が実際にビルドできるか、起動できるか。
- 旧版の画面表示、Active の切替、削除の挙動などの実行時の振る舞い。
- この環境の `dotnet workload` の構成。
- Visual Studio のフルIDEと Modernize 製品がこの環境で使えるか。
- 上流リポジトリの他のファイル・他の章（取得していないため当然未確認）。
- SQLite で採用すべき照合順序（実行AIが決めて記録する項目。`ACCEPTANCE.md` の受入条件3）。

## 8. この準備段階で行っていないこと

- .NET 10 への移行実装（SDK形式への変換、TargetFramework の変更、ASP.NET Core 化、EF Core 化）。
- SQLite 化、DB初期化処理の変更、seed の寿命変更。
- 移行の assessment / plan / tasks の作成。
- .NET 10 の完成コードの作成。
- 旧版のビルド・起動、旧版と移行後アプリの同時起動による比較。

## 9. 参考にした公式資料（一般技術資料）

準備段階で参照した一般資料です。出典リンクを手掛かりに完成例を開いていません。

- https://learn.microsoft.com/en-us/ef/core/providers/sqlite/
- https://learn.microsoft.com/en-us/ef/core/providers/sqlite/limitations
- https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/connection-strings
- https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/types
- https://learn.microsoft.com/en-us/ef/core/managing-schemas/ensure-created
- https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/?view=aspnetcore-10.0
