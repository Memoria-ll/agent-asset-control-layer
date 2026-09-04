# GUIDE_THIS_TREE.md — shared/src

この guide は `shared/src/` 以下に適用する。子ディレクトリに guide がある場合も先に読む。

## Local invariants

- 境界 DTO は `z.strictObject` を使う。plain `z.object` の JSON Schema 表現だけでは input と output の unknown-key behavior の差を検出できない。
- 閉じた値集合は `as const` の member array を正とし、schema と runtime export を同じ集合から作る。schema internals を consumer に読ませない。
- parser にしか表せない cross-field 制約を公開 JSON Schema と同等の制約として扱わない。契約 shape の変更が必要な制約は独立して設計する。
