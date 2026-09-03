# Agent Asset Control Layer — 開発要件 v12

## 1. 概要

**Agent Asset Control Layer（AACL）** は、Claude Code と Codex を含むAI開発Runtimeで利用するskill、rule、hook、workflow、role、guardrail、project knowledge、routing policy、capability等のAI開発資産を管理し、**ユーザーが繰り返し行う開発行為をWorkflowとして再利用可能にする local-firstなControl Plane** である。

AACLのユーザー体験上の中心はWorkflowとする。ユーザーは詳細な開発手順や長いpromptを毎回記述する代わりに、`/issue-development #123` のように **Workflow + 追加指示** を指定する。Workflowは複数Role、Stage、Role間の接続、遷移制約、必要Asset、完了条件を定義し、Orchestrator Roleがその定義の範囲で今回の進行を判断する。

AACL CoreはAI開発資産、Workflow Definition / State、適用意味論のSource of Truthを持つ。ただし、Workflow / Role / Model選択、Assetの初期作成、Role / Model / Workflowへの紐付け等の**開発方針そのものはユーザー所有**を基本とする。Coreはそれらを保存・検証・適用するが、ユーザーの開発思想をコード上の推測規則へ置き換えない。Context Resolverは重要なCore機能だが、ユーザー意図から任意の開発工程を推測・生成する中心エンジンとはしない。**選択されたWorkflow / Stage / Role / Project / Runtime / Model等に対して、明示されたAsset relation・scope・policyを決定論的に解決する内部機構** とする。

Workflowが明示されていない通常会話では、AACLは実コード変更を伴う設計・実装・PR等のDevelopment Executionへ自動移行しない。質問、検討、調査、考え方の整理、Issue作成、事前検討資料等のboundedな汎用Skillを利用する **Advisory / Preparation Mode** として扱う。

Claude Code の `.claude` や Codex 側の設定を直接正本として管理するのではなく、AACL Coreで管理したCanonical Assetから、それぞれに必要な設定・skill・rule・context等をRuntime-specific representationとしてmaterializeまたは提供する。

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
- 開発のたびに同じ工程・考え方・指示をpromptとして再記述する必要がある
- AIが会話から開発工程を都度推測すると、実行ごとの構造が揺れ、改善対象を特定しにくい

という問題がある。

---

## 3. 目的

AACLの主目的は、ClaudeとCodexの設定を同期することでも、万能なContext Resolverがユーザー意図から開発方法を推測することでもない。

**ユーザーが繰り返し行うAI開発作業をWorkflowとして定義し、そのWorkflowを支えるRole / Skill / Rule / Knowledge / Policy等をCanonical Assetとして管理し、短い指示から一貫した開発工程を再利用できるようにすること**を目的とする。

Workflowはユーザーの開発思想を実行可能な形にした主要単位であり、AACLはWorkflowの実行、必要Assetの解決、実行観測、Journal、Diagnostics、改善ループを一つのControl Planeとして接続する。

目指すユーザー操作は以下。

```text
/issue-development #123

/refactoring target=src/foo

/architecture-change 認証方式を見直したい
```

ユーザーは「何をしたいか」と「どのWorkflowを使うか」を明示し、Workflow内に既に定義された工程・Role・Policyを毎回promptへ書き直さない。

概念上の中心は以下とする。

```text
User
  ↓
Workflow Selection + Additional Instruction
  ↓
Workflow Definition / State
  ↓
Stage / Role
  ↓
Asset Resolution
  ↓
Agent Runtime
  ↓
Execution Snapshot / Journal
  ↓
Workflow-centered Improvement
```

Workflowを選択しない通常会話では、実開発の自動開始を行わない。

```text
No Workflow
   ↓
Advisory / Preparation Mode
   ↓
Question / Discussion / Research / Issue / Design Note
```

これにより、「相談していただけなのに実装へ進む」「その場でAIが独自の開発工程を組み立て、毎回異なる方法で実行する」といった挙動を避ける。

---

## 設計思想

本システムは、単なるClaude / Codex間の設定同期、Skill配布、Context削減ツールではない。

**ユーザー自身の開発思想をWorkflow / Role / Skill / Rule等として明示化し、それを繰り返し実行・観測・改善できるようにするAI開発基盤** とする。

### 1. Workflowをユーザー体験と改善の中心にする

Workflowは単なる複数Stageの定義ではない。

少なくとも以下の役割を持つ。

```text
Workflow
├─ repeated development action
├─ user intent contract
├─ execution structure
├─ development authorization boundary
└─ learning / measurement unit
```

Workflowは、ユーザーが「この種類の開発をどう進めたいか」を定義した実行可能な開発方法とする。

ユーザーはWorkflowを明示的に選択し、追加promptは今回固有の対象・制約・目的を中心にする。

### 2. ユーザーの開発思想をSource of Intentとする

Workflow / Role / Modelの選択、Skill / Rule等の初期作成、Role / Model / Workflowとの紐付けは、原則としてユーザーが定義する。

AACL CoreはそれらのCanonical Stateと適用意味論を保持するが、ユーザーの開発思想をCoreコード内の推測ロジックへ置き換えない。

```text
User-defined way of working
        ↓
Workflow / Role / Model / Assets
        ↓
AACL applies and observes
```

AACLの価値は「ユーザーの代わりに最適な開発思想を決める」ことではなく、**ユーザーが選択・蓄積・改善してきた開発方法を再現性高く運用できること**に置く。

### 3. Workflow未指定時はDevelopment Executionへ進まない

Workflow未指定の通常会話では、質問、調査、検討、考え方の整理、Issue作成、事前検討資料等を扱う。

この状態を **Advisory / Preparation Mode** とする。

許可される代表例:

```text
question
research
discussion
architecture consideration
issue creation
pre-design note
bounded standalone skill
```

Workflowが明示されていない状態から、会話内容を推測して以下へ自動移行しない。

```text
implementation
repository modification
pull request creation
multi-stage development execution
```

実開発を開始するにはDevelopment-capable Workflowを選択する。

### 4. Resolverは推測エンジンではなく決定論的解決器とする

Context ResolverはCoreの重要機能だが、ユーザー意図からWorkflowを発見・合成したり、「今回はどの開発方法を使うべきか」を推測する中心AIではない。

Resolverへの主要入力は、既に明示・確定された状態とする。

```text
Workflow
Stage
Role
Project
Task Type
Provider
Runtime
Model
Directory
```

Resolverは、これらに対してユーザーまたは承認済みAssetが定義したscope / relation / dependency / policyを機械的かつ決定論的に適用する。

```text
Selected Workflow / Stage / Role
          ↓
Explicit Asset Relations / Scopes
          ↓
Context Resolver
          ↓
Resolved Context + Policy
```

「意味的にこのRuleはLuna向けだろう」「このWorkflowにも適用した方がよい」といった判断をResolverコードへ組み込まない。

### 5. 必要十分なContextを配る

すべてのAIにすべての知識を常時持たせない。選択されたWorkflow、Stage、Role、Project、Model等から、その実行に必要なContextだけを解決する。

目標は最小Contextではなく、**必要十分なContextを、再現性高く、できるだけ低コストで提供すること** とする。

### 6. Assetは共通管理単位であり、共通意味論ではない

Skill、Rule、Workflow、Role、Guardrail、Template、Project Knowledge、Routing Policy、Capability等を共通して **Asset** と呼ぶ。これは識別、scope、versioning、relation、history、resolution対象として統一管理するための抽象であり、すべてを同一の意味論で扱うことを意味しない。

各Asset Typeは必要に応じて独自のvalidation、applicability、merge、conflict、execution / materialization semanticsを持つ。Resolverは共通pipelineで候補を評価するが、最終的な合成規則はAsset Typeごとの契約に従う。

### 7. AI資産を適切なレイヤーへ配置する

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

### 8. 強制できる安全策はPromptに依存しない

AIが守るべき重要事項のうち、機械的に判定できるものは、RuleだけでなくHook / Guardrailによる強制を優先する。

### 9. RoleとModelを別軸で扱う

Roleは「その実行で何者として振る舞うか」、Modelは「どのモデルが実行するか」を表す。

Role / Modelの利用方針やbindingはユーザー定義を基本とする。

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

### 10. Workflowを安定した観測単位にする

改善可能なシステムには、比較可能な実行の「型」が必要である。

同一Workflowとそのrevisionを繰り返し実行することで、以下をStage / Role単位で観測可能にする。

```text
return rate
retry rate
review defect
missing context
journal friction
context cost
```

毎回AIが自由に工程を生成することを標準動作にすると、実行構造が揺れ、何を改善すべきか特定しにくくなる。

そのため、Development Executionの主要観測軸をWorkflowとする。

### 11. Journal Reviewの意味的判断とResolverの機械判断を分離する

Journal ReviewはAIを利用し、Journal / Execution Snapshot / Diagnosticsを意味的に解釈する。

例えば、複数のJournalが `role=implementer, model=Luna` で発生していても、提案Assetのscopeが同じであるとは限らない。

```text
Observed in:
  role = implementer
  model = Luna

Journal Review judgment:
  problem appears role-wide

Proposed scope:
  role = implementer
```

または、Model固有と判断した場合は、

```text
Proposed scope:
  role = implementer
  model = Luna
```

と提案できる。

この意味的判断はJournal Review AIの責務であり、Resolverコードに推測規則として実装しない。

Proposalには、観測されたscopeと提案scope / relationを分離して記録し、判断理由を提示する。

### 12. 改善はユーザー起点・人間承認とする

Journal Review自体をユーザーが発火する。

```text
User-defined Assets
      ↓
Workflow Execution
      ↓
Execution Snapshot
      ↓
Journal
      ↓
User-triggered Journal Review
      ↓
AI Improvement Proposal
      ↓
Human Approval
      ↓
Asset Change Set
```

AIは改善候補を提案できるが、重要なAsset変更を無承認で確定しない。

### 13. Assetの現在状態と由来を分離する

Asset本文や現在metadataへ、過去のJournal Review履歴を無制限に埋め込まない。

論理的に以下を分離する。

```text
Asset Content
Current Asset Metadata
Provenance / Change Set
```

Current Metadataは現在のscope / relation / dependency / compatibility等を表す。

Provenanceは、

- なぜ作成・変更されたか
- human editかJournal Review由来か
- どのJournal / Snapshotが根拠か
- どのscopeで問題が観測されたか
- なぜ現在のscope / relationを提案したか
- 誰が提案・承認したか

等のdecision historyを保持する。

### 14. Git revision historyとAACL decision historyを分離する

Gitは主に、

```text
what changed
when it changed
file / revision difference
```

を追跡するRevision History Backendとして利用できる。

一方AACL Provenance / Change Setは、

```text
why it changed
which journals caused the proposal
why a role / model / workflow binding was selected
which proposal was approved
```

を追跡する。

Git commit messageだけを意味的由来のSource of Truthとしない。

両者はChange Set ID、commit reference等で相互参照可能にする。

### 15. 肥大化を改善とみなさない

Journal ReviewでSkill / Rule等を追加できるが、Asset数の増加自体を改善とはみなさない。

新規Asset追加と同時に、既存Asset強化、削除、降格、Hook移行、Project固有化、scope限定等を検討する。

### 16. Context削減と品質を同時に評価する

Context量を減らすことだけを成功条件にしない。

```text
Context Cost ↓
Defects       ↓
Rework        ↓
Missing Info  ↓
```

を同時に目指す。

---

## 4. システム境界

AACLは「AACL Core / Control Plane」と「IDE / Runtime側のExecution Surface」を分離する。

```text
          Agent Asset Control Layer Core
                      │
        ┌─────────────┼─────────────┐
        │             │             │
    Asset Store   Resolver      Workflow/Learning
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
- Workflow Definition / State
- Project Overlay管理
- MCP / Capability管理
- Context Resolution
- 実行時Snapshot
- Asset履歴
- Provenance / Change Set
- Journal / Journal Review
- Diagnostics
- Asset Graph / 関係性可視化

### Coreが意味的に自動決定しないもの

- ユーザーに代わるWorkflow選択
- Workflow未指定会話からのDevelopment Execution開始
- Role / Model利用方針の自動発明
- JournalからAsset scope / relationを機械ルールで推測すること

これらの意味的判断が必要な場合、ユーザー明示設定またはJournal Review等のAI判断 + Proposal + Human Approvalを利用する。

### VS Code拡張の責務

- 現在のworkspace取得
- 開いているファイル・選択範囲等のIDEコンテキスト取得
- Workflow / Skill起動UI
- Context Preview
- 実行状態表示
- 必要に応じたJournal入力
- Coreとの通信

---

## 5. 基本概念

### Workflow

**ユーザーが繰り返したい複数工程の開発行為を定義する主要な実行単位**。

Workflow DefinitionはCore Assetであり、少なくとも以下を表現できる。

- entry role
- stages
- stageごとのrequired role / task type
- Role間の接続
- transition constraints
- retry / reject / return可能な遷移
- completion state
- required artifact / capability
- Development-capableかどうか

Workflowは「次に何が可能か」を定義するが、「今回どの遷移を選ぶか」はOrchestrator / Userが所有する。

### Role

**誰として振る舞うか**を定義する。

OrchestratorもRoleとして扱う。

初期role:

- orchestrator
- specifier
- specification-reviewer
- implementer
- reviewer
- code-reviewer

### Skill

**単一の再利用可能な手順・専門知識・bounded action**を表す。

WorkflowとSkillをCanonical Domain上で別概念として扱う。

Runtimeが `/` の入口をSkill / Commandとしてしか公開できない場合、AdapterがWorkflow Launcher相当のRuntime-specific representationを生成してよいが、それをCanonical Workflowとは別の正本にしない。

Standalone SkillはWorkflowを必要としないが、Development Executionを許可するかどうかはSkillのcapability / policyで明示する。

### Rule

**何を守るか**を定義する。

### Task Type

**何を対象に何をするか**を定義する。

### Advisory / Preparation Mode

Workflow未指定時の標準実行モード。

質問、検討、調査、Issue作成、事前資料作成、bounded Skill等を扱う。

Development-capable Workflowなしにrepository modification等へ進まない。

---

## 6. 現在の開発フロー

### Orchestrator

主担当:

- Opus
- Fable

責務:

- Workflow内でのタスク理解
- 開発工程の管理
- 適切な設計者の選択
- 実装者・レビュー者への委譲
- 工程間の状態管理
- 必要に応じた差し戻し

Orchestratorは **Workflow実行時の意思決定Role** とする。

Orchestratorの利用有無・Role / Model bindingはWorkflow / user configurationで明示する。

### Specifier / Designer

規模感に応じて以下の優先順位で使用する。

1. Luna
2. Sol
3. Opus

責務:

- 要件整理
- 仕様策定
- 設計成果物作成
- 実装可能な状態まで仕様を確定する

### Specification Review

設計成果物は、原則として作成側とは反対側のAI系統へレビューを依頼する。

### Implementer

基本担当:

- Luna

責務:

- 確定した仕様に基づく実装
- 必要なテスト
- 既存ruleへの準拠
- Pull Request作成

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

### Workflow Mode

Development-capable Workflowを明示的に選択して開始する。

例:

```text
/issue-development #123
```

概念:

```text
User
  ↓ selects
Workflow: issue-development
  ↓
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

### Advisory / Preparation Mode

Workflow未指定時の既定モード。

例:

- 質問
- 方針相談
- アーキテクチャ検討
- 技術調査
- Issue作成
- 事前検討資料
- bounded review / analysis Skill

このモードでは実開発Workflowへ暗黙遷移しない。

### Standalone Skill

Workflowを必要としないbounded action。

例:

- refactoring-review
- architecture-review
- security-review
- test-review
- journal
- journal-review

Standalone Skillでrepository mutationを許可する場合は、そのSkill自体に明示的なexecution permissionが必要とする設計を可能にする。

---

## 8. ユーザー起点

ユーザーが `/` 等から開始できる単位はWorkflowとSkillの両方とする。

```text
/issue-development #123
/refactoring-review src/foo
/journal-review
```

Canonical Domain上では、

```text
Workflow ≠ Skill
```

とする。

RuntimeがWorkflowを直接commandとして表現できない場合は、AdapterがRuntime向けlauncher representationを生成する。

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
- Provenance / Change Set

独立コア内に保持する。

ただし、**CoreがSource of Truthであることと、Coreが開発方針のAuthorであることを同一視しない。**

Workflow / Role / Model方針やAsset bindingのAuthorはユーザー、またはユーザーが発火・承認したJournal Review Proposalでありうる。

---

## 10. Context Layer

管理する情報は少なくとも以下のレイヤーに分類する。

### Shared Context

開発全体で共有される知識。

### Workflow Context

選択されたWorkflow / Stageに必要な知識。

### Role Context

役割固有の知識。

### Task Type Context

特定のタスク種別に必要な知識。

### Provider / Runtime / Model Context

Provider、Runtime、Model固有の情報を別軸として扱う。

### Project Context

特定リポジトリ・プロジェクトにのみ適用される情報。

---

## 11. Skill管理

SkillはCoreをSource of Truthとして一元管理する。

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
- execution permission

Skillは常時全内容を読み込ませない。

---

## 12. Rule管理

RuleもCoreをSource of Truthとして管理する。

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

Scope / relationはユーザー定義または承認済みJournal Review Proposalから設定される。

ResolverはRule本文の意味からscopeを推測しない。

---

## 13. Context Resolution

### 責務

Context Resolverは、**選択済みWorkflow / Stage / Role / Project / Runtime / Model等に対して、明示されたAsset relation・scope・policyを解決する**。

以下はResolverの責務ではない。

- 自然言語から最適Workflowを選ぶ
- Workflowがない場合に開発工程をその場で合成する
- Journal内容からAsset bindingを推測する
- ユーザーの開発方針を推定して永続化する

### Resolution Semantics

Scope Resolutionは決定的・説明可能であることを必須とする。

#### Match semantics

- 1 Asset内の異なるscope条件はAND
- 同一scope内の複数候補値はOR / IN
- `Agent Execution` は静的scopeとして使用しない
- 暗黙の「後勝ち」を禁止する

#### Resolution order

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

#### Default scope precedence

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

複合scopeはspecificityで優先される。

#### Mandatory policy

`mandatory` は通常のoverride / disableより強い。

#### Disable and dependency

Required dependencyがdisable / unavailableなら親Assetを成功扱いしない。

#### Final tie

意味が変わる排他的Asset競合を暗黙決定しない。

各Assetについて `included / excluded / overridden / disabled / unavailable / degraded / conflict` の理由を返す。

---

## 14. Bootstrap / Progressive Context Loading

すべてのskill/ruleを常時注入しない。

```text
Runtime built-in context
        ↓
AACL Runtime Bootstrap
        ↓
Selected Workflow / Session Mode
        ↓
Initial Context Resolution
        ↓
Resolved Initial Context
        ↓
Discoverable / On-demand Context
```

### AACL Runtime Bootstrap

RuntimeがCoreとの契約を成立させるための極小Contextとする。

Bootstrapは冪等でなければならない。

### Initial Context Resolution

Session開始時に、Workflowが選択されている場合はWorkflowを主要入力として解決する。

Workflow未指定時はAdvisory / Preparation Modeとして解決する。

### Context Delivery Strategy

少なくとも以下を持つ。

```text
runtime-pull
host-inject
```

---

## 15. Role起動時Context Injection

Workflow StageまたはStandalone SkillによりRoleが確定した後、そのRole向けContextを解決する。

RoleそのものをResolverが自然言語から推測することを標準動作としない。

---

## 16. Runtime / Provider Adapter

Canonical Contextと各Agent Runtime / Provider固有形式を分離する。

Adapterはdomain decisionを持たず、Workflow / SkillのCanonical種別をRuntime都合で変形しても正本を書き換えない。

---

## 17. Claude固有・Codex固有機能

情報ごとにcompatibilityを管理する。

```text
portable
claude-only
codex-only
adaptable
unsupported
```

---

## 18. Hook管理

Hookについても将来的にはAACL Core側で管理可能とする。

---

## 19. Workflow管理

WorkflowをAACLの主要Assetとして管理する。

各Workflowは少なくとも、

- ID
- name
- description
- revision
- development capability
- entry role
- stages
- role connections
- transition constraints
- required assets
- required capabilities
- completion criteria

を持てる。

Workflowの選択はユーザー操作を基本とする。

Coreが自然言語から「最適Workflow」を自動選択することはMVPの必須責務としない。

---

## 20. Workflow State

Workflow Modeでは、現在どの工程にいるかを保持する。

Execution Snapshotには使用したWorkflow IDとrevisionを必ず記録する。

これにより同一Workflow revisionの実行群を比較可能にする。

---

## 21. Context Handoff

AI間でタスクを渡す際、単純な文章だけを渡さない。

最低限、

```text
Task
Workflow / Revision
Stage
Role
Execution Mode
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

設計成果物レビューでは、作成側と異なるAI系統を優先できる。

この方針はユーザー定義Workflow / Routing Policyとして表現する。

---

## 23. Rule / Skill Validation

以下を検出する。

- Duplicate
- Conflict
- Shadowing
- Missing Dependency
- Unreachable

---

## 24. Context Preview

AIへ渡される前に、最終Contextを確認できる。

Workflow実行時は少なくとも、

```text
Workflow / Revision
Stage
Role
Runtime / Model
Loaded
Excluded
```

を確認可能にする。

---

## 25. VS Code UI

最低限以下を確認できるUIを提供する。

```text
AI Context
├── Workflows
├── Skills
├── Rules
├── Roles
├── Task Types
├── Providers / Runtimes / Models
├── Projects
├── Provenance / Change Sets
└── Diagnostics
```

Workflowを主要な起動対象として見つけやすくする。

---

## 26. Generated Artifacts / Runtime Bootstrap

Runtime固有生成物を編集元としない。

Canonical WorkflowをRuntime都合でlauncher skill / commandとしてmaterializeしてよいが、生成物をCanonical Workflowの正本にしない。

---

## 27. Import / Native Context Migration

既存Claude / Codex資産をCoreへ取り込めるようにする。

Import後はAACL側を正本とする。

---

## 28. MCPとの責務分離

Capability → MCP/Tool Provider と Provider → Account → Model は別軸として管理する。

---

## 29. Workflow / Orchestrator / Coreの責務分離

```text
Workflow Definition:
ユーザーが繰り返したい開発方法
Stage / Role / Transition / completion model

Core:
Workflow Definition / Current Stateを保持
明示Asset relationを解決
possible transitions / policy violationを返す

Orchestrator Role:
Workflow定義の範囲で今回のassignment / transitionを判断

User:
Workflowを選択
Role / Model方針を定義
必要に応じてtransitionを直接決定

Agent Runtime:
model invocation / tool invocation / subagent spawnを実行
```

**Workflowはユーザーが定義した進め方であり、Orchestratorはその中で今回の進行を決定する。**

---

## 30. Global Assets / Project Assets / Project Overlay

AI資産の論理Source of TruthはCoreが所有するが、物理配置はscopeに応じて分離する。

### Global / Personal Assets

Core-managed Asset Storeへ配置する。

### Project Assets

Project固有Assetは原則 `<project-root>/.aacl` を正本とする。

### Project Overlay

Global Assetを複製せず、add / override / disable / bindを指定できる。

---

## 30.1 Project Identity / Initialization

AACL Projectは `.aacl/project.*` 等のMarkerとstable project-idで認識する。

Project登録は初回Chatの副作用ではなく、`aacl init`等の明示操作とする。

未初期化workspaceでもGlobal / Personal ContextのみでAdvisory / Preparation Modeを利用できる。

---

## 31. MCP / Capability / Project Integration

```text
Skill / Workflow
  ↓ requires
Capability
  ↓ provided by
MCP
```

Workflowもrequired capabilityを宣言可能にする。

---

## 32. MCP / Tool Trust・権限管理

「接続されている」と「使用を許可されている」を分離する。

---

## 33. Scope Priority / Conflict Resolution

Scope Priority / Conflict Resolutionの正規仕様は §13 を使用する。

重要な原則:

- Resolverは明示されたscopeを解決する
- Asset本文から意味的scopeを推定しない
- scope生成・変更の意味的判断はUserまたはJournal Review Proposalが担当する

---

## 34. Resolution Explainability

Resolverは最終結果だけでなく各Assetの適用・除外理由を返す。

ただし、「なぜそのAssetがそもそもこのRoleに紐づけられたか」はResolver reasonではなくProvenanceから確認する。

つまり、

```text
Resolution Explainability
→ 今回なぜ適用されたか

Provenance
→ なぜその適用条件になったか
```

を分離する。

---

## 35. Execution Snapshot

各AI実行について、その時点で実際に解決されたContextをSnapshotとして保存する。

最低限、

- project
- task
- execution mode
- workflow id / revision
- workflow stage
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

Workflow未指定時は `workflow = none` とAdvisory / Preparation Modeであることを識別可能にする。

---

## 36. Asset Versioning / History / Rollback

Skill、Rule、Workflow等はAsset単位で履歴を確認・比較・復元できる。

### Revision HistoryとProvenanceを分離する

AACLでは以下を別概念として扱う。

```text
Git / History Backend
  → revision history
  → what changed

AACL Provenance / Change Set
  → decision history
  → why it changed
```

### Change Set

複数Assetを1回のユーザー操作またはJournal Reviewで変更した場合、Change Setとして束ねる。

Change Setは少なくとも、

- change set id
- origin type (`human-edit`, `journal-review`, etc.)
- affected assets
- operation (`create`, `update`, `scope-change`, `relation-change`, `delete`等)
- source journal review
- source journals / snapshots
- observed scope
- proposed / approved scope or relation
- decision summary
- approval information
- Git commit / revision reference（存在する場合）

を保持できる。

### Gitとの関係

Git commit messageへ詳細な由来情報を押し込むことは必須としない。GitをHistory Backendとして使う場合、commitにはChange Set ID / Journal Review ID等の参照を記録してよいが、意味的由来のSource of TruthはAACL Provenance / Change Setとする。

```text
Journal Review
   ↓
Proposal
   ↓
Approval
   ↓
Change Set
   ├─ Asset A create
   ├─ Asset B update
   └─ Asset C scope change
        ↓
Git commit / revision
```

Asset自身には過去のChange Set内容を複製保存せず、referenceから履歴を辿れる構造を基本とする。

### Rollback

- Asset rollback
- Change-set rollback

を提供する。

History BackendはCore domainから抽象化する。

---

## 37. Asset Graph / Core UI

Role中心ビューとAsset中心ビューに加えて、Workflow中心ビューを主要表示とする。

### Workflow中心ビュー

- Stages
- Role connections
- Role / Model binding
- required Skills / Rules / Capabilities
- execution statistics
- related Journals
- Change Sets

を確認可能にする。

### Asset Provenance表示

Asset詳細から、

```text
created by human
updated by Journal Review #12
scope changed by human
updated by Journal Review #31
```

のようにdecision historyを辿れることが望ましい。

---

## 38. Journal

JournalをCoreの正式機能とする。

目的は、設計・実装・レビュー等の実行直後に、AI資産やWorkflowの使われ方に関する一次観測を残すこと。

### Coreが自動記録する事実

Execution Snapshotから取得する。

- project
- task
- workflow id / revision
- workflow stage
- role
- task type
- provider / runtime / model
- loaded skill / rule
- MCP / Tool
- applied override
- asset revision

### 実行者が残す観測

- unexpected value
- friction
- missing support
- improvement seed
- possible cause
- confidence

Journalは観測事実を残すものであり、この時点でAsset scopeや改善内容を確定しない。

---

## 39. Journal Review / Improvement Proposal

Journal Reviewをユーザー発火のStandalone Skillとして実装する。

入力:

```text
accumulated journals
execution snapshots
workflow / stage statistics
diagnostics
asset provenance
```

Journal Review AIは意味的判断を担当する。

### Journal Reviewが判断できること

- Workflow構造の改善候補
- Stage追加 / 削除 / 接続変更候補
- Role責務の改善候補
- 新規Skill / Rule候補
- 既存Asset強化候補
- 削除 / 降格 / Hook移行候補
- Project固有化 / Global化候補
- Role / Model / Workflowへのscope / relation候補

### Observed ScopeとProposed Scopeを分離する

Proposalでは必ず、可能な範囲で以下を区別する。

```text
Observed in
Proposed binding
Reason
Evidence
```

例:

```text
Observed in:
  workflow = issue-development
  stage = implementation
  role = implementer
  model = Luna

Proposed:
  Rule X
  scope = role:implementer

Reason:
  issue appears related to implementer responsibility rather than Luna-specific behavior
```

この判断をResolverの固定ロジックで実施しない。

### Review結果のChange Summary

その回のJournal Reviewで、

- Added
- Updated
- Scope / Relation changed
- Removed
- Rejected / no-change proposals

を明示する。

各変更について、根拠Journal、観測Role / Model / Workflow、提案bindingと理由を確認可能にする。

### Human Approval

Journal Reviewから直接Assetを無承認で変更しない。

承認後にChange Setを生成し、Assetへ反映する。

---

## 40. Asset Bloat / Staleness Diagnostics

肥大化防止をJournal Reviewだけに任せず、Diagnosticsが客観データを提供する。

Diagnosticsはdetect / measure / correlate / flagまでとする。

意味的な改善判断・scope変更判断はJournal Review AIが担当する。

---

## Context Cost Metrics

Resolved Contextのコストを定量評価する。

Workflow ID / revision / stage / role別に集計できるようにする。

これにより、同一Workflow改善前後のContext Costと品質を比較可能にする。

---

## 41. Learning Loop

AACLのLearning LoopはWorkflowを主要な観測単位とする。

```text
User-defined Way of Working
      ↓
Workflow / Assets
      ↓
Workflow Execution
      ↓
Execution Snapshot
      ↓
Journal
      ↓
Diagnostics
      ↓
User-triggered Journal Review
      ↓
AI Semantic Judgment
      ↓
Improvement Proposal
      ↓
Human Approval
      ↓
Change Set / Provenance
      ↓
Versioned Asset Update
      └──────────────→ next Workflow Execution
```

### Workflow improvement

同一Workflow / revisionの反復から、Stage / Role / Asset単位で問題を比較する。

Workflow revision変更後は、変更前後の実行結果を別母集団として比較可能にする。

### Ad-hoc executionを標準改善経路にしない

Development Workflowが存在しない場合にAIがその場で自由な工程を生成して実装することを標準機能にしない。

新しい開発方法が必要な場合は、まずWorkflow候補として検討・作成し、その後明示的に利用する。

これにより改善対象を永続Assetへ固定する。

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
- 自然言語だけからDevelopment Workflowを自動推測・生成して実行する
- Resolverにユーザーの開発思想を学習・推測させる

---

## Core / Extension Responsibility Split

### Core Tool

CoreはAI開発資産と実行意味論のSource of Truthを持つ。

主な責務:

- Workflow / Skill / Rule / Role等の管理
- Workflow State
- Project Overlay
- MCP / Capability
- Context Resolution
- Journal / Journal Review
- Execution Snapshot
- Provenance / Change Set
- Diagnostics
- History / Rollback
- Context Cost Metrics

CoreはWorkflow選択やAsset bindingの意味的判断を自律推測するAgentではない。

### VS Code Extension

- Workflow / Skill launcher
- multi-session
- Provider / Model切替
- IDE context取得
- Host Inject
- Workflow状態表示
- Context Preview
- Journal入力
- Journal Review結果 / Change Set表示

Extension自身はWorkflow semanticsやResolver semanticsを持たない。

---

## Provider / Account / Model

Provider、Account、Modelを別概念として扱う。

Role / Model bindingはユーザー設定を基本とし、将来的な自動Model選択は別機能として扱う。

---

## Chat / Runtime Context Bootstrap

Chat Session開始時、Workflowが指定されていればWorkflow情報をCoreへ渡す。

指定がなければAdvisory / Preparation Modeとして開始する。

Conversation途中でDevelopment Workflowを開始する場合、明示的なWorkflow起動操作を要求する。

---

## Chat Sessions

最低限保持する情報:

- session id
- project
- provider
- model
- role
- active skill
- active workflow / revision / stage
- execution mode
- created at / updated at
- title
- linked executions
- relevant snapshots

---

## Orchestrator Context Bootstrap

WorkflowがOrchestratorをentry roleとして指定した場合にのみ、Orchestrator Contextを解決する。

Orchestratorがsubagentを起動する前に、Workflow Stageとtarget role/model/task/projectを用いてDelegation Contextを解決する。

---

## Consolidated Responsibility Model

| Component | Owns | Does not own |
|---|---|---|
| User | Workflow selection, user-authored Workflow/Role/Model policy, initial Asset intent, approval | Resolver implementation |
| Core / Control Plane | Asset Store, History, Provenance, Scope/Policy application, Context Resolver, Workflow Definition/State, Snapshot, Journal/Diagnostics | user development philosophyの自律推測、model/tool execution |
| Workflow | user-defined repeated development structure, Stage, Role relation, transition constraints, completion model | 今回どのtransitionを選ぶか |
| Journal Review AI | Journal/Snapshotの意味的解釈、improvement / scope / relation proposal | 無承認Asset mutation |
| Orchestrator Role | assignment, transition, retry/reject/fallback decision within Workflow | Asset Source of Truth |
| Agent Runtime | model invocation, tool invocation, subagent spawn | domain policyの正本 |
| Extension | Human UI, IDE context, Workflow launcher, Host Inject, Preview, state visualization | Asset / Workflow semantics |
| Resolver | explicit scope / relation / policy resolution | Workflow discovery, semantic binding inference |

---

## Local-first / Self-hostable Core

Coreはservice-capableに設計し、MVPでは個人localhost運用を基本とする。

Windows / WSLから同一Coreを利用可能な構造を維持する。

Remote / Teamは後続Phaseとする。

---

## Technology Stack Direction

初期実装はTypeScript中心とする。

```text
Core Domain / Service
→ TypeScript / Node.js

Desktop Shell / Core UI
→ Tauri 2

VS Code Extension
→ TypeScript

Persistence
→ Filesystem + Git
→ Runtime / Provenance Storeとして必要に応じてSQLite等
```

### Provenance / History

Assetのcurrent stateとdecision provenanceを分離する。Git-compatible History Backendはrevision追跡に利用できるが、Journal Review / source Journal / scope判断 / approval等の意味的由来はAACL Change Set / Provenance Storeで管理する。

---

## Explicit Design Decisions

### Workflow-first

Development ExecutionはWorkflowを明示的に選択して開始する。

### User-owned Development Philosophy

Workflow / Role / Model方針、Asset初期定義とbindingはユーザー所有を基本とする。

### Resolver

Resolverは選択済み構造に対する決定論的Asset Resolutionを担当し、Workflow discovery / generationやsemantic binding inferenceを担当しない。

### Journal Review

Journal Review AIが観測データを意味的に解釈し、Asset / Workflow / scope / relation改善をProposalとして提示する。

### Provenance

Asset本文・current metadataと、変更理由・根拠・承認を表すdecision provenanceを分離する。

### History

Git revision historyとAACL decision historyを別責務とし、相互参照する。

---

## 43. 初期運用MVP

### 必須

- 独立Core + VS Code拡張の責務分離
- Workflowを主要なDevelopment Execution単位として管理
- Workflow明示起動
- Workflow未指定時のAdvisory / Preparation Mode
- Development Workflowなしで実装へ暗黙移行しない実行境界
- Skill管理
- Rule管理
- Role管理
- Task Type管理
- Provider / Runtime / Model管理
- User-defined Role / Model binding
- Context Resolution
- Resolverは明示scope / relationのみを決定論的解決
- Context Preview
- Claude / Codex materialization
- Runtime Bootstrap
- runtime-pull / host-inject
- Native Asset import
- Project Asset / Overlay
- MCP / Capability
- Workflow State
- Execution SnapshotにWorkflow ID / revision / stageを保存
- Workflow単位のJournal集計
- Asset History / Change Set / Rollback
- Journal
- User-triggered Journal Review
- Journal Review AIによるsemantic scope / relation proposal
- Observed Scope / Proposed Scope / Reasonの明示
- Review単位のAdded / Updated / Removed / Binding Change表示
- Human Approval前にAsset変更しない
- Provenance / decision history
- Git revision historyとAACL decision provenanceの分離・相互参照
- Diagnostics
- Context Cost Metrics

### 後回し

- Hook統合
- 自動矛盾検出
- Semantic duplicate検出
- Workflow GUI editor
- 複雑な状態管理
- 自動Workflow選択
- 自動Workflow生成
- 自動モデル選択
- 高度なコンテキスト最適化
- Protected Resources / Guardrails管理
- Claude / Codex以外のProvider Adapter

---

### MVP内部マイルストーン

#### Milestone A — User-owned Assets / Resolver Foundation

- Canonical Asset model
- Workflow / Skill / Rule / Role / Task Type
- User-defined binding
- Scope Resolution
- Context Preview
- Project / Global assets
- Claude / Codex materialization

#### Milestone B — Workflow Runtime

- Workflow launcher
- Advisory / Preparation Mode
- Development execution boundary
- Workflow State
- Orchestrator bridge
- Runtime integration
- Execution Snapshot
- Delegation Context

#### Milestone C — Workflow Learning / Operations

- Journal
- Workflow/stage observation
- Journal Review semantic judgment
- Improvement Proposal
- Provenance / Change Set
- History / rollback
- Diagnostics
- Context Cost Metrics

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

## 45. MVPの主要Workflow / Skill

### Workflow

```text
issue-development
```

### Standalone Skill

```text
refactoring-review
architecture-review
security-review
test-review
journal
journal-review
```

---

## 46. MVPの主要Workflow

```text
/issue-development #123
      ↓
Workflow: issue-development
      ↓
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

## 47. MVP完了条件

以下を満たした状態をMVP完成とする。

1. WorkflowをCanonical Assetとして登録・編集できる
2. WorkflowにStage / Role / transition / completion criteriaを定義できる
3. `/workflow + additional instruction` でWorkflowを明示開始できる
4. Workflow未指定SessionがAdvisory / Preparation Modeになる
5. Workflow未指定状態から実装・repository modification・PR作成へ暗黙移行しない
6. Skill / Rule / Role / Task Typeを管理できる
7. Role / Model bindingをユーザーが設定できる
8. AssetにWorkflow / Role / Model等のscope / relationを設定できる
9. Resolverが明示されたscope / relationから必要Contextを決定論的に解決できる
10. ResolverがAsset本文からRole / Model / Workflow bindingを意味推測しない
11. Context Resolution reasonを表示できる
12. Context PreviewでWorkflow / revision / stage / roleを確認できる
13. Claude / CodexへCanonical Assetを利用可能な形式で提供できる
14. Runtime Bootstrapが極小かつ冪等である
15. runtime-pull / host-injectを利用できる
16. Global / Project Assetを統合解決できる
17. `.aacl` Projectとstable project-idを利用できる
18. Workflow StateをCoreで保持できる
19. AI間handoffにWorkflow / revision / stageを含められる
20. Execution SnapshotにWorkflow ID / revision / stage / Role / Model / Asset revisionsを保存できる
21. Workflow未指定ExecutionをSnapshot上で識別できる
22. JournalがWorkflow / revision / stage / role / modelと紐づく
23. 同一Workflow revisionのJournal / retry / return等を集計可能である
24. Journal Reviewをユーザーが明示的に発火できる
25. Journal Review AIがJournal / Snapshotを意味的に解釈できる
26. Journal Reviewが新規Asset / 既存Asset改善 / Workflow改善 / scope / relation変更をProposalとして提示できる
27. Journal ReviewのProposalがObserved ScopeとProposed Scope / Relationを区別する
28. Proposalにbinding判断理由と根拠Journalを表示できる
29. Journal Review単位でAdded / Updated / Removed / Scope or Relation Changedを確認できる
30. Human Approval前にProposalがAssetへ反映されない
31. 承認済みProposalをChange Setとして反映できる
32. Change Setにhuman-edit / journal-review等のoriginを記録できる
33. Asset本文とProvenanceを分離できる
34. Assetから作成・変更に関係したChange Setを辿れる
35. Git revision historyとAACL provenance / decision historyを分離できる
36. Change SetとGit commit / revisionを相互参照できる
37. Asset単位のhistory / diff / rollbackを利用できる
38. Change-set rollbackを利用できる
39. Diagnosticsが改善候補を提示しても自動mutationしない
40. Context CostをWorkflow / stage / role / Asset別に計測できる
41. 同一Workflowのrevision変更前後で品質・Context Costを比較可能なデータを保持できる
42. 新しいDevelopment方法が必要な場合、Workflowなしのad-hoc実装ではなくWorkflow作成・選択へ誘導できる
43. ユーザー定義Workflow / Role / Model / Asset設定がAACLの開発方針のSource of Intentとして維持される

---

## 48. 最終的に目指す状態

ユーザーは毎回長い開発promptを書かない。

```text
Before

「Issue #123を対応して。
まず要件を整理して、別モデルでレビューして、
その後Lunaで実装して、テストして、PRを作って、
Solでレビューして……」
```

ではなく、

```text
After

/issue-development #123
```

とする。

AACLは、ユーザー自身が定義したWorkflow / Role / Model / Skill / Ruleを使って実行する。

```text
User-defined Development Philosophy
             ↓
          Workflow
             ↓
      Roles / Stages
             ↓
       Asset Resolution
             ↓
       Agent Runtime
             ↓
     Snapshot / Journal
             ↓
 User-triggered Journal Review
             ↓
       Improvement Proposal
             ↓
        Human Approval
             ↓
    User-owned Assets Evolve
```

最終的に育つのは「AACL自身の独自思想」ではなく、**ユーザー自身の開発方法**である。
