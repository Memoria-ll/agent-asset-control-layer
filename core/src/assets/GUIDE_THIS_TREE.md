# GUIDE_THIS_TREE.md — core/src/assets

この guide は `core/src/assets/` 以下に適用する。

## Local invariants

- `save` の直列化キーは `resolve()` 済み root directory とし、chain は module scope で共有する。`rootId` は同じ directory に複数付けられるため排他キーにしない。
- managed root の同一性は `resolve()` による字句正規化で扱う。symlink alias や case-insensitive filesystem 上の綴り違いは同一 root と判定できない。
