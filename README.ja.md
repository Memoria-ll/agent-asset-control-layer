# Agent Asset Control Layer

[English](README.md) | **日本語**

**AACLは、AIと進める開発手順を保存し、繰り返し使い、実行記録から改善するローカルアプリです。**

最初に既存の指示を取り込むか、AIに手順の作成を依頼します。次回からは、保存したWorkflow（開発工程）と今回の対象を指定します。

```text
/issue-development #123 ログイン時の不具合を修正してください
```

これは`issue-development`を登録した場合の依頼例です。AACLが手順と状態を管理し、接続したAIの実行環境がコード変更やレビューを行います。

```mermaid
flowchart LR
    User["ユーザー<br/>手順と今回の対象を指定"] --> AI["接続したAI"]
    AI <-->|"手順の取得・結果の報告"| Core["AACL<br/>資産・工程・履歴を管理"]
    AI --> Work["実行環境<br/>担当AIの起動・開発・レビュー"]
    Work -->|"結果"| AI
    User <-->|"閲覧・手動編集"| UI["ブラウザUI"]
    UI <--> Core
```

**現在利用できるもの:** ローカルCore、ブラウザUI、MCP接続、CLI、既存資産の導入、単独ファイルへの出力。Coreは保存と検証を行うサービスです。MCPはAIがその操作を呼び出すための接続規約、CLIは端末からの操作手段です。

## 始める

Node.js 24以上を用意し、このリポジトリのルートで実行します。

```sh
npm ci
npm run build
npm start
```

| 接続方法            | 設定                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| ブラウザUI          | `http://localhost:4780`を開きます。                                       |
| MCPのHTTP接続       | AIの接続先に`http://localhost:4780/mcp`を設定します。                     |
| MCPの標準入出力接続 | Coreを起動したまま、リポジトリを作業場所として`npm --silent run mcp`を実行します。 |

標準入出力の接続は、稼働中のCoreへの中継です。接続後は「このプロジェクトを登録し、既存の開発手順を取り込んで整理してください」とAIに依頼できます。資産がない場合は、新しいWorkflowの作成を依頼するか、UIから編集可能なスターターを追加します。モデルの登録は任意です。

| 環境変数        | 用途・既定値                                                |
| --------------- | ----------------------------------------------------------- |
| `AACL_DATA_DIR` | Coreの保存先。既定はリポジトリ内の`.aacl-data`です。        |
| `PORT`          | Coreのポート。既定は`4780`です。                            |
| `AACL_URL`      | 標準入出力の中継先。既定は`http://127.0.0.1:4780/mcp`です。 |
| `AACL_API_URL`  | CLIの接続先。既定は`http://127.0.0.1:4780`です。            |

Coreは`127.0.0.1`で待ち受けます。ポートを変えた場合は、AIとCLIの接続先も合わせます。

## 手順を資産として保存する

再利用する指示や知識を**Asset（資産）**と呼びます。資産にはID、改訂番号、適用条件、参照関係を保存します。

| 種類       | 保存するもの                                           |
| ---------- | ------------------------------------------------------ |
| Workflow   | 工程、担当Role、委譲、成果物、差し戻し、完了条件。     |
| Role       | 担当者の責務と期待する成果物。                         |
| Skill      | 現在の担当者が使う手順・知識と補助ファイル。           |
| Rule       | 条件に合う作業で守る指示。                             |
| Task Type  | 作業の目的、品質基準、制約。                           |
| Capability | 外部ツールの接続と利用許可。                           |
| その他     | プロジェクト知識、方針、テンプレート、未分類資産など。 |

Workflowが担当を決め、担当者が必要なSkillを使います。次は、実装とレビューを分ける構成例です。

```mermaid
flowchart LR
    Implement["実装工程<br/>Role: 実装担当"] --> Review["レビュー工程<br/>Role: レビュー担当"]
    Review -->|"合格"| Done["完了"]
    Review -->|"差し戻し"| Implement
    Implement -. "必要時に使う" .-> Coding["Skill: 実装手順"]
    Review -. "必要時に使う" .-> Checking["Skill: 確認手順"]
    Rules["Rule: 共通の制約"] -. "両担当に適用" .-> Implement
    Rules -. "両担当に適用" .-> Review
```

Skillは担当やモデルを選びません。同じ担当者が行う順序付きの手順はSkillに書けます。別担当への委譲や工程の制御はWorkflowに保存します。旧`skill.steps`は読み取れますが実行せず、新規保存も拒否します。

リポジトリを変更する作業には、開発を許可したWorkflowの明示起動が必要です。Workflowなしの会話や単独Skillは相談・準備として扱います。AACL内の資産編集は、ユーザーの依頼に基づく別の管理操作です。

UIでは工程、担当、成果物、差し戻し先を編集できます。以下の画面は説明用データで撮影しています。

![Workflowの工程と担当を編集する画面](docs/images/readme-workflow.png)

## 既存の指示を取り込む

導入は、退避・取り込み・接続確認・AIによる整理を経て、元の自動読込を停止します。元ファイルを残したまま接続と内容を確認できます。フォルダーの探索は指示ファイルと指示用フォルダーを対象とし、通常のプロジェクト文書を除外します。READMEを再利用するために取り込む場合は、そのファイルのパスを明示します。Skillの補助ファイルに含まれるREADMEも、切り替え時に元の場所へ残します。

Assetsの取り込み画面は、単一Markdownを有効な資産として登録します。元のパスやハッシュは記録しません。フォルダーの移行・退避・接続検証・切り替え・導入IDによる復元には、同じ画面の依頼文をコピーしてAIへ渡してください。Skillの名前は先頭のnameから提案し、保存前に変更できます。

```mermaid
flowchart TD
    Backup["探索・退避コピー"] --> Import["出所付きで取り込み<br/>初期状態は無効"]
    Import --> Organize["取得と保存を確認<br/>AIが分類・整理"]
    Organize --> Check{"分類は確定したか"}
    Check -->|"はい"| Cutover["変更がないことを検証<br/>元の自動読込を停止"]
    Check -->|"いいえ"| Hold["無効のまま保留"]
    Cutover -. "復元" .-> Restore["元ファイルと整理前の状態を復元"]
```

`skills`フォルダーにあるだけではSkillに確定しません。AIが原文の実際の動作を読み、1つの原文をWorkflow・Role・Skillへ分割できます。出力ID、分類理由、未変換部分、出所を記録します。

導入IDで中断後の作業を再開できます。切り替えと復元では、対象ファイルと資産の改訂を検証します。後から編集された内容は上書きしません。認証情報・接続設定・履歴・キャッシュは資産本文に取り込みません。

Codex・Claude・Cursor向けの接続設定も導入できます。未対応形式やプラグイン管理下の資産は、理由を示して切り替えを保留します。手順は[導入・運用ガイド](docs/mcp-operations.md)を参照してください。

## 必要な指示だけを渡す

**Contextは、その担当者へ渡す作業情報です。** CoreはProject、Workflow、工程、Role、作業種別、Runtime、モデル、ディレクトリー等の条件から内容を決めます。Runtimeは、担当AIとツールを実際に動かす環境です。

初期ContextにはRule本文とSkillの説明一覧を含めます。Skill本文や補助ファイルは、AIが必要なものを選んで取得します。

```mermaid
flowchart TD
    Conditions["今回の条件<br/>Project・工程・Role・実行環境"] --> Resolve["Coreが適用を判定"]
    Resolve --> Rules["適用するRule本文"]
    Resolve --> Catalog["Skillの説明一覧<br/>ID・改訂・取得方法"]
    Rules --> AI["担当AI"]
    Catalog --> AI
    AI -->|"必要なSkillを選ぶ"| Body["その改訂の本文を取得"]
    Body -->|"必要な参照だけ"| Files["補助ファイル・参照先を個別取得"]
    Resolve -. "本文を渡さない" .-> Other["対象外の資産<br/>除外理由だけを返す"]
```

異なる条件軸はANDで組み合わせます。例えば`Role = reviewer`と`Model = model-a`を設定すると、両方が一致したときだけ適用します。Projectごとの無効化、置き換え、条件の上書きも指定できます。

同じSkillが複数の関係から選ばれても、候補を重複させず選択理由を残します。候補の提示、本文取得、使用報告は別々の記録です。本文を取得しただけで「使用した」とは判定しません。

実行画面では、その工程のContextとSkill候補を確認できます。

![実行の状態と担当へ渡すContextを確認する画面](docs/images/readme-run-context.png)

## モデル指定は任意にする

Roleとモデルは別の設定です。モデルを指定した場合は、実行時の指定、工程の指定、Roleの割り当ての順に決めます。

```mermaid
flowchart TD
    Order["指定を探す<br/>実行 → 工程 → Roleの順に優先"] --> Selected{"指定はあるか"}
    Selected -->|"ある"| Explicit["指定モデルで起動を依頼"]
    Selected -->|"ない"| Default["モデル引数を省略<br/>Runtimeの標準設定で起動"]
    Explicit --> Report["実モデルを別に報告<br/>不明なら未報告のまま"]
    Default --> Report
```

モデル未指定を「親AIと同じモデル」に置き換えません。明示指定に対応しないRuntimeでは、指定を無視せず競合を返します。

指定モデルと、Runtimeが報告した実モデルは別に保存します。未登録のモデルも報告できますが、モデル固有の資産を適用するには対応するモデル設定が必要です。特定モデルや別モデルによるレビューを必須にしたWorkflowは、実行報告で確認できなければ進行・完了できません。

## AIからWorkflowを使う

接続したAIは、最初に`aacl_bootstrap`または`aacl://bootstrap`を読みます。正確な引数は、接続先のMCPツール定義から取得します。

Coreへの開始要求は準備状態を作ります。実作業を行うのはRuntimeです。次は1工程の基本的な呼び出し順です。

```mermaid
sequenceDiagram
    participant AI as 接続したAI・Runtime
    participant Core as AACL Core
    AI->>Core: aacl_session_preflight（全工程を事前確認）
    AI->>Core: aacl_session_start（Workflowと今回の指示）
    Core-->>AI: 実行ID・現在の版
    AI->>Core: aacl_context_handoff（担当へ渡す内容を取得）
    Core-->>AI: 起動方針・Rule本文・Skill候補
    AI->>AI: 担当AIを起動
    AI->>Core: aacl_runtime_event: started（実モデルが分かれば報告）
    Core-->>AI: 試行のSnapshot・実モデルを反映したContext
    AI->>Core: aacl_skill_get（必要な本文を取得）
    AI->>AI: 作業・検証
    AI->>Core: aacl_runtime_event: result / failed
    AI->>Core: aacl_workflow_transition（成果物・完了根拠）
```

Snapshotは、資産の改訂・設定・Contextを固定した記録です。開始報告では準備時の記録を保ち、実モデルを反映した別Snapshotを作ります。

AIが守る操作上の要点は次のとおりです。

1. 資産の新規作成・整理には実行や架空のJournalを作りません。`userRequest`、変更理由、実際の依頼者を記録します。
2. 開発操作前の引き継ぎには`action: "development"`を指定し、`developmentAllowed`を確認します。
3. `aacl_skill_get`には返された`id`・`revision`・`snapshotId`を使います。閲覧は`usage: "inspect"`、使用報告は`usage: "use"`です。補助ファイルは`aacl_asset_file_get`で同じ改訂を取得します。
4. 更新には最新の`expectedVersion`を使います。再送を支える操作では、同じ内容と`requestId`を再利用します。開始報告の`attemptId`は実際の試行を識別します。
5. 閲覧には`aacl_run_get`と`aacl_context_handoff_preview`を使います。閲覧で実行の版やSnapshotを増やしません。
6. 遷移には定義済みの工程、成果物、完了根拠を渡します。差し戻し後は必要な根拠を取り直します。最新版での再開は`aacl_run_restart`で別の実行を作ります。

## 記録から改善する

Journalは、実際の試行で観測した問題や結果の記録です。ユーザーの依頼でAIが記録を読み、変更を提案します。

```mermaid
flowchart TD
    Work["実際の作業"] --> Journal["Journal<br/>問題・結果を記録"]
    Journal --> Review["依頼されたAIレビュー"]
    Review --> Proposal["具体的な変更案<br/>差分と根拠"]
    Proposal --> Decision{"ユーザーの判断"}
    Decision -->|"承認"| Revision["新しい改訂を保存"]
    Decision -->|"拒否"| Keep["変更せず判断を保存"]
    Revision --> Next["次の実行で利用"]
    Next --> Work
```

初回作成や直接の変更依頼は`aacl_asset_propose`・`aacl_asset_change`、承認判断は`aacl_proposal_decision`で扱います。実行記録に基づく改善は`aacl_review_start`から始めます。組み込みの`aacl-asset-authoring` Skillは、相談段階から作成と分類を支援します。

資産・モデル割り当て・Project設定は変更前後と理由を保存し、復元できます。過去のSnapshotは書き換えません。比較画面では、準備数と実試行数、指定モデルと実モデル、資産や設定の改訂差を分けて確認できます。

## ファイルへ書き出す

組み込みの`aacl-asset-export` Skillと`aacl_export_bundle`で、指定資産と必要な参照先をまとめて取得します。出力中に異なる改訂を混ぜないよう、1時点の資産・関係・設定を固定します。

```mermaid
flowchart LR
    Assets["指定資産と必要な参照先"] --> Bundle["1時点の出力データ<br/>改訂・設定・ハッシュ・配置表"]
    Bundle --> Standalone["standalone<br/>ローカルの工程・Role・Skill・補助ファイル"]
    Bundle --> Connected["connected<br/>MCP接続を使う起動手順"]
    Standalone --> Offline["AACL停止後も利用"]
    Connected --> Online["稼働中のAACLへ接続"]
```

| 出力モード   | 利用条件                                                                               |
| ------------ | -------------------------------------------------------------------------------------- |
| `standalone` | Workflowの委譲・差し戻し手順と参照ファイルを同梱します。生成後の利用にCoreは不要です。 |
| `connected`  | MCP接続が必要です。配置先で接続を設定します。                                          |

対応する出力形式は`codex`・`claude`・`cursor`・`generic`です。元の接続先は両モードで出力から除きます。`limitations`に未対応事項を返し、`ready: false`なら阻害理由を解消してから利用します。出力しただけでモデル選択や権限制約が保証されるものではありません。

例えば、次を`export-input.json`に保存します。資産IDは登録済みのものに置き換えます。

```json
{
  "assetIds": ["issue-development"],
  "mode": "standalone",
  "runtime": "codex"
}
```

Coreを起動した状態で、まだ存在しないディレクトリーへ出力します。

```sh
npm run cli -- export-bundle export-input.json ./exported-assets
```

AIに配置を依頼する場合は、配置先と既存ファイルとの差分を確認し、出力仕様に従って書き込み・検証します。Context Previewでは、選択したWorkflowと追加の利用候補について、出力形式を選んで単独出力の依頼文をコピーできます。同じ画面のCodex・Claudeのファイル生成ボタン、`aacl_materialize`、CLIの`export`は、MCPを必要とする接続用の出力です。

## 実装と検証

CoreはTypeScript・Node.js・Express、UIはReact・Viteで実装しています。正本はJSONファイルです。共有資産と状態はCoreの保存先、Project資産は各プロジェクトの`.aacl`に保存します。

```sh
npm run dev                      # 開発用サーバー
npm run check                    # 型検査・ビルド・サーバーテスト
npx playwright install chromium  # 初回のみ
npm run test:ui                  # ブラウザテスト
```

ブラウザテストはポート4781と一時データを使います。2026年9月9日の実装検証では、サーバー141件・ブラウザ23件のテストが通っています。

現在はローカルの単一ユーザー向けです。VS Code拡張、デスクトップ専用シェル、複数ユーザー管理、リモート運用は未実装です。Coreは自身を経由する操作を検証します。実モデルの起動、外部ツールの実行、OS上の操作制限はRuntimeが担います。実行報告や推定Context量だけから開発品質の改善を認定しません。

| 読みたい内容                        | 文書                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------- |
| 導入・日常操作・復元・出力          | [導入・運用ガイド](docs/mcp-operations.md)                                |
| 型ごとの契約・変更提案・改訂比較    | [Coreの契約](docs/core-contracts.md)                                      |
| 現在の要件                          | [開発要件v15](agent-asset-control-layer-requirements.md)                  |
| 実装箇所と検証範囲                  | [2026年9月9日の実装確認表](docs/improvement-implementation-2026-09-09.md) |
| Skill・Workflow・モデル・出力の設計 | [設計方針](docs/skill-workflow-model-and-export-design.md)                |

ライセンスは[Apache License 2.0](LICENSE)です。
