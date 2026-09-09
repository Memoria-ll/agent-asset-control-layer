# 会話から導入・運用する

AACLでは、既存資産の取り込みと最初の整理を済ませた後、Workflowと今回の対象を会話で指定して作業を始められます。MCPは、AIがAACLの操作を呼び出すための接続です。Coreは正本と実行状態を保存し、接続したRuntimeがモデルとツールを実際に動かします。

## 最初の接続と既存資産の導入

Coreを起動し、対象Projectのディレクトリで`aacl init`を実行します。対象を指定する場合は`aacl init /path/to/project`を使います。Project自身の`.aacl/project.json`をCoreへ登録し、再実行時も同じProject IDを返します。CLIのインストール手順は[README](../README.ja.md#始める)を参照してください。

`http://localhost:4780/mcp`へRuntimeを接続します。標準入出力の接続を使う場合は、Coreの起動後に`aacl mcp`を使います。コマンドは`aacl`、引数は`["mcp"]`で、作業場所の指定は不要です。接続先を変更する場合は`AACL_URL`を設定します。Runtimeごとの接続設定案は`aacl_onboarding_plan`で取得できます。

開発用にインストール前のコマンドを使う場合は、Coreの起動後に`npm --silent run mcp`も利用できます。`--silent`はnpmの起動ログがMCPの標準出力へ混ざることを防ぎます。

`aacl_onboarding_connect`または`aacl onboarding connect <id> input.json`では、ユーザーの導入依頼に基づいてCodex・Claude・Cursorの接続設定と案内ファイルを配置できます。元の設定値と認証情報を保持します。退避した設定本文は非公開のファイルに保存し、MCP応答や資産本文へ渡しません。未対応の構文や既存定義との競合は、変更せずに通知します。設定を配置しただけでは接続済みと判定しません。

導入操作は、保存された導入IDを使って再開します。以下のツール名は公開MCPツールです。各ツールの入力形式はMCPのツール一覧から取得できます。

同じCoreで複数の導入が接続設定を共有している場合は、その設定を再利用した後続の導入から復元します。先行導入を先に復元しようとすると、`CONNECTION_IN_USE`と後続の導入IDを返します。接続や取り込み済み資産を変更する前に停止するため、後続の作業が使う接続を失いません。

接続設定の配置・復元が途中の場合、新しい導入で同じ設定を共有しようとすると`CONNECTION_BUSY`を返します。通知された導入IDで再開または復元を済ませてから、新しい導入を続けます。

| 操作           | ツールと意味                                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 探索           | `aacl_onboarding_discover`は既定のユーザー環境、登録Project、または明示した`roots`を調べます。ホスト・元パス・内容のハッシュ・未対応理由を保存します。                 |
| 状況確認       | `aacl_onboarding_list`と`aacl_onboarding_get`で、導入ID、段階、取り込み対象、除外理由、中断原因を確認します。                                                          |
| 退避と取り込み | `aacl_onboarding_import`は対象ファイルを退避コピーしてから取り込みます。初期状態は無効・オンデマンドです。元の読込と二重適用しません。                                 |
| 接続確認       | AIが取り込んだ全資産を`aacl_asset_get`で取得し、`aacl_onboarding_verify`にユーザーの導入依頼を渡します。Coreへの保存も実際に行い、取得と更新の両方を確認します。       |
| 初回整理       | `aacl_onboarding_organize`に依頼・理由・分類結果・変更の配列を渡します。分類、Roleへの紐づけ、適用条件を一括保存できます。未確定な資産は無効・未紐づけのまま残せます。 |
| 元の読込を停止 | `aacl_onboarding_cutover`は、内容が変わっていないことを検証し、退避済みの取り込み対象だけを元の場所から除きます。元の設定や認証情報は維持します。                      |
| 復元           | `aacl_onboarding_restore`は元ファイルと初回整理を復元します。後から編集されたファイルや資産を上書きせず、競合を示します。                                              |

通常のREADMEや設計文書はフォルダー探索の候補にしません。AGENTS.mdなどの指示ファイル、Skill、rules・prompts・commands内の指示を探索します。文書を明示的に資産化する場合は、そのファイルをrootsに指定します。READMEは補助ファイルとして取り込んだ場合も切り替えで削除しません。`aacl_onboarding_plan`の`paths`が削除対象、`retainedPaths`が残す文書です。残したREADMEの後続編集は、導入の復元でも保持します。

明示的な探索の入力例です。パスはCoreが動くOS上で既に存在する場所に置き換えます。別ホストのパスをローカルのパスとして推測しません。

```json
{
  "id": "my-first-import",
  "includeDefaults": false,
  "roots": [{ "path": "/home/example/.codex", "runtime": "codex" }]
}
```

Skillは本文と補助ファイルをまとめて保存します。`aacl_asset_file_get`は補助ファイルを相対パスで個別取得でき、`revision`を指定すると過去の内容を取得できます。`other`は未分類のAI開発資産です。認証ファイル、設定、セッション履歴、キャッシュ、プラグインや拡張機能の実体を`other`へ入れません。プラグイン管理下の資産、シンボリックリンク、未対応形式、上限を超えるファイルは理由を示します。

`skills`フォルダーの原文も分類前は無効にします。AIは本文・補助ファイルを読み、委譲、担当変更、工程、レビュー差し戻しを実際に制御する原文をWorkflowとRoleへ変換します。単語や例示が含まれるだけでは分類しません。1原文から複数資産を作れます。`classification`には次の形で全原文の対応を指定します。`sourceId`は取り込み応答の資産IDです。

```json
{
  "reviewer": "connected-runtime",
  "entries": [
    {
      "sourceId": "imported-source-id",
      "status": "classified",
      "outputIds": ["work-process", "implementer", "reviewer", "check-procedure"],
      "reason": "原文が担当の委譲とレビュー差し戻しを定義しています",
      "unconvertedParts": []
    }
  ]
}
```

未確定な場合は`status: "uncertain"`にして無効な資産として保存します。未確定分類や未変換部分が残る導入は切り替えできません。整理は導入IDにつき1回の一括処理です。整理を見直す場合は復元して新しい導入を作ります。出力資産も改訂と復元の対象です。

一度に探索する根は32か所、取り込む資産は100件、1資産のファイルは200件までです。本文・各補助ファイルは20万バイト、1資産全体は200万バイト、探索全体は2,000万バイトまでです。未対応ファイルを含むSkillを、補助ファイルが欠けたまま切り替えることはできません。バックアップはCoreのデータディレクトリー内に保存します。

CLIからも`aacl onboarding discover input.json`を使えます。その後の操作は`aacl onboarding import <id>`などで指定します。`connect`、`verify`、`organize`は`userRequest`を含む入力ファイルを渡します。CLIの接続確認も実際のMCP接続を使用します。既に接続済みの場合、接続設定の再配置は不要です。

## 初めてWorkflowを作る

ユーザーは「仕様レビューとコードレビューを含むWorkflowを作ってください」と依頼できます。AIは登録資産を調べ、足りないRoleとWorkflowをまとめて提案します。実行やJournalを先に作る必要はありません。

変更操作には次の三つの情報を渡します。Runtimeが操作を送る場合も、実際に依頼したユーザーを記録します。これらは接続したRuntimeが伝えるローカルの監査情報であり、Coreが別の認証サービスで本人確認した記録ではありません。

```json
{
  "userRequest": "このWorkflowと必要なRoleを作ってください",
  "reason": "仕様とコードの両方をレビューする手順を用意します",
  "actor": { "kind": "runtime", "id": "my-ai", "userId": "local-owner" }
}
```

`aacl_asset_propose`に上記と`operations`を渡すと、差分と影響を持つ提案が保存されます。新規資産は`expectedRevision: 0`、既存資産は現在の改訂番号を指定します。ユーザーの承認・拒否は`aacl_proposal_decision`に`decision: "approve"`または`"reject"`として渡します。承認時に資産・設定・抽出関係が変わっていた場合は、古い差分を適用せず再提案を求めます。

既にユーザーが具体的な変更を依頼している場合は`aacl_asset_change`で提案と適用を続けて記録できます。同じ依頼を資産ごとに確認し直す必要はありません。改訂の復元は`aacl_asset_rollback`を使います。

## 上位で担当とモデルを決める

Workflowの工程はRoleを選びます。Roleのモデル割り当ては`aacl_config_get`で取得した設定の`bindings`に保存します。`model`は省略できます。全Workflow共通のRole割り当てと、特定Workflowの割り当てを区別できます。設定は`aacl_config_update`へ現在の`settingsVersion`を`expectedVersion`として渡して変更します。

モデルは実行時の明示指定、工程の`model`、Roleの割り当ての順に決まります。指定がなければ`launch.modelPolicy`は`runtime-default`となり、起動引数の`model`を省きます。親のモデルを子へコピーしません。Runtimeが明示選択に対応しない場合は指定モデルでの起動を拒否します。工程の`modelConstraint.model`は必須モデル、`modelConstraint.differentFromStage`は指定工程と異なる実モデルを要求します。開始報告で確認できない制約を満たしたものとして進行・完了できません。

RoleからSkill・Rule等への利用関係は資産の`relations`に保存します。Modelに共通する資産は`scope.model`で紐づけます。特定RoleとModelの組み合わせには両方の条件を指定します。Project、Runtime、directory等もAND条件として組み合わせられます。上下関係だけから優先順位を決めません。

```json
{
  "target": "review-checklist",
  "kind": "required",
  "origin": "manual",
  "reason": "このRoleでは共通の確認手順を使います"
}
```

`aacl_asset_relations`で、選択したWorkflow・Role・Model・Skillの関係と逆引きを確認できます。同じSkillを複数Role・Modelで共有でき、本文は一度だけ渡します。SkillからRole・Modelを選択したり、開発権限を広げたりする関係は拒否します。

Skillの明確なID・相対パスへの利用指示は、取り込み・本文変更時に抽出します。抽出関係には記述位置と理由を保存します。手動の関係は本文変更後も維持します。

| 種類          | 保存と実行時の扱い                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `required`    | 対象とその条件を検証します。Skillは説明を候補として提示し、本文は個別取得します。必須利用の循環は拒否します。                          |
| `conditional` | `scope`に評価可能な条件を保存します。自然言語だけの`condition`は自動判定しません。AIが条件を確認した場合、明示取得の対象に指定します。 |
| `reference`   | 説明資料への参照です。本文や手順を自動適用しません。必要なときに取得します。                                                           |

禁止の記述から利用関係を作りません。IDやパスが曖昧な場合も推測で結びません。自然言語の意味の整理は、ユーザーが依頼したAIによる初回整理・編集で行います。`skill.steps`の新規保存は拒否します。旧データは読み取り可能ですが工程として展開しません。同じ担当者が行う通常の本文手順は維持し、担当や工程の制御はWorkflowへ移します。

## Skillを必要なときに読む

初期Contextの`skillCandidates`にはID・説明・改訂・取得方法だけを含めます。本文と補助ファイル、さらに先のSkill本文は含みません。Rule本文は初期Contextへ含めます。

`aacl_skill_get`に候補の`id`、`revision`、`snapshotId`を渡すと、その時点のSkill本文と参照先の情報を取得できます。補助ファイルは返された改訂番号を使い`aacl_asset_file_get`で個別取得します。閲覧の既定値は`usage: "inspect"`です。現在の作業で使う場合は`usage: "use"`と理由を報告します。候補表示、取得、使用報告は集計で区別します。使用報告はRuntimeの申告であり、Coreによる実行の観測ではありません。

準備時点で使用を報告したSkillの完了条件は、開始報告後も保持します。別工程や新たな引き継ぎで使用する場合は、そのSnapshotで取得し直します。過去のSkill改訂は現在の資産編集で変わりません。

## 同じWorkflowを繰り返し使う

`aacl_session_preflight`にWorkflowと今回の対象を渡します。各工程のModel・Runtime、必要資産、接続済みかつ許可済みのCapability、Runtimeの制約設定を確認できます。不足があれば一覧や設定変更のツールで解消します。

`aacl_session_start`は準備状態を作ります。Runtimeが引き継ぎを取得し、`aacl_runtime_event`で`started`を報告して実作業を始めます。開始報告には一意な`attemptId`と現在の`expectedVersion`が必要です。終了は`result`または`failed`、ユーザーの判断待ちは`waiting-user`、回答後の再開は同じ試行の`resumed`として記録します。複数回の判断待ちも別々の更新として保存できます。再送する報告は同じ`requestId`を使用できます。引き継ぎ取得だけを実作業の開始として扱いません。

子の実行環境で分かる場合は、開始報告に`actualModel`と`actualRuntime`を含めます。実モデルは未登録でも報告できます。不明なモデル名は推定で埋めません。開始報告は準備時の資産・設定を保った別Snapshotを作ります。返された引き継ぎ内容を確認し、以後のSkill取得とJournalには試行のSnapshotを使います。登録済みの実モデルだけがモデル条件付き資産の解決対象です。

開始と引き継ぎを再送するときは、同じ内容・同じ`requestId`を使います。異なる内容で同じIDを再使用すると競合になります。閲覧や再接続の確認は`aacl_run_get`、`aacl_context_handoff_preview`で行います。これらは実行の版やSnapshotを増やしません。

`aacl_workflow_transition`は、定義された遷移と必要な成果物・完了条件の根拠を検証します。最終レビューは`canComplete: true`と実装への差し戻し遷移を併記できます。差し戻し後は対象工程と後続工程の成果物・根拠を取り直します。過去の根拠はイベント履歴から読めます。`aacl_run_restart`は最新Workflowで別の実行を作り、明示した成果物だけを再利用します。

Runtimeの`enforcement`は、ファイル変更・外部操作・ツール制限を実際に強制できるかの宣言です。Workflowの`requiredEnforcement`に必要な項目を指定すると、対応しないRuntimeへの引き継ぎを拒否します。Coreが検証できるのはCoreを経由する操作と登録された宣言です。外部RuntimeによるOS上の操作をCoreが独自に遮断する機能はありません。

## 作成支援と単独ファイルへの出力

組み込みの`aacl-asset-authoring`と`aacl-asset-export`は、実行記録を作る前から取得できます。作成支援は初回分類と同じ基準で、相談内容をWorkflow・Role・Skill等へ整理します。管理操作の依頼と承認は従来の提案APIで記録します。

`aacl_export_bundle`は次の入力で、指定資産と必要な関係先、設定、ファイルを1時点から取得します。

```json
{
  "assetIds": ["issue-development"],
  "mode": "standalone",
  "runtime": "codex"
}
```

応答の`manifest`にはID・改訂・ハッシュ・ファイル配置を保存します。`files`が出力する本文、`outputSpecifications`が配置と検証の契約、`limitations`が未対応事項です。`ready: false`の場合は、阻害理由を解決してから利用します。単独出力は工程・Role・成果物・差し戻しの指示とローカル参照を含みます。Skill本文を一括で子へ渡さず、説明の一覧から選べる構成です。必要に応じて同梱するNodeの遷移検証プログラムもCoreから独立しています。`mode: "connected"`は稼働中のMCP接続を前提とします。

Runtimeの接続先は認証情報を含む可能性があるため、両モードで出力から除きます。接続出力では配置先の環境で接続を設定します。元の接続先を出力ファイルへコピーしません。

ファイルへ書き出す場合は入力を`export-input.json`に保存し、次のコマンドを使います。出力先はまだ存在しないディレクトリーを指定します。Coreは出力を取得するときに起動しておきます。生成したプログラムは出力処理では実行しません。

```sh
aacl export-bundle export-input.json ./exported-assets
```

既存の配置へ統合する場合は、Runtimeがユーザーの指定先と差分を確認し、補助ファイルと参照を含めて配置・検証します。単独出力の生成には実Runtimeの起動やモデル実行の検証は含みません。従来の`export`コマンドは接続用のWorkflow起動ファイルを生成します。

## 観測と変更の履歴を調べる

`aacl_journal_append`の`observedAt`は観測した時刻、`createdAt`は保存した時刻です。`attemptId`を指定する場合、Snapshotと同じ試行かを検証します。改善する実行を`aacl_journal_list`で絞り、`aacl_review_start`でユーザーがレビューを始めます。AIが提案した後、`aacl_review_decision`にユーザーの判断を記録します。

設定変更も`aacl_settings_history`で理由・実施者・変更前後を確認できます。`aacl_settings_restore`による復元は新しい設定版として残ります。過去のSnapshotの適用内容は変わりません。

`aacl_workflow_metrics`は、実行の開始時刻による対象期間と件数を返します。Workflow改訂、Project、Model、Runtime、設定版、資産改訂が異なる記録を分けます。準備数、開始報告のある試行数、結果、失敗、差し戻し、人間の判断待ち、欠陥の観測を区別します。推定Context量の減少だけから品質改善とは判断しません。実際のモデル消費量や作業規模の同等性は、別の実測と合わせて判断します。
