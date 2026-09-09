# AACL — Agent Asset Control Layer

Workflowを中心にAI開発資産を管理する、ローカル用Control Planeです。TypeScript Core、ブラウザUI、HTTP API、MCPサーバーを実装しています。Coreが状態・Context・承認済みAssetを管理し、モデルの実行と外部ツールの呼び出しはClaude / Codexなどの接続先Runtimeが担当します。

## 起動

Node.js 24以上とGitを使用します。このworkspaceではWSL内で実行してください。

```bash
cd /home/owner/dev/aacl
npm ci
npm run build
npm start
```

UI: [http://localhost:4780](http://localhost:4780)  
MCP: `http://localhost:4780/mcp`

開発中は`npm run dev`で、同じポートからUIとCoreを提供します。Node.jsをnvmでインストールしている場合は、先に`source ~/.nvm/nvm.sh`を実行してください。Windowsブラウザからもlocalhostで接続できます。

`PORT`でポート、`AACL_DATA_DIR`で保存先を変更できます。既定の保存先はこのリポジトリの`.aacl-data`です。同じ保存先を複数Coreで同時に開くことはできません。stdio接続は既存Coreへのbridgeです。

## 最初の操作

1. Workflows画面の「スターターを追加」を押します。6 Stageの`issue-development`、6つのRole、Task Type、Rule、単独レビューSkillを登録します。初期状態は空で、自動登録しません。
2. Assetsから内容・複合scope・依存関係・priorityなどを編集します。Workflow定義はJSONで編集できます。新規Workflowは、参照するRoleを先に登録してください。
3. Context PreviewでWorkflow / Stage / Role / Project / Runtime / Modelを指定し、適用・除外理由を確認します。
4. 「新しい実行」からWorkflowと追加指示を指定します。選択しなければAdvisory Modeになります。
5. Runtime & MCPに表示された接続先をClaude / Codexに登録します。CoreがRunを開始しただけではAIの実作業は始まりません。接続先AIにRun IDを渡し、`aacl_context_handoff`から引き継がせます。
6. Stageの完了根拠と成果物を登録して進行し、実行後にJournalを記録します。
7. Journalを選択してReviewを開始します。「AIへの依頼をコピー」を接続先AIへ渡してください。AIは`aacl_review_get`で根拠を読み、`aacl_review_submit`で提案を提出します。UIの「承認して反映」で初めてAssetを変更します。

ModelのIDやRole bindingはRuntime & MCP画面でユーザーが登録します。Model名を推測して自動選択しません。Accountは識別用metadataのみで、APIキーを保存しません。

## MCP接続

Streamable HTTPとstdio bridgeを実装しています。SDKの実クライアントでinitialize、tools/list、resources/read、Workflow起動、Handoff、Journal、Proposalを検証しています。

Codexの設定例:

```toml
[mcp_servers.aacl]
url = "http://localhost:4780/mcp"
```

Streamable HTTPサーバーのURLは`mcp_servers`に設定します。[Codex MCP公式ドキュメント](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

Claude Codeの設定例:

```bash
claude mcp add --transport http aacl http://localhost:4780/mcp
```

HTTP transportの登録形式はClaude Codeの公式仕様に従います。[Claude Code MCP公式ドキュメント](https://code.claude.com/docs/en/mcp)

stdioを使う場合は、Coreを別途起動した状態で次をクライアントに登録します。`/absolute/path/to/aacl`を実際のパスへ置き換えてください。

```json
{
  "mcpServers": {
    "aacl": {
      "command": "node",
      "args": [
        "--import",
        "/absolute/path/to/aacl/node_modules/tsx/dist/loader.mjs",
        "/absolute/path/to/aacl/server/stdio.ts"
      ],
      "env": { "AACL_URL": "http://127.0.0.1:4780/mcp" }
    }
  }
}
```

MCP tool一覧:

| 用途     | Tools                                                                              |
| -------- | ---------------------------------------------------------------------------------- |
| 閲覧     | `aacl_workflow_list`, `aacl_asset_list`, `aacl_asset_get`, `aacl_run_list`         |
| Context  | `aacl_context_resolve`, `aacl_context_handoff`, `aacl_snapshot_get`                |
| 実行状態 | `aacl_session_start`, `aacl_workflow_transition`                                   |
| 改善     | `aacl_journal_append`, `aacl_review_list`, `aacl_review_get`, `aacl_review_submit` |
| 運用     | `aacl_bootstrap`, `aacl_materialize`, `aacl_diagnostics`                           |

Resources: `aacl://bootstrap`, `aacl://workflows`。人間の承認・Asset直接編集・RollbackはMCP toolに公開していません。UI / CLI用APIで操作します。

`aacl_context_handoff`は`delivery=runtime-pull`と`delivery=host-inject`を受け付け、同じContextとSnapshot参照を返します。実際のhost injectionは呼び出し元が行います。repository modificationの前に`action=development`を指定し、Coreの実行境界検証を受けてください。Coreは外部Runtimeが独自に行う操作をOSレベルで遮断するサンドボックスではありません。

## Project / Native import / Export

```bash
# 既存ディレクトリにstable project-idを付与
npm run cli -- init /path/to/project "My project"

# Workflowを明示起動
npm run cli -- start /issue-development '#123'

# 新しいディレクトリへ生成（既存ディレクトリは上書きしない）
npm run cli -- export codex issue-development ./generated-codex
npm run cli -- export claude issue-development ./generated-claude
```

Project Assetは`<project>/.aacl/assets.json`、identityは`.aacl/project.json`に保存します。Global Assetを複製せず、Project overlayでdisable / override / bindを指定できます。Project IDを含むasset scopeは対象Projectに固定します。Asset IDはCore内で一意です。

UIのインポートではSKILL.md・rule・knowledgeのMarkdownを取り込めます。単純な`name`と`description`のfrontmatterを解析し、scopeやmodel bindingは推測しません。複数行YAMLの完全な解釈やSkill同梱スクリプトの再帰importは未対応です。

Exportは`AACL-BOOTSTRAP.md`、`AACL-CONTEXT.md`、Runtime向け`SKILL.md`、revision manifestを生成します。Context Previewからも内容確認・ダウンロードできます。既存の`AGENTS.md`、`CLAUDE.md`、MCP設定を自動変更しません。BootstrapをRuntimeの初期指示へ組み込み、MCP接続を設定してください。

## 実装した意味論

- Scopeは異なる軸をAND、同じ軸の値をOR / INとして評価します。Directoryはpath境界を確認します。
- Scope一致→mandatory→disable→priority→specificity→scope precedence→依存・競合→依存順の並びでContextを作ります。意味が変わる排他的同順位はconflictにします。
- Role / Workflow / Task Type / Skill / Capabilityは明示選択または依存関係から読み込みます。Rule / Knowledge / Policyはscopeとactivationで絞り込みます。
- 必要な依存の欠落・disable・互換性不一致・循環がある場合は成功扱いにしません。Capabilityはconnectedとallowedの両方が必要です。この2値は明示申告で、外部サーバーへの接続probeは実装していません。
- RunはWorkflow全定義とrevisionを固定します。Stage・Role・Task Type、許可遷移、成果物、完了条件を検証します。Snapshotは実際に解決した本文・asset revisions・除外理由・推定tokensを保持します。
- Asset編集とRun遷移はexpectedRevision / expectedVersionで古い更新を拒否します。Proposalの承認時にも競合を再検証します。
- Roleの作業目的差は複合scopeで表現します。本文からのscope推測やWorkflow自動選択はありません。
- Journal Reviewの意味判断は外部AI Runtimeが行います。Coreは根拠bundle、提案検証、承認、Change Setを担当します。疑似AIによる固定ルールの改善提案は生成しません。
- Asset / Change Set rollbackは履歴を消さずに新しいrevisionを作ります。後続変更があるChange Setの巻き戻しは拒否し、Asset単位の復元を使います。

## 保存と回復

```text
.aacl-data/
  assets.json       Global / Personal Assetの正本
  state.json        Run / Snapshot / Journal / Review / Provenance / config
  transaction.json  複数ファイル更新のwrite-ahead記録（処理中のみ）
  .lock             Core単一writerのロック（起動中のみ）
  history/.git/     Asset revisionの専用Git履歴
<project>/.aacl/
  project.json      stable project-id
  assets.json       Project Assetの正本
```

ファイルは一時ファイル・fsync・renameで置換します。複数ファイル変更は先にtransactionを永続化し、起動時または次の読込時に残りを再適用します。Core内の読込は回復後に行います。外部プロセスが複数JSONを直接読む場合の一貫したsnapshotは保証しません。更新はCore APIを通してください。

Git commitはChange Set IDを参照し、Provenanceはcommit hashを参照します。Asset / state commit後のGit記録は別処理で、Git失敗時もCanonical変更は保持し、Diagnosticsに記録します。Git記録の直前にプロセスが強制終了した場合はcommit参照が未付与のまま残る可能性があります。Asset / Change Set履歴からの復元は利用できます。

この版は個人localhost運用・単一プロセスを対象に、JSONを一括読込します。大規模データの索引・ページ分割・SQLite移行、複数writer、Team / remote認証は未実装です。ローカルHTTPのHost / Origin検証とUI操作tokenは、ネットワーク越しのユーザー認証を代替しません。

## 検証

```bash
npm run check              # TypeScript・本番build・Core/HTTP/MCP統合テスト
npx playwright install --with-deps chromium
npm run test:ui            # 実ブラウザの操作フローとモバイル幅
```

テストは一時ディレクトリを使用し、通常の保存先を変更しません。ブラウザテストのスクリーンショットは`test-results/`に出力されます。Claude / Codex本体での有料モデル呼び出しは実施していません。接続とCoreの振る舞いはSDKクライアントで検証します。

## 現時点の境界

要求v13から、コアの一連の操作が動く実装を優先しています。VS Code拡張、Tauriデスクトップシェル、Workflowの図形編集、外部モデルの直接実行、外部MCPへのproxy / 接続probe、Hooks / OS Guardrails、AI自動選択、semantic duplicate検出は含みません。Token数は文字種からの推定で、モデル別tokenizerによる実測ではありません。Providerの価格を使った金額計算も行いません。

主なコードは`server/domain.ts`（契約）、`server/resolver.ts`（決定論的解決）、`server/core.ts`（状態・承認）、`server/store.ts`（保存・回復・Git）、`server/mcp.ts`（MCP）、`src/`（UI）に分かれています。
