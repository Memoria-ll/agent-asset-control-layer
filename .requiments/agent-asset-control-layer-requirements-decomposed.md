# Agent Asset Control Layer — v12 要件分解

> Source: `agent-asset-control-layer-requirements-v12.md`
>
> 本書は v12 を、実装・検証・Issue 化しやすい要件単位へ分解したもの。v12で採用したWorkflow-first execution、Resolver責務縮小、No-workflow execution boundary、Workflow-centered learning loopを反映する。

## 0. 読み方

- **ID**: 追跡用の要件ID。
- **要件**: システムが満たすべき事項。
- **検証条件**: 実装完了を確認する観点。v12の明示内容を具体的な確認単位へ落としたもの。
- **MVP**: `必須` / `後回し` / `将来`。
- **出典**: v12内の主な対応章。

MVPの「必須」は §43「初期運用MVP」および §47「MVP完了条件」を基準とする。Workflow未指定時のAdvisory / Preparation境界はMVPの実行安全性要件として扱う。Guardrail / Hook等、設計上定義されていても §43 で後回しとされたものはその境界を維持する。

---

# 1. システム定義・責務境界

## SYS-001 — AACLをWorkflow-drivenなAI開発Control Planeとして定義する
- **要件**: AACLはskill、rule、workflow、role、project knowledge等のAI開発資産を管理するとともに、ユーザーが繰り返す開発行為をWorkflowとして定義・再利用し、短い指示で一貫した開発工程を起動できるlocal-firstなControl Planeであること。
- **検証条件**:
  - Workflowが主要なユーザー実行単位としてドメインモデルに存在する。
  - Asset管理、Context Resolution、Workflow State、実行観測、改善ループがWorkflow executionを中心に接続されている。
- **MVP**: 必須
- **出典**: §1, §3, 設計思想

## SYS-002 — CoreをSource of Truthとする
- **要件**: Asset / Rule / Workflow / Resolver semanticsのSource of TruthはAACL Coreが所有すること。
- **検証条件**:
  - ExtensionやRuntime-specific fileを編集元として扱わない。
  - Canonical AssetからRuntime表現が派生する一方向関係になっている。
- **MVP**: 必須
- **出典**: §1, §9, Consolidated Responsibility Model

## SYS-003 — Extensionはdomain semanticsを所有しない
- **要件**: VS Code ExtensionはWorkbench / Execution Surface / Runtime Bridgeとして振る舞い、Skill semantics、Routing Policy、Role責務、Model Policy、Resolver semanticsを独自に所有しないこと。
- **検証条件**:
  - Extension側にCoreと異なるAsset解決ロジックが存在しない。
  - IDE変更時にもAsset / History / Learning Loopが失われない構造である。
- **MVP**: 必須
- **出典**: §4, Core / Extension Responsibility Split

## SYS-004 — Workflow / Orchestrator / Runtimeの責務を分離する
- **要件**:
  - Workflow: Stage / Role relation / transition constraints / completion modelを定義する。
  - Core: Workflow Definition / State / Policy / Contextを保持・解決する。
  - Orchestrator Role: assignment / transition / retry / reject / fallback等を決定する。
  - Agent Runtime: model invocation / tool invocation / subagent spawnを実行する。
- **検証条件**: いずれかの層が他層の責務を暗黙に兼ねる設計になっていない。
- **MVP**: 必須
- **出典**: §29, Consolidated Responsibility Model

## SYS-005 — Adapterは変換境界とし、domain decisionを持たない
- **要件**: Runtime AdapterはCanonical表現とRuntime固有形式、Bootstrap、Delivery方式を変換するが、Resolution Resultの意味を独自に変更しないこと。
- **検証条件**: 同一Resolution Resultに対し、Adapterが独自のinclude/exclude/override判断を追加しない。
- **MVP**: 必須
- **出典**: 設計思想4, §16

## SYS-006 — Native Runtimeを主要Execution Planeとする
- **要件**: MVPではClaude Code / Codex等の既存認証済みNative Runtimeを主要Execution Planeとして扱い、API直接呼出を必須条件にしないこと。
- **検証条件**: AACL利用に別途API直接課金・API key入力が必須にならない。
- **MVP**: 必須
- **出典**: §16, Document Reconciliation Status

## SYS-007 — 正式名称をAgent Asset Control Layerに統一する
- **要件**: 製品・システムの正式名称はAgent Asset Control Layer（AACL）とし、旧称を正式名称として使用しないこと。
- **検証条件**: UI / docs / schema等のユーザー向け正式名称がAACLに統一されている。
- **MVP**: 必須
- **出典**: 用語上の位置づけ, Explicit Design Decisions


## SYS-008 — ユーザーの開発思想を正本とする
- **要件**: Workflow / Role / Model selection、初期Skill / Rule、relation / bindingは原則としてユーザーが定義した開発方法の表現として扱い、Coreが一般論から恒久設定を暗黙生成しないこと。
- **検証条件**:
  - Coreの決定論的コードは既存scope / relation / policyの適用に限定される。
  - ユーザーが定義していないRole / Model / Workflow bindingをResolverが観測履歴から自動永続化しない。
- **MVP**: 必須
- **出典**: 設計思想3, Explicit Design Decisions

---

# 2. Canonical Assetモデル

## AST-001 — Assetを共通管理単位として扱う
- **要件**: Skill、Rule、Hook、Workflow、Role、Guardrail、Template、Project Knowledge、Routing Policy、Capability等を識別・scope・versioning・relation・history・resolution対象として共通のAsset管理単位に載せること。
- **検証条件**: Asset ID、scope、revision、relationを共通機構で扱える。
- **MVP**: 必須（MVP対象Asset種別の範囲で）
- **出典**: 設計思想2, §9

## AST-002 — Asset Typeごとの意味論を保持する
- **要件**: Assetという共通抽象により、Skill / Rule / Workflow等のvalidation、applicability、merge、conflict、execution/materialization semanticsを均一化しないこと。
- **検証条件**: Asset Typeごとの契約を定義可能で、全種別へ単一merge ruleを強制していない。
- **MVP**: 必須
- **出典**: 設計思想2, §33

## AST-003 — WorkflowとSkillを別のCanonical Assetとして扱う
- **要件**: Workflowは反復可能な実行契約、Skillはbounded operation / procedure / advisory等として別概念で管理すること。
- **検証条件**: WorkflowをSkill kindとしてのみ表現する必須設計になっていない。
- **MVP**: 必須
- **出典**: §5, §8, Explicit Design Decisions

## AST-004 — Runtime固有のWorkflow entry表現を派生物として扱う
- **要件**: RuntimeがWorkflowをSkill/Command形式で起動する必要がある場合、Adapterでentry representationをmaterializeし、Canonical Workflowを正本とすること。
- **検証条件**: Runtime-specific launcher本文へWorkflow Definitionを重複保持しない。
- **MVP**: 必須
- **出典**: §5, §8, §16

## AST-005 — Bounded SkillはDevelopment Executionを暗黙開始しない
- **要件**: Advisory / Preparation / System SkillはWorkflow未選択状態から実装・repository変更・PR作成等へ暗黙昇格しないこと。
- **検証条件**: create-issue / research等のSkill実行後もWorkflow未選択ならDevelopment Executionへ進まない。
- **MVP**: 必須
- **出典**: §7, §8

## AST-006 — RoleをModelと独立した概念として管理する
- **要件**: Roleは「何者として振る舞うか」、Modelは「何が実行するか」として別軸で管理すること。
- **検証条件**: 同じRoleに複数Modelを割当可能で、Model × Role scopeも表現できる。
- **MVP**: 必須
- **出典**: 設計思想7, §10

## AST-007 — OrchestratorをRoleとして扱う
- **要件**: Orchestrator専用巨大Skillを必須とせず、OrchestratorをRole Assetとして管理すること。
- **検証条件**: Workflowの`entry-role`等からOrchestrator Roleを指定可能。
- **MVP**: 必須
- **出典**: §5-7, §29, Explicit Design Decisions

## AST-008 — Task TypeをRoleから分離する
- **要件**: feature-development、bug-fix、security-review等の「何をするか」をTask Typeとして、reviewer等のRoleから分離すること。
- **検証条件**: 同一reviewer Roleを複数レビューTask Typeで再利用可能。
- **MVP**: 必須
- **出典**: §5, §43-45

## AST-009 — Provider / Runtime / Modelを別概念として管理する
- **要件**: Provider、Runtime、Modelを分離し、Provider固有・Runtime固有・Model固有Contextを独立にscope可能とすること。
- **検証条件**: `Provider != Runtime != Model`のデータモデルになっている。
- **MVP**: 必須
- **出典**: §10, Provider / Account / Model, Agent terminology

## AST-010 — Agent Executionを静的Asset scopeに使用しない
- **要件**: Agent Executionは実行instanceを表すruntime metadataとし、静的Asset scopeとして扱わないこと。
- **検証条件**: Asset scope schemaにAgent Execution ID依存の恒久ルールを置かない。
- **MVP**: 必須
- **出典**: §10, Explicit Design Decisions

## AST-011 — CompatibilityをAssetごとに管理する
- **要件**: portable / claude-only / codex-only / adaptable / unsupported等のcompatibilityを管理可能とすること。
- **検証条件**: UIまたはAPIで対象Runtimeへの互換性を確認できる。
- **MVP**: 必須（Claude/Codex区別）
- **出典**: §17, §47

---

# 3. Skill / Rule管理

## SR-001 — Skillの正本をCoreで管理する
- **要件**: Skill本文・metadata・relationをCoreがSource of Truthとして管理すること。
- **検証条件**: Extensionから登録・編集しても正本はCore側に保存される。
- **MVP**: 必須
- **出典**: §11, §47

## SR-002 — Skill metadataを保持する
- **要件**: Skillは少なくともID、名前、説明、本文、execution mode、task type、role、provider/runtime/model、workflow、project、priority、dependency、conflict、activation condition、expected output、completion criteriaを表現できること。
- **検証条件**: MVPで利用する項目を保存・取得・編集できる。
- **MVP**: 必須
- **出典**: §11

## SR-003 — Ruleの正本をCoreで管理する
- **要件**: Rule semanticsと正本はCoreが管理し、Extensionは編集UIに留まること。
- **検証条件**: Runtime設定へ直接書いたRuleが正本扱いされない。
- **MVP**: 必須
- **出典**: §12

## SR-004 — Ruleに複合scopeを設定できる
- **要件**: Ruleはglobal / project / workflow / role / task-type / provider / runtime / model / directoryを含む複数scopeを持てること。
- **検証条件**: 1 Ruleにrole + workflow等のAND条件を設定可能。
- **MVP**: 必須
- **出典**: §12-13

## SR-005 — Assetを常時全量ロードしない
- **要件**: Skill / Rule本文を常時すべてRuntimeへ注入せず、ResolutionおよびProgressive Loadingで必要分のみ提供すること。
- **検証条件**: role/task等に非該当のAssetがResolved Contextへ入らない。
- **MVP**: 必須
- **出典**: §11, §14, §47

---

# 4. Context Resolution

## RES-001 — Context Resolverを明示構成のAsset解決境界とする
- **要件**: Resolverは選択済みWorkflow / Stage / Role / Project / Runtime / Model等から適用Asset / Policyを決定するCore機能とし、Workflow発見・ad-hoc合成・Development Execution開始判断を主要責務にしないこと。
- **検証条件**: Resolver APIが自然言語だけから任意Workflowを選択して実装開始する挙動を持たない。
- **MVP**: 必須
- **出典**: 設計思想3, §13

## RES-002 — Resolver入力軸をサポートする
- **要件**: 少なくともProject、Task、Execution Mode、Workflow/Stage、Task Type、Role、Provider、Runtime、ModelをResolution入力として扱えること。
- **検証条件**: 入力値を変更した際、Resolution Resultを再計算できる。
- **MVP**: 必須
- **出典**: §13

## RES-003 — 異なるscope条件をANDで評価する
- **要件**: 1 Asset内の異なるscope軸はAND条件でmatchすること。
- **検証条件**: role一致・model不一致のAssetがincludeされない。
- **MVP**: 必須
- **出典**: §13 Match semantics

## RES-004 — 同一scopeの複数候補値をOR / INで評価する
- **要件**: 同じscope軸内の複数候補値はOR / INとしてmatchすること。
- **検証条件**: role=[implementer, reviewer]のいずれかでmatchする。
- **MVP**: 必須
- **出典**: §13 Match semantics

## RES-005 — Resolution pipelineを所定順序で評価する
- **要件**: scope match → mandatory/protection → disable → explicit priority → specificity → scope precedence → dependency validation → conflict/merge → ordering/materialization → reasonsの順序を正規pipelineとすること。
- **検証条件**: 同じ入力とrevision集合から同じ結果が得られる。
- **MVP**: 必須
- **出典**: §13 Resolution order

## RES-006 — explicit priorityをspecificityより先に評価する
- **要件**: 意図的overrideのためexplicit priorityをspecificityより優先すること。ただしmandatory弱体化には使用しない。
- **検証条件**: priority差がある競合で指定通りに決着する。
- **MVP**: 必須
- **出典**: §13

## RES-007 — 既定scope precedenceを実装する
- **要件**: 同priority・同specificityのtie-breakでBuilt-in/Global < Team < Project < Workflow < Task Type < Role < Provider < Runtime < Model < Directoryの既定precedenceを使用すること。
- **検証条件**: 単独scope同士の競合で表の順位が適用される。
- **MVP**: 必須（Team以外のMVP対象scope）
- **出典**: §13 precedence table

## RES-008 — 複合scopeをよりspecificとして扱う
- **要件**: role=model等の複合scopeを単独scopeよりspecificとすること。
- **検証条件**: `role=implementer + model=Luna`が各単独条件よりspecificとして評価される。
- **MVP**: 必須
- **出典**: §13, §33

## RES-009 — Mandatory Policyを通常overrideから保護する
- **要件**: mandatoryは通常のoverride/disableより強く、特にsafety/protected-resource系は既定でoverride不可とすること。
- **検証条件**: Project Overlayからmandatory safety policyを無効化できない。
- **MVP**: 基本実装必須 / 高度Guardrailは後回し
- **出典**: §13 Mandatory policy, §30

## RES-010 — required dependency欠落時に親Assetを成功扱いしない
- **要件**: required dependencyがdisabled/unavailableなら親Assetをunavailable/failとすること。
- **検証条件**: missing required dependency時にincluded扱いされない。
- **MVP**: 必須
- **出典**: §13 Disable and dependency

## RES-011 — optional dependency欠落時にdegradedを返す
- **要件**: optional dependencyが満たせない場合はdegraded状態と理由を返すこと。
- **検証条件**: 実行可能性を維持しつつdegradedを観測できる。
- **MVP**: 必須
- **出典**: §13, §31

## RES-012 — fallback dependencyを解決する
- **要件**: fallback dependencyが成立した場合、fallback採用と理由を返すこと。
- **検証条件**: Primary unavailable時に許可されたfallbackへ切替可能。
- **MVP**: 必須（Capability依存の基本）
- **出典**: §13, §31

## RES-013 — Directory scopeは最深pathを優先する
- **要件**: 複数Directory scope一致時はpriority → 最深path → specificity → conflictの順に解決すること。
- **検証条件**: nested directoryで深いscopeが優先される。
- **MVP**: 必須
- **出典**: §13 Directory scope

## RES-014 — 排他的Assetの最終tieを暗黙決定しない
- **要件**: 同priority / specificity / precedenceで意味が変わる排他的Asset競合は、必須ならconflict/fail、非必須ならwarning/除外またはtype既定mergeとすること。
- **検証条件**: 「最後に読んだ方が勝つ」実装になっていない。
- **MVP**: 必須
- **出典**: §13 Final tie, §33

## RES-015 — additive Assetを決定論的順序でmergeできる
- **要件**: 複数Rule等のadditive AssetはAsset Type契約に従い決定論的orderingでmerge可能とすること。
- **検証条件**: 入力順によらず同じmaterialization順を得る。
- **MVP**: 必須
- **出典**: §13, §33

## RES-016 — AssetごとのResolution reasonを返す
- **要件**: included / excluded / overridden / disabled / unavailable / degraded / conflictの状態と理由を返すこと。
- **検証条件**: Preview/APIから各Assetの決定理由を追跡できる。
- **MVP**: 必須
- **出典**: §13, §34, §47

## RES-017 — Resolutionを決定論的にする
- **要件**: 同一Context入力と同一Asset revision集合から原則同一Resolution Resultを得ること。
- **検証条件**: 順序・ファイル列挙順等の非決定要因で結果が変化しない。
- **MVP**: 必須
- **出典**: 設計思想3

---

## RES-018 — Workflow selectionを推測で補完しない
- **要件**: Development Executionに必要なWorkflowが未指定の場合、Resolverは類似Workflow探索やad-hoc Workflow生成で補完せず、No-workflow境界を維持すること。
- **検証条件**: 「これ実装して」のような指示だけでWorkflowが暗黙選択されない。
- **MVP**: 必須
- **出典**: §7, §13, Explicit Design Decisions

---

# 5. Bootstrap / Context Delivery

## CTX-001 — Runtime Bootstrapを極小化する
- **要件**: CLAUDE.md / AGENTS.md等の常時自動読込領域にはProject RuleやSkill本文等をdumpせず、AACLとの接続・初期化契約だけを持たせること。
- **検証条件**: Bootstrap内容がCore Source of Truth、resolve方法、再resolve契約等に限定される。
- **MVP**: 必須
- **出典**: §14, §16, §26

## CTX-002 — Runtime Bootstrapを冪等にする
- **要件**: Native BootstrapとExtension Bootstrapが同一Executionで重複してもsession二重作成、Asset二重登録、意味的二重適用を起こさないこと。
- **検証条件**: 同じbootstrap処理を複数回行ってもResolution意味が変化しない。
- **MVP**: 必須
- **出典**: §14, Chat / Runtime Context Bootstrap, §47

## CTX-003 — Initial ContextをResolution Resultとして生成する
- **要件**: Initial Contextを保存済み巨大promptとしてではなくsession開始時のResolution Resultとして扱うこと。
- **検証条件**: workspace/runtime/model/role/task等を入力して初期解決できる。
- **MVP**: 必須
- **出典**: §14

## CTX-004 — Discoverable Contextをサポートする
- **要件**: Assetの名前・概要・適用条件のみを提示し、必要時に詳細取得できる層を持つこと。
- **検証条件**: 本文未ロードのAssetをdiscover可能。
- **MVP**: 基本対応
- **出典**: §14

## CTX-005 — On-demand Contextをサポートする
- **要件**: 特定task/stageでのみAsset本文を取得・提供できること。
- **検証条件**: 初期Contextへ不要本文を常時含めず後から取得できる。
- **MVP**: 基本対応
- **出典**: §14

## CTX-006 — runtime-pull方式をサポートする
- **要件**: AACLを認識しMCP/tool呼出可能なRuntimeがCoreからResolved Contextをpullできること。
- **検証条件**: Native Runtime → Core interface → Resolved Contextの経路が成立する。
- **MVP**: 必須
- **出典**: §14 Context Delivery Strategy

## CTX-007 — host-inject方式をサポートする
- **要件**: Coreを自律認識できないRuntime向けにExtension/Adapter/HostがResolved Contextを注入できること。
- **検証条件**: Chat Extension経由でInitial Resolved ContextをRuntimeへ渡せる。
- **MVP**: 必須
- **出典**: §14, Chat / Runtime Context Bootstrap, §47

## CTX-008 — Role起動時にRole固有Contextを自動解決する
- **要件**: Specifier / Implementer / Reviewer等のrole起動時、Role・Model・Task等に応じて必要Contextを提供すること。
- **検証条件**: Implementerへreviewer専用Contextが不要に渡らず、Reviewerへimplementation専用Contextが不要に渡らない。
- **MVP**: 必須
- **出典**: §15, §47

## CTX-009 — 委任前にDelegation Contextを解決する
- **要件**: Orchestratorがsubagentを起動する前にtarget role/model/task/projectを用いてCoreからResolved Delegation Contextを取得すること。
- **検証条件**: delegation briefに必要Skill / Rule / Model Policy / Project ContextをCore結果から付与できる。
- **MVP**: 必須
- **出典**: Orchestrator Context Bootstrap, §43

---

# 6. Project / Global Asset管理

## PRJ-001 — Global / Personal AssetをCore-managed storeへ置く
- **要件**: Global / Personal Assetの物理正本をCore-managed Asset Storeで管理すること。
- **検証条件**: Project repository外でGlobal Assetを一元管理できる。
- **MVP**: 必須
- **出典**: §30, §43

## PRJ-002 — Project Assetを原則`<project-root>/.aacl`へ置く
- **要件**: Project固有AssetはProject root配下の`.aacl`を物理正本とし、repository revision/branchと同時管理可能にすること。
- **検証条件**: Project-local assetが`.aacl`から読込・保存される。
- **MVP**: 必須
- **出典**: §30, §43

## PRJ-003 — Project AssetにProject以外の複合scopeを許可する
- **要件**: `.aacl`配下のAssetもRole / Model / Workflow / Task Type / Directory等の複合scopeを持てること。
- **検証条件**: Project Ruleに`role=reviewer + model=Sol`等を設定可能。
- **MVP**: 必須
- **出典**: §30, §47

## PRJ-004 — Project Overlayでadd / override / disable / bindを行える
- **要件**: ProjectはGlobal Assetを複製せずOverlayで追加・上書き・無効化・bindingを指定できること。
- **検証条件**: Global Assetの原本を変えずProject固有差分を適用できる。
- **MVP**: 必須
- **出典**: §30, §43, §47

## PRJ-005 — GlobalとProject Assetを単一Resolverで統合する
- **要件**: Global/Personal + Project Asset/Overlay + Workflow/Task/Role/Runtime等を単一Resolverで合成すること。
- **検証条件**: Resolution Resultに各Assetの由来と適用理由が含まれる。
- **MVP**: 必須
- **出典**: §30, §47

## PRJ-006 — `.aacl`をtrust boundaryとして扱う
- **要件**: Project-local Assetはcheckout/branchで変化しうるためtrust boundaryとして扱い、Global mandatory safety policyを既定で弱められないこと。
- **検証条件**: externally modified/newly cloned `.aacl`を警告可能な設計で、権限緩和に強い制約を適用できる。
- **MVP**: 基本境界必須 / 高度警告は段階実装可
- **出典**: §30 Project trust boundary

## PRJ-007 — Project MarkerでAACL Projectを認識する
- **要件**: `.aacl/project.*`等のMarkerを使ってAACL Projectを認識すること。
- **検証条件**: pathだけに依存せずProject判定できる。
- **MVP**: 必須
- **出典**: §30.1

## PRJ-008 — stable project-idを保持する
- **要件**: Project Markerに安定したproject-idを保持し、clone先・Windows/WSL path・worktree差異でも論理identityを維持できること。
- **検証条件**: workspace path変更後も同じproject-idでCore Registryへ関連付く。
- **MVP**: 必須
- **出典**: §30.1, §47

## PRJ-009 — Git repository rootとAACL Project rootを同一概念に固定しない
- **要件**: 通常一致を許容しつつ、monorepo等で複数AACL Projectを持てる余地を残すこと。
- **検証条件**: Project root決定処理がGit root固定前提になっていない。
- **MVP**: 設計制約
- **出典**: §30.1

## PRJ-010 — Project Initを明示操作とする
- **要件**: Project登録を初回Chatの副作用にせず、`aacl init`または同等UIから明示的に初期化すること。
- **検証条件**: Chat開始だけでは`.aacl`作成やRegistry登録をしない。
- **MVP**: 必須
- **出典**: §30.1, §43, §47

## PRJ-011 — Project Initの標準処理をCore operationに集約する
- **要件**: root確定、既存`.aacl`検出、project-id発行/読込、初期構造作成、Registry登録、native asset検出、import候補提示、初期Overlay作成を同一Core operationとして扱うこと。
- **検証条件**: CLI/Extension/UIが別々のdomain logicを実装しない。
- **MVP**: 必須
- **出典**: §30.1

## PRJ-012 — 未初期化workspaceでGlobal-only実行を許可する
- **要件**: `.aacl`のないworkspaceでもAACL Chatを利用でき、Global/Personal Contextのみで動作すること。
- **検証条件**: Project init未実施でもsession開始可能で、Project-specific Contextは含まれない。
- **MVP**: 必須
- **出典**: §30.1, §43, §47

---

# 7. Runtime Adapter / Native Context Migration

## RUN-001 — Claude / Codex Runtime Adapterを提供する
- **要件**: Canonical ContextをClaude CodeおよびCodex向け形式へ変換・配送するAdapterを持つこと。
- **検証条件**: 同一Canonical Assetから両Runtime向け表現を生成できる。
- **MVP**: 必須
- **出典**: §16, §43, §47

## RUN-002 — AdapterがRuntime固有差異を吸収する
- **要件**: instruction形式、skill/rule materialization、Bootstrap形式、native auto-load入口、MCP/tool invocation、Delivery Strategy、Runtime固有機能をAdapter境界で扱うこと。
- **検証条件**: Core domain modelがClaude/Codex固有file formatに依存しない。
- **MVP**: 必須
- **出典**: §16

## RUN-003 — Generated Artifactを派生物として扱う
- **要件**: Runtime固有生成物を編集元にせず、Canonical Assets / Bootstrap Contract → Adapter → Generated Artifactの一方向とすること。
- **検証条件**: Generated file編集からCore Assetを逆同期しない。
- **MVP**: 必須
- **出典**: §26

## RUN-004 — Generated Artifactのdriftを検知・警告する
- **要件**: 管理対象生成物の直接変更を上書き警告・drift・unmanaged native context警告の対象とすること。
- **検証条件**: Core生成状態と実ファイルの不一致を識別可能。
- **MVP**: 基本対応
- **出典**: §26

## RUN-005 — 既存user-level Native Assetを検出する
- **要件**: `%USERPROFILE%/.claude`, `%USERPROFILE%/.codex`, `$HOME/.claude`, `$HOME/.codex`等をimport候補として検出すること。
- **検証条件**: 対象環境で既存設定の存在を列挙できる。
- **MVP**: 必須
- **出典**: §27, §43

## RUN-006 — 既存project-level Native Assetを検出する
- **要件**: Project領域の既存instruction / skill / rule / hook等をimport候補として検出すること。
- **検証条件**: Project init/import時に候補を提示できる。
- **MVP**: 必須
- **出典**: §27, §47

## RUN-007 — Import後はAACL側を正本とする
- **要件**: ImportしたAssetはCore/managed Project AssetをSource of Truthとし、native fileとの恒久的双方向同期を前提にしないこと。
- **検証条件**: Import後の編集先がAACL側に限定される。
- **MVP**: 必須
- **出典**: §27

## RUN-008 — Native configuration retirementを明示操作として提供する
- **要件**: import後、既存`.claude` / `.codex`等を退避/renameできるが、自動破壊的変更はしないこと。
- **検証条件**: ユーザー明示操作なしに既存設定をrename/deleteしない。
- **MVP**: 必須
- **出典**: §27, §43

## RUN-009 — unmanaged native context併用を識別する
- **要件**: 既存native contextを残して併用する場合、完全なContext再現性・conflict説明可能性を保証しないcompatibility/unmanaged modeとして扱うこと。
- **検証条件**: UI/Snapshotでunmanaged状態を識別できる。
- **MVP**: 必須
- **出典**: §27, §43, §47

---

# 8. Workflow / Execution Mode

## WFL-001 — Workflowを主要なユーザー実行単位として管理する
- **要件**: ユーザーが繰り返す開発行為をWorkflowとして登録し、`/<workflow> + 追加指示` で直接選択・起動できること。
- **検証条件**: `issue-development`等をCanonical Workflowとして直接開始できる。
- **MVP**: 必須
- **出典**: §7, §8, §19

## WFL-002 — Workflowを実行契約として扱う
- **要件**: Workflowはentry role、stages、Role接続、transition constraints、required Asset/Capability/Artifact、completion stateを定義すること。
- **検証条件**: 実行中の可能な進行をWorkflow Definitionから計算できる。
- **MVP**: 必須
- **出典**: §5, §19, §29

## WFL-003 — Workflow StateをCoreで保持する
- **要件**: Workflow実行中のcurrent stage、task、role assignment、workflow revision等を保持できること。
- **検証条件**: AI側が現在工程を毎回推測せず取得できる。
- **MVP**: 必須
- **出典**: §20

## WFL-004 — OrchestratorがWorkflow内のtransition decisionを所有する
- **要件**: Workflowが可能遷移を定義し、Orchestrator/Userが今回のaccept/reject/retry/fallback/returnを決めること。
- **検証条件**: Resolverが今回の遷移を勝手に決定しない。
- **MVP**: 必須
- **出典**: §29

## WFL-005 — 単一Roleで完結するStandalone Workflowを許可する
- **要件**: review等の反復可能タスクをWorkflowとして管理しつつOrchestratorを必須にしないこと。
- **検証条件**: `refactoring-review`等を単一Role Workflowとして開始できる。
- **MVP**: 必須
- **出典**: §7, §45

## WFL-006 — Workflow未指定時はAdvisory / Preparation Modeとする
- **要件**: Workflowが選択されていない通常会話では質問・調査・検討・Issue作成・事前資料・bounded Skillのみを許可すること。
- **検証条件**: Workflowなしで実装工程へ入らない。
- **MVP**: 必須
- **出典**: §7, Explicit Design Decisions

## WFL-007 — Workflow未指定状態からDevelopment Executionへ自動昇格しない
- **要件**: 会話内容や推測だけを根拠に実装、repository変更、PR作成等へ移行しないこと。
- **検証条件**: Development Execution開始時に明示Workflow selectionが存在する。
- **MVP**: 必須
- **出典**: §7, §42, §47

## WFL-008 — Context HandoffをWorkflow構造に基づき生成する
- **要件**: AI間handoffでWorkflow/Stage、Task、Role、Relevant Artifacts、Required Rules/Skills、Constraints、Expected Output、Completion Criteriaを解決できること。
- **検証条件**: 単なる自然文handoffだけに依存しない。
- **MVP**: 必須
- **出典**: §21

## WFL-009 — Workflow revisionを実行Snapshotへ固定する
- **要件**: ExecutionがどのWorkflow revisionに基づいたか保存すること。
- **検証条件**: Workflow更新後も過去実行の構造を識別できる。
- **MVP**: 必須
- **出典**: §35, §41

## WFL-010 — Workflow / Stageを改善の集計単位にする
- **要件**: retry / reject / return / friction / missing-context等をworkflow-id / revision / stage / role単位で集計可能にすること。
- **検証条件**: 同一Workflow反復実行の傾向を比較できる。
- **MVP**: 必須
- **出典**: §38-41, §47

## WFL-011 — Workflow Definition改善をProposal対象にする
- **要件**: Journal ReviewがStage構成、Role接続、Transition、required Asset等のWorkflow改善案を提示できること。
- **検証条件**: Proposal typeがSkill/Rule変更だけに限定されない。
- **MVP**: 必須
- **出典**: §39, §41

# 9. Capability / MCP / Permission

## CAP-001 — CapabilityとMCP/Tool Providerを分離する
- **要件**: Skill → requires Capability → provided by MCPの関係で管理すること。
- **検証条件**: 同一Capabilityを異なるMCPで満たせる。
- **MVP**: 必須
- **出典**: §28, §31

## CAP-002 — Provider/Account/Model軸とCapability/MCP軸を分離する
- **要件**: AI Provider hierarchyとTool Capability hierarchyを同一概念にしないこと。
- **検証条件**: Claude/CodexをMCPの一種として扱わない。
- **MVP**: 必須
- **出典**: §28, Provider / Account / Model

## CAP-003 — ProjectごとにCapability bindingを設定する
- **要件**: Projectごとに利用可能MCPおよびCapability bindingを変更可能とすること。
- **検証条件**: 同じSkillでもProjectごとに異なるMCPを選択可能。
- **MVP**: 必須
- **出典**: §31, §47

## CAP-004 — dependency strengthを管理する
- **要件**: Capability/MCP依存にrequired / optional / preferred / fallbackを設定できること。
- **検証条件**: 強度に応じてunavailable/degraded/fallbackを返せる。
- **MVP**: 必須
- **出典**: §31

## CAP-005 — Capabilityを単純boolに固定しない
- **要件**: 必要に応じてsub-capability / feature setを表現できる拡張可能な構造とすること。
- **検証条件**: capability IDだけでなくfeature要求を持てる余地がある。
- **MVP**: 設計制約
- **出典**: §31

## CAP-006 — availableとallowedを分離する
- **要件**: Tool/MCPが接続されていることと使用許可されていることを別状態として扱うこと。
- **検証条件**: available=true, allowed=falseを表現可能。
- **MVP**: 必須
- **出典**: §32

## CAP-007 — preferred / required Tool状態を表現する
- **要件**: MCP/Toolにavailable / allowed / preferred / requiredを区別可能とすること。
- **検証条件**: Resolverが権限制約を含めて実行可能性を判定できる。
- **MVP**: 必須
- **出典**: §32

---

# 10. Guardrail / Protected Resource

## SEC-001 — 強制可能な安全策をPromptだけに依存させない
- **要件**: 決定論的に検出・強制できる重要事項はRuleだけでなくHook / Guardrail enforcementを優先すること。
- **検証条件**: policy definitionとenforcement pointが分離された設計である。
- **MVP**: 後回し
- **出典**: 設計思想5, Consolidated Responsibility Model

## SEC-002 — Protected Resourceを定義可能にする
- **要件**: `.env`、secret files、production config、migration、lock、CI/CD、deployment manifest、protected branch等をProtected Resourceとして定義可能とすること。
- **検証条件**: Resource / Operationのpolicy targetとして識別可能。
- **MVP**: 後回し
- **出典**: 設計思想6

## SEC-003 — Resource / Operation policy outcomeを表現する
- **要件**: allow / deny / human-approval-required / project-specific-policyを表現可能とすること。
- **検証条件**: operationごとの判定結果を返せる。
- **MVP**: 後回し
- **出典**: 設計思想6

## SEC-004 — Secret値をAsset Storeへ保存しない
- **要件**: 実Secretの保存・暗号化・rotationは外部Secret Manager等の責務とし、AACLはSecret Awareness / policyを扱うこと。
- **検証条件**: Secret raw valueを通常Asset/promptへ保存・注入しない。
- **MVP**: 必須の設計制約 / 高度連携は後回し
- **出典**: 設計思想11, Provider / Account / Model

## SEC-005 — Guardrail Definitionとenforcementを分離する
- **要件**: Definition/Protected Resource PolicyはCore、policy evaluationはCoreまたはRuntime boundary、interception/deny/approvalは操作捕捉可能地点が担当すること。
- **検証条件**: Coreが全tool executionを必ずinterceptする前提になっていない。
- **MVP**: 後回し
- **出典**: Consolidated Responsibility Model

---

# 11. Context Preview / Explainability

## PRE-001 — Context Previewを提供する
- **要件**: AIへ渡す前にRuntime/Model、Role、Task Type、Loaded/Excluded等の最終Contextを確認できること。
- **検証条件**: 実行前にResolved Contextの要約を表示できる。
- **MVP**: 必須
- **出典**: §24, §43, §47

## PRE-002 — PreviewからResolution reasonを確認できる
- **要件**: include/excludeだけでなくmatch/override/disable/unavailable等の理由を確認可能とすること。
- **検証条件**: Asset単位のreason表示がある。
- **MVP**: 必須
- **出典**: §34

---

# 12. Execution Snapshot / Runtime Data

## SNP-001 — Execution Snapshotを保存する
- **要件**: 各AI実行について実行時に解決・付与されたContextをSnapshotとして保存すること。
- **検証条件**: 実行後にSnapshotを取得できる。
- **MVP**: 必須
- **出典**: §35, §43

## SNP-002 — Snapshotに実行metadataを保持する
- **要件**: project、task、execution mode、workflow/stage、task type、role、provider/runtime/modelを保持すること。
- **検証条件**: 各executionの実行構成を後から識別できる。
- **MVP**: 必須
- **出典**: §35

## SNP-003 — SnapshotにResolved Asset情報を保持する
- **要件**: loaded skills/rules/project knowledge、available/selected MCP、overrides、excluded context、relevant artifacts、asset revisionsを保持すること。
- **検証条件**: 当時のContext構成とrevisionを再構築できる。
- **MVP**: 必須
- **出典**: §35

## SNP-004 — Snapshotの再現範囲をResolved Contextに限定する
- **要件**: LLM output、外部Tool結果、repository stateの完全再現は保証せず、当時解決・付与されたContextの再構築を保証範囲とすること。
- **検証条件**: UI/docs/APIが完全実行再現を示唆しない。
- **MVP**: 必須
- **出典**: Consolidated Responsibility Model

## SNP-005 — unmanaged native context状態をSnapshotへ記録する
- **要件**: unmanaged native context併用時、完全再現性を保証できない状態をSnapshot上で識別すること。
- **検証条件**: managed/unmanaged状態を後から判別できる。
- **MVP**: 必須
- **出典**: §27, §47

---

# 13. History / Versioning / Rollback

## HIS-001 — Asset単位の履歴を提供する
- **要件**: Skill、Rule、Hook、Workflow等のAsset単位でrevision historyを確認可能にすること。
- **検証条件**: history(asset)相当の操作が可能。
- **MVP**: 必須（MVP Asset種別）
- **出典**: §36

## HIS-002 — 任意revision間diffを提供する
- **要件**: Assetの任意revision間差分を確認できること。
- **検証条件**: diff(asset, revision)相当の操作が可能。
- **MVP**: 必須
- **出典**: §36

## HIS-003 — Asset rollbackを提供する
- **要件**: 単一Assetを指定revisionへrestoreできること。
- **検証条件**: restore(asset, revision)相当の操作が可能。
- **MVP**: 必須
- **出典**: §36

## HIS-004 — Change Setを管理する
- **要件**: 1回の改善で複数Assetを変更した場合、Change Setとして束ねられること。
- **検証条件**: 関連変更群を1単位として追跡可能。
- **MVP**: 必須
- **出典**: §36, §39

## HIS-005 — Change-set rollbackを提供する
- **要件**: 1 Change Setで変更したAsset群をまとめてrestore可能にすること。
- **検証条件**: restore(changeSet)相当の操作が可能。
- **MVP**: 必須
- **出典**: §36

## HIS-006 — History backendをCore domainから抽象化する
- **要件**: Core domain modelをGit固定にせずHistory API境界を持つこと。
- **検証条件**: backend差替え可能なinterfaceになっている。
- **MVP**: 必須の設計制約
- **出典**: §36

## HIS-007 — Global AssetとProject Assetで適切な履歴backendを使う
- **要件**: 初期構成ではGlobal AssetはCore Store + Git、Project AssetはProject repository revision、Runtime DataはDB/Filesystem等を利用可能とすること。
- **検証条件**: Core API上は保存場所に関わらず統一意味論で扱える。
- **MVP**: 必須
- **出典**: §36

## HIS-008 — Revision HistoryとDecision Provenanceを分離する
- **要件**: Git等のHistory Backendが持つrevision historyと、なぜAssetが変更されたかを表すAACL Provenance / Change Setを別の概念として管理すること。
- **検証条件**: ファイルrevisionだけでは失われるsource Journal、scope / relation判断、approval理由等をAACL側から取得できる。
- **MVP**: 必須
- **出典**: §36 Revision HistoryとProvenanceを分離する

## HIS-009 — ProvenanceをAsset本文から分離する
- **要件**: origin、source Journal Review、source Journals、scope / relation判断等の由来情報をAsset本文へ埋め込まず、Assetに付随する管理情報として保持すること。
- **検証条件**: Asset current stateとProvenance recordを独立に取得でき、Assetから関連Change Setを辿れる。
- **MVP**: 必須
- **出典**: §36

## HIS-010 — Change SetとGit revisionを相互参照できる
- **要件**: GitをHistory Backendとして利用する場合、Change Set / Journal Review IDとcommit referenceを相互参照可能にし、commit messageだけを意味的由来のSource of Truthにしないこと。
- **検証条件**: Change Setから対応commitを、commit referenceからChange Setを辿れる。
- **MVP**: 必須
- **出典**: §36

## HIS-011 — Human editとJournal Review由来変更を同一Provenanceモデルで扱う
- **要件**: Assetの作成・変更originとしてhuman-edit / journal-review等を区別しつつ、同じChange Set / Provenance機構で履歴を追跡すること。
- **検証条件**: 1 Assetの履歴上で人間直接編集とJournal Review由来変更を一貫して表示できる。
- **MVP**: 必須
- **出典**: §36

---

# 14. Journal / Improvement Loop

## JRN-001 — Journalを正式機能として提供する
- **要件**: 実行直後のAI資産・Tool利用に関する一次観測をmemo-levelで記録できること。
- **検証条件**: Journal entryを保存できる。
- **MVP**: 必須
- **出典**: §38, §43

## JRN-002 — Journalの事実部分をSnapshotから自動記録する
- **要件**: project、task、role、task type、workflow stage、provider/runtime/model、loaded Asset、Tool、override、revision等をSnapshotから取得すること。
- **検証条件**: 手入力なしでexecution factsがJournalに関連付く。
- **MVP**: 必須
- **出典**: §38

## JRN-003 — Journalの観測項目を保持する
- **要件**: unexpected value、friction、missing support、improvement seed、possible cause、confidenceを記録可能とすること。
- **検証条件**: 原因仮説と確信度を任意項目として保存できる。
- **MVP**: 必須
- **出典**: §38

## JRN-004 — Journal時点でAsset変更を確定しない
- **要件**: 単発観測から直接Skill/Ruleを変更せず、過適合を避けること。
- **検証条件**: Journal保存操作がAsset updateを暗黙実行しない。
- **MVP**: 必須
- **出典**: §38

## JRN-005 — Journal ReviewをStandalone Skillとして提供する
- **要件**: accumulated journals + snapshots + diagnosticsを入力しImprovement Proposalを出力するStandalone Skillを提供すること。
- **検証条件**: Journal ReviewをOrchestratorなしで実行可能。
- **MVP**: 必須
- **出典**: §39, §43

## JRN-006 — Journal ReviewでWorkflow単位の反復問題を評価する
- **要件**: workflow-id / revision / stage / roleを軸に、繰り返すfriction、return、missing context等を評価すること。
- **検証条件**: 単発executionだけでなく同一Workflow母集団を比較できる。
- **MVP**: 必須
- **出典**: §38-41

## JRN-006A — Journal Reviewで肥大化抑制を考慮する
- **要件**: 新規Asset追加だけでなく、既存強化、削除、降格、Hook移行、Project/Global移動、scope限定等を候補として検討すること。
- **検証条件**: Proposal typeが追加だけに限定されない。
- **MVP**: 必須
- **出典**: 設計思想10, §39

## JRN-007 — Improvement Proposalから直接無承認変更しない
- **要件**: Journal ReviewはProposal生成までとし、人間承認前にAssetを書き換えないこと。
- **検証条件**: Proposal生成とAsset updateが別操作である。
- **MVP**: 必須
- **出典**: §39, §47

## JRN-008 — Human Approval後にVersioned Asset Updateする
- **要件**: 承認された改善をChange Setとしてversioned Asset updateへ反映すること。
- **検証条件**: 更新理由と関連Journal Review/Change Setを追跡できる。
- **MVP**: 必須
- **出典**: §36, §39, §41

## JRN-009 — Scope / Relationの意味的判断をJournal Review AIが行う
- **要件**: Journal / SnapshotのRole / Model / Workflow / Stage等を観測条件として参照し、どのAsset scope / relationへ反映すべきかをJournal Review AIが意味的に判断してProposal化すること。
- **検証条件**: Resolverや固定CoreロジックがJournal履歴から新規bindingを自動生成しない。
- **MVP**: 必須
- **出典**: 設計思想3, §39

## JRN-010 — Observed scopeとProposed scopeを分離する
- **要件**: Journalが発生した実行条件と、Journal Reviewが提案するAssetの適用scope / relationを別情報として表示・保存すること。
- **検証条件**: `observed role=implementer, model=Luna`から`proposed role=implementer`のような異なる提案を理由付きで表現できる。
- **MVP**: 必須
- **出典**: 設計思想3, §39 Scope / Relation proposal

## JRN-011 — Journal Reviewごとの変更内容を明示する
- **要件**: 各Reviewで提案・承認された変更をChange Set単位でAdded / Updated / Removed / Binding changedに分類して表示すること。
- **検証条件**: 各変更からsource Journalとscope / relation判断理由を辿れる。
- **MVP**: 必須
- **出典**: §39 Review change summary

## JRN-012 — Journal Reviewの判断根拠をProvenanceへ残す
- **要件**: 承認済み変更についてsource Journal Review、source Journals / Snapshots、observed context、proposed binding、判断理由、approval結果をProvenanceとして保存すること。
- **検証条件**: 後から「なぜこのRuleがこのRole / Model / Workflowへ紐づいているか」を説明できる。
- **MVP**: 必須
- **出典**: §36, §39

---

# 15. Diagnostics / Context Cost

## DIA-001 — 基本Diagnosticsを提供する
- **要件**: unreachable、duplicate、dependency問題、pruning candidateを検出できること。
- **検証条件**: 対象Assetと診断理由を列挙できる。
- **MVP**: 必須
- **出典**: §23, §40, §43

## DIA-002 — Conflict / Shadowingを検出可能な構造にする
- **要件**: rule conflict、意図しないshadowingを検出対象として扱うこと。
- **検証条件**: Resolver/Diagnosticsが競合関係を表現できる。
- **MVP**: conflict基本は必須 / 自動高度検出は後回し
- **出典**: §23, §43

## DIA-003 — Semantic duplicate検出を将来拡張可能にする
- **要件**: near-duplicate/semantic duplicateを診断対象とすること。
- **検証条件**: exact duplicateと将来のsemantic検出を分離できる。
- **MVP**: 後回し
- **出典**: §23, §40, §43

## DIA-004 — Diagnosticsは検出・計測・相関・flagまでとする
- **要件**: 原因解釈・改善仮説・Asset変更ProposalはJournal Reviewが担当し、Diagnosticsが勝手に変更しないこと。
- **検証条件**: Diagnostics実行がAsset mutationを起こさない。
- **MVP**: 必須
- **出典**: Consolidated Responsibility Model

## COST-001 — Context CostをCoreでローカル計測する
- **要件**: token計測をLLMに実行させず、追加LLM呼出なしでCore側機械計測すること。
- **検証条件**: 計測処理だけで外部model invocationが発生しない。
- **MVP**: 必須
- **出典**: Context Cost Metrics, §47

## COST-002 — model別estimated tokenを扱える
- **要件**: tokenizer差異を考慮し、必要に応じてmodel別estimated tokenとして記録すること。
- **検証条件**: 単一絶対token値に固定しないデータモデルである。
- **MVP**: 必須
- **出典**: Context Cost Metrics

## COST-003 — Context Costを層別・Asset別に記録する
- **要件**: Core / Project / Role / Workflow / Task Type / Skills / Rules / Project Knowledge / Artifacts / Total、およびAsset別内訳を記録可能とすること。
- **検証条件**: Execution Snapshotから内訳を取得できる。
- **MVP**: 必須
- **出典**: Context Cost Metrics, §43

## COST-004 — Context CostをSnapshotへ保存する
- **要件**: 計測結果を通常promptへ常時注入せず、Execution Snapshot metadataとして保存すること。
- **検証条件**: 実行後にContext Costを参照可能。
- **MVP**: 必須
- **出典**: Context Cost Metrics

## COST-005 — Context CostをDiagnostics入力に使う
- **要件**: 高cost/低usage/低value等をAsset肥大化診断へ利用可能とすること。
- **検証条件**: Cost metricを診断ロジックから参照できる。
- **MVP**: 必須
- **出典**: Context Cost Metrics

## COST-006 — Cost削減と品質指標を併用する
- **要件**: review defect、rework、spec clarification、missing-context journal、差し戻し等と組み合わせ、削りすぎを診断候補として扱うこと。
- **検証条件**: Cost低下だけを成功判定にしない。
- **MVP**: 必須
- **出典**: 設計思想10, Context Cost Metrics, §47

---

# 16. Asset Graph / Core UI

## UI-001 — Core UIで主要Assetを管理・確認する
- **要件**: Skills、Rules、Hooks、Roles、Workflows、Task Types、MCP/Capabilities、Project Knowledge、Journals等を管理対象として表示できること。
- **検証条件**: MVP対象Assetへ到達できる管理UIがある。
- **MVP**: 必須（基本UI）
- **出典**: §37, Core UI

## UI-002 — Role中心ビューを提供する
- **要件**: Roleへ適用されるSkill / Rule / Hook等を確認できること。
- **検証条件**: Roleから関連Assetを辿れる。
- **MVP**: 必須
- **出典**: §37, §47

## UI-003 — Asset中心ビューを提供する
- **要件**: AssetからRole、Workflow、Project、dependency、Journal参照等を確認できること。
- **検証条件**: Asset関係性を一覧で辿れる。
- **MVP**: 必須
- **出典**: §37

## UI-004 — 高度graph visualizationをMVP必須にしない
- **要件**: 初期MVPは基本一覧・関係表示を優先し、高度graph visualizationを後回し可能とすること。
- **検証条件**: MVP完成判定が高度graph UIに依存しない。
- **MVP**: 後回し
- **出典**: §37, Explicit Design Decisions

---

# 17. VS Code Extension / Chat Session

## EXT-001 — Extensionで複数Chat Sessionを表示・切替できる
- **要件**: 独自AI Workbenchとして複数Chat Sessionを管理できること。
- **検証条件**: session間をUIで切替可能。
- **MVP**: 必須
- **出典**: Core / Extension Responsibility Split, §43

## EXT-002 — ChatごとにProvider / Modelを切替できる
- **要件**: Session単位でClaude/Codex Provider / Modelを選択可能とすること。
- **検証条件**: Session metadataに選択値を保持しResolutionへ反映できる。
- **MVP**: 必須
- **出典**: §43

## EXT-003 — `/`からCore Skillを選択・起動できる
- **要件**: ユーザー起点のSkill launcherをExtensionに提供すること。
- **検証条件**: Core管理Skill一覧から起動可能。
- **MVP**: 必須
- **出典**: §8, §43

## EXT-004 — IDE contextをCoreへ渡す
- **要件**: workspace / repository / active file / selection等のIDE contextを取得しCoreへ渡せること。
- **検証条件**: Resolution requestにworkspace/editor metadataを含められる。
- **MVP**: 必須
- **出典**: §4, Core / Extension Responsibility Split, §43

## EXT-005 — Initial Resolution triggerを担う
- **要件**: Chat Session開始時にExtensionがCoreへmetadataを渡しInitial Resolved Context取得を開始できること。
- **検証条件**: Session開始時にCore resolveが発火する。
- **MVP**: 必須
- **出典**: Chat / Runtime Context Bootstrap

## EXT-006 — Workflow / Execution状態を表示する
- **要件**: 現在のWorkflow / Execution状態をExtension UIで確認できること。
- **検証条件**: stage/role等の状態が表示される。
- **MVP**: 必須
- **出典**: Core / Extension Responsibility Split

## EXT-007 — Journal入力UIを提供する
- **要件**: 必要に応じて実行者がJournal観測を入力できるUIを持つこと。
- **検証条件**: current execution/snapshotへJournalを関連付けられる。
- **MVP**: 必須
- **出典**: §4, Core / Extension Responsibility Split

## EXT-008 — Chat Session metadataをCoreで管理する
- **要件**: session id、project、provider、model、role、active skill、workflow/execution mode、timestamps、title、linked executions、relevant snapshotsを意味的metadataとしてCore側で管理すること。
- **検証条件**: Session metadataをCore APIから取得可能。
- **MVP**: 必須（基本項目）
- **出典**: Chat Sessions

## EXT-009 — 会話ログをAssetとして扱わない
- **要件**: Conversation logはRuntime DataでありAI Assetではないこと。
- **検証条件**: Asset history/scope semanticsにchat logを混在させない。
- **MVP**: 必須の設計制約
- **出典**: Chat Sessions

## EXT-010 — User SessionとAgent Executionを区別する
- **要件**: ユーザーが開くChatとOrchestrator内部subagent executionを別概念として扱うこと。
- **検証条件**: Agent ExecutionをUI sessionと同一ID体系に強制しない。
- **MVP**: 必須
- **出典**: Chat Sessions

## EXT-011 — Chat初期タイトルを自動生成できる
- **要件**: 初回メッセージまたは初期タスクからSession titleを生成可能とすること。
- **検証条件**: Session title metadataを自動設定可能。
- **MVP**: 基本機能
- **出典**: Chat Title Management

## EXT-012 — Human Renameを常時許可する
- **要件**: ユーザーが任意タイミングでChat titleを変更可能とすること。
- **検証条件**: rename操作を提供する。
- **MVP**: 基本機能
- **出典**: Chat Title Management

## EXT-013 — AI Rename / suggest-onlyを将来拡張とする
- **要件**: AIによるChat title変更提案・実行を将来可能とし、human-fixed titleを勝手に上書きしないこと。
- **検証条件**: Session metadata/permission modelが将来のrename policyを阻害しない。
- **MVP**: 後回し
- **出典**: Chat Title Management, §43

---

# 18. Provider / Account / Authentication

## AUTH-001 — Provider / Account / Modelを階層として扱う
- **要件**: Provider → Account/Credential Source → Modelの関係を管理すること。
- **検証条件**: 複数Accountや利用可能ModelをProvider metadataから表現できる構造である。
- **MVP**: 基本管理必須
- **出典**: Provider / Account / Model

## AUTH-002 — Provider正規認証を利用する
- **要件**: 独自Secret保存方式を避け、Provider正規login flow、OS keychain/provider credential store等を利用すること。
- **検証条件**: Raw credentialをAsset Storeへ保存しない。
- **MVP**: 必須の設計制約
- **出典**: Authentication

## AUTH-003 — Coreはcredential reference / connection status / available modelsを把握する
- **要件**: Secret値そのものではなく接続状態・credential参照・利用可能Model情報をCoreが扱えること。
- **検証条件**: 接続確認にSecret raw valueの保持を要求しない。
- **MVP**: 基本対応
- **出典**: Authentication

---

# 19. Local-first / Service Architecture

## OPS-001 — Coreをservice-capableに設計する
- **要件**: MVPはlocalhost運用でも、Core Domain / ServiceをUIアプリ内部へ閉じ込めず、複数clientから利用可能にすること。
- **検証条件**: Tauri UI / VS Code Extension / CLI / MCPが同じCore service境界を利用できる。
- **MVP**: 必須
- **出典**: Local-first / Self-hostable Core, Technology Stack Direction

## OPS-002 — MVPをSingle-user Local Coreとする
- **要件**: 初期運用はSingle User + Local Core Service + localhostを基本とすること。
- **検証条件**: Team/RBAC/Remote ServerなしでMVP利用可能。
- **MVP**: 必須
- **出典**: Local-first / MVP, §43

## OPS-003 — Windows / WSLから同一Coreへ接続可能な構造にする
- **要件**: 同一PCのWindowsとWSLが同一Core Service / Asset Storeを利用できる構造とすること。
- **検証条件**: Core identity/asset管理をOS側ごとに二重化する必須設計になっていない。
- **MVP**: 設計目標
- **出典**: Windows / WSL

## OPS-004 — Core locationをclientから極力透過化する
- **要件**: localhost / Windows / WSL / remote / team server等の配置差をCore Client Interfaceから隠蔽できること。
- **検証条件**: 接続先設定を変えてもdomain APIは同じ。
- **MVP**: 設計制約
- **出典**: Local-first / Self-hostable Core

## OPS-005 — Remote modeとTeam機能を分離する
- **要件**: Single-user Remote CoreをMulti-user Team Coreより先に実装可能な境界を保つこと。
- **検証条件**: Remote接続機能がRBAC/team modelを必須依存しない。
- **MVP**: 将来
- **出典**: Server modeとTeam機能は分離する

## OPS-006 — Remote failure toleranceを将来拡張可能にする
- **要件**: Last Known Good Context、revision cache、reconnect/resync、stale revision表示等を将来導入可能な構造とすること。
- **検証条件**: client/cache境界を将来追加できる。
- **MVP**: 将来
- **出典**: Offline / Failure Tolerance

## OPS-007 — Core APIをMCPだけに限定しない
- **要件**: Agent Runtime向けにMCPを利用可能としつつ、UI/Session/Diagnostics等はLocal API / IPC / HTTP / WebSocket等の別interfaceを利用可能とすること。
- **検証条件**: MCPがCore全機能の唯一のtransportではない。
- **MVP**: 必須の設計制約
- **出典**: MCPとの関係, Technology Stack Direction

---

# 20. Technology / Architecture Constraints

## TEC-001 — Core Domain / ServiceをTypeScript / Node.js中心で開始する
- **要件**: 初期実装は仕様変更追従性とVS Codeとの型/ロジック共有を優先しTypeScript中心とすること。
- **検証条件**: Core domain/serviceがTS/Node.jsで構成される。
- **MVP**: 方針
- **出典**: Technology Stack Direction

## TEC-002 — Desktop Core UI ShellはTauri 2を第一候補とする
- **要件**: Core UIをTauri 2 + TypeScript frontendで構成する方向とし、Core自体をTauri内部へ密結合しないこと。
- **検証条件**: TauriはCore clientとして接続する。
- **MVP**: 方針
- **出典**: Technology Stack Direction

## TEC-003 — PersistenceをFilesystem + Git中心とする
- **要件**: Asset Source of Truthはhuman-readable filesystem、revision historyはGit-compatible backendを初期採用し、SQLite等はIndex/Runtime Storeとして必要時に利用すること。
- **検証条件**: Asset原本がDB専用opaque形式にならない。
- **MVP**: 方針
- **出典**: Technology Stack Direction, §36

## TEC-004 — Rustを初期Core必須にしない
- **要件**: RustはGuardrail、process supervision、file watching、credential integration、Hook execution、subprocess管理、performance-sensitive path等の安定したsystem boundaryへ将来導入可能とすること。
- **検証条件**: 初期CoreがRust前提で停滞しない一方、境界分離が可能。
- **MVP**: 将来拡張
- **出典**: Rustの位置付け

## TEC-005 — UI / IDE / AdapterからCore Domainを分離する
- **要件**: mono-repo構成にかかわらずCore domainをcore-ui / vscode-extension / provider adapterから分離すること。
- **検証条件**: Core domainがUI SDKや特定Runtime APIへ逆依存しない。
- **MVP**: 必須
- **出典**: 想定ディレクトリ境界

---

# 21. Non-Goals / MVP Boundary

## NGL-001 — ClaudeとCodexの完全同一動作を目標にしない
- **MVP**: 非目標
- **出典**: §42

## NGL-002 — モデル固有能力差の完全吸収を目標にしない
- **MVP**: 非目標
- **出典**: §42

## NGL-003 — AIモデル自体を実装しない
- **MVP**: 非目標
- **出典**: §42

## NGL-004 — MCP Serverを全面置換しない
- **MVP**: 非目標
- **出典**: §42

## NGL-005 — GitHub管理機能を再実装しない
- **MVP**: 非目標
- **出典**: §42

## NGL-006 — 公開Marketplaceを初期目標にしない
- **MVP**: 非目標
- **出典**: §42

## NGL-007 — 他ユーザー向け設定互換性を初期優先しない
- **MVP**: 非目標
- **出典**: §42

## NGL-008 — 全Standalone TaskへOrchestratorを強制しない
- **MVP**: 非目標
- **出典**: §42

---

## NGL-009 — Workflow未指定の自然言語から自動で開発Workflowを発見・合成して実装へ進まない
- **MVP**: 非目標
- **出典**: §42

# 22. MVPで後回しにする機能

以下はv12で明示的に後回しとされる。

1. Hook統合
2. 自動矛盾検出
3. Semantic duplicate検出
4. Workflow GUI editor
5. 複雑な状態管理
6. 自動モデル選択
7. 高度なコンテキスト最適化
8. Model / Model × Role Policyの高度化
9. Protected Resources / Guardrails管理
10. 外部Secret ManagerとのCredential Awareness連携
11. Provider / Account管理UIの高度化
12. Claude / Codex以外のProvider Adapter
13. Chat titleのAI rename / suggest-only
14. Agent ExecutionのOpen as Chat

---

# 23. MVP内部マイルストーンへの対応

## Milestone A — Canonical Assets / Resolver
対象要件:
- AST-001〜011
- SR-001〜005
- RES-001〜017
- PRJ-001〜012
- PRE-001〜002
- RUN-001〜009のうちmaterialization/import関連
- TEC-001〜005

主な成果:
- Canonical Asset model
- Skill / Rule / Role / Workflow / Task Type
- Scope Resolution / precedence / conflict
- Context Preview
- Claude / Codex materialization
- import / Project Overlay
- `.aacl` marker / stable project-id / Project Init
- Global Store + Project-local Source

## Milestone B — Workflow / Runtime Integration
対象要件:
- CTX-001〜009
- WFL-001〜008
- SNP-001〜005
- EXT-001〜010
- RUN-001〜004
- CAP-001〜007

主な成果:
- Workflow direct invocation / no-workflow boundary
- Orchestrator bridge
- Runtime Bootstrap
- runtime-pull / host-inject
- delegation context resolution
- Execution Snapshot
- multi-session / model switching

## Milestone C — Learning / Operations
対象要件:
- HIS-001〜007
- JRN-001〜008
- DIA-001〜004
- COST-001〜006
- UI-001〜004

主な成果:
- History / rollback + Provenance / Change Set
- Journal / Journal Review + AI scope/relation proposal
- Diagnostics
- Context Cost Metrics
- Improvement Proposal
- Asset Graph基本表示

---

# 24. v12 MVP完了条件とのトレーサビリティ

| v12 §47 | 対応要件 |
|---:|---|
| 1 | SR-001, SR-003, EXT系 |
| 2 | AST-006, SR-002, SR-004 |
| 3 | AST-003, AST-008, SR-002 |
| 4 | AST-009, AST-011, RUN-001 |
| 5 | RES-002〜017 |
| 6 | PRE-001, PRE-002 |
| 7 | RUN-001, RUN-002 |
| 8 | RUN-001, RUN-002 |
| 9 | SYS-002, RUN-001〜003 |
| 10 | RES-003〜008, CTX-008 |
| 11 | RES-003〜008, CTX-008 |
| 12 | RUN-005, RUN-006 |
| 13 | RUN-007, RUN-008 |
| 14 | AST-004, WFL-001 |
| 15 | AST-005, WFL-002 |
| 16 | RES-002〜016, WFL-002 |
| 17 | PRJ-004 |
| 18 | CAP-003 |
| 19 | RES-016, PRE-002 |
| 20 | SNP-001〜004 |
| 21 | HIS-001〜003 |
| 22 | JRN-001〜003, SNP系 |
| 23 | JRN-005〜008 |
| 24 | UI-002 |
| 25 | DIA-001〜004 |
| 26 | COST-001〜004 |
| 27 | COST-005, COST-006 |
| 28 | CTX-001, CTX-002 |
| 29 | CTX-006, CTX-007 |
| 30 | CTX-007, EXT-005 |
| 31 | PRJ-007, PRJ-008, PRJ-010, PRJ-011 |
| 32 | PRJ-012 |
| 33 | PRJ-003, SR-004 |
| 34 | PRJ-005, RES-016 |
| 35 | RUN-009, SNP-005 |

---

# 25. MVP主要Asset初期セット

## Roles
- orchestrator
- specifier
- specification-reviewer
- implementer
- reviewer
- code-reviewer

## Skills
### Workflow Launcher
- issue-development

### Standalone Review
- refactoring-review
- architecture-review
- security-review
- test-review

## Workflow
`issue-development`:

```text
Orchestrator
  ↓
Specification
  ↓
Specification Review
  ↓
Implementation
  ↓
Pull Request
  ↓
Code Review
```

---

# 26. 要件数サマリ

v12ではv11の162要件を単純増減させるのではなく、Workflow / Skill / Resolver責務を再分類した。特に実装Issue化では以下を独立した検証単位として扱う。

- Workflow direct invocation
- No-workflow Advisory / Preparation boundary
- Development Execution authorization boundary
- Workflow revision付きSnapshot
- Workflow / Stage単位のJournal / Metrics
- Workflow Definition Improvement Proposal
- ResolverからのWorkflow discovery / synthesis責務除外

既存のAsset / Project / Runtime / Capability / History等の要件は、上記の実行モデルへ従属する形で引き続き有効とする。
