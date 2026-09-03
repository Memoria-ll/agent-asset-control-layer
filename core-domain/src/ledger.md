# Ledger — core-domain/src

置き場の規則は root `AGENTS.md` の `## Ledger` にある。

## Traps

- asset frontmatter の未知 top-level key は validation error になる。`mandatory` / `priority` /
  `disable` / `override` も v1 では拒否される。**#4 がこれらの directive を導入するときは
  asset schema version（`schema-version:`）の bump が要る** — v1 parser は未知 version を
  `incompatible_contract` で拒否し、暗黙の migration を行わない (#2)
