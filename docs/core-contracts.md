# Coreの追加契約

開発要件v16のうち、Skill / Role / Task Typeの固有設定、Journal Review Proposal、Asset別Context Cost、revision比較の実装仕様です。会話による操作、段階的なSkill取得、任意のモデル指定、初回分類と出力は[運用ガイド](mcp-operations.md)を参照してください。VS Code Extensionは含みません。

## Asset Typeごとの設定

共通のID・scope・priority・dependencies・conflicts・revisionに、次の任意フィールドを追加しています。対応するAsset Type以外への設定は拒否します。UIのAsset編集からフォームで設定できます。

| Asset Type | フィールド                                                               | 内容                                                                                                          |
| ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| skill      | `skill.executionMode`                                                    | `standalone` / `workflow` / `both`。既定は`both`                                                              |
| skill      | `skill.role`, `skill.taskType`                                           | 既存のRole / Task Typeを制約する参照です。上位で選択済みの場合に一致を検証します。Skillから担当を選びません。 |
| skill      | `skill.executionPermission`                                              | `read-only` / `workflow-development`。既定は`read-only`                                                       |
| skill      | `skill.expectedOutput`                                                   | 成果物名の配列。完了・次Stageへの進行時に成果物の参照先または結果が必要                                       |
| skill      | `skill.completionCriteria`                                               | 条件の配列。完了・次Stageへの進行時に各条件の根拠が必要                                                       |
| role       | `role.responsibilities`, `role.expectedOutput`                           | 責務と期待する成果物。Runtimeへ渡すContextに含む                                                              |
| task-type  | `taskType.objective`, `taskType.qualityCriteria`, `taskType.constraints` | 作業目的・品質基準・制約。Runtimeへ渡すContextに含む                                                          |

Skillの各条件はResolverで評価し、不一致の必須SkillはRun起動・Handoffを拒否します。適用可能なSkillは`available`として説明を提示し、本文をContextへ展開しません。明示取得時に対象を再検証します。単独Skillは起動時のrevisionを固定します。既存Runに固定Skillがない場合は、起動時Snapshotから取得します。`skill.steps`の新規保存は拒否し、旧データの手順も実行指示として展開しません。

`workflow-development`のSkillは、Development-capable Workflow内でのみ利用できます。単独Skillを含むAdvisory Modeに開発権限は与えません。`read-only`は個々のSkillに渡す実行上の制約です。外部Runtimeによる実ファイル操作をOSレベルで遮断する機構ではありません。開発操作前のHandoff検証は引き続き必要です。

契約のない既存Assetには新しい完了条件を付け足しません。既存のSnapshotや履歴の本文・契約は書き換えません。Roleの成果物やTask Typeの品質基準はRuntime向けの指示であり、Coreが成果物の内容を意味的に採点する機能はありません。

## Proposalの変更ごとの根拠

`aacl_review_submit`、`POST /api/reviews/:id/proposal`は、`reason`・`proposedBy`と次の`items`を受け取ります。

```json
{
  "reason": "調査で不足した確認手順を追加する",
  "proposedBy": "external-runtime",
  "items": [
    {
      "operation": {
        "op": "upsert",
        "expectedRevision": 0,
        "asset": {
          "id": "target-check",
          "type": "rule",
          "name": "対象の確認",
          "content": "調査対象と範囲を確認する。",
          "scope": { "team": ["research"] }
        }
      },
      "proposedScope": { "team": ["research"] },
      "proposedRelations": { "dependencies": [], "conflicts": [] },
      "reason": "調査チームの作業に適用するため",
      "evidence": {
        "journalIds": ["実在するReview対象Journal ID"],
        "snapshotIds": [],
        "explanation": "対象が曖昧だったという観測に対応する"
      }
    }
  ]
}
```

- Observed scopeは、根拠JournalとSnapshotの実行ContextからCoreが導出します。
- 根拠IDはReview対象に限定します。Journalに紐づくSnapshotも自動で根拠に含めます。
- Proposed Scope / Relationは変更後Assetと一致させます。Project Assetは保存先Projectにscopeが固定されるため、その値も指定します。削除提案では両方を`null`にします。
- 追加・更新・削除・Scope変更・Relation変更・変更なしを分類します。理由、根拠、観測範囲、提案範囲は承認後のChange Setにも保存します。
- 提案時はコピー上で変更全体を検証します。承認時にrevisionを再検証し、競合があれば一切反映しません。
- 変更不要は`items: []`。旧クライアントの`operations`形式も受け付けますが、根拠はReview全体で共有する旧形式として明示します。`items`と`operations`の併記は禁止です。

## Context Costとrevision比較

| 用途                       | HTTP GET                           | MCP                                    |
| -------------------------- | ---------------------------------- | -------------------------------------- |
| Asset別Context Cost        | `/api/metrics/assets`              | `aacl_asset_metrics`                   |
| 削除済みも含むrevision履歴 | `/api/assets/:id/history`          | `aacl_asset_history`                   |
| 指定revisionの比較         | `/api/assets/:id/diff?from=1&to=2` | `aacl_asset_diff` (`id`, `from`, `to`) |

CostはSnapshotに保存されたAsset単位の推定tokensを、Asset ID / Asset revision / Workflow ID / Workflow revision / Stage / Roleで集計します。`candidatePresentations`はSkill候補の提示、`retrieved`は改訂を指定した個別取得記録、`reportedUses`は使用報告の件数です。参照をたどって後から取得したSkillも記録に含めます。候補の提示だけを本文取得や使用とは数えません。本文取得分には固定した改訂の本文と契約の推定量を加えます。現在のAssetを編集しても過去のCostは変化しません。旧Snapshotは当時の推定値を保持します。

Diagnostics画面でWorkflow・revision・Stage・Roleを絞り込めます。実際のモデル課金額や、Assetと不具合の因果関係を表す指標ではありません。

比較は本文の行差分と、scope・型固有契約などの設定差分を返します。revision `0`はAssetが存在しない状態で、追加・削除の比較に使います。正のrevisionは実在するものだけ指定できます。大きな変更は計算量を制限してブロック単位で比較し、UIは変更箇所の周辺を段階的に表示します。復元は既存と同様に新しいrevisionを作成します。

## 検証と残る範囲

2026年9月9日の試用対応では、次の契約を追加しています。

- `workflow.stages[].expectedOutput`は工程で必要な成果物名の配列です。省略した既存の工程には成果物条件を追加しません。指定した工程ではSkillの成果物と合わせて、進行・完了時に記録を求めます。
- `aacl_context_handoff`は更新後の`version`と、プロジェクトの`id`・`name`・`root`を持つ`project`を返します。未登録の作業場所では`project`は`null`です。`root`はCoreが動くOS上のパスです。
- 新しいSnapshotは作成時の`project`を保存します。既存のSnapshotにこのフィールドを補完する処理はありません。
- 実行の`lastHandoff`は現在工程での最後の取得方法を、`runtimeHandoffAt`はAIからの取得日時を記録します。手動取得はAIからの取得記録を消しません。工程を遷移・再試行すると両方を解除します。AIによる作業開始を示す記録ではありません。
- `GET /api/reviews/:id/preview`は、提案の`expectedRevision`に対応する変更前Asset、提案する変更後Asset、本文と設定の差分を返します。変更後Assetのrevision `0`は未保存の提案を表します。承認時には従来どおり現在のrevisionを検証します。

`npm run check`で型検査・ビルド・Core/MCPのテスト、`npm run test:ui`でブラウザ操作を検証します。テストデータは一時ディレクトリに分離します。

この追加は全44項目の再監査や完了宣言ではありません。診断のConflict / Shadowing / Unreachable網羅、Resolutionの`degraded`、その他Asset Typeの追加の固有契約、Hook / Guardrail、VS Code Extensionは今回の変更に含みません。
