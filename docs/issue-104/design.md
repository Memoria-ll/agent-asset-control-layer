# Issue #104 Binding設計

## 目的

保存された明示bindingをSource of Intentとして、Role・Provider・Runtime・Model・Workflow・Stage・Task Type・Projectの関係を解決し、OrchestratorとUIへ候補と理由を返す。Coreはassignmentを確定しない。

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
schema-version: 3
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

## 解決契約

- targetはprovider、runtime、model、runtime-modelのclosed setとする。
- 同じRoleへ複数bindingを保存でき、複数eligible候補をそのまま返す。
- statusはeligible、unavailable、fallbackのclosed setとし、理由を構造化して返す。
- fallbackはbinding IDによる明示relationだけから生成する。
- scope、Project Overlay、disable、Capability結果を既存Asset resolution経路で評価する。
- Workflow / StageのRole・Task Type relationはWorkflow Definitionを正とし、binding Assetへ複製しない。
- 自然言語、Journal、実行履歴からbindingを推測しない。
- winner、assignment、transition、runtime invocationは生成しない。

## レイヤ責務

- `shared`: transport-neutralなrequest / response / status / reason / target schema。
- `core-domain`: binding Assetのtype固有検証、catalog照合、fallback graph、候補statusとreason。
- `core`: Global / Personal / Project root、保存・再読込、Project discovery、Capability結果の注入。
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

## 全体の証明条件

- 同一Roleの複数Model候補が同時にeligibleとして残る。
- Project add / override / disableがGlobal / Personal候補へ既存semanticsで作用する。
- deniedまたは欠落したrequired Capabilityがunavailable理由へ保持される。
- primaryが利用不能な場合だけ、明示fallbackがfallback statusになる。
- Workflow AssetからStageのrequired Role / Task Typeが取得できる。
- save後のfilesystem再読込から同じrevision・binding・候補結果を得る。
- responseにwinnerまたはassignment欄が存在しない。
- canonical gateが全項目PASSする。
