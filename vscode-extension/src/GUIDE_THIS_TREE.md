# GUIDE_THIS_TREE.md — vscode-extension/src

この guide は `vscode-extension/src/` 以下に適用する。

## Local invariants

- Extension は Project Init / discovery を transport-neutral な `ProjectClient` 境界から利用し、Core service 実装へ直接依存しない。
