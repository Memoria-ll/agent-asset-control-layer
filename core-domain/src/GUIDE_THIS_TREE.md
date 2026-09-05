# GUIDE_THIS_TREE.md — core-domain/src

この guide は `core-domain/src/` 以下に適用する。子ディレクトリに guide がある場合も先に読む。

## Local invariants

- asset frontmatter は versioned strict schema。未知の top-level key と未知 schema version を拒否するため、新しい directive や field の導入は asset schema version の更新として設計する。
- `CanonicalAsset` の省略された directive はキー自体を作らない。resolver は `explicitPriority` 未指定を最低順位、明示 `0` を値 `0` として扱うため、parser 側で既定値を埋めると順位だけが静かに変わる。
- merge mode の既定値は `AssetTypeContract.mergePolicy.defaultMode` が所有する。asset parser と candidate projection の両方に既定値を置かない。
- `AgentExecutionRecord` を DTO へ投影するときは `tryParseAgentExecutionDto` で runtime validation する。
- `AgentExecutionRecord.providerId` は、参照する Runtime と Model の `providerId` の両方に一致させる。各 ID の存在確認だけで組合せを受理しない。
