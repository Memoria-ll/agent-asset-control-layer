# GUIDE_THIS_TREE.md — core/src/http

この guide は `core/src/http/` 以下に適用する。

## Local invariants

- request handler の例外は transport 境界で捕捉し、raw exception detail は `core.request_failed` にだけ記録する。応答には例外由来の message / details を含めず、generic な `internal` の `CoreErrorDto` を返す。
