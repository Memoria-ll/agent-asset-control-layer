# GUIDE_THIS_TREE.md — core/src/assets

この guide は `core/src/assets/` 以下に適用する。

## Local invariants

- `save` の直列化キーは `resolve()` 済み root directory とし、chain は module scope で共有する。`rootId` は同じ directory に複数付けられるため排他キーにしない。
- request の `loadingTiers` は配信範囲の選択であり、resolution 入力の絞り込みに使わない。overlay と対象の tier は一致を強制されず `requires` も tier を跨ぐため、snapshot 側で落とすと issuer が消えて対象が黙って included のまま残るか、対象が消えて `operation_conflict` になる。`resolveScope` は全候補で走らせ、結果の `evaluations` だけを絞る。`outcome` と `conflicts` は resolution 全体の性質なので絞らない。
