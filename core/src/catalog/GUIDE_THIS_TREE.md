# GUIDE_THIS_TREE.md — core/src/catalog

この guide は `core/src/catalog/` 以下に適用する。

## Local invariants

- execution-target catalog は `readFile` の前に `stat().isFile()` で regular file を確認する。
- `AgentExecutionRecord` を DTO へ投影するときは `tryParseAgentExecutionDto` で runtime validation する。
- `AgentExecutionRecord.providerId` は、参照する Runtime と Model の `providerId` の両方に一致させる。各 ID の存在確認だけで組合せを受理しない。
