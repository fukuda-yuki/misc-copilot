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
- `shared-legacy-app/src/BookCatalog.Web/` 配下の全ファイル（22ファイル。Views、Controllers、Models、Content、App_Start、Web.config、packages.config、Properties、Global.asax を含む）
- 上流ルートの `LICENSE`

取り込んだファイルは24件で、いずれも上流の blob SHA と一致することを確認しています
（確認方法と結果は [docs/demo/BASELINE.md](docs/demo/BASELINE.md) の「無改変確認」を参照）。

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
