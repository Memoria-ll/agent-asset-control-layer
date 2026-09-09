# AGENTS.md

Agent Asset Control Layer（AACL）は、AI開発アセット、Workflow、Context Resolutionを管理するlocal-firstのCoreと、そのReact UIおよびMCP境界で構成する。

## コマンド

- 依存導入: `npm ci`（依存を更新するときは `npm install`）
- 開発サーバー: `npm run dev`
- 本番ビルド: `npm run build`
- 単体・APIテスト: `npm test`
- UIテスト: `npm run test:ui`
- 品質確認: `npm run check`
- 整形: `npm run format`

Node.js 24以上を前提とする。生成物の`dist/`、実行時データの`.aacl-data/`、テスト成果物はリポジトリへ追加しない。

## リポジトリの構造

- `server/domain.ts`: Asset、Workflow、Context、Config、Run等の公開契約と入力検証。
- `server/resolver.ts`: Scope、依存関係、優先度、競合を決定論的に解決する境界。
- `server/core.ts`: 状態遷移、実行Snapshot、Journal、Proposal、承認、楽観的同時実行制御。
- `server/store.ts`: ローカル永続化、Git履歴、原子書き込み、回復。
- `server/adapters.ts`: Canonical AssetからRuntime向け表現への変換。独自の適用判断を追加しない。
- `server/mcp.ts` / `server/stdio.ts`: MCPのHTTP・stdio境界。
- `server/discovery.ts`: 既存CLIやローカルサーバーからのModel候補取得。認証情報や推論結果はCoreへ渡さない。
- `src/`: UI層。Coreの契約と決定を表示・入力するが、Resolverや永続化の意味を再実装しない。
- `tests/`: server/domain、HTTP/MCP、UIの動作を固定するテスト。

## 基本方針

- Canonical Assetとその履歴をsource of truthとし、UI・Runtime固有ファイル・Modelの推測を正本にしない。
- Scopeは明示的な条件として扱う。複数の次元はAND、同じ次元内の候補はORで評価し、欠けたContext軸を候補から推測しない。
- Role、Task Type、Workflow、Stage、Runtime、Modelは別の次元として保持する。作業目的の差をRoleの機械的な複製で表現しない。
- Resolverが選択・除外・上書き・競合・利用不可を決め、その理由を結果へ残す。AdapterやUIで暗黙に再解釈しない。
- WorkflowのDefinition、Revision、State、Execution Snapshotは区別する。開始時に選択したRevisionとContextを後から書き換えない。
- Journalからの改善はProposalとして扱い、人間の承認なしにAssetを変更しない。
- Coreはlocal-first・single-userを基本とし、認証を持たない機能をloopback外へ公開しない。
- ProviderのAPIキーやCLIのログイン情報などのraw credentialを保存・ログ出力しない。Model discoveryは利用権限を試す推論やダウンロードを実行しない。
- MCP、HTTP、filesystemの境界では、成立し得ない状態をstrict schemaで拒否する。optional値がない場合はキー自体を省略する。

## 変更時の注意

- 公開契約を変更したら、入力検証、HTTP/MCP response、永続化、UIの利用箇所を同時に確認し、実データ経路のテストを追加・更新する。
- Resolutionに関わる変更では、AND/OR、priority、disable、dependency、cycle、conflict、project overlay、directory境界を確認する。
- WorkflowやRunに関わる変更では、revision固定、許可された遷移、完了条件、artifact/evidence、snapshotの不変性を確認する。
- 永続化を変更するときは、原子性、single-writer lock、corruption/future-versionの扱い、Git履歴との整合性を壊さない。
- discoveryを変更するときは、CLIのページネーション、失敗・未ログイン状態、ローカルURLのredirect拒否、応答サイズ上限を維持する。
- UIを変更するときは、キーボード操作、dialog lifecycle、モバイル幅、APIエラー表示、非同期reloadの競合を確認する。
- 依存関係を変更したら`package-lock.json`を更新し、ビルドとテストを実行する。外部Runtimeへの実接続や資格情報をテストに持ち込まない。
- 要件と実装の境界を変更した場合は`agent-asset-control-layer-requirements.md`も確認し、READMEの記述と矛盾させない。

## 検証

通常の変更では最低限`npm run check`を実行する。UIやブラウザ境界を変更した場合は`npm run test:ui`も実行する。失敗を無視して公開状態へ進めず、環境起因の失敗は原因と実行条件を報告する。
