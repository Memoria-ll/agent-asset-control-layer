# Phase B — capabilities 箱への移設

issue #100 / 統合ブランチ `integration/issue-100`。着地方法: **PR**。

---

## 1. 読む範囲

| 出典 | 範囲 | 何のために |
|---|---|---|
| `design/issue-100/design.md` §3 新規結合の明示宣言 | 64-79 | Resolver → Capability の一方向という制約 |
| `design/issue-100/design.md` §3 末尾 | 78 | 新箱は package を増やさない内部箱で、`ledger.md` と root 一覧の追加が要る |
| `design/issue-100/design.md` §11 の B 行 | — | 証明条件 |
| root `AGENTS.md` `### フォルダ構成` / `## Ledger` | — | 箱の定義と、箱を足すときに更新する場所 |
| `core-domain/src/resolution/ledger.md` | 全文 | capability 関連のエントリがどれか |

---

## 2. スコープガード

### やること

- `core-domain/src/resolution/capabilities.ts`（557 行）を
  **`core-domain/src/capabilities/dependencies.ts` へ `git mv` で逐語移動**する。
  中身は 1 バイトも変えない。
- 参照している 5 ファイル 6 行の import path を張り替える。
  - `core-domain/src/index.ts`（2 行）
  - `core-domain/src/resolution/candidate-validation.ts`（2 行）
  - `core-domain/src/resolution/dependency-evaluation.ts`（2 行）
  - `core-domain/src/resolution/protection-overlay.ts`（1 行）
  - `core-domain/src/resolution/resolution-types.ts`（1 行）
- 新箱の `core-domain/src/capabilities/ledger.md` を作り、`resolution/ledger.md` から
  capability 側に属するエントリを**移す**（両方に置かない）。
- root `AGENTS.md` の `## Ledger` の箱一覧へ `core-domain/src/capabilities/ledger.md` を足す。

### やらないこと

- **`capabilities.ts` の中身を変えない。** 型・関数・コメントを 1 バイトも変えるな。
  ファイル分割もするな。
- **`capabilitySnapshot` を required にしない。** 省略の扱いを変えるのは振る舞いの変更で、
  このフェーズの証明条件（同一スイート緑）と両立しない。Phase D が context union と
  一緒に決める。
- **`available` / `allowed` を分離しない。** Phase C。
- **`core-domain/tests/**` を変更しない。** テストは `../src/index.ts` からしか import して
  いないので（実測: 非 index の src import は 0 件）、`index.ts` の re-export 名を保てば
  無変更で通る。テストの変更が要るなら張り替えを間違えている。
- **テストツリーを箱に合わせて割らない。** `AGENTS.md` は「`core-domain/tests` は現状フラット
  なので 1 箱として扱う」と定めている。`capabilities.test.ts` はそのまま。
- `shared/`、`core/`、`vscode-extension/` を触らない。

---

## 3. 回帰テストの要件

| # | 要件 | 既存 / 新規 | 現状 |
|---|---|---|---|
| R1 | capability の意味論が変わらない | **既存** | `core-domain/tests/capabilities.test.ts` と `scope-resolver.test.ts` の capability 系。**書き換え禁止** |
| R2 | `core-domain` の公開面は `src/index.ts` の re-export が正 | **既存** | re-export 名の集合が不変であること。実測: 現在 88 名 |
| R3 | 依存方向と host 能力の禁止 | **既存・追加作業なし** | `dependency-boundary.test.ts` が `../src/**/*.ts` を全数走査するので新箱を自動的に含む |
| R4 | 共通 pipeline に asset type の分岐が入らない | **既存** | `asset-type-contracts.test.ts` の scan 対象は `../src/resolution/*.ts`。`capabilities.ts` が箱の外へ出るので走査対象から 1 ファイル減る。**これは意図した縮小**で、当該ファイルは型 dispatch pipeline ではなく、実測でも禁止パターンは 0 件だった |

**新規テストは書かない。** 逐語移設なので、同一スイート緑が証明である。

---

## 4. 証明条件

1. `git mv` の diff が rename として検出され、内容の変更が 0 行であること
   （`git diff --numstat` の当該ファイルが `0 0`、または rename 表示）。
2. `core-domain/src/index.ts` の re-export 名の集合が不変（88 名）。
3. `core-domain/tests/**` の diff が 0 行。
4. `pnpm -r test` で `core-domain` 231 件緑。
5. `bash ~/.claude/scripts/run-gate.sh` が exit 0（4 step すべて PASS）。
6. コードに旧 path が残っていない — `git grep -n "resolution/capabilities" -- '*.ts'` が 0 件。
   設計・仕様文書は移設前の状態や移設そのものを述べるので、この検査の対象外とする。

---

## 5. Ledger の移管

`core-domain/src/resolution/ledger.md` のうち **capability 側に属するエントリを新箱へ移す**。
判定は「そのエントリに違反しうる編集がどの箱で起きるか」で行う（root `AGENTS.md` の規則）。

- capability の catalog / offer / feature の内部規則を述べたもの → `capabilities/ledger.md`
- Resolver が capability の結果をどう扱うかを述べたもの → `resolution/ledger.md` に残す
- **同じエントリを両方に置かない。** 守備範囲が変わったものは移す。

新箱の `ledger.md` は、エントリが 1 件も無いなら「エントリなし」とだけ書く
（`core-domain/tests/ledger.md` が先例）。
