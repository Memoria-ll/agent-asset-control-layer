# Ledger — core/src/http

置き場の規則は root `AGENTS.md` の `## Ledger` にある。

## Traps

- `node:http` のリクエストハンドラ内で throw すると `uncaughtException` になり、**その接続には
  応答が返らずクライアントがハングする**（500 にはならない）。transport は必ず例外境界で捕まえて
  `internal` の `CoreErrorDto` を返す。`server.on("error")` は **`listen()` と同じ同期ターン内**で
  登録する — `setImmediate` / `setTimeout` を挟むと `EADDRINUSE` がハンドラに届かず
  `uncaughtException` でプロセスが落ちる（`listen()` の前後は無関係で、ターンが同じかだけが効く） (#1)
