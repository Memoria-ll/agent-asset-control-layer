# Ledger — shared/tests

置き場の規則は root `AGENTS.md` の `## Ledger` にある。

## Traps

- **`shared/tests/json-schema.test.ts` の strict object 検査は root の `oneOf` までしか展開せず、
  nested object property へは降りない。** 境界 DTO が nested object を持つとき
  （`WorkflowDefinitionDto` の stage / transition など）、その strictness は汎用網の**外**にある。
  registry に登録しただけでは検査されないので、nested の `additionalProperties` は
  個別 assertion で pin する (#7)
