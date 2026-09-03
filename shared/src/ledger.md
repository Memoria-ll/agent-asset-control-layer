# Ledger — shared/src

置き場の規則は root `AGENTS.md` の `## Ledger` にある。

## Traps

- 境界 DTO は `z.strictObject`。`z.object` でも既定の `z.toJSONSchema` は
  `additionalProperties: false` を書くため、公開 schema を読んでも差が出ない。差を捕まえるのは
  `io: "input"` と `io: "output"` の突き合わせだけで、`contractSchemas` から到達しない schema
  （`CompatibilityResult` / `DegradedInfo`）はこの網の外にある (#46)
