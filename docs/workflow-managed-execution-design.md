# AACL Workflow-managed Execution 設計方針

作成日: 2026-09-11

この文書は、Agent Asset Control Layer（AACL）のrequirementsに置く製品原則を、実際の利用体験・責務分担・接続方式へ落とすための設計資料である。

requirementsのSource of Truthを置き換えるものではない。特に、Skill picker、slash command、MCP、Adapter、画面構成等の具体手段はこの文書で扱い、requirementsでは原則と成立条件を中心に扱う。

## 1. 中心となる境界

AACLが管理・観測・改善する対象は、ユーザーがWorkflowを明示的に選択した実行である。

```text
Explicit Workflow Selection
        ↓
AACL-managed Execution
        ↓
Workflow State
        ↓
Context Resolution
        ↓
Runtime Execution
        ↓
Snapshot / Journal
        ↓
Diagnostics / Improvement
```

Workflow Selectionは、AI開発そのものの許可境界ではない。

Workflowを選択していない場合は、Claude Code、Codex、Cursor、Copilotその他の接続先AI Runtime / AIアプリを通常どおり利用する。質問、相談、調査、設計、実装、ファイル変更、Pull Request作成等についてAACLが独自の許可・禁止規則を上乗せしない。

```text
No Workflow Selection
        ↓
Normal AI Tool Usage
        ↓
Runtime / AI App owns ordinary behavior
```

AACLはAIツール全体を支配するControl Planeではなく、ユーザーが再利用したい開発方法をWorkflowとして管理するControl Planeである。

## 2. Workflow明示選択が本質であり、UIは手段

AACL-managed executionを開始する前に、対象Workflowが一意かつ明示的に選択されていることを必須条件とする。

その表現方法は接続先ごとに異なってよい。

- Skill picker
- slash command
- command picker
- Workflow名を含む自然言語の明示依頼
- MCP Prompt等のユーザー選択UI
- 専用Adapterによる選択UI

「送信前に候補から選べる」体験は望ましい主要UXだが、AACLの意味論そのものではない。Pickerを持たないRuntimeでも、ユーザーが一回の開始依頼の中でWorkflowを一意に明示できるなら、AACL-managed executionを成立させられる。

逆に、履歴やAI推測だけでWorkflowを黙って選択した場合は、明示的Workflow Selectionとはみなさない。

## 3. Workflow EntryとCanonical Skillを区別する

AACL内部のCanonical Asset TypeとしてのSkillと、WorkflowをRuntimeから起動するために生成するSkill / Commandを同一概念として扱わない。

設計上、後者を **Workflow Entry** または **Workflow Launcher** と呼ぶ。

```text
Canonical Workflow
        ↓ materialize
Workflow Entry / Launcher
        ↓ user selects
AACL-managed Execution
```

Runtimeの仕様上、Workflow Entryが`SKILL.md`等として配置されることはあり得る。しかし、それはWorkflowを呼び出すRuntime-specific representationであり、Canonical SkillのSource of Truthにはしない。

Workflowの表示名変更やEntry形式変更によってCanonical Workflow IDが変わらないことを基本とする。

## 4. 通常AI利用からの資産化

Workflow未選択の通常AI利用は、AACLにとって無価値な領域ではない。探索的な会話・実装・レビューを通じて、ユーザー自身の良い進め方が見つかる場所として扱う。

ユーザーが再利用価値を認めた時点で、明示的な依頼によりWorkflow / Skill / Rule / Knowledge等へ資産化できる。

```text
Normal AI Tool Usage
        ↓
Useful way of working discovered
        ↓
User: "この進め方をWorkflowにして"
        ↓
AI extracts structure / intent
        ↓
AACL stores Workflow / Assets
        ↓
Future Explicit Workflow Selection
        ↓
Repeatable observation and improvement
```

元の通常利用を遡及してAACL-managed executionやJournalとして偽装しない。資産化時には、ユーザーが提供した会話・成果物・要約等を由来情報として参照できる。

これにより、AACLは「最初から正しいWorkflowを定義してからでなければ開発できない」製品にはならない。

## 5. 人間・AI・Core・Runtimeの責務

### User

ユーザーは開発思想と意思決定主体を所有する。

- どの進め方をWorkflowとして保持するか
- 今回AACL-managed executionを使うか
- どのWorkflowを選択するか
- Role / Model / Asset relation等の方針
- 改善案や方針変更を受け入れるか

ただし「ユーザー所有」は、設定ファイルやrelationをすべてユーザー自身が手入力することを意味しない。

### AI

接続中のAIは、ユーザーの自然言語を具体的なAACL操作・定義案へ変換するオペレーターとして振る舞える。

- 既存Workflow / Assetの検索
- ユーザー依頼からWorkflow / Asset案の作成
- 通常利用からの資産化
- 既存指示の分類
- 改善候補の意味的判断
- 状態を読んだ上での復旧判断

対象と変更内容がユーザー依頼から一意に決まる場合、同じ意思決定を形式的に再承認させない。

一方、工程構造・適用範囲・モデル方針等が依頼から一意でない場合、AIは具体案を提示し、その方針判断をユーザーへ戻す。

### Core

Coreは賢い意味推測器ではなく、Canonical Stateと適用意味論を保持する堅い基盤とする。

- Workflow / AssetのSource of Truth
- revision / history / provenance
- Workflow State
- 明示済みscope / relation / policyの決定論的解決
- Snapshot / Journal / Diagnostics
- 競合・整合性・状態遷移の検証

AIが「このRuleはこのRole向けだろう」と判断した内容を、実行時Resolverが毎回意味推測して再現する設計にはしない。AI判断を保存する場合は、明示的なrelation / scope等へ変換してCoreへ渡す。

### Runtime / AI App

Runtimeはモデルとツールを実際に動かすExecution Surfaceである。

Workflow未選択時は通常AI利用そのものを提供する。

Workflow選択時は、AACLから取得したWorkflow / Role / Asset / completion conditions等に基づいてモデル呼び出し、tool invocation、subagent spawn等を行う。

AACL CoreがOSレベルでRuntimeの全操作を支配できるとは仮定しない。

## 6. ユーザー所有とAI委譲の境界

次の原則を採用する。

```text
Human owns intent and policy.
AI translates intent into concrete operations.
Core validates and stores explicit state.
Runtime executes.
```

例えば「このプロジェクトのレビュー手順に、この確認項目を追加して」という依頼で、対象Workflowと追加内容が一意なら、その依頼自体を変更意図として扱える。

Proposal作成、別画面でのApprove、もう一度同じ確認という二重承認を必須にしない。

一方、「最近のレビューを改善して」のように変更内容が未確定なら、AIがJournal等から具体差分を作り、人間が方針を判断する。

Human-in-the-loopの目的はクリック回数を増やすことではなく、**方針の決定主体を人間に維持すること**である。

## 7. Bootstrapと通常会話

AACL接続済みRuntimeに必要なのは、全Asset本文を常時読み込ませることではない。

Bootstrapは少なくとも次を発見できればよい。

- AACLが利用可能であること
- Workflow Entryの利用方法
- 明示的なAACL管理操作の呼び出し方法
- Workflow選択後に現在状態・ContextをCoreから取得する方法

Workflow未選択の通常会話へ、AACLのRule / Skill / Project Knowledgeを自動的に常時注入することを基本条件にしない。

これにより、AACLを導入しただけで既存AIツールの通常挙動が変質することを避ける。

## 8. 日常利用の主要経路

### Workflowを使う場合

理想的には、接続先アプリの入力欄でWorkflow Entryを候補から選び、今回の対象を添えて一回の送信で開始する。

```text
Select: issue-development
Input: #123 ログイン不具合
Send
```

AIは選択されたWorkflowと対象をCoreへ渡し、必要なWorkflow State / Contextを取得して作業を開始する。

対象とWorkflowが一意なら、開始確認を繰り返さない。

### Workflowを使わない場合

通常どおりAIを使う。

AACLは「Workflowを選んでください」と割り込まない。

### 通常利用を資産化する場合

ユーザーが明示的に「今の進め方をWorkflowにして」等と依頼する。

AIは直前の会話だけに依存せず、必要ならユーザーが指定した成果物・対象・範囲を確認し、再利用可能な定義へ変換する。

## 9. Journalと改善ループ

AACLの標準的な改善対象は、明示的Workflow Selectionにより開始された実行とする。

同一Workflow / revisionを繰り返し実行することで、比較可能な観測母集団を作る。

```text
Workflow revision N
  ├─ Run 1
  ├─ Run 2
  ├─ Run 3
  └─ ...
        ↓
Journal / Diagnostics
        ↓
Journal Review
        ↓
Improvement Proposal
        ↓
Human decision
        ↓
Workflow / Asset revision N+1
```

通常AI利用を自動Journal化してこの母集団へ混在させない。

通常利用は「新しい方法の発見」、Workflow実行は「既知の方法の再現・観測・改善」という役割分担になる。

## 10. Adapterとアプリ差

AACLは全AIアプリのチャットUIを自前実装しない。

Adapterは接続先の能力に合わせて、少なくとも次を扱う。

- Workflow Entry / Launcherのmaterialize
- Workflow選択情報の受け渡し
- Project / workspace contextの取得
- AACL Core接続
- Context delivery
- 必要な状態表示

Skill picker等のUI能力は接続先ごとに異なるため、Runtime固有差として扱う。CoreのWorkflow semanticsへ混ぜない。

未知のアプリについては、Skill配置先を指定できるだけで「対応済み」と判定せず、少なくともWorkflowの明示選択からCore取得、Runtime実行までの接続契約が成立することを確認する。

## 11. 設計上の非目標

- Workflow未指定のAI利用をAACLが禁止・制御すること
- 全AIチャットをAACL UIへ置き換えること
- WorkflowをAIが履歴から暗黙選択すること
- Runtime-specific Workflow EntryをCanonical Skillとして管理すること
- AIによる意味判断をResolverの固定ロジックへ埋め込むこと
- ユーザー所有を「すべて手作業で設定すること」と解釈すること
- 通常AI利用を自動的にAACLの実行履歴・Journalへ取り込むこと

## 12. requirementsとの分離

requirementsには主に次を残す。

- Workflow-first / Explicit Workflow Selection
- AACL-managed execution boundary
- Workflow未指定時にAACLが通常AI利用を規定しないこと
- User-owned Development Philosophy
- Normal usageからのuser-triggered assetization
- Core / AI / Runtimeの責務境界
- Resolverの決定論性
- Workflow中心の観測・改善
- Workflow EntryとCanonical Skillの概念分離

一方、次は設計・実機検証事項として本資料または後続資料で扱う。

- 各アプリでの候補UI
- Skill / command配置パス
- Workflow Entryの具体形式
- MCP Promptの採否
- 会話IDやworkspaceの取得方法
- Windows / WSL間のpath mapping
- Coreの配布・起動管理
- 中断・再開の具体API
- UI画面構成
- 具体的な受け入れ試験表

この分離により、製品思想をRuntime固有の現在仕様へ固定せず、設計詳細を更新してもAACLの中心原則を維持できるようにする。
