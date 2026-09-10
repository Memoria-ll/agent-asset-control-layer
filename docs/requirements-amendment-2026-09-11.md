# AACL requirements 追補 — Workflow-managed Execution Boundary

作成日: 2026-09-11

この文書は、`agent-asset-control-layer-requirements.md` の初期v13を基準とし、2026-09-11の方針変更を規範的に追補する。

本追補とv13本文が競合する場合は、本追補を優先する。Runtime固有のUI、Skill配置先、MCP Prompt、Adapter実装、画面構成、Windows / WSL接続等の具体設計は `docs/workflow-managed-execution-design.md` で扱う。

## 1. Explicit Workflow SelectionをAACLの関与境界とする

AACLがWorkflow State、Context Resolution、Execution Snapshot、Journal、Diagnostics、Learning Loopを適用する対象は、ユーザーがWorkflowを明示的に選択した実行とする。

Workflow SelectionはAI開発そのものの許可境界ではない。**AACL-managed executionへの参加境界**である。

```text
Explicit Workflow Selection
        ↓
AACL-managed Execution
        ↓
Workflow / Role / Asset Resolution
        ↓
Execution Snapshot / Journal
        ↓
Workflow-centered Improvement
```

Workflowを選択しないことは、設計・実装・repository modification・Pull Request作成等を禁止することを意味しない。

## 2. Workflow未指定の通常AI利用をAACLが規定しない

Workflowが明示されていない通常会話・調査・相談・設計・実装等について、AACLは独自のExecution Mode、Development authorization、許可・禁止規則、Workflow Stateを自動適用しない。

```text
No Workflow Selection
        ↓
Normal AI Runtime / AI App Usage
        ↓
AACL does not govern ordinary execution behavior
```

その会話で何を行い、どこまで自律実行するかは、ユーザーと接続先AI Runtime / AIアプリ本来の関係に委ねる。

したがって、v13の `Advisory / Preparation Mode` をWorkflow未指定Sessionの強制的な既定モードとはしない。また、Workflow未指定状態からrepository modificationへ進むことをAACLが一律禁止しない。

AACLはWorkflow未指定の通常利用へ、Workflow / Rule / Skill / Project Knowledge等を暗黙適用することを標準動作としない。

## 3. Workflow未指定の通常利用を自動観測しない

Workflow未指定の通常AI利用に対して、AACLは以下を自動作成しない。

- Workflow State
- AACL-managed Execution
- Execution Snapshot
- Journal
- Workflow比較用の実行統計

通常利用をAACL-managed executionとして遡及的に記録することも行わない。

AACLの改善ループにおける安定した観測単位は、明示的に選択されたWorkflowとそのrevisionとする。

## 4. 通常AI利用からWorkflow / Assetへ資産化できる

Workflow未指定の通常AI利用は、新しい開発方法・レビュー観点・知識・手順を探索する場として利用できる。

ユーザーが再利用価値を認めた場合、明示的な依頼によって、その会話・成果物・進め方をWorkflow / Skill / Rule / Knowledge等へ資産化できる。

```text
Normal AI Tool Usage
        ↓
Useful way of working discovered
        ↓
User-triggered Assetization
        ↓
Workflow / Assets
        ↓
Future Explicit Workflow Selection
        ↓
Repeatable Observation / Improvement
```

資産化元の通常利用はAACL-managed executionとして偽装しない。必要に応じて、ユーザーが提示した会話・成果物・要約等をProvenanceのsourceとして参照する。

通常利用からの資産化はJournal Reviewとは別の入口を持てる。

## 5. User-owned Development PhilosophyとAI操作委譲を両立する

Workflow / Role / Model方針、Assetの意図、binding方針、改善方針等の**決定主体はユーザー**とする。

ただし、ユーザー所有は「ユーザー自身が設定ファイル、scope、relation、Workflow定義をすべて手入力すること」を意味しない。

接続中のAIは、ユーザーの自然言語を具体的なAACL操作・定義案へ変換できる。

AIが担当できる代表例:

- Workflow / Assetの検索
- ユーザー依頼からのWorkflow / Asset案作成
- 既存指示の分類・整理
- 通常AI利用からの資産化
- Journal / Snapshotからの意味的な改善判断
- AACL状態を読んだ上での復旧判断

対象・変更内容・適用範囲がユーザー依頼から一意に決まる場合、その依頼自体を変更意図として扱い、同じ意思決定への形式的な二重承認を必須としない。

一方、工程構造の変更、複数範囲への展開、Model方針変更等、ユーザー依頼から一意に決まらない方針判断は、AIが具体案を作り、ユーザーへ判断を戻す。

**Human Approvalの目的はクリック回数を増やすことではなく、開発思想・方針の決定主体を人間に維持することである。**

## 6. AIの意味判断とCoreの決定論的意味論を分離する

AIは意味的判断を行える。一方、Core / Resolverは同じ明示状態に同じ意味論を適用する決定論的基盤とする。

```text
User intent
    ↓
AI semantic judgment / concrete proposal
    ↓
Explicit Workflow / Asset / relation / scope
    ↓
Core validation and storage
    ↓
Deterministic Resolver
```

AIが「このRuleはこのRole向けだろう」「この進め方はWorkflow化できる」と判断することは許容する。

ただし、その判断を実行時Resolverの暗黙推測規則として埋め込まない。永続化する場合は、明示的なWorkflow Definition、Asset、scope、relation、policy等へ変換する。

Coreはユーザーの開発思想を自律発明するAgentではない。

## 7. Workflow明示選択が本質であり、Pickerは実装手段とする

AACL-managed execution開始前に、対象Workflowが**一意かつ明示的に選択されていること**を必須とする。

選択手段はRuntime / AIアプリごとに異なってよい。

- Skill picker
- slash command
- command picker
- Workflow名を含む明示的な自然言語依頼
- MCP Prompt
- Adapter固有UI

送信前の候補選択は主要なUX手段として採用できるが、AACL Coreの意味論そのものにはしない。

AIが最近使ったWorkflow、会話内容、履歴等から黙ってWorkflowを推測・適用することは、明示的Workflow Selectionとはみなさない。

## 8. Workflow Entry / LauncherとCanonical Skillを区別する

AACL Canonical Domain上の `Skill` と、WorkflowをRuntimeから選択・起動するために生成するSkill / Commandは別概念とする。

後者を設計上 **Workflow Entry** または **Workflow Launcher** と呼ぶ。

```text
Canonical Workflow
        ↓ materialize
Workflow Entry / Launcher
        ↓ explicit selection
AACL-managed Execution
```

Runtimeの仕様上 `SKILL.md` 等として生成しても、それをCanonical SkillのSource of Truthにはしない。

Workflow Entryは安定したWorkflow IDを参照し、表示名・Runtime表現・配置形式の変更をCanonical Workflow identityの変更と混同しない。

## 9. BootstrapはAACLの存在と入口を知らせるための最小情報とする

Runtime Bootstrapは、Workflow未指定の通常AI利用へAACLの開発方針を常時注入する仕組みとはしない。

少なくとも以下を発見できればよい。

- AACLが利用可能であること
- Workflowを明示選択する入口
- Workflow選択後にCoreからContext / Stateを取得する方法
- Workflow / Assetの検索・作成・編集・資産化等の明示的なAACL管理操作

全Workflow本文、全Rule、全Skill、全Project Knowledgeを通常会話へ常時ロードすることを前提にしない。

## 10. Learning LoopはWorkflow中心を維持する

AACLの改善対象は、同一Workflow / revisionを繰り返し実行した比較可能な母集団を中心とする。

```text
Workflow / Assets
      ↓
Explicit Workflow Selection
      ↓
AACL-managed Execution
      ↓
Execution Snapshot
      ↓
Journal / Diagnostics
      ↓
User-triggered Journal Review
      ↓
AI Semantic Judgment
      ↓
Improvement Proposal
      ↓
Human Decision
      ↓
Versioned Workflow / Asset Update
```

通常AI利用は「新しい方法を発見する場」、Workflow実行は「既知の方法を再現・観測・改善する場」として共存させる。

## 11. 責務モデル

| Component | Owns | Does not own |
|---|---|---|
| User | Workflow Selection、開発思想、Workflow / Role / Model方針、Asset intent、方針変更判断 | Resolver implementation、全操作の手入力 |
| AI | 自然言語の意味判断、定義案作成、資産化、改善案、具体的AACL操作への変換 | 無断での方針確定、Core semantics |
| Core | Canonical State、Workflow State、History、Provenance、明示scope / relation / policyの検証・適用 | Workflow未指定通常利用の統制、ユーザー思想の自律推測、model/tool execution |
| Resolver | 選択済み状態に対する決定論的Asset Resolution | Workflow discovery / selection、semantic binding inference |
| Workflow | 再利用する開発方法、Stage / Role / transition / completion、AACL-managed executionの構造 | Workflow外の通常AI利用 |
| Agent Runtime / AI App | 通常AI利用、model invocation、tool invocation、subagent spawn | AACL Canonical State |
| Adapter / Extension | Workflow Entry、IDE context、Core接続、Runtime固有representation | Workflow / ResolverのCanonical semantics |

## 12. v13から置き換える主な考え方

v13本文中、以下の考え方は本追補で置き換える。

- `Workflow = development authorization boundary` → `Workflow = AACL-managed execution boundary`
- `Workflow未指定 = Advisory / Preparation Mode` → `Workflow未指定 = Normal AI Tool Usage outside AACL-managed execution`
- `Workflowなしではrepository modificationへ進まない` → AACLは通常AI利用の開発可否を規定しない
- `Workflow未指定ExecutionもSnapshot対象` → 通常利用はSnapshot / Journalを自動作成しない
- `新しいDevelopment方法はまずWorkflow化してから実行` → 通常利用で探索してからWorkflow / Assetへ資産化してよい
- `Runtime向けWorkflow launcher skill` → Canonical Skillと区別するWorkflow Entry / Launcher

一方、以下のv13思想は維持する。

- Workflow-first
- User-owned Development Philosophy
- Workflow / Role / Skill / Rule等のCanonical Asset管理
- Roleを共通責務として再利用し、Workflow / Task Type等で作業目的差を表現する
- Resolverは推測エンジンではなく決定論的解決器とする
- 必要十分なContextを段階的に配る
- Workflowを安定した観測・改善単位とする
- Journal Reviewの意味判断とResolverの機械判断を分離する
- ProvenanceとGit revision historyを分離する
- 改善によるAsset肥大化を成功とみなさない
- Context Costと品質を同時に評価する

## 13. requirementsと設計資料の境界

本追補は「何を成立条件とするか」を規定する。

次の具体事項はrequirementsの原則ではなく設計・検証事項とする。

- 送信前Pickerの具体UI
- 各RuntimeのSkill / Command配置先
- Workflow Entryのファイル形式
- MCP Promptの採否
- 会話ID / workspace取得方法
- Windows / WSL path mapping
- Coreの配布・自動起動方式
- 中断・再開API
- 管理画面の構成
- Runtimeごとの受け入れ試験手順

これらは `docs/workflow-managed-execution-design.md` を起点に扱う。
