# Phase B: HTTP・Extension配線

## Scope

- Phase AのCore serviceをHTTP listenerへ注入する。
- bindingのsave / get / resolve requestをshared schemaで検証する。
- Core error、revision conflict、not found、unavailableを既存HTTP status mappingへ載せる。
- Extensionにtransport-neutralなBinding clientを追加し、同じshared DTOを利用する。
- filesystem pathやdomain内部型を公開境界へ漏らさない。

## Scope外

- Orchestratorのassignment決定とWorkflow transition
- Capability Provider / Tool permissionの実装
- binding editorの具体的UI
- 自動Model選択と高度Policy

## 実装anchor

- `core/src/http/router.ts`のroute closed set
- `core/src/http/listener.ts`の例外境界とrequest lifecycle
- `core/src/http/responses.ts`のstatus / error mapping
- `core/src/main.ts`のcomposition root
- `vscode-extension/src/project-client.ts`のtransport境界パターン
- Core / Extensionの`src/index.ts`

行番号は着手時に再確認する。

## 新規テスト

- save → get → resolveのHTTP round-trip。
- malformed request、revision conflict、not found、domain failure、unknown route。
- `/bindings/resolve`とID routeの衝突防止。
- raw exceptionとabsolute filesystem pathの非漏洩。
- Extension clientがresponseをshared parserで検証し、winner logicを持たないこと。
- `/health`のGET / HEAD契約が維持されること。

## 完了条件

- HTTPとExtensionがPhase Aと同じcontractを使用する。
- transport層にscope、fallback、Capability、assignment semanticsが複製されない。
- `bash ~/.claude/scripts/run-gate.sh`がexit 0になる。
