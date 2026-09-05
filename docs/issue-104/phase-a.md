# Phase A: Binding契約・保存・解決

## Scope

- sharedへBinding ID、target、record、resolve request / responseのstrict schemaを追加する。
- Asset Typeへbindingを追加し、binding固有metadataを検証する。
- Global / Personal / Projectのbindingを既存Asset Storeで保存・取得する。
- Binding候補のapplicabilityには既存resolverの評価をそのまま保持する。
- Provider / Runtime / Model catalog照合とfallback relationをapplicabilityから独立して返す。
- Workflow Definitionから選択Stageのrequired Role / Task Typeを取得するserviceをBinding候補解決から分離する。
- Orchestratorが構築した明示contextに対して、scope、Project Overlay、dependency、Capability結果を評価する。
- Core serviceのpublic exportを実データ経路テストから駆動する。

## Deferred to Phase B

- HTTP routeとrequest body処理
- Extension clientとactivation wiring
- Orchestratorによるassignment / handoff
- Capability Provider / Tool permissionの発見と判定
- 自動推薦、score、最適化

## 実装anchor

- shared closed set / schema: `shared/src/resolved-context.ts`の`ASSET_TYPES`、`shared/src/json-schema.ts`、`shared/src/index.ts`、`shared/src/contract-version.ts`
- branded ID: `shared/src/identifiers.ts`
- Canonical Asset parser: `core-domain/src/assets.ts`の`validateAsset` / `serializeCanonicalAsset`
- type semantics: `core-domain/src/resolution/asset-type-contracts.ts`の`DEFAULT_ASSET_TYPE_CONTRACTS`
- catalog: `core-domain/src/catalog.ts`、`core-domain/src/catalog-document.ts`
- projection/resolution: `core/src/assets/resolution-input.ts`、`core/src/assets/resolve-assets.ts`
- filesystem: `core/src/assets/filesystem-store.ts`の`AssetStore`
- package exports: 各`src/index.ts`

行番号は着手時に再確認し、symbolとgrep predicateを正とする。

## 実装単位

1. A1: Markdown保存契約、type固有parser、filesystem load / save。
2. A2: 既存resolver evidenceを保持したBinding候補投影とtarget catalog照合。
3. A3: 明示fallback relationの検証と評価。
4. A4: 選択Stageのrequired Role / Task Type取得service。

各単位は前段の公開契約だけへ依存し、Workflow解決をBinding候補解決へ埋め込まない。

## 新規テスト

- shared strict schema、unknown key、closed set、JSON Schema registry、contract version。
- binding metadataのtarget組合せ、fallback ID、unknown metadata、disable、round-trip。
- catalog存在確認とruntime-modelのProvider一致。
- fallback relationの成立・不成立。
- Global / Personal / Projectのadd / override / disableと既存resolver evidenceの保持。
- Capability allowed / denied / missingとdependency失敗情報の保持。
- Workflow / Stageのrequired Role / Task Type取得がBinding候補を暗黙に絞らないこと。
- 同じRoleがTask Type / Workflowの違いによって異なるAsset集合を得ること。
- temporary directoryへsaveし、再読込後にpublic Core serviceでresolveする統合テスト。

テストはpublic entry pointを駆動し、resolverやpredicateをテスト側で再実装しない。

## 完了条件

- `docs/issue-104/design.md`のPhase Aに対応する証明条件がすべて赤→緑で固定される。
- Phase Bがshared DTOとCore serviceだけへ依存できる。
- `bash ~/.claude/scripts/run-gate.sh`がexit 0になる。
