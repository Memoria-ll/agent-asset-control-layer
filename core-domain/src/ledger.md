# Ledger — core-domain/src

置き場の規則は root `AGENTS.md` の `## Ledger` にある。

## Traps

- asset frontmatter の未知 top-level key は validation error になる。新しい top-level 欄・namespace は
  on-disk 公開契約の変更として `save-schema-check` を通し、project stage に応じて migration と
  `schema-version` の要否を決める。v1 parser は未知 version を `incompatible_contract` で拒否する。
