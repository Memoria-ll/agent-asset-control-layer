# GUIDE_THIS_TREE.md — core/src/http

この guide は `core/src/http/` 以下に適用する。

## Local invariants

- request handler の例外は transport 境界で捕捉し、`internal` の `CoreErrorDto` を返す。handler 内の未捕捉例外は応答にならず接続を停止させる。
