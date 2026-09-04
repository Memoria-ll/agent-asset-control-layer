# GUIDE_THIS_TREE.md — shared/tests

この guide は `shared/tests/` 以下に適用する。

## Known traps

- JSON Schema の root と union arm の strictness 検査は nested object property まで保証しない。nested boundary object を追加したときは `additionalProperties` を個別に固定する。
