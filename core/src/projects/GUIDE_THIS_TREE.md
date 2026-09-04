# GUIDE_THIS_TREE.md — core/src/projects

この guide は `core/src/projects/` 以下に適用する。

## Local invariants

- init の途中状態は `pending` として durable に残し、Marker の観測結果から `bound` または `mismatch` を確定する。異なる Marker identity で既存 binding を上書きしない。
