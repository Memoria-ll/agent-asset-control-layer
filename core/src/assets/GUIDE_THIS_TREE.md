# GUIDE_THIS_TREE.md — core/src/assets

この guide は `core/src/assets/` 以下に適用する。

## Local invariants

- `save` の直列化キーは `resolve()` 済み root directory とし、chain は module scope で共有する。`rootId` は同じ directory に複数付けられるため排他キーにしない。
- `AssetRevision` は canonical frontmatter と body の内容 hash。同じ revision を同じ内容として畳む resolver の前提なので、revision の生成規則を変える変更では resolver の deduplication も見直す。
- `save` の `relativePath` は Windows でも安全な名前だけを受理する。`list` は手作業で置かれた filesystem file を読むため同じ制限を課さず、list 結果がそのまま save 可能とは限らない。
- managed root の同一性は `resolve()` による字句正規化で扱う。symlink alias や case-insensitive filesystem 上の綴り違いは同一 root と判定できない。
