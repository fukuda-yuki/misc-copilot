# GitHub Copilot 用の追加指示

このリポジトリで GitHub Copilot を使う場合も、指示の内容は [AGENTS.md](../AGENTS.md) と
`docs/` の要求に従ってください。

- 目的・作業範囲・参照禁止事項・記録の原則： [AGENTS.md](../AGENTS.md)
- 開始地点の説明： [docs/BASELINE.md](../docs/BASELINE.md)
- 受入条件： [docs/ACCEPTANCE.md](../docs/ACCEPTANCE.md)
- 学習の進め方（学習者向け）： [docs/LEARNING-PATH.md](../docs/LEARNING-PATH.md)
- 移行の進め方（AIセッション向け）： [.github/ai/START-MODERNIZE.md](ai/START-MODERNIZE.md)

要点だけを繰り返します。

- 学習者向けの文書（`README.md`、`docs/`）に、AIセッション・run番号・並列開発の話を書かない。
- 完成済み実装、完成版向けテスト、既成の移行計画、過去runのコードを参照・コピーしない。
- Docker、コンテナー、SQL Server、SQL Server LocalDB、Azure を使わない。
- 受入条件は `docs/ACCEPTANCE.md`。実装に合わせて黙って弱めない。
- 実測していないことを実測済みとして書かない。成功・失敗・未実施を区別する。
