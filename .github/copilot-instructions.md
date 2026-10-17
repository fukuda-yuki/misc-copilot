# GitHub Copilot 用の追加指示

このリポジトリで GitHub Copilot を使う場合も、指示の内容は [AGENTS.md](../AGENTS.md) と
`docs/demo/` の公開要求に従ってください。

- 目的・作業範囲・参照禁止事項・記録の原則： [AGENTS.md](../AGENTS.md)
- 開始地点の説明： [docs/demo/BASELINE.md](../docs/demo/BASELINE.md)
- 公開受入条件： [docs/demo/ACCEPTANCE.md](../docs/demo/ACCEPTANCE.md)
- 移行の進め方： [docs/demo/START-MODERNIZE.md](../docs/demo/START-MODERNIZE.md)

要点だけを繰り返します。

- 完成済み実装、完成版向けテスト、既成の移行計画、過去runのコードを参照・コピーしない。
- Docker、コンテナー、SQL Server、SQL Server LocalDB、Azure を使わない。
- 受入条件は `docs/demo/ACCEPTANCE.md`。実装に合わせて黙って弱めない。
- 実測していないことを実測済みとして書かない。成功・失敗・未実施を区別する。
