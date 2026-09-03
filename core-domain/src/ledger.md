# Ledger — core-domain/src

置き場の規則は root `AGENTS.md` の `## Ledger` にある。

## Traps

- 境界の値集合（`ASSET_TYPES` 等）の正は #2 の Canonical Asset model。#2 Scope が初期 type として
  Skill / Rule / Role / Workflow / Task Type / Policy / Guardrail / Knowledge の 8 個を挙げており、
  `ASSET_TYPES` はこれと一致している。README の製品説明はこれより広い語（templates / checklists /
  capability bindings）を含むが型の正ではない。**#2 が type を増やしたら同じ変更で `ASSET_TYPES` を
  更新する** — enum への値追加は破壊的変更 (#47)

- asset frontmatter の未知 top-level key は validation error になる。`mandatory` / `priority` /
  `disable` / `override` も v1 では拒否される。**#4 がこれらの directive を導入するときは
  asset schema version（`schema-version:`）の bump が要る** — v1 parser は未知 version を
  `incompatible_contract` で拒否し、暗黙の migration を行わない (#2)

- **`Array.isArray` は union から `readonly string[]` を除去しない。** `AssetFieldValue`
  （`string | readonly string[]`）を絞るのに使うと、false 分岐に配列が残って scalar 側が
  `string` にならない。`typeof value === "string"` で判別する (#5)

- **`AgentExecutionRecord.providerId` は、指定された Runtime / Model 定義の `providerId` と一致する必要がある。**
  各 ID の存在確認だけでは、別 Provider に属する実行先の組合せを通してしまう (#66)
