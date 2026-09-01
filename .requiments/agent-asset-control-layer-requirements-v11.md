# Agent Asset Control Layer — 開発要件 v11

## 1. 概要

**Agent Asset Control Layer（AACL）** は、Claude Code と Codex を含むAI開発Runtimeで利用するskill、rule、hook、workflow、role、guardrail、project knowledge、routing policy、capability等のAI開発資産を管理し、実行文脈に応じて必要な資産とpolicyを解決・提供する **local-firstなControl Plane** である。

AACL Coreを Claude Code / Codex / IDE の上位に位置する **AI開発資産と適用意味論の Source of Truth** とする。Context Resolutionはその中核機能であり、Project / Task / Workflow / Role / Runtime / Model / Directory等から、その実行に適用されるAssetとPolicyを決定する。VS Code拡張はSource of Truthを持たず、IDEコンテキスト取得・実行・Preview等を担う、**domain semanticsを所有しないクライアント**とする。

Claude Code の `.claude` や Codex 側の設定を直接正本として管理するのではなく、AACL Coreで管理したCanonical Assetから、それぞれに必要な設定・skill・rule・context等をRuntime-specific representationとしてmaterializeまたは提供する。

---

## Document Reconciliation Status

本版では、資料の成長過程で残っていた旧設計との齟齬を以下の原則で統一した。

- Asset / Rule / Workflow / ResolverのSource of TruthはCore
- ExtensionはWorkbench / Runtime Bridgeであり、domain semanticsの正本を持たない
- Workflow Definition / StateはCore、Transition DecisionはOrchestrator / User、ExecutionはAgent Runtime
- OrchestratorはSkillではなくRole
- Skillは外部Runtime互換の共通呼び出し形式として維持し、Core内部でsemantic kindを分ける
- Guardrail PolicyとEnforcement Pointを分離
- Snapshotの再現範囲はResolved Contextに限定
- Diagnosticsは検出・相関・候補提示まで
- Provider / Account / ModelとCapability / MCP / Tool Providerを別軸で扱う
- MVPは個人localhostの初期運用版。Remote / Team / RBACは将来拡張
- API直接呼出を必須前提とせず、Claude Code / Codex等の既存認証済みNative Runtimeを主要Execution Planeとして利用する
- Native Runtimeの自動Context読込は排除せず、Core管理の極小・冪等なRuntime Bootstrapとして統制する
- Context DeliveryはRuntime PullとHost Injectの2方式を持ち、RuntimeがCoreを認識できない場合はExtension / Adapterが注入する
- Global AssetはCore-managed store、Project固有Assetは原則 `<project-root>/.aacl` を正本とし、Coreが両者を統合解決する
- AACL Projectは `.aacl` markerと安定したproject-idで識別し、`aacl init` 等の明示操作で初期化する
- 製品名を **Agent Asset Control Layer（AACL）** に統一し、旧称「AI Development Context Manager」は使用しない
- Assetは共通の管理・識別・scope・versioning・relation単位であり、異なるAsset Typeの意味論を均一化しない
- Context ResolverをCoreの主要な決定境界とし、Adapter / ClientはResolution Resultの意味を独自に書き換えない

---


## 2. 背景

現在の開発フローでは、主に Claude Code 側に以下の知見が蓄積されている。

- skill
- rule
- hook
- 開発フロー
- 設計ルール
- 実装ルール
- レビュールール
- Claude / Codex 間の委譲方法
- モデルごとの役割
- 過去の運用から得られた知見

Claudeをオーケストレーターとして育ててきたため、Codexへタスクを委譲する際にはClaudeが、

- タスクそのもの
- 必要なrule
- 必要なskill
- 実装上の制約
- レビュー上の制約
- その他必要な前提情報

を選択し、Codex側へ渡している。

この方式ではClaudeが暗黙的な「コンテキスト編集・配送レイヤー」となっている。

そのため、

- Claudeの常時コンテキストが増大する
- Claude側だけに知識が偏る
- Codex単独利用時に同等の知識を利用しにくい
- 同じ情報をClaude/Codex向けに重複管理する可能性がある
- どのroleに何の情報が必要なのかが暗黙的になる
- ruleやskillの依存関係・重複・矛盾を管理しにくい

という問題がある。

---

## 3. 目的

AACLの主目的は、ClaudeとCodexの設定を同期することではない。

**AI開発に必要な知識・規則・ワークフロー・安全策等をCanonical Assetとして管理し、実行文脈に応じて適用対象を決定し、各Runtimeへ必要十分な形で提供すること**を目的とする。

したがってAACLは単なるprompt manager / settings synchronizerではなく、AI開発資産の管理、Context Resolution、policy適用、workflow state、実行観測、改善ループを担うControl Planeとして位置づける。

目指す状態は以下。

```text
                Agent Asset Control Layer
                          │
          ┌───────────────┼───────────────┐
          │               │               │
        Skills           Rules          Workflow
          │               │               │
          └───────────────┼───────────────┘
                          │
                  Context Resolution
                          │
         ┌────────────────┼────────────────┐
         │                │                │
     Specifier        Implementer       Reviewer
         │                │                │
         ▼                ▼                ▼
   Claude / Codex    Claude / Codex    Claude / Codex
```

Claude Code / Codex は、この知識管理システムの利用者となる。

---



## 設計思想

本システムは、単なるClaude / Codex間の設定同期、Skill配布、Context削減ツールではない。

**AI開発で起きやすい事故・摩擦・知識の偏りを抑えながら、Skill / Rule / Hook / Workflow / Project Knowledge等のAI資産を、適切なレイヤーに配置し、運用から継続的に育てるための基盤** とする。

### 1. 必要十分なContextを配る

すべてのAIにすべての知識を常時持たせない。Project、Task、Workflow、Role、Model等から、その実行に必要なContextだけを解決する。

目標は最小Contextではなく、**必要十分なContextを、再現性高く、できるだけ低コストで提供すること** とする。

### 2. Assetは共通管理単位であり、共通意味論ではない

Skill、Rule、Workflow、Role、Guardrail、Template、Project Knowledge、Routing Policy、Capability等を共通して **Asset** と呼ぶ。これは識別、scope、versioning、relation、history、resolution対象として統一管理するための抽象であり、すべてを同一の意味論で扱うことを意味しない。

各Asset Typeは必要に応じて独自のvalidation、applicability、merge、conflict、execution / materialization semanticsを持つ。Resolverは共通pipelineで候補を評価するが、最終的な合成規則はAsset Typeごとの契約に従う。

「すべてAssetだから同じ優先順位・同じmerge規則で処理できる」という設計にはしない。

### 3. Context ResolverをCoreの決定境界とする

AACL Coreの価値はAssetを保存することだけではなく、**現在の実行に何が適用され、何が適用されないかを決定すること**にある。Context ResolverをCoreの主要なpolicy / compilation境界として扱う。

同一の入力Contextと同一のAsset revision集合からは、原則として同一のResolution Resultを得られる決定論性を求める。結果には採用Assetだけでなく、exclusion、override、disabled、unavailable、degraded、conflictとその理由を含める。

Runtime Adapter / Extension / Runtime BootstrapはResolution Resultを配送・変換できるが、独自の暗黙ルールで適用結果を書き換えない。実行時に使用したResolution ResultはExecution Snapshotから追跡可能にする。

概念上の中心経路は以下とする。

```text
Canonical Assets
      ↓
Context Resolver
      ↓
Resolved Context + Policy
      ↓
Runtime Adapter / Host Inject / Runtime Pull
      ↓
Agent Runtime
```

### 4. AI資産を適切なレイヤーへ配置する

問題をすべてRuleで解決しない。性質に応じて配置先を分ける。

```text
判断・行動指針                  → Rule
再利用可能な手順・専門知識      → Skill
決定論的に検出・強制できる安全策 → Hook / Guardrail
複数工程の進行                  → Workflow
役割固有の責務                  → Role
モデル固有の弱点補正            → Model Policy
プロジェクト固有知識            → Project Knowledge / Project Overlay
外部能力                        → MCP / Capability
実行から得た一次観測            → Journal
```

Skill / Ruleを増やすこと自体を目的にしない。必要に応じて、RuleからSkillへの降格、RuleからHookへの移行、GlobalとProject間の移動、Model / Model × Roleへの限定、不要Assetの削除を行えることを前提とする。

### 5. 強制できる安全策はPromptに依存しない

AIが守るべき重要事項のうち、機械的に判定できるものは、RuleだけでなくHook / Guardrailによる強制を優先する。

例:

```text
.env delete                        → Human approval required
secret file commit                 → deny
protected production config delete → Human approval required
```

`.env` 等の秘密情報そのものを本システムがSecret Storeとして管理することは主目的としない。

一方で、**AIが秘密情報・重要ファイル・危険操作をどう扱ってよいか** という安全ポリシーは本システムの管理対象とする。

### 6. Protected Resources / Guardrails

重要ファイルや操作をProtected Resourceとして定義できるようにする。

例:

- `.env`
- secret files
- production configuration
- migration files
- lock files
- CI/CD definitions
- deployment manifests
- protected branches

各Resource / Operationに対して、少なくとも `allow` / `deny` / `human-approval-required` / `project-specific-policy` を表現できる構造を想定する。

Global GuardrailをProject Overlayで追加・上書き・無効化できることを想定する。

### 7. RoleとModelを別軸で扱う

Roleは「その実行で何者として振る舞うか」、Modelは「どのモデルが実行するか」を表す。

Rule / Skill等は以下のようなscopeを持てる。

```text
global
project
workflow
task-type
role
model
model + role
directory
```

モデル全般の弱点はModel scopeで補い、特定Role時だけ現れる弱点はModel × Role scopeで補う。

### 8. 運用からAI資産を育てる

AI資産は静的な設定ではなく、実行結果から改善されるものとして扱う。

```text
Knowledge / Assets
      ↓
Execution
      ↓
Execution Snapshot
      ↓
Journal
      ↓
Diagnostics
      ↓
Journal Review
      ↓
Improvement Proposal
      ↓
Human Approval
      ↓
Asset Update
```

Journalは一次観測、Diagnosticsは計測結果、Journal Reviewは改善判断を担当する。

自動収集・自動分析は行ってよいが、重要なAsset変更は人間承認を前提とする。

### 9. 肥大化を改善とみなさない

改善ループによってRule / Skillが単調増加しないようにする。

新規Asset追加と同時に、既存Asset強化で済まないか、重複していないか、On-demand化できないか、Hookへ移せないか、Project固有やModel / Role scopeへ限定できないか、削除できるAssetがないかを継続的に検討する。

Context Cost Metrics、Execution Snapshot、Journal、Asset Graphを診断材料として利用する。

### 10. Context削減と品質を同時に評価する

Context量を減らすことだけを成功条件にしない。

```text
Context Cost ↓
Defects       ↓
Rework        ↓
Missing Info  ↓
```

を同時に目指す。

Context Costが下がってもreview defect、rework、missing-context journal、差し戻しが増えた場合は、Resolverが必要情報を削りすぎた可能性として扱う。

### 11. Secret管理とSecret Awarenessを分離する

実Secretの保存・暗号化・ローテーション等は外部Secret Managerの責務とする。

本システムは必要に応じて、Secret / Credentialの存在、Capabilityとの関係、Projectごとの利用可否、必要権限、Protected Resource policyを把握できる。

Secret値そのものをPrompt Contextへ注入することは避ける。

### 12. AACL CoreをControl Plane、IDE拡張をExecution Surfaceとする

AACL Coreは、AI資産管理、関係性可視化、Context Resolution、Guardrail、Workflow State、Execution Snapshot、Journal / Diagnostics、Historyを担う。Context Resolutionを中心に、管理・適用・観測・改善を一つのControl Planeとして接続する。

VS Code拡張は、workspace / editor context取得、Skill起動、Context Preview、実行状態表示、Journal入力を担う。ここでいう「薄い」は機能量ではなく、**domain semantics / routing policy / asset semanticsを所有しない**ことを意味する。

IDEを変えても、AI資産・履歴・改善ループが失われない構造を維持する。

### 用語上の位置づけ

- **Agent Asset Control Layer / AACL**: 製品・システム全体の正式名称
- **AACL Core**: Source of Truthとdomain semanticsを所有するControl Plane
- **Context Resolver**: 実行文脈から適用Asset / Policyを決定するCore機能
- **Resolved Context**: Resolverが生成する実行向けの解決結果。単なるprompt文字列ではなく、適用Asset、Policy、理由、状態を含む
- **Runtime Adapter**: Canonicalな解決結果をRuntime固有形式へ変換・配送する境界

旧称「AI Development Context Manager」は本版以降の正式名称として使用しない。

---

## 4. システム境界

AACLは「AACL Core / Control Plane」と「IDE / Runtime側のExecution Surface」を分離する。

```text
          Agent Asset Control Layer Core
                      │
        ┌─────────────┼─────────────┐
        │             │             │
    Asset Store   Resolver      Runtime/Learning
        │             │             │
        └─────────────┼─────────────┘
                      │
            Local API / MCP / IPC
          ┌───────────┼───────────┐
          │           │           │
     VS Code拡張   Claude Adapter  Codex Adapter
```

### Coreの責務

- AI資産のSource of Truth
- Skill / Rule / Hook / Role / Workflow / Task Type管理
- Project Overlay管理
- MCP / Capability管理
- Context Resolution
- 実行時Snapshot
- Asset履歴
- Journal / Journal Review
- Diagnostics
- Asset Graph / 関係性可視化

### VS Code拡張の責務

- 現在のworkspace取得
- 開いているファイル・選択範囲等のIDEコンテキスト取得
- Skill起動UI
- Context Preview
- 実行状態表示
- 必要に応じたJournal入力
- Coreとの通信

VS Code拡張は全AI資産を独自に解釈・保持せず、必要な解決結果をCoreから取得する。

---

## 5. 基本概念

本システムでは、以下を明確に分離する。

### Skill

Claude / Codex等の外部Runtimeでは、Command / Action / Skillが実質的に同一形式へ収束する場合があるため、本システムでは **Skillを共通の呼び出し可能Asset形式** として扱う。

ただしCore内部では、Skillの意味的役割を区別する。

例:

```text
Skill
├─ Workflow Launcher
├─ Standalone Task
├─ Procedure
├─ Advisory
└─ System / Meta
```

例:

- issue-development: Workflow Launcher
- refactoring-review: Standalone Task
- journal: System / Meta
- journal-review: System / Meta

Skillは外部Runtime上では同じMarkdown形式へmaterializeされてもよいが、Coreは `kind` とRelationを保持する。

Workflow Launcher SkillはWorkflowそのものを本文に抱え込まず、対象Workflowを起動する薄い入口とする。

```text
Skill: issue-development
  kind: workflow-launcher
  launches: Workflow(issue-development)
```

Standalone Skillは単独Role / Task Typeを直接起動できる。

### Role

**誰として振る舞うか**を定義する。

OrchestratorもSkillではなくRoleとして扱う。Workflowが `entry-role: orchestrator` を指定した場合、そのRole ContextとWorkflow StateをCoreが解決して実行主体へ渡す。

初期role:

- orchestrator
- specifier
- specification-reviewer
- implementer
- reviewer
- code-reviewer

### Rule

**何を守るか**を定義する。

例:

- Implementerは確定仕様を独断で変更しない
- PR作成前に必要なテストを実行する
- 設計成果物は反対側モデルでレビューする

### Workflow

**複数工程をどう繋ぐか**を定義する。

Workflow DefinitionはCore Assetであり、少なくとも以下を表現できる。

- entry role
- stages
- stageごとのrequired role / task type
- transition constraints
- retry / reject / return可能な遷移
- completion state
- required artifact / capability

Workflowは「次に何が可能か」を定義するが、「今回どの遷移を選ぶか」という実行判断そのものはOrchestrator / Userが所有する。

例:

```text
Orchestration
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

### Task Type

**何を対象に何をするか**を定義する。

例:

- feature-development
- bug-fix
- refactoring-review
- architecture-review
- security-review
- test-review
- pull-request-review

RoleとTask Typeを分離することで、reviewer roleをレビュー種別ごとに増殖させない。

---

## 6. 現在の開発フロー

### Orchestrator

主担当:

- Opus
- Fable

責務:

- タスクの理解
- 開発工程の管理
- 適切な設計者の選択
- 実装者・レビュー者への委譲
- 工程間の状態管理
- 必要に応じた差し戻し

Orchestratorは **workflow実行時の意思決定Role** とする。

Orchestrator専用の巨大Skillを必須とはしない。Workflow Definition、Orchestrator Role、Routing Policy、Transition Policy、Resolved Contextを組み合わせて動作する。

Orchestratorの主なDecision Ownership:

- 誰に何を任せるか
- 現在の結果をaccept / reject / retryするか
- 次のWorkflow Stateへ進むか
- 差し戻し先をどこにするか
- fallbackを利用するか

すべてのタスクの入口として必須にはしない。

---

### Specifier / Designer

規模感に応じて以下の優先順位で使用する。

1. Luna
2. Sol
3. Opus

基本方針:

- Lunaを優先
- 中規模以上、または適性に応じてSol
- 必要な場合のみOpus

責務:

- 要件整理
- 仕様策定
- 設計成果物作成
- 実装可能な状態まで仕様を確定する

---

### Specification Review

設計成果物は、原則として作成側とは反対側のAI系統へレビューを依頼する。

```text
Claude側で設計
    ↓
Codex側でレビュー

Codex側で設計
    ↓
Claude側でレビュー
```

目的:

- 同一モデル系統による思考の偏りを減らす
- 見落としを検出する
- 要件解釈の妥当性を確認する

---

### Implementer

基本担当:

- Luna

責務:

- 確定した仕様に基づく実装
- 必要なテスト
- 既存ruleへの準拠
- Pull Request作成

原則として、実装工程では仕様そのものを独断で変更しない。

仕様変更が必要な場合は設計工程へ戻す。

---

### Code Reviewer

基本担当:

- Sol

責務:

- Pull Requestレビュー
- 仕様との一致確認
- 実装品質確認
- rule違反確認
- テスト妥当性確認
- 回帰リスク確認

---

## 7. 実行モード

Coreは少なくとも以下の2種類の実行モード定義を持ち、Extensionはその起動・表示を担う。

### Workflow Mode

複数工程を伴うタスク。

例:

- 新規Issue対応
- 新機能開発
- バグ修正
- 設計から実装・レビューまで一連で進める課題

基本形:

```text
Skill: issue-development
  kind: workflow-launcher
        ↓ launches
Workflow: issue-development
  entry-role: orchestrator
        ↓
Orchestrator Role
        ↓
Specifier
        ↓
Specification Reviewer
        ↓
Implementer
        ↓
PR
        ↓
Code Reviewer
```

このモードではWorkflowがOrchestrator Roleをentry roleとして指定できる。Orchestratorの有無はWorkflow Definitionで決まり、ユーザーがOrchestrator Skillを直接起動する必要はない。

### Standalone Mode

単一タスクとして閉じる処理。

例:

- リファクタリングレビュー
- アーキテクチャレビュー
- セキュリティレビュー
- テストレビュー
- 特定コードだけの可読性レビュー

基本形:

```text
Skill: refactoring-review
        ↓
      Reviewer
        ↓
      Result
```

Standalone ModeではOrchestratorを必須としない。

---

## 8. Skillを共通のユーザー起点とする

ユーザーが `/` 等から開始する単位は原則Skillとする。

これはClaude / Codex等のRuntimeでSkillが共通の呼び出し形式として扱われることとの親和性を優先したものであり、Core内部の意味論まで単一化することを意味しない。

例:

```text
/issue-development
/refactoring-review
/journal
```

CoreはSkillの `kind` に応じて実行意味論を変える。

### Workflow Launcher

```text
Skill
  ↓ launches
Workflow
  ↓ entry role
Orchestrator / other entry Role
```

Skill本文へWorkflow全体を重複記述しない。

### Standalone Task

```text
Skill
  ↓
Role + Task Type
  ↓
Agent Execution
```

### System / Meta

Journal / Journal Review等、AI資産管理・改善ループに関する操作。

各Skillは必要に応じて以下を定義できる。

- kind
- execution mode
- task type
- required role
- required rules
- required auxiliary skills
- required artifacts
- expected output
- completion criteria
- workflow reference
- capability dependency
- scope / activation condition

Model AssignmentはSkill本文へ固定するのではなく、Role / Routing Policy / Model Policyから解決することを基本とする。

---

## 9. 独立コアをSource of Truthとする

以下をClaude側・Codex側に直接分散管理しない。

- skill
- rule
- workflow
- role定義
- context routing定義
- Provider / Runtime / Model固有ルール
- hook
- MCP定義 / Capability定義
- Project固有Knowledge
- Journal / Journal Review / Improvement Proposal

独立コア内に保持する。

```text
Agent Asset Control Layer Core
    │
    ├── Skills
    ├── Rules
    ├── Roles
    ├── Workflows
    ├── Task Types
    ├── Runtime Profiles / Provider Metadata
    ├── Hooks
    ├── MCP Catalog / Capabilities
    ├── Projects / Project Overlays
    ├── Journals / Journal Reviews
    └── Routing Policies
```

Claude Code / Codex向けの設定は派生物として扱う。

---

## 10. Context Layer

管理する情報は少なくとも以下のレイヤーに分類する。

### Shared Context

開発全体で共有される知識。

例:

- Git運用
- Pull Request方針
- Issue運用
- コーディング原則
- 開発フロー
- セキュリティ原則

### Workflow Context

特定の開発工程に必要な知識。

例:

- Specification
- Specification Review
- Implementation
- Pull Request
- Code Review

### Role Context

役割固有の知識。

例:

- orchestrator
- specifier
- specification-reviewer
- implementer
- reviewer
- code-reviewer

### Task Type Context

特定のタスク種別に必要な知識。

例:

- refactoring-review
- architecture-review
- security-review
- pull-request-review

### Provider / Runtime / Model Context

Provider、Runtime、Model固有の情報を別軸として扱う。

例:

- Provider-specific: Anthropic / OpenAI等
- Runtime-specific: Claude Code / Codex CLI / IDE integration等
- Model-specific: Opus / Fable / Luna / Sol等

Roleはこれらと独立軸であり、必要に応じて複合scopeを使用する。

例:

```text
scope:
  role = implementer
  model = Luna
```

`Agent Execution` は個々の実行instanceを表すため、原則として静的Asset scopeには使用しない。
Execution Snapshot / Session / Journal等のruntime metadataとして記録する。

### Project Context

特定リポジトリ・プロジェクトにのみ適用される情報。

例:

- architecture
- directory structure
- naming conventions
- project-specific constraints

---

## 11. Skill管理

SkillはCoreをSource of Truthとして一元管理する。Extensionは登録・編集・起動UIを提供してよいが、Skill semanticsや正本を保持しない。

各Skillは少なくとも以下の情報を持つ。

- ID
- 名前
- 説明
- 本文
- execution mode
- task type
- 適用role
- 適用provider / runtime / model
- 適用workflow
- 適用project
- priority
- dependency
- conflict
- activation condition
- expected output
- completion criteria

Skillは常時全内容を読み込ませない。

---

## 12. Rule管理

RuleもCoreをSource of Truthとして管理する。Extensionは編集UIを提供してよいが、Rule semanticsや正本を保持しない。

Ruleは以下のような適用範囲を持てるものとする。

```text
global
project
workflow
role
task-type
provider
runtime
model
directory
```

一つのRuleが複数スコープを持つことを許容する。

例:

```text
Rule:
「Implementerは確定仕様を独断で変更しない」

scope:
role = implementer
workflow = implementation
```

---

## 13. Context Resolution

### Resolution Semantics

Scope Resolutionは決定的・説明可能であることを必須とする。

#### Match semantics

- 1 Asset内の異なるscope条件はAND
- 同一scope内の複数候補値はOR / IN
- `Agent Execution` は静的scopeとして使用しない
- 暗黙の「後勝ち」を禁止する

#### Resolution order

以下の順で評価する。

```text
1. scope match
2. mandatory / protection class evaluation
3. disable evaluation
4. explicit priority
5. specificity
6. scope precedence
7. dependency validation
8. conflict resolution / merge
9. final ordering / materialization
10. resolution reasons
```

`explicit priority` は、意図的なoverrideを表現するため `specificity` より先に評価する。
ただしmandatory policyを弱める目的には使用できない。

#### Default scope precedence

同一priority・同一specificityで競合した場合の既定precedenceは以下とする。

| Rank | Scope | 意味 |
|---:|---|---|
| 10 | Built-in / Global | 全体既定 |
| 20 | Team | Team共有方針 |
| 30 | Project | Project固有overlay |
| 40 | Workflow | Workflow固有 |
| 50 | Task Type | 作業種別固有 |
| 60 | Role | Role固有 |
| 70 | Provider | Provider固有 |
| 80 | Runtime | 実行環境固有 |
| 90 | Model | Model固有 |
| 100 | Directory | 対象path固有 |

これは単独scope同士のtie-break用の既定値であり、複合scopeは `specificity` により優先される。

例:

```text
role=implementer + model=Luna
```

は `role=implementer` 単独や `model=Luna` 単独よりspecificとする。

Provider / Runtime / Model / Roleは意味的に独立した軸であり、通常はmergeする。
排他的Assetで競合した場合のみ上記規則を使用する。

#### Mandatory policy

`mandatory` は通常のoverride / disableより強い。

- Personal / Project Overlayからdisable不可
- 同等以上の管理scopeで明示的にoverride可能と設定された場合のみ変更可能
- safety / protected-resource系mandatory policyは既定でoverride不可

#### Disable and dependency

Asset AがAsset Bを `required` dependencyとして持つ場合:

- Bがdisable / unavailable → Aは `unavailable` / `fail`
- Bがoptional dependency → Aは `degraded`
- fallback dependencyが成立 → `fallback` と理由を記録

disableは依存関係を無視して成功扱いにはしない。

#### Directory scope

複数Directory scopeが一致する場合:

1. explicit priority
2. 最も深いpath
3. specificity
4. 同条件ならconflict

の順で解決する。

#### Final tie

同一priority・同一specificity・同一scope precedenceでも排他的Assetが競合する場合、暗黙のtie-breakは行わない。

- 実行に必須 → `conflict / fail`
- 非必須 → `warning` として双方を除外またはAsset type既定merge ruleを適用
- additive Asset（複数Rule等） → deterministic orderingでmerge可能

各Assetについて `included / excluded / overridden / disabled / unavailable / degraded / conflict` の理由を返す。

Coreの中核機能とする。

AIが起動する、またはタスクを委譲される際に、

```text
Project
Task
Execution Mode
Workflow Stage
Task Type
Role
Provider
Runtime
Model
```

を入力として必要なコンテキストを決定する。

概念的には以下。

```text
resolveContext(
    project,
    task,
    executionMode,
    workflow,
    taskType,
    role,
    provider,
    runtime,
    model
)
```

結果として、

- 必須rule
- 必須skill
- role instruction
- workflow instruction
- task-type instruction
- project context
- provider / runtime / model固有instruction

を組み立てる。

---

## 14. Bootstrap / Progressive Context Loading

すべてのskill/ruleを常時注入しない。

本システムでは、Runtime起動からタスク固有Context取得までを以下の層に分離する。

```text
Runtime built-in context
        ↓
AACL Runtime Bootstrap
        ↓
Initial Context Resolution
        ↓
Resolved Initial Context
        ↓
Discoverable / On-demand Context
```

### Runtime built-in context

Claude Code / Codex等のAgent Runtime自身が持つbuilt-in instructionやtool semanticsを指す。
Coreの管理対象Assetとは区別する。

### AACL Runtime Bootstrap

RuntimeがCoreとの契約を成立させるための極小Contextとする。

BootstrapにはProject Rule、Skill本文、Workflow本文等のdomain assetを持たせない。
原則として以下のみを定義する。

- AACL CoreがAI開発ContextのSource of Truthであること
- CoreからResolved Contextを取得する必要があること
- session / execution初期化方法
- task / role / workflow変更時の再resolve方法
- native側の生成物を正本として扱わないこと

Native Runtime向けには、Claudeの `CLAUDE.md`、Codexの `AGENTS.md` 等、Runtimeが常時自動読込する入口へmaterializeしてよい。
具体的な配置・形式はRuntime Adapterが吸収する。

Bootstrapは **冪等** でなければならない。
同じExecutionでNative BootstrapとExtension Bootstrapが重複しても、session二重作成、Asset二重登録、Resolved Contextの意味的二重適用等を発生させない。

### Initial Context Resolution

Bootstrap ContextおよびHostから得られるruntime metadataを入力として、session開始時にCoreが初期Contextを解決する。

入力例:

```text
workspace / project
runtime / provider / model
role
workflow / execution mode
task / task type
active directory
```

Initial Contextは保存された巨大な単一promptではなく、**session開始時のResolution Result** とする。

### Discoverable

名前・概要・適用条件のみ提供し、必要になった場合に詳細を取得する。

### On-demand

特定タスク・工程でのみ本文を提供する。

これにより、

- context消費
- instruction pollution
- rule衝突
- 不要なskillの誤利用

を減らす。

### Context Delivery Strategy

Coreは「何を渡すべきか」を解決するが、RuntimeへContextを配送する主体を固定しない。
少なくとも以下の2方式を持つ。

```text
runtime-pull
host-inject
```

#### Runtime Pull

Claude Code / Codex等、Bootstrap instructionとMCP / Tool呼出が可能なRuntime向け。

```text
Native Runtime
  ↓ Runtime Bootstrap
Core MCP / Core interface
  ↓
Resolved Context
  ↓
Native Runtime
```

#### Host Inject

Local LLM、単純なAPI互換Runtime、Coreを自律的に認識できないRuntime向け。

```text
Extension / Adapter / Host
  ↓
Core Context Resolution
  ↓
Resolved Context
  ↓
Runtime input / system context
```

本ツールのChat Extensionは標準HostとしてHost Injectを実行できる。
そのため、対象Runtime自身がAACLやMCPを認識していることをシステム全体の前提としない。

---

## 15. Role起動時Context Injection

各roleが立ち上がった際に、自動的にそのrole向けコンテキストを提供する。

### Specifier

```text
role = specifier
model = luna

→ requirements rules
→ architecture rules
→ specification skill
→ project architecture
```

### Implementer

```text
role = implementer
model = luna

→ implementation rules
→ coding conventions
→ testing rules
→ confirmed specification
```

### Code Reviewer

```text
role = code-reviewer
model = sol

→ review rules
→ specification
→ changed files
→ architecture constraints
```

### Standalone Refactoring Reviewer

```text
execution-mode = standalone
role = reviewer
task-type = refactoring-review

→ core reviewer rules
→ refactoring review skill
→ project architecture
→ target code
```

---

## 16. Runtime / Provider Adapter

AACL Core内部のCanonical Contextと、各Agent Runtime / Provider固有の設定・実行形式を分離する。

```text
Canonical Context
       │
       ├── Claude Runtime Adapter
       ├── Codex Runtime Adapter
       └── Local / future Runtime Adapter
```

Adapterは少なくとも以下を吸収する。

- instruction形式
- skill / rule materialization形式
- Runtime Bootstrap形式
- native auto-load contextの入口
- MCP / tool invocation方式
- Context Delivery Strategy（runtime-pull / host-inject）
- provider / runtime固有機能

### Native Runtimeを基本Execution Planeとする

MVPではAPI直接呼出を必須前提としない。
Claude Code / Codex等、ユーザーが既に正規認証して利用しているNative Runtimeを主要Execution Planeとして扱う。

API直接呼出は将来または任意Adapterとして利用可能にしてよいが、製品利用の必須条件にはしない。

### Native auto-load context

Claude Code / Codex等が自身の設定ファイルを自動読込すること自体は排除しない。
代わりに、その常時読込領域をCoreが生成する **極小Runtime Bootstrap** に限定する方向を基本とする。

実際のProject Rule / Skill / Role / Workflow / KnowledgeはCore Resolutionから取得する。

---

## 17. Claude固有・Codex固有機能

すべてを共通化する必要はない。

情報ごとにcompatibilityを管理する。

例:

```text
portable
claude-only
codex-only
adaptable
unsupported
```

UI上でも確認可能とする。

---

## 18. Hook管理

Hookについても将来的にはAACL Core側で管理可能とする。

ただし、HookはClaude / Codex固有実装への依存度が高いため、Skill/Ruleとは分離する。

概念上は、

```text
Event
    ↓
AACL Hook Definition
    ↓
Platform Adapter
    ├── Claude hook
    └── Codex equivalent
```

とする。

同等機能が存在しない場合は無理に変換しない。

---

## 19. Workflow管理

開発工程自体も明示的なworkflowとして管理する。

初期workflow:

```text
Task
 ↓
Orchestration
 ↓
Specification
 ↓
Cross-model Specification Review
 ↓
Implementation
 ↓
Pull Request
 ↓
Code Review
 ↓
Complete
```

必要に応じて、

```text
Specification
     ↑
     │ reject
     │
Specification Review
```

のような差し戻しを扱う。

---

## 20. Workflow State

Workflow Modeでは、現在どの工程にいるかを保持できるようにする。

例:

```text
task:
  id: xxx

state:
  workflow: implementation

roles:
  orchestrator: opus
  specifier: luna
  specification-reviewer: codex
  implementer: luna
  code-reviewer: sol
```

これによりAI側が毎回開発状態を推測する必要を減らす。

Standalone Modeでは、Workflow Stateを必須としない。

---

## 21. Context Handoff

AI間でタスクを渡す際、単純な文章だけを渡さない。

最低限、

```text
Task
Role
Execution Mode
Workflow State
Task Type
Relevant Artifacts
Required Rules
Required Skills
Constraints
Expected Output
Completion Criteria
```

をAACL Coreが解決する。

---

## 22. Cross-model Review

設計成果物レビューでは、作成側と異なるAI系統を優先する。

AACL Coreは、

- 作成provider / runtime
- 作成model
- review対象
- 推奨reviewer

を認識できるものとする。

同系統レビューになった場合は警告できることが望ましい。

---

## 23. Rule / Skill Validation

管理知識の品質を維持するため、以下を検出する。

### Duplicate

同一またはほぼ同じrule。

### Conflict

互いに矛盾するrule。

### Shadowing

上位ruleが下位ruleによって意図せず上書きされる状態。

### Missing Dependency

必要Skill / Ruleが存在しない状態。

### Unreachable

どのrole / workflow / task-type / skillからも参照されないSkill / Rule。

---

## 24. Context Preview

AIへ渡される前に、最終的なcontextを確認できる機能を持つ。

例:

```text
Context Preview

Runtime / Model:
Codex / Luna

Role:
Implementer

Task Type:
feature-development

Loaded:
✓ Core workflow
✓ Implementation rules
✓ Testing rules
✓ Project architecture
✓ Specification #123

Excluded:
- Review rules
- Refactoring review skill
- Orchestrator policy
```

---

## 25. VS Code UI

最低限以下を確認できるUIを提供する。

```text
AI Context

├── Skills
├── Rules
├── Roles
├── Task Types
├── Workflows
├── Providers / Runtimes / Models
├── Projects
└── Diagnostics
```

Skill / Rule選択時には、

- 本文
- 適用対象
- dependency
- conflict
- Claude compatibility
- Codex compatibility

を確認できるものとする。

---

## 26. Generated Artifacts / Runtime Bootstrap

Claude Code / Codex等がネイティブ設定ファイルを必要とする場合、それらをCoreから生成可能とする。

ただし、

**生成物を編集元としない。**

必ず、

```text
Canonical Assets / Bootstrap Contract
            ↓
Runtime Adapter
            ↓
Generated Artifact
```

の一方向とする。

Runtimeの常時自動読込領域へ生成するものは、原則としてAACLとの接続・初期化契約だけを持つ極小Bootstrapとする。
Project Skill / Rule等の本文を常時生成物へdumpしない。

生成済みファイルを直接変更した場合は、

- 上書き警告
- drift検出
- unmanaged native contextとしての警告

の対象とする。

---

## 27. Import / Native Context Migration

初回導入時、既存Claude / Codex資産をCoreへ取り込めるようにする。

ユーザー領域では少なくとも以下の既存Runtime設定を検出対象とする。

```text
%USERPROFILE%/.claude
%USERPROFILE%/.codex
$HOME/.claude
$HOME/.codex
```

Project領域でも、Runtimeが認識する既存instruction / skill / rule / hook等をimport候補として検出できるようにする。

Import後はAACL側を正本とする。

### Native configuration retirement

既存のuser-level `.claude` / `.codex` 等については、import後に退避・renameする選択肢を提供する。
これは明示的なユーザー操作とし、自動破壊的変更は行わない。

概念例:

```text
.claude → .claude.pre-aacl
.codex  → .codex.pre-aacl
```

退避後、必要に応じてAACL管理のRuntime Bootstrapを新規materializeする。

既存native contextを退避せず併用することも許可できるが、その場合はCore外ContextがRuntimeへ自動注入される可能性があるため、

- Resolved Contextとの一致
- Execution SnapshotによるContext再構築
- conflict / overrideの完全な説明可能性

を保証しない **compatibility / unmanaged mode** として扱う。

既存ファイルとの双方向同期を永続的な前提にはしない。

---

## 28. MCPとの責務分離

Claude / CodexはProvider / Agent Runtime側の概念であり、MCPそのものの例として扱わない。Capability → MCP/Tool Provider と Provider → Account → Model は別軸として管理する。

MCPとAACL Coreは別責務とする。

### MCP

AIが何を実行できるか。

```text
GitHub
filesystem
database
browser / external tools
```

### Agent Asset Control Layer Core

AIがどう振る舞うべきか。

```text
rules
skills
workflow
role
task type
context
policy
```

---

## 29. Workflow / Orchestrator / Coreの責務分離

Workflow、Orchestrator、Core、Agent Runtimeの責務を分離する。

```text
Workflow Definition:
どのStage / Role / Transitionが存在し、何が許可されるか

Core / Control Plane:
Workflow Definition / Current State / Transition Constraintsを保持
eligible / unavailable / recommended model、required capability、
resolved context、possible transitions、policy violationを返す

Orchestrator Role:
誰に何を任せるか
どのtransitionを選ぶか
accept / reject / retry / fallback / 差し戻しを決定する

User:
必要に応じてRouting / Transition Decisionを直接所有できる

Agent Runtime / Execution Plane:
model invocation / tool invocation / subagent spawnを実行する
```

**Workflowは可能な進行を定義し、Orchestratorは今回の進行を決定する。**

Routing PolicyはCore Assetとして保持できるが、Routing DecisionそのものはOrchestrator / Userが所有する。

OrchestratorはSkillではなくRoleであり、Workflowが必要な場合に `entry-role` 等で指定する。

Standalone Taskでは原則としてOrchestratorを経由しない。

---


## 30. Global Assets / Project Assets / Project Overlay

AI資産の論理的なSource of TruthはCoreが所有するが、**物理配置はscopeに応じて分離できる**ものとする。
CoreがSource of Truthであることを「すべてのAsset fileをCore directoryへ置くこと」と同一視しない。

### Global / Personal Assets

Global / Personal AssetはCore-managed Asset Storeへ配置する。

```text
AACL Core Store
├─ global/
│  ├─ skills/
│  ├─ rules/
│  ├─ roles/
│  ├─ workflows/
│  └─ ...
└─ runtime-data/
```

### Project Assets

Project固有Assetは原則としてProject root配下の `.aacl` を正本とする。

```text
project/
├─ src/
├─ ...
└─ .aacl/
   ├─ project.*
   ├─ knowledge/
   ├─ rules/
   ├─ skills/
   ├─ hooks/
   └─ overlay/
```

Project-local AssetをProject repositoryと同じrevision / branchで管理できることを重視する。

Project固有のledger、trap、domain concept等はRuleやSkillへ無理に押し込まず **Project Knowledge** として保持できる。

### Project Assetのscope

物理的に `.aacl` 配下にあるAssetも、Project scopeだけに限定されない。
Role / Model / Workflow / Task Type / Directory等の複合scopeを持てる。

例:

```text
Project Rule
scope:
  role = reviewer
  model = Sol
```

Project identityはAssetの配置場所から取得し、今回のrole / model / task等はChat Session / Agent Execution metadataから取得する。
Resolverが両者を実行時に結合する。

### Project Overlay

ProjectはGlobal Assetを複製せず、Overlayとして以下を指定できる。

- add
- override
- disable
- bind

Resolved Contextは原則として以下から合成する。

```text
Resolved Context
=
Global / Personal Assets
+ Project Assets / Project Overlay
+ Workflow / Task Type
+ Role
+ Provider / Runtime / Model
+ Directory / Runtime Context
```

### Project trust boundary

`.aacl` はrepository revisionとともに変更されうるため、Project-local instructionをtrust boundaryとして扱う。

- checkout / branch切替によりProject Assetが変化しうる
- newly cloned / externally modified `.aacl` を必要に応じて警告できる
- Project AssetからGlobal mandatory / safety policyを既定で弱められない
- MCP / Tool permission等の権限緩和は通常のProject Rule変更より強い制約を適用できる

---

## 30.1 Project Identity / Initialization

AACL Projectの認識とChat Sessionの開始を分離する。

### Project marker

AACL Projectは `.aacl/project.*` 等のProject Markerで認識する。
PathそのものをProject IDには使用しない。

Project Markerには少なくとも安定した `project-id` を保持する。

```text
workspace path
    ↓
.aacl/project.*
    ↓
project-id
    ↓
Core Project Registry
```

これによりclone先、Windows / WSL path、worktree等が変わっても論理Project identityを維持できる構造とする。

Git repository rootとAACL Project rootは通常一致してよいが、同一概念として固定しない。
monorepo等で複数AACL Projectを持てる余地を残す。

### Explicit Project Init

Project登録は初回Chatの副作用として自動実行しない。
Project rootでのCLIまたはExtension UIから明示的に初期化する。

標準概念:

```text
aacl init
```

Project Initでは少なくとも以下を行う。

1. Project root確定
2. 既存 `.aacl` 検出
3. stable project-id発行または読込
4. `.aacl` 初期構造作成
5. Core Project Registryへ登録
6. 既存Project-local Claude / Codex asset検出
7. import候補提示
8. 初期Project Overlay作成

CLI、VS Code Extension、将来のUIは別々にdomain logicを持たず、同一のCore Project Init API / service operationを利用する。

### Uninitialized Workspace

`.aacl` のないworkspaceでもAACL Chatを利用可能とする。

```text
Uninitialized Workspace
→ Global / Personal Contextのみ
→ Project-specific Contextなし
```

Project固有Assetを利用・作成したい時点で明示的にProject Initializeする。

---

## 31. MCP / Capability / Project Integration

MCPは具体的なTool Providerとして管理し、Skillとの間にCapabilityレイヤーを設ける。

```text
Skill
  ↓ requires
Capability
  ↓ provided by
MCP
```

これにより、同じCapabilityをProjectごとに異なるMCPで満たせる。

Projectは利用可能なMCPおよびCapability bindingを持つ。

MCP依存には少なくとも以下の強度を持てる。

- required
- optional
- preferred
- fallback

Skill起動時、Resolverは対象Projectで必要Capabilityを満たせるかを判定する。

満たせない場合は、

- unavailable
- degraded
- fallback available

等の状態を返す。

Capabilityは単純なboolに固定せず、必要に応じてsub-capability / feature setを表現できる構造とする。

---

## 32. MCP / Tool Trust・権限管理

「接続されている」と「使用を許可されている」を分離する。

MCP / Toolには少なくとも以下を区別できるようにする。

- available
- allowed
- preferred
- required

Project OverlayやRole / Task Typeによって利用可否を制御できる。

ResolverはCapabilityを満たすMCPが存在しても、権限上利用できない場合は実行可能と判定しない。

---

## 33. Scope Priority / Conflict Resolution

Scope Priority / Conflict Resolutionの正規仕様は **§13 Context Resolution / Resolution Semantics** のprecedence tableとdecision pipelineを使用する。

追加原則:

- Scopeは可能な限り直交する軸として扱い、単純な「ModelはRoleより常に強い」といった意味的上書きを前提にしない
- 複合scopeは単独scopeよりspecific
- explicit priorityは意図的overrideとしてspecificityより優先
- mandatory policyは通常のpriority競争へ参加させない
- additive / exclusive等、Asset Typeごとにmerge semanticsを定義する
- 最終tieで意味が変わる場合はfailし、暗黙決定しない

Resolverは決定理由と、どの規則が勝敗を決めたかを返す。

---

## 34. Resolution Explainability

Context Resolverは最終結果だけでなく、各Assetが適用・除外された理由を返す。

例:

```text
Rule X
  included:
    project = A
    role = implementer

Skill Y
  excluded:
    task-type mismatch

MCP F
  unavailable:
    disabled by Project Overlay
```

Context PreviewおよびDiagnosticsから確認できるようにする。

---

## 35. Execution Snapshot

各AI実行について、その時点で実際に解決されたContextをSnapshotとして保存する。

最低限、

- project
- task
- execution mode
- workflow / stage
- task type
- role
- provider / runtime / model
- loaded skills
- loaded rules
- loaded project knowledge
- available / selected MCP
- applied overrides
- excluded context
- relevant artifacts
- asset revisions

を保持する。

後から現在のAsset定義ではなく、**その実行時に何が渡されていたか**を再現できることを要件とする。

Journal / Journal Review / DiagnosticsはこのSnapshotを参照できる。

---

## 36. Asset Versioning / History / Rollback

Skill、Rule、Hook、Workflow等はAsset単位で履歴を確認・比較・復元できる。

UI上では最低限、

- Asset単位の履歴
- 任意revision間のdiff
- 任意revisionへのrestore
- 変更理由
- 関連Journal Review
- 関連change set

を確認できる。

複数Assetを1回の改善で変更した場合は **Change Set** として束ねる。

Rollbackは以下の2種類を持つ。

- Asset rollback: 1 Skill / 1 Rule等だけを戻す
- Change-set rollback: 1回のJournal Review等で変更した一式を戻す

### 保存方式

コアのドメインモデルをGitに固定しない。

```text
Core
└─ History API
   ├─ history(asset)
   ├─ diff(asset, revision)
   ├─ restore(asset, revision)
   └─ restore(changeSet)
```

初期History BackendはGitを利用してよい。

推奨初期構成:

```text
Global / Personal Assets
  Filesystem = Core Asset Store
  Git        = Core Asset Store revision backend

Project Assets
  Filesystem = <project>/.aacl
  Git        = Project repository revision backend

Runtime Data
  DB / Filesystem = Session / Snapshot / Index store
```

Core API上では保存場所にかかわらず、

```text
history(asset)
diff(asset, revision)
restore(asset, revision)
```

の統一意味論を提供する。

Project-local AssetはProject repositoryのbranch / commitと同じrevision historyへ含めることを基本とする。
Global AssetとProject Assetで物理History Backendが異なっても、Core UI / APIからはAsset単位で統合して扱う。

将来別Backendへ交換可能な境界を維持する。

---

## 37. Asset Graph / Core UI

Core UIではAI資産そのものと関係性を確認できることを重視する。

管理対象:

```text
Assets
├─ Skills
├─ Rules
├─ Hooks
├─ Roles
├─ Workflows
├─ Task Types
├─ MCP / Capabilities
├─ Project Knowledge
└─ Journals
```

関係例:

```text
Role → Skill
Role → Rule
Workflow → Role
Skill → Rule
Skill → Capability
Capability → MCP
Project → Overlay
Hook → Event
Journal → Asset
Journal Review → Change Set
```

最低限、Role中心ビューとAsset中心ビューを提供する。

### Role中心ビュー

そのRoleへ何が適用されるかを確認する。

### Asset中心ビュー

そのAssetが、

- どのRoleで使われるか
- どのWorkflow / Projectで使われるか
- 何に依存するか
- Journalから何回参照されたか

を確認する。

高度なgraph visualizationは初期MVP必須とはしない。

---

## 38. Journal

JournalをCoreの正式機能とする。

目的は、設計・実装・レビュー等の実行直後に、**AI資産や道具の使われ方に関する一次観測**を残すこと。

Journalは長い事後分析ではなくmemo-levelを維持する。

Core化後は「事実」と「実行者の観測」を分離する。

### Coreが自動記録する事実

Execution Snapshotから取得する。

- project
- task
- role
- task type
- workflow stage
- provider / runtime / model
- loaded skill / rule
- MCP / Tool
- applied override
- asset revision

### 実行者が残す観測

主に以下。

- unexpected value: 今回初めて / 意外に効いたもの
- friction: 困った・詰まった・遠回り
- missing support: 足りなかったrule / skill / context / tool
- improvement seed: 改善案の種
- possible cause: 原因仮説（任意）
- confidence: 原因仮説の確信度（任意）

既に定番化している成功パターンを毎回書かせない。

Journal時点でSkill / Rule変更を確定させず、局所事例への過適合を避ける。

---

## 39. Journal Review / Improvement Proposal

Journal ReviewをStandalone SkillとしてCoreに正式実装する。

```text
Skill: journal-review
execution-mode: standalone
role: knowledge-reviewer
input:
  accumulated journals
  execution snapshots
  diagnostics
output:
  improvement proposals
```

Journal Reviewは、

- 繰り返す摩擦
- 繰り返し効いた新規パターン
- 新規Rule / Skill候補
- 既存Asset強化候補
- 削除 / 降格 / Hook移行候補
- Project固有化 / Global化候補

を検討する。

既存Ruleが本来効くべきだった問題について、安易に新規Ruleを増やさず既存Ruleの強化を優先する。

決定論的に検証可能な事項は、prompt RuleではなくHook等の機械チェックへの移行候補とする。

### 適用フロー

```text
Journals
  +
Execution Snapshots
  +
Diagnostics
      ↓
Journal Review
      ↓
Improvement Proposals
      ↓
Human Approval
      ↓
Change Set
      ↓
Asset Update
```

Journal Reviewから直接Assetを無承認で書き換えない。

---

## 40. Asset Bloat / Staleness Diagnostics

肥大化防止をJournal Reviewだけに任せず、Core Diagnosticsが客観データを提供する。

診断候補:

- unreachable asset
- duplicate / near-duplicate
- conflict
- shadowing
- missing dependency
- 長期間参照されていないAsset
- 常時ロードされるが利用根拠の薄いRule
- Journalで一度も「効いた / 破られた」形跡のないRule
- 同じ問題に対して重複追加されたRule
- RuleからSkill / Hookへ降格・移行可能な候補
- Project固有にすべきGlobal Asset
- Global化できるProject Asset

Diagnosticsは削除を自動適用せず、Journal Reviewへ根拠として渡す。

例:

```text
Rule X

loaded executions: 143
journal positive refs: 0
journal violation refs: 0
explicit dependencies: 0

→ pruning candidate
```

判断の質は完全自動化せず、人間がJournal Reviewを発火・承認する改善ループを維持する。

---


## Context Cost Metrics

AACL Coreは、Resolved Contextのコストを定量評価できるようにする。

目的は単なる請求トークン数の把握ではなく、**どのAI資産・コンテキスト層がどれだけContext Budgetを消費しているかを可視化し、Context Resolutionの品質改善に使うこと**とする。

### 基本方針

- token計測はLLMに実行させない
- Core側でローカルに機械計測する
- 計測のための追加LLM呼び出しを発生させない
- 計測結果を通常プロンプトへ常時注入しない
- Execution Snapshotへメタデータとして保存する
- モデルごとにtokenizer差異があるため、必要に応じてmodel別estimated tokenとして扱う

### 最低限記録する指標

```text
Context Cost
├─ Core
├─ Project
├─ Role
├─ Workflow
├─ Task Type
├─ Skills
├─ Rules
├─ Project Knowledge
├─ Artifacts
└─ Total
```

追加で以下を記録できることが望ましい。

- 除外されたContext量
- override前後の差分
- 前回同種タスクとの差分
- Standalone / Workflow別平均
- role別平均
- project別平均
- skill / rule単位のContext Cost
- 実行中に追加取得されたContext量

### Diagnosticsとの連携

Context Cost MetricsはAsset肥大化診断の入力として利用する。

例:

```text
Skill X
context cost: high
usage frequency: low
journal value refs: 0

→ 分割 / on-demand化 / 削減候補
```

```text
Rule Y
always-loaded cost: moderate
violation refs: high

→ retain
```

### 品質指標との組み合わせ

Context Cost削減だけを成功条件としない。

以下のような品質指標と併せて評価する。

- review defect
- rework
- specification clarification
- missing-context journal
- 差し戻し
- 実装後に不足が判明したRule / Skill

目標は単純な最小Contextではなく、

**必要十分なContextを、再現性高く、できるだけ低コストで提供すること**

とする。

概念的には以下を継続評価する。

```text
Context Cost ↓
Defects       ↓
Rework        ↓
Missing Info  ↓
```

Context Costが下がっても品質指標が悪化した場合は、Contextを削りすぎた可能性としてDiagnostics / Journal Reviewの対象にする。

---

## 41. Learning Loop

Core全体として以下の閉ループを形成する。

```text
Knowledge / Assets
      ↓
Context Resolution
      ↓
Execution
      ↓
Execution Snapshot
      ↓
Journal
      ↓
Diagnostics
      ↓
Journal Review
      ↓
Improvement Proposal
      ↓
Human Approval
      ↓
Versioned Asset Update
      └──────────────→ 次回Execution
```

Coreの価値を単なる「設定配布」ではなく、**AI開発プロセスの知識管理・配布・観測・改善**まで含むものとして定義する。

---

## 42. 非目標

初期段階では以下を目的としない。

- ClaudeとCodexを完全に同一動作させる
- モデル固有能力の差を吸収する
- AIモデルそのものを実装する
- MCPサーバーを全面的に置き換える
- GitHub管理機能を再実装する
- 汎用的な公開マーケットプレイスを作る
- 他ユーザー向け設定互換性を優先する
- すべての単独タスクにOrchestratorを強制する

個人利用を前提とする。

---


## Core / Extension Responsibility Split

本システムは **Core Tool** と **VS Code Extension** を明確に分離する。

### Core Tool

CoreはAI開発資産と実行意味論のSource of Truthを持つ。

主な責務:

- Skill / Rule / Hook / Guardrail / Workflow / Role / Model Policy管理
- Project / Team / Personal scope管理
- Project Overlay / override / disable / promotion管理
- MCP / Capability / Provider / Model情報管理
- Provider Account状態と利用可能Modelの管理
- Context Resolution
- Model / Role / Model × Roleに基づくContext Injection内容の解決
- Workflow Definition / Orchestrator Role / Routing Policy / Transition Policyを独立Assetとして管理
- Journal / Journal Review / Diagnostics
- Execution Snapshot / Context Cost Metrics
- Asset History / Change Set / Rollback
- Asset Graph / Impact表示
- Chat Sessionの意味的metadata管理
- Project Registry / project-id管理
- Project Init semantics
- Runtime Bootstrap contractの正本
- Context Deliveryに必要なResolved Initial Contextの生成

Coreは「誰に何をさせるか」を直接実行するAgent Runtimeそのものではなく、**実行に必要なAsset・Policy・Context・Routing情報を解決するControl Plane** とする。
CoreはRuntimeへ自律的にpushすることを必須責務とせず、Runtime / Extension / Adapterからのresolution requestへ応答する。

### VS Code Extension

VS Code拡張はCoreを利用する **Execution Surface / Workbench** とする。

主な責務:

- 複数Chat Sessionの表示・切替
- ChatごとのProvider / Model切替
- `/` コマンドによるCore Skill選択
- workspace / repository / active file / selection等のIDE context取得
- Chat Session開始時のInitial Context Resolution trigger
- CoreからResolved Contextを取得してAgent Runtimeへ渡すHost Inject
- Runtime Bootstrapと同等の初期化契約をChat経由で成立させるbootstrap host
- Project Initialize UI / command surface（domain semanticsはCore）
- Orchestratorがsubagentを起動する際にCore Context Resolutionを利用させるbootstrap / bridge
- Workflow / Execution状態表示
- Context Preview
- Journal入力UI
- Chat Session UI

Extension自身はSkill内容、Routing Policy、Role責務、Model Policyをハードコードしない。

---

## Provider / Account / Model

Provider、Account、Modelを別概念として扱う。

```text
Provider
  ↓
Account / Credential Source
  ↓
Model
```

MVPではClaude / Codexを対象とし、将来Provider Adapter追加によって他Providerへ拡張できる構造とする。

### Authentication

Core UIから接続状態を一元確認できるようにするが、認証情報そのものを独自方式で保持することは避ける。

原則:

- Providerの正規ログインフローを利用
- OS keychain / provider credential store等を利用
- Coreはcredential reference / connection status / available modelsを把握
- Secret値そのものはAsset Storeへ保存しない

---

## Chat / Runtime Context Bootstrap

本ツールのChat Extensionは、Coreを認識しないRuntimeに対する標準Bootstrap Hostとして動作する。

Chat Session開始時、Extensionはworkspace / project / provider / runtime / model等のmetadataをCoreへ渡し、Initial Resolved Contextを取得して対象Runtimeへ配送する。

```text
Chat Extension
  ↓ session / workspace metadata
Core Resolver
  ↓ Initial Resolved Context
Extension / Runtime Adapter
  ↓
Claude / Codex / Local LLM / future runtime
```

Claude Code / Codex等のNative Runtimeが同時にAACL Runtime Bootstrapを自動読込する場合、同一Bootstrap契約が重複することを許容する。
ただしBootstrapは冪等であり、重複によって意味・状態・Asset適用結果が変化してはならない。

---

## Chat Sessions

ChatはExtension側でユーザーが操作し、Core側では意味的なSession metadataを管理する。

最低限保持する情報:

- session id
- project
- provider
- model
- role
- active skill
- workflow / execution mode
- created at / updated at
- title
- linked executions
- relevant snapshots

会話ログそのものはAI AssetではなくRuntime Dataとして扱う。

### User Session / Agent Execution

ユーザーが明示的に開くChatと、Orchestratorが内部で起動するsubagent executionを区別する。

```text
User Session
→ Chat UIで表示

Agent Execution
→ Runtime履歴として保持
→ 必要ならOpen as Chat可能
```

---

## Chat Title Management

Chat Sessionには自動タイトル生成を提供する。

### 初期タイトル

初回メッセージまたは初期タスク内容から自動要約タイトルを生成する。

一般的な「初回要約で一度だけ固定」ではなく、タイトルをSession metadataとして扱う。

### Human Rename

ユーザーは任意のタイミングでChat名を変更できる。

### AI Rename

MVP以降、AI自身がChat名変更を提案・実行できる仕組みを持てるようにする。

想定用途:

- 会話の主題が初期タイトルから大きく変わった
- Issue番号やPR番号が確定した
- 「設計」「実装」「レビュー」等の実態が明確になった
- OrchestratorがSessionの意味をより正確に要約できる状態になった

AIからの改名は通常の本文生成とは分離されたSession操作として扱う。

推奨ポリシー:

- 自動初期命名: allowed
- 人間による改名: always allowed
- AIによる改名: allowed / suggest-only を設定可能
- 人間が明示的に固定したタイトルはAIが勝手に上書きしない
- 改名履歴は必要に応じてSession metadataに保持できる

AIによるChat名変更は、Skill / Role / Workflowの意味を理解しているCore側が候補を生成し、ExtensionがUIへ反映する構造を想定する。

---

## Orchestrator Context Bootstrap

Orchestratorの責務はRole Assetとして、Workflow進行はWorkflow Definitionとして、Routing / Transition条件はPolicy AssetとしてCoreで分離管理する。

Extension側にはOrchestratorのdomain logicを埋め込まず、Host RuntimeへCore解決結果を渡すbridgeのみを提供する。

概念:

```text
Subagent delegation before spawn:

1. target role / model / task / projectを確定
2. CoreへResolved Delegation Contextを要求
3. 返されたSkill / Rule / Model Policy / Project Contextをbriefへ付与
4. subagentを起動
```

可能なHostではHookで未解決の委任を防止し、Hookが利用できないHostではRule / Skillによるbootstrapで実現する。

Core:

```text
何を知らせるべきか
```

Orchestrator:

```text
誰に何をさせるか
```

Extension / Adapter:

```text
CoreとAgent Runtimeを接続する
```

という責務分離を維持する。

---



## Consolidated Responsibility Model

資料全体の責務定義は以下を正とし、他章ではこの定義を参照する。

| Component | Owns | Does not own |
|---|---|---|
| Core / Control Plane | Asset Store, History, Scope/Policy, Context Resolver, Workflow Definition/State, Capability/Provider metadata, Snapshot, Journal/Diagnostics | model/tool executionそのもの |
| Workflow | Stage, Role relation, transition constraints, completion model | 今回どのtransitionを選ぶか |
| Orchestrator Role | assignment, transition, retry/reject/fallback decision | Asset Source of Truth, Runtime implementation |
| Agent Runtime / Execution Plane | model invocation, tool invocation, subagent spawn, enforce可能地点でのguardrail interception | domain policyの正本 |
| Extension / Workbench | Human UI, IDE context acquisition, Project Init surface, Initial Resolution trigger, Host Inject, Preview, Runtime bridge, Session/state visualization | Asset semantics, Routing Policy, Resolver semantics |
| Adapter | Canonical表現とProvider/Runtime固有形式、Runtime Bootstrap、Context Delivery方式の変換 | domain decision |
| User | 明示的なoverride/approval/decision | 自動的なasset semantics |

### Guardrail

- Guardrail Definition / Protected Resource Policy: Core
- Policy evaluation: CoreまたはRuntime境界
- deny / approval / interception: Runtime / Adapter / Host Hook等の操作を捕捉できる地点
- Coreが全tool executionをinterceptする前提にはしない

### Execution Snapshot

Snapshotが保証するのは **その実行時に解決・付与されたContextの再構築** とする。

LLM出力や外部Tool結果、repository stateを完全に再現することまでは保証しない。

### Diagnostics

Diagnosticsはdetect / measure / correlate / flagまでを担当する。

原因解釈・改善仮説・Asset変更ProposalはJournal Review、人間承認はHumanが担当する。

---

## Local-first / Self-hostable Core

Coreは最初から **service-capable** に設計するが、MVPでは個人利用・localhost運用を基本とする。

本システムは、中央SaaSへの接続を必須としない。

### 基本思想

```text
Local-first
+
Self-hostable
+
Location-transparent Core
```

を原則とする。

利用側はCoreが、

- localhost上にある
- Windows側にある
- WSL側にある
- 別PCにある
- Team Server上にある

といった配置差を極力意識しない。

Extension / Runtime Adapter / MCP Clientは、論理的なCore接続先だけを利用し、実際のhost addressやtransportは接続設定側で解決する。

---

### MVP

初期段階では以下を基本とする。

```text
Single User
    ↓
Local Core Service
    ↓
localhost
    ↓
VS Code / Claude / Codex
```

目的:

- セットアップを単純化する
- Git pull等による設定同期を不要にする
- Windows / WSL間で同一Asset Storeを即時共有できるようにする
- CoreのSource of Truthを一箇所にする

---

### Windows / WSL

同一PC上のWindowsとWSLが、同じCore Serviceへ接続できる構造を想定する。

```text
             Local Core
             /        \
        Windows       WSL
          │             │
       Claude         Claude
       Codex          Codex
       VS Code        CLI
```

これにより、Windows側とWSL側で個別にSkill / Rule / Hookを同期する必要をなくす。

---

### Remote / Multi-PC

MVP以降、同一Coreをremote/self-hosted serviceとして起動できる構造を維持する。

```text
PC A ─┐
PC B ─┼── Remote Core
PC C ─┘
```

Local modeとRemote modeでCoreのドメインAPIを変えない。

Extension側は同じCore Client Interfaceを利用する。

---

### Team Sharing

将来的なTeam利用では、Shared AssetとPersonal Assetを分離する。

```text
Built-in
   +
Team
   +
Project
   +
Personal
   +
Runtime
```

Team Assetには必要に応じて以下の強度を持たせる。

- mandatory
- recommended
- optional

Personal Assetは自由に育成でき、共有価値があるもののみ明示的にTeamへPromotionする。

```text
Personal
   ↓
Journal / Review
   ↓
Team Candidate
   ↓
Approval
   ↓
Team Shared
```

個人のJournal / Chat / Account情報を自動的にTeamへ共有しない。

---

### Server modeとTeam機能は分離する

Remote Coreが存在することと、Multi-user / Team機能を持つことは別要件とする。

想定段階:

```text
Phase 1
Single-user Local Core

Phase 2
Single-user Remote Core / Multi-PC

Phase 3
Multi-user Team Core
```

Windows / WSL共有や複数PC利用のために、Team/RBAC等を先に実装する必要はない。

---

### Offline / Failure Tolerance

Remote Core利用時でも、Coreへの一時的な接続断によって開発作業全体が停止しない構造を目指す。

将来的に、

- Last Known Good Context
- Asset revision cache
- reconnect / resync
- stale revision表示

等を導入できるようにする。

ただし、MVPではRemote mode自体を必須としない。

---

### MCPとの関係

AI Runtime-facing interfaceとしてMCPを利用できるが、Core全APIをMCPに限定しない。

```text
Agent Runtime
  ↓ MCP
Core

VS Code Extension
  ↓ Local API / IPC / HTTP / WebSocket
Core
```

MCPはAgent RuntimeがContext ResolutionやSkill情報を取得するための接続面とし、UI・Session・Diagnostics等は別APIを利用してよい。

---

## Technology Stack Direction

初期実装は、仕様変更への追従性とVS Code拡張との型・ロジック共有を優先し、**TypeScript中心で開始する**。

### 推奨構成

```text
Core Domain / Service
→ TypeScript / Node.js

Desktop Shell / Core UI
→ Tauri 2
→ Frontend: TypeScript + React / Svelte等

VS Code Extension
→ TypeScript

Persistence
→ Filesystem + Git
→ 必要に応じてSQLite等をIndex / Runtime Storeとして追加

Core Interface
→ Local HTTP / WebSocket / JSON-RPC / MCP等から選定
```

### 基本方針

CoreそのものをTauriアプリに閉じ込めない。

```text
Core
  ↑
Tauri UI

Core
  ↑
VS Code Extension

Core
  ↑
CLI / MCP / future IDE adapters
```

となるように、Core Domain / Serviceを独立させる。

TauriはDesktop UI / Shellの一クライアントとして扱う。

### TypeScript Coreを初期採用する理由

初期段階で最も変更が多いと想定されるのは、

- Asset Model
- Scope Resolution
- Project Overlay
- Role / Model / Model × Role binding
- Workflow
- MCP / Capability model
- Journal / Diagnostics
- Provider / Session model

等のドメイン設計である。

MVPではパフォーマンスよりも仕様変更への追従性を優先し、VS Code Extensionと型・ロジックを共有しやすいTypeScriptを採用する。

### Rustの位置付け

Rustは初期Coreの必須要件としない。

ただし、以下のようなシステム境界・安全性・常駐処理に関する機能は、要件が安定した段階でRustへ移行または分離できる構造とする。

- Guardrail Engine
- Protected Resource enforcement
- process supervision
- file watching
- credential / OS keychain integration
- 高信頼なHook execution
- MCP stdio / subprocess管理
- 性能上のボトルネック

概念:

```text
TypeScript Core
    ↓ stable boundary
Rust system components
```

### Electronについて

Electronも実装候補ではあるが、CoreをDesktop App内部へ密結合しやすいため第一候補とはしない。

本ツールは長期的に、

- VS Code
- CLI
- 他IDE
- MCP
- Desktop UI

から同一Coreを利用できる構造を重視する。

そのため、Desktop ShellはTauriを第一候補とする。

### 想定ディレクトリ境界

```text
packages/
  core/
  core-service/
  core-ui/
  vscode-extension/
  adapters/
    claude/
    codex/
  shared/
```

実際のmono-repo構成は実装時に決定するが、**UI / IDE / Provider AdapterからCore Domainを分離する**ことを不変条件とする。

---

## Explicit Design Decisions

レビューで要決定とされた論点について、現時点では以下を採用する。

### Agent terminology

`Agent` 単体はドメイン用語として使用せず、実行時instanceを指す場合は **Agent Execution** を使用する。

概念を以下に分離する。

```text
Provider
Runtime
Model
Role
Agent Execution
```

Providerは提供元、Runtimeは実行環境、Modelは推論モデル、Roleは振る舞いを表す。Agent Executionは、それらの実行構成とResolved Contextを与えられて実際に動く実行instanceとする。

Agent Executionは静的Asset scopeには使用せず、Execution Snapshot / Session / Journal等のruntime metadataとして扱う。

### Chat UI

VS Code Extensionは独自のAI Workbenchとしてmulti-session / model switching / Skill launcherを持つ方向を採用する。

ただしTool executionやmodel invocationの実装責務はAgent Runtime側とのbridgeとして設計し、Extension独自のdomain policyを持たない。

### Core UI

Core管理UIとVS Code実行UIは責務として分離する。

初期運用MVPではCore Asset管理・Preview・History等に必要な最小Core UIを対象とし、Graph等の高度UIは後回しにできる。

### Skill terminology

外部Runtimeとの互換性を優先し、ユーザー起点の共通形式名としてSkillを維持する。

ただしCore内部では `kind` によりWorkflow Launcher / Standalone Task / Procedure / Advisory / System Meta等を区別する。

Command / Actionを別の外部実行形式として必須化しない。

### Orchestrator

Orchestrator専用Skillは必須Assetとしない。

Orchestrationは以下の組み合わせで成立する。

```text
Workflow Launcher Skill
+ Workflow Definition / State
+ Orchestrator Role
+ Routing Policy
+ Transition Policy
+ Context Resolution
```

---

## 43. 初期運用MVP

最初の公開版は「単なるResolver試作」ではなく、個人が日常利用できる初期運用版を目標とする。ただしTeam/RBAC/Remote Serverは含めない。

### 必須

- 独立Core + VS Code拡張の責務分離
- Skill管理
- Rule管理
- Role管理
- Task Type管理
- Workflow / Standalone の実行モード管理
- Provider / Runtime / Model管理（MVP対象: Claude / Codex）
- role / task-typeベースContext Resolution
- Context Preview
- Claude Runtime向けcontext materialization
- Codex Runtime向けcontext materialization
- Native RuntimeをAPI直接課金なしで利用できるRuntime Bridge
- 極小・冪等なRuntime Bootstrap materialization
- Context Delivery Strategy（runtime-pull / host-inject）
- Chat ExtensionによるInitial Context Resolution / Host Inject
- user-level `.claude` / `.codex` の既存資産検出・import・任意退避
- unmanaged native context併用時の非保証表示
- Workflow Launcher SkillからWorkflowを起動
- Standalone Review Skillの起動
- VS Code拡張で複数Chat Sessionを切り替えられる
- ChatごとにClaude / CodexのProvider / Modelを選択できる
- `/` からCore管理Skillを選択・起動できる
- Extensionがworkspace / editor contextをCoreへ渡せる
- Workflow実行中の委任時にCore Context Resolutionを利用できる
- Global / Project Asset管理
- Global AssetのCore-managed store
- Project Assetの `<project-root>/.aacl` 管理
- stable project-id / Project Registry
- `aacl init` 相当の明示Project Initialization
- 未初期化workspaceでGlobal-only実行
- Project AssetへのRole / Model / Task Type等の複合scope
- Project Overlay（add / override / disable / bind）
- MCP / Capability binding
- Scope priority / conflict resolutionの基本実装
- Resolution reason表示
- Execution Snapshot保存
- Asset単位のhistory / diff / rollback
- Journal保存
- Journal ReviewからImprovement Proposal生成
- Asset Graphの基本一覧（Role中心 / Asset中心）
- 基本Diagnostics（unreachable / duplicate / dependency / pruning candidate）
- Context Cost Metrics（ローカル計測、Execution Snapshot保存、Asset別内訳）

### 後回し

- Hook統合
- 自動矛盾検出
- Semantic duplicate検出
- Workflow GUI editor
- 複雑な状態管理
- 自動モデル選択
- 高度なコンテキスト最適化
- Model / Model × Role Policyの高度化
- Protected Resources / Guardrails管理
- 外部Secret ManagerとのCredential Awareness連携
- Provider / Account管理UIの高度化
- Claude / Codex以外のProvider Adapter
- ChatタイトルのAIによるrename / suggest-only
- Agent ExecutionのOpen as Chat

---


### MVP内部マイルストーン

同一の「初期運用MVP」内で実装順を分ける。

#### Milestone A — Canonical Assets / Resolver

- Canonical Asset model
- Skill / Rule / Role / Workflow / Task Type
- Scope Resolution / precedence / conflict
- Context Preview
- Claude / Codex materialization
- import / basic Project Overlay
- `.aacl` Project Marker / project-id / Project Init
- Global store + Project-local Asset source

#### Milestone B — Workflow / Runtime Integration

- Workflow Launcher
- Orchestrator Role bridge
- Runtime integration
- Runtime Bootstrap / runtime-pull / host-inject
- Chat Extension initial bootstrap host
- delegation context resolution
- Execution Snapshot
- multi-session / model switchingの基本

#### Milestone C — Learning / Operations

- Asset History / rollback
- Journal / Journal Review
- Diagnostics
- Context Cost Metrics
- Improvement Proposal
- Asset Graph基本表示

各MilestoneはMVPの製品境界を変更するものではなく、実装・検証順を明確にするための区分とする。

---

## 44. MVPの主要Role

```text
orchestrator
specifier
specification-reviewer
implementer
reviewer
code-reviewer
```

---

## 45. MVPの主要Skill

### Workflow Launcher

```text
issue-development
```

### Standalone Review系

```text
refactoring-review
architecture-review
security-review
test-review
```

レビュー観点そのものは各Skillに保持し、reviewer roleは共通化する。

---

## 46. MVPの主要Workflow

```text
Skill: issue-development
      ↓ launches
Workflow: issue-development
      ↓ entry-role
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

Standalone ReviewはこのWorkflowに所属しなくてもよい。

---

## 47. MVP完了条件

以下を満たした状態をMVP完成とする。

1. ExtensionからCore上のSkill / Ruleを登録・編集できる
2. Skill / Ruleにroleを設定できる
3. Skillにexecution modeとtask typeを設定できる
4. Claude / Codex固有設定を区別できる
5. role / task typeを指定すると必要Contextを解決できる
6. 解決結果をPreviewできる
7. Claudeへ利用可能な形式で提供できる
8. Codexへ利用可能な形式で提供できる
9. 同じRuleをClaude/Codexへ重複記述する必要がない
10. ImplementerにReviewer専用Contextが不要に渡らない
11. ReviewerにImplementation専用Contextが不要に渡らない
12. 既存Claude / Codex user-level・project-level資産を初期データとしてimportできる
13. import後はCore / managed Project Assetを正本として管理でき、既存native contextを任意退避できる
14. `issue-development` 等のWorkflow Launcher SkillからWorkflowを開始できる
15. `refactoring-review` 等からOrchestratorを介さずStandalone Reviewを開始できる
16. Standalone Review時にレビュー種別に応じたskill/ruleだけをロードできる
17. Project OverlayによりGlobal Assetを追加・上書き・無効化できる
18. Projectごとに利用MCPとCapability bindingを変更できる
19. ResolverがAssetの適用・除外理由を説明できる
20. 実行時ContextをSnapshotとして再現できる
21. Skill / Rule等をAsset単位で履歴確認・diff・rollbackできる
22. JournalがExecution Snapshotと紐づく
23. Journal Reviewが改善案をProposalとして提示し、人間承認前にAssetを変更しない
24. Roleから紐づくSkill / Rule / Hook等をCore UIで確認できる
25. Diagnosticsが肥大化・未使用・依存問題の候補をJournal Reviewへ提供できる
26. Resolved Contextのtoken概算とAsset別Context Costを追加LLM呼び出しなしで計測できる
27. Context Costと品質指標を組み合わせ、削りすぎの可能性を診断候補として提示できる
28. Native Runtime向けRuntime Bootstrapが極小かつ冪等であり、Chat経由との重複で意味が変わらない
29. Context Deliveryをruntime-pull / host-injectからRuntime特性に応じて選択できる
30. Coreを自律的に認識しないRuntimeでもChat Extension経由でInitial Resolved Contextを受け取れる
31. `aacl init` または同等UIでProjectを明示初期化し、`.aacl` markerとstable project-idを生成できる
32. `.aacl` のないworkspaceではGlobal / Personal Contextのみで動作できる
33. Project-local Skill / Rule等にRole / Model / Task Type / Workflow / Directory等の複合scopeを設定できる
34. Global AssetとProject-local Assetを単一Resolverで結合し、各Assetの由来と適用理由を説明できる
35. unmanaged native contextを併用した場合、Context再現性を保証しないことをUI / Snapshot上で識別できる

---

## 48. 最終的に目指す状態

現在:

```text
Claude
  ↓
大量のskill / rule / workflow知識
  ↓
Claudeが必要情報を判断
  ↓
Codexへ手動・半自動handoff
```

目標:

```text
       Agent Asset Control Layer Core
                   │
          Knowledge Source of Truth
                   │
        Context Resolution Engine
                   │
      ┌────────────┴────────────┐
      │                         │
   Claude                     Codex
      │                         │
Orchestrator              Specifier
Specifier                 Implementer
Reviewer                   Reviewer
```

各AIは、全知識を持つのではなく、

**現在の仕事を遂行するために必要な知識だけを受け取る。**

また、タスクの性質によって以下を使い分ける。

```text
新規Issue / 課題
    ↓
Workflow Launcher Skill
    ↓
Workflow
    ↓
Orchestrator Role
    ↓
複数工程

単独レビュー
    ↓
Standalone Review Skill
    ↓
Reviewer
    ↓
単一結果
```

これにより、

- Claudeの基本コンテキスト削減
- Codexへのhandoff品質の安定
- Skill / Ruleの重複管理削減
- AIごとの責務明確化
- 開発フローの明文化
- Standalone Taskの軽量実行
- コンテキストの可視化
- 将来のモデル変更への耐性向上

を実現する。
