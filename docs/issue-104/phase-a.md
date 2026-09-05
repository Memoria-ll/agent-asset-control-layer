# Phase A: Binding契約・保存・解決

## Scope

- sharedへBinding ID、target、status、reason、record、resolve request / responseのstrict schemaを追加する。
- Asset Typeへbindingを追加し、binding固有metadataを検証する。
- Role / Provider / Runtime / Model catalogとWorkflow Definitionの既存正本を参照する。
- Global / Personal / Projectのbindingを既存Asset Storeで保存・取得する。
- scope、Project Overlay、Capability結果、明示fallbackを評価し、候補一覧を返す。
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

## 新規テスト

- shared strict schema、unknown key、closed set、JSON Schema registry、contract version。
- binding metadataのtarget組合せ、fallback ID、unknown metadata、disable、round-trip。
- catalog存在確認とruntime-modelのProvider一致。
- fallback欠落・cycle・primary eligible / unavailable。
- Global / Personal / Projectのadd / override / disable。
- Capability allowed / denied / missing。
- Workflow / Stageのrequired Role / Task Type投影。
- temporary directoryへsaveし、再読込後にpublic Core serviceでresolveする統合テスト。

テストはpublic entry pointを駆動し、resolverやpredicateをテスト側で再実装しない。

## 完了条件

- `docs/issue-104/design.md`のPhase Aに対応する証明条件がすべて赤→緑で固定される。
- Phase Bがshared DTOとCore serviceだけへ依存できる。
- `bash ~/.claude/scripts/run-gate.sh`がexit 0になる。
