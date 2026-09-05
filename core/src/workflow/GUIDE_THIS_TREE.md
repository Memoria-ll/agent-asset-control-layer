# GUIDE_THIS_TREE.md — core/src/workflow

この guide は `core/src/workflow/` 以下に適用する。

## Local invariants

- State store は新規 ID を作るときは注入された乱数 suffix から `instance-<suffix>` を組み立て、composite commit が先に発行した ID を保存するときは caller の execution instance ID も同じ filename 検証へ通す。安全な文字集合は `[a-z0-9-]` とし、正規化せず不正値を拒否する。
- filesystem の identity 検査は Core が所有する state directory 以下に限定し、設定 root より上の運用者所有 ancestor へ広げない。
