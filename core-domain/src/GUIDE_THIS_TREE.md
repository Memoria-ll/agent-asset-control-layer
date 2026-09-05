# GUIDE_THIS_TREE.md — core-domain/src

この guide は `core-domain/src/` 以下に適用する。子ディレクトリに guide がある場合も先に読む。

## Local invariants

- asset frontmatter は versioned strict schema。未知の top-level key と未知 schema version を拒否する。新しい top-level 欄・namespace・directive の追加は on-disk 公開契約の変更として `save-schema-check` を通し、asset schema version の更新として設計したうえで、project stage に応じて migration の要否を決める。
- `CanonicalAsset` の省略された directive はキー自体を作らない。resolver は `explicitPriority` 未指定を最低順位、明示 `0` を値 `0` として扱うため、parser 側で既定値を埋めると順位だけが静かに変わる。
- merge mode の既定値は `AssetTypeContract.mergePolicy.defaultMode` が所有する。asset parser と candidate projection の両方に既定値を置かない。
- capability id と feature id は frontmatter キーへ逐語で埋め込む（`capability.features.<capabilityId>`）。識別子を受理する述語は `tokens.ts` の `isLowerKebabToken` 一本に揃える。在庫・offer 側だけ緩めると、保存できない依存を組み立てられてしまう。
- capability 依存の同一性キーは capabilityId 単独。frontmatter は capability ごとに1エントリしか持たないので、1つの capability への primary 参照は1件、その fallback も1件、fallback の `fallbackFor` は primary の feature 集合を逐語で再現する。feature 集合で参照を区別する設計は on-disk 表現を持たない。
- `serializeCanonicalAsset` が正準順序を要求するのは `requires`、各 scope 軸、capability の全 feature list（primary / fallback / `fallbackFor`）の3箇所だけで、`validateAsset` は読込時にその3つを整列する。type 固有の Canonical Asset 構築関数はこの3つを整列してから serializer へ渡す。片方だけ整列すると、同じ値が読込経由では通り構築経由では拒否される。metadata のリスト値はどちらの経路も並べ替えないので、caller の順序がそのまま保存順になる。
- Skill の `metadata.*` は契約が名前を与えていないキーも受理し、`CanonicalSkill.additionalMetadata` として往復させる。type 固有 metadata の許可値集合は #87 が導入するまで存在しないので、type 固有 parser を足すときも契約外キーを落とさない。
- type 固有の Canonical Asset 構築関数は、その型が名前を与えていない asset 欄（`mandatory` / `priority` / `merge-mode` / `merge-group`）を入力から再構成できない。`SkillInput.resolutionDirectives` のように元の asset から逐語で受け取って載せる。載せ忘れると、無関係な項目だけの更新でその欄が保存時に消える。
- `AgentExecutionRecord` を DTO へ投影するときは `tryParseAgentExecutionDto` で runtime validation する。
- `AgentExecutionRecord.providerId` は、参照する Runtime と Model の `providerId` の両方に一致させる。各 ID の存在確認だけで組合せを受理しない。
