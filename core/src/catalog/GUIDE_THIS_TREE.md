# GUIDE_THIS_TREE.md — core/src/catalog

この guide は `core/src/catalog/` 以下に適用する。

## Local invariants

- execution-target catalog は `readFile` の前に `stat().isFile()` で regular file を確認する。
