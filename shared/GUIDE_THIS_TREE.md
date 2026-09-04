# GUIDE_THIS_TREE.md — shared

この guide は `shared/` 以下に適用する。`src/` または `tests/` の子 guide がある場合も先に読む。

## Change considerations

- JSON Schema の root と union arm の strictness 検査は nested object property まで保証しない。nested boundary object を `src` へ追加した変更では、`tests` に `additionalProperties` の個別 assertion を追加する。
