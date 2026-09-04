# GUIDE_THIS_TREE.md — core/src/workflow

この guide は `core/src/workflow/` 以下に適用する。

## Local invariants

- State store は execution instance ID 全体を受け取らず、注入された乱数 suffix を検証して `instance-<suffix>` を組み立てる。安全な文字集合は `[a-z0-9-]` とし、正規化せず不正値を拒否する。
- filesystem の identity 検査は Core が所有する state directory 以下に限定し、設定 root より上の運用者所有 ancestor へ広げない。
- `ExecutionInstanceId` は全 Workflow Definition を通じて一意。`workflowId` は namespace ではなく、保存済み state の所属不一致を検出する値として扱う。
- Workflow State と Agent Execution の link は双方向で保持する。両者を別 document に永続化する実装では、片側の atomic rename を全体の transaction と扱わない。
