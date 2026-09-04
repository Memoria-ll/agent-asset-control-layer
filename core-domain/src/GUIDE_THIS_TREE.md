# GUIDE_THIS_TREE.md — core-domain/src

この guide は `core-domain/src/` 以下に適用する。子ディレクトリに guide がある場合も先に読む。

## Local invariants

- asset frontmatter は versioned strict schema。未知の top-level key と未知 schema version を拒否するため、新しい directive や field の導入は asset schema version の更新として設計する。
- host path、clock、process、network、filesystem などの能力を domain logic に持ち込まず、入力値または注入した純粋な seam から受け取る。
