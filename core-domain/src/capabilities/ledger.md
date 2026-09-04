# Ledger — core-domain/src/capabilities

置き場の規則は root `AGENTS.md` の `## Ledger` にある。

## Traps

- **`CapabilityDependencyOutcome` の判別子 `kind` は通常の列挙可能欄で持つ。**
  `Object.defineProperty(..., { enumerable: false })` で隠すと直接読みだけが通り、
  spread / `structuredClone` / `JSON.stringify` を経た値から欠落する。**typecheck は
  宣言型どおり `kind` を保ったまま緑で、既存の exact-shape assertion（`toEqual`）も
  received 側から欄が消えるため緑のまま通る** — 破れるのは公開型に反する値が
  consumer へ渡ったときだけ。outcome の欄を増やしたら exact-shape の期待値を更新する
  側で吸収する (#100)
