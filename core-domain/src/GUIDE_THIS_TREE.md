# GUIDE_THIS_TREE.md — core-domain/src

この guide は `core-domain/src/` 以下に適用する。子ディレクトリに guide がある場合も先に読む。

## Local invariants

- asset frontmatter は versioned strict schema。未知の top-level key と未知 schema version を拒否する。新しい top-level 欄・namespace の追加は on-disk 公開契約の変更として `save-schema-check` を通し、project stage に応じて migration と asset schema version 更新の要否を決める。
- capability id と feature id は frontmatter キーへ逐語で埋め込む（`capability.features.<capabilityId>`）。識別子を受理する述語は `tokens.ts` の `isLowerKebabToken` 一本に揃える。在庫・offer 側だけ緩めると、保存できない依存を組み立てられてしまう。
- capability 依存の同一性キーは capabilityId 単独。frontmatter は capability ごとに1エントリしか持たないので、1つの capability への primary 参照は1件、その fallback も1件、fallback の `fallbackFor` は primary の feature 集合を逐語で再現する。feature 集合で参照を区別する設計は on-disk 表現を持たない。
- Skill の `metadata.*` は契約が名前を与えていないキーも受理し、`CanonicalSkill.additionalMetadata` として往復させる。type 固有 metadata の許可値集合は #87 が導入するまで存在しないので、type 固有 parser を足すときも契約外キーを落とさない。
- `AgentExecutionRecord` を DTO へ投影するときは `tryParseAgentExecutionDto` で runtime validation する。
- `AgentExecutionRecord.providerId` は、参照する Runtime と Model の `providerId` の両方に一致させる。各 ID の存在確認だけで組合せを受理しない。
