# Issue #104 Binding設計

## 目的

保存された明示bindingをSource of Intentとして、明示されたProject・Workflow・Stage・Task Type・Roleの実行contextに合うProvider・Runtime・Model候補をOrchestratorとUIへ返す。Coreは候補の適用可否を既存resolverで評価し、assignmentを確定しない。

## 保存契約

- bindingは既存Asset Storeが管理する独立したMarkdown Assetとする。
- 共通frontmatterがID、tier、scope、operation、Capability dependencyを持つ。
- binding固有metadataがtarget kind、Provider / Runtime / Model ID、fallback先binding IDを持つ。
- bodyは任意の説明文であり、解決条件には使わない。
- UIはファイルを直接解釈せず、sharedの型付きDTOだけを扱う。
- Project root由来のbindingは既存のowning Project制約とProject Overlayに従う。

例:

```markdown
---
schema-version: 4
id: reviewer-luna
type: binding
tier: core
scope.role: [reviewer]
metadata.target-kind: runtime-model
metadata.runtime-id: codex
metadata.model-id: gpt-5.6-luna
metadata.fallback-for: reviewer-primary
---
レビュー用のfallback候補
```

## 実行context契約

- Roleは再利用可能な責務を表し、Issue開発・リファクタリングなどの作業目的をRole名へ埋め込まない。
- Task Typeは作業目的、Workflowは工程、Stageは工程内の位置を表す。
- Workflow DefinitionがStageのrequired Role / Task Typeを保持する。
- Orchestratorは選択Stageの要件を取得し、Workflow・Stage・Task Type・Roleを明示した実行contextを組み立ててからAsset解決を要求する。
- resolverは候補自身やWorkflow Definitionから欠落context軸を推測・補完しない。
- Skill・Rule・Knowledge・Policy・bindingは同じ実行contextとscope semanticsで評価する。
- task固有Assetを実行へ適用する経路では、必要なTask Type / RoleをOrchestratorが省略しない。

## Binding解決契約

- targetはprovider、runtime、model、runtime-modelのclosed setとする。
- 同じRoleへ複数bindingを保存でき、複数候補をそのまま返す。
- scope、Project Overlay、disable、dependency、Capability結果は既存Asset resolverの評価を正とし、Binding固有reasonへ再解釈しない。
- target catalog照合とfallback relationは、resolverの適用可否とは独立した結果として返す。
- fallbackはbinding IDによる明示relationだけから生成する。
- 選択Stageのrequired Role / Task Type取得はBinding候補解決から分離する。
- 自然言語、Journal、実行履歴からbindingを推測しない。
- winner、assignment、transition、runtime invocationは生成しない。

## レイヤ責務

- `shared`: transport-neutralなrequest / response、target、resolver evidence、target availability、fallback relation、Stage requirement schema。
- `core-domain`: binding Assetのtype固有検証、catalog照合、fallback relation評価。既存resolver reasonを複製しない。
- `core`: Global / Personal / Project root、保存・再読込、Project discovery、既存resolverの呼出し、Stage requirement取得。
- Orchestrator: Workflow / Stage要件から完全な実行contextを構築し、Bindingを含むAsset解決へ渡す。
- `vscode-extension`: shared DTOを利用するtransport client。domain規則を再実装しない。

## Phase

| Phase | 状態 | レビュー可能な完了単位 |
|---|---|---|
| A | 進行中 | shared契約、binding Asset、保存・取得・解決をCoreの実データ経路で証明する |
| B | 未着手 | 同じDTOをCore HTTPとExtension clientへ配線し、transport境界を証明する |

各Phaseは`integration/issue-104`から分岐し、個別PRで同branchへ統合する。最後のPhase後にこの作業文書を削除してからmain向けPRを作成する。

## 不変条件

- `CONTRACT_VERSION`は公開DTOの変更と同時に更新する。
- optional欄の欠落はキーごと省略し、空配列を別の意味として受理しない。
- `resolveScope`へ`capabilityContext`を明示的に渡す。
- malformed Assetはsnapshot全体を落とす前にproducer側で診断へ分離する。
- `ResolutionResult.context.directory`はcaller表現、scope matchingは正規化表現を使う。
- same-ID Project Overlayは`mergeGroup`を必須にしない。
- candidateの入力順から優先候補やfallbackを推測しない。
- applicability、target availability、fallback relationを単一statusへ畳まず、それぞれの事実を独立して返す。
- Workflow / Stage要件取得とBinding候補解決を一つの関数で相互依存させない。

## 全体の証明条件

- 同一Roleの複数Model候補が、既存resolverのincluded評価を保ったまま残る。
- Project add / override / disableがGlobal / Personal候補へ既存semanticsで作用し、そのresolver evidenceが欠落しない。
- deniedまたは欠落したrequired CapabilityのIDと原因が既存resolver evidenceへ保持される。
- targetのcatalog存在・Provider整合性がapplicabilityと独立して確認できる。
- 明示fallback relationのprimary IDと評価結果がapplicabilityと独立して確認できる。
- Workflow AssetからStageのrequired Role / Task TypeをBinding解決とは別に取得できる。
- 明示contextのTask Type / Workflowだけが異なる同一Roleの要求で、異なるAsset集合が得られる。
- save後のfilesystem再読込から同じrevision・binding・候補結果を得る。
- responseにwinnerまたはassignment欄が存在しない。
- canonical gateが全項目PASSする。
