# GUIDE_THIS_TREE.md — core-domain/src/capabilities

この guide は `core-domain/src/capabilities/` 以下に適用する。

## Local invariants

- `CapabilityDependencyOutcome.kind` は通常の enumerable field とする。spread、`structuredClone`、JSON serialization を経ても discriminant を保持する。
