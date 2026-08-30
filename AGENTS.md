# AGENTS.md

Agent Asset Control Layer — AI開発アセットの単一の source of truth と context resolution を担う
local-first Core、およびその Workbench となる VS Code Extension。

## コマンド

- 依存導入: `pnpm install`
- 品質ゲート: `bash ~/.claude/scripts/run-gate.sh`（canonical。判定条件は `gate.json` が唯一の正）

## Architecture

### 実行・配布形態

- Core service は host 直実行の Node プロセス（localhost）。docker compose 既定からの逸脱 —
  理由は「逸脱・未定」に記載。
- Phase 1 = single-user localhost、Phase 2 = single-user remote / multi-PC、Phase 3 = multi-user team。
  remote / team 運用を local 利用の前提条件にしない。
- 現時点は自分用ツール。`rules/distributed-app.md` の品質バーは未発効。
- バージョンは root `package.json` の `version`。`0.0.0` のため `project-stage.sh` は `dev` を返す
  （保存データの破壊的変更が許される状態）。配布を始める前に実バージョンへ更新する。

### package 構成と依存方向

- pnpm workspaces の monorepo。package は `shared` / `core` / `vscode-extension` の 3 つ。
- 依存方向は一方向: `core` → `shared`、`vscode-extension` → `shared`。
  `shared` は何にも依存しない。`core` と `vscode-extension` は相互に依存しない。
- `shared` は Core / Extension 間の契約面。DTO・schema・serialization・error / version contract のみを置く。
  domain semantics と実装ロジックは置かない。
- `shared` は Core 実装にも VS Code API にも依存しない。
- Extension は Core domain 実装を複製しない。API DTO / schema を Extension 内で再定義しない。

### 公開契約の境界

- `shared/src/` の公開型が公開契約。network / IPC 境界を越える型は明示的な serialization schema を持つ。
- Core API の request / response・error・version contract は公開契約。
- Asset の source of truth は人間可読なファイルシステムファイル。その形状は公開契約 —
  変更は `save-schema-check` を通す。
- `core/` 内部の domain model、`vscode-extension/` の view model / UI state は内部配線。
  `core` の内部 domain model と `shared` の公開 DTO は分離してよい。

### レイヤ / seam mapping

- logic unit（テスト対象）: `core/src/`（domain / resolver / workflow / policy / adapter）、
  `shared/src/`、`vscode-extension/src/` のうち VS Code API に依存しない client / view model。
- view-glue（テスト対象外）: `vscode-extension/src/` のうち VS Code API へ直接触れる面
  （activation / lifecycle、command 登録、webview 配線）。
- テストは各 package の `tests/`。
- gate: `bash ~/.claude/scripts/run-gate.sh`

### 逸脱・未定

- docker compose 既定からの逸脱: Core は利用者のファイルシステム・git 履歴・keychain に直接触れ、
  かつ Windows と WSL の双方から同一 localhost Core として見える必要がある。
  bind mount とパス変換を Core の契約面へ載せないため host 直実行とする。
- `gate.json` の `min_count` は typecheck が走る package 数 3 を固定値で持つ。
  package を増減させるときは同じ変更で更新する。
- 未定: テストランナーと `gate.json` の test step。テストがまだ 1 本も無いため step を置いていない
  （置けば無音の空振りで緑になる）。最初のテストが入る #1 で決めて追加する。vitest が第一候補。
- 未定: Core UI（Tauri 2 shell、#19）の package 位置。
- 未定: `vscode-extension` の bundling（esbuild）と extension manifest
  （`engines.vscode` / activation / contributes）。#31 で決める。
