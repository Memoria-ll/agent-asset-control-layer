# AGENTS.md

Agent Asset Control Layer — AI開発アセットの単一の source of truth と context resolution を担う
local-first Core、およびその Workbench となる VS Code Extension。

## コマンド

- 依存導入: `pnpm install`
- テスト: `pnpm -r test`（gate の test step と同一コマンド）
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
- root `package.json` の `engines.node` は、lockfile 上の全依存の `engines` の積集合を宣言する。
  依存を追加・更新したら `pnpm-lock.yaml` の `engines:` を見て範囲を更新する
  （宣言だけが広いと、範囲内の Node で gate が動かない）。
- 依存方向は一方向: `core` → `shared`、`vscode-extension` → `shared`。
  `shared` は workspace package に依存しない。外部依存は schema library (`zod`) 1 つに限る。
  `core` と `vscode-extension` は相互に依存しない。
- `core` / `vscode-extension` は `zod` を直接依存に持たない。境界の検証入口と JSON Schema 出力は
  `shared` が公開する。
- `shared` は Core / Extension 間の契約面。DTO・schema・serialization・error / version contract のみを置く。
  domain semantics と実装ロジックは置かない。
- `shared` は Core 実装にも VS Code API にも依存しない。
- Extension は Core domain 実装を複製しない。API DTO / schema を Extension 内で再定義しない。

### 公開契約の境界

- `shared/src/` の公開型が公開契約。network / IPC 境界を越える型は明示的な serialization schema を持つ。
- `shared/src/` の公開契約は `zod/mini` の schema が単一の正で、TypeScript の型は `z.infer` で導出する。
  境界 DTO はすべて `z.strictObject`（未知キーを拒否する）。
  serialization schema は `contractJsonSchemas()` が返す JSON Schema draft 2020-12。
- 境界 DTO は成立し得ない状態を parse させない。負の件数・自己矛盾する enum の組合せ・
  否定状態を説明する空配列/空文字列は、型が通っても契約違反として reject する。
  表示文字列と理由・説明の欄は `NonEmptyString`。optional な配列は「省略＝無し」で表現するため、
  存在するなら `minLength(1)` を持つ。空が実状態である欄（`ResolvedAssetDto.body` の空ファイル、
  `CoreErrorDetail.path` の空キー・全体指定）は制約せず、その理由を欄のコメントに書く。
- **このルールが及ぶのは JSON Schema に出力できる制約まで。** 2 欄を比較する順序制約
  （`endedAt >= startedAt` 等）は draft 2020-12 に対応キーワードが無く、構造を変えないと
  表現できない。契約形の変更を伴うため、その場で `z.refine` を足さず issue に切り出す（#48）。
- 相互排他な組合せは `z.discriminatedUnion` のアームに分ける。cross-field の `z.refine` は
  使わない — parser では効くが `z.toJSONSchema()` の出力に一切現れず、schema 駆動の consumer が
  同じ値を通してしまう（実測）。union の JSON Schema は `additionalProperties` を root でなく
  `oneOf` の各アームに持つため、schema を検査するテストは root だけを見ない。
- 契約全体のバージョンは `shared` の `CONTRACT_VERSION` 1 つ。互換判定は
  `checkContractCompatibility()`。enum への値追加と required 欄の追加は破壊的変更。
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
- テストは各 package の `tests/` に置き、vitest で走らせる（`pnpm -r test`）。
  3 package すべてが `test` script を持つ。
- gate: `bash ~/.claude/scripts/run-gate.sh`

### 逸脱・未定

- docker compose 既定からの逸脱: Core は利用者のファイルシステム・git 履歴・keychain に直接触れ、
  かつ Windows と WSL の双方から同一 localhost Core として見える必要がある。
  bind mount とパス変換を Core の契約面へ載せないため host 直実行とする。
- `gate.json` の `min_count` は typecheck / test の 2 step とも package 数 3 を固定値で持つ。
  package を増減させるときは同じ変更で両方を更新する。test step は package 数だけを固定し、
  テスト本数は固定しない。
- 未定: Core UI（Tauri 2 shell、#19）の package 位置。
- 未定: `vscode-extension` の bundling（esbuild）と extension manifest
  （`engines.vscode` / activation / contributes）。#31 で決める。

## Ledger

### Traps

- `shared/package.json` の `exports` は `types` / `default` とも `./src/index.ts` を指す。
  `dist` を指すと `pnpm -r typecheck` は exit 0 のまま、`pnpm -r test` だけが `core` と
  `vscode-extension` で `Failed to resolve entry for package "@aacl/shared"` を出して落ちる (#46)
- 境界 DTO は `z.strictObject`。`z.object` でも既定の `z.toJSONSchema` は
  `additionalProperties: false` を書くため、公開 schema を読んでも差が出ない。差を捕まえるのは
  `io: "input"` と `io: "output"` の突き合わせだけで、`contractSchemas` から到達しない schema
  （`CompatibilityResult` / `DegradedInfo`）はこの網の外にある (#46)
