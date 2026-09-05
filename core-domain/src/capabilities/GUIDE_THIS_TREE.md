# GUIDE_THIS_TREE.md — core-domain/src/capabilities

この guide は `core-domain/src/capabilities/` 以下に適用する。

## Local invariants

- `CapabilityDependencyOutcome.kind` は通常の enumerable field とする。spread、`structuredClone`、JSON serialization を経ても discriminant を保持する。
- Project Tool binding の scope selector は permission 境界なので、対応 axis が execution context に無い場合は不適用として fail closed にする。既存 asset scope matcher の中立規則を再利用しない。
