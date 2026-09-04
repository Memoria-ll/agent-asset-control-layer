# GUIDE_THIS_TREE.md — core/src/projects

この guide は `core/src/projects/` 以下に適用する。

## Local invariants

- Marker は schema version 1 の strict object で、`projectId` は `^project-[a-z0-9-]+$`、全長 128 文字以内とする。
- Marker を読む全経路で `.aacl` を real directory、Marker を regular file として扱い、no-follow descriptor と前後の `dev` / `ino` guard で同じ source を読んだことを確認する。
- Registry の read-modify-write は恒久 lock file に対する OS-native exclusive FD lock と atomic persist で保護する。lock file を unlink / rename せず、protocol 外 writer は保証対象に含めない。
- init の途中状態は `pending` として durable に残し、Marker の観測結果から `bound` または `mismatch` を確定する。異なる Marker identity で既存 binding を上書きしない。
