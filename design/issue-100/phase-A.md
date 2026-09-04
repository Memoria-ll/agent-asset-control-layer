# Phase A — 7 seam へのファイル分割

issue #100 / 統合ブランチ `integration/issue-100`。

**着地方法: PR を作らず `--no-ff` で `integration/issue-100` へ直接マージする**（ユーザー裁定
2026-09-04）。証明成果物（下記）を統合 commit のメッセージに記載する。

---

## 1. 読む範囲

`design/issue-100/design.md` の以下を読む。全文を読む必要はない。

| 章 | 行範囲 | 何のために |
|---|---|---|
| §1 設計の前提となる実測 | 3-16 | 行数・宣言数・consumer 0 件の根拠 |
| §3 7 seam と判断の所有者 | 48-63 | **7 seam の module 名と所有する判断。この表が分割の正** |
| §3 新規結合の明示宣言 | 64-79 | 追加してよい import 方向。`capabilities` 箱への結合は Phase B |
| §3 resolution Ledger の全エントリと移管先 | 80-98 | 10 エントリをどの seam の `ledger.md` へ移すか |
| §3 軸語彙と `matchedAxes` の契約 | 106-125 | `axis-mapping.ts` の役割 |
| §4 データフロー / 固定点の反復状態 | 126-174 | seam 間で渡す値と反復の終了条件 |
| §5 7 seam の型定義 | 175-405 | 各 seam の入出力型 |
| §9 asset type source scan の拡張 | 788-793 | **glob 拡張。本フェーズの成果物** |
| §10.1 normalise-and-sort source comparison | 816-830 | **証明手順。正規化規則 6 項** |
| §11 フェーズ表の A 行 | 843-855 | 証明条件 |

要件は `.requiments/agent-asset-control-layer-requirements-decomposed.md` の RES-001〜018
（190-298 行）。**Phase A は挙動を一切変えないので、要件は「変えていないこと」の確認にのみ使う。**

Ledger は `core-domain/src/resolution/ledger.md`（全 10 エントリが load-bearing）と
root `AGENTS.md` の `## Ledger` を読む。

---

## 2. スコープガード

### やること

- `core-domain/src/resolution/scope-resolver.ts` の 873-2287 行（`resolveScopeFixedPoint`）の
  意味論を、design §3 の表が定める 7 module へ移す。
  - `candidate-validation.ts` / `scope-matching.ts` / `protection-overlay.ts` /
    `ranking-precedence.ts` / `dependency-evaluation.ts` / `type-resolution.ts` /
    `result-assembly.ts`
  - 合成のみを持つ `pipeline.ts`（順序・反復・終了条件・failure short-circuit だけ）
  - 共通型の `resolution-types.ts`、軸対応の `axis-mapping.ts`
- 公開入口 `resolveScope` を `pipeline.ts` の実装へ接続する。`core-domain/src/index.ts` の
  re-export を新 module へ付け替える。
- `core-domain/tests/asset-type-contracts.test.ts:368-382` の
  `import.meta.glob<string>("../src/resolution/scope-resolver.ts")` を
  `import.meta.glob<string>("../src/resolution/*.ts")` へ拡張し、
  `source === undefined` の throw を「glob が返した map のキー集合が空なら throw」へ書き換える。
- `scope-resolver.ts` を削除する。`resolveScopeFixedPoint` と、その実装だけを支える
  nested type / Map / SCC / operation helper / selection helper を残さない。
- `core-domain/src/resolution/ledger.md` の 10 エントリを design §3（80-98 行）の割当てに従って
  各 seam の記述へ更新する。`AGENTS.md` の `### レイヤ / seam mapping` と `### フォルダ構成` の
  記述を新しい module 構成へ同期する。

### やらないこと（後続フェーズ）

- **公開契約を一切変えない。** `ResolveRequest.scope` / `ResolvedContextDto` /
  `ResolutionReason` / `ConflictDto` / `CONTRACT_VERSION` はそのまま。`shared/` を触らない。
- **`core-domain/src/capabilities/` を作らない。** `resolution/capabilities.ts` は現在地のまま
  残し、`dependency-evaluation.ts` はそこから import する。箱の移設は Phase B。
- **`available` / `allowed` の分離をしない。** Phase C。
- **`executionMode` / `workflow.kind` / `standalone` / `matchedAxes` の公開を導入しない。** Phase D。
  `axis-mapping.ts` は本フェーズで作るが、用途は on-disk kebab 軸 ↔ resolver camel 軸の
  対応を 1 箇所へ集約することに限り、公開契約へは出さない。
- **`TaskId` / `workflowRevision` / `provenance` を導入しない**（#110 / #13 / #14 が owner）。
- Core HTTP route と Extension client の配線を追加しない（#12 / #31）。

---

## 3. 回帰テストの要件

| # | 要件 | 既存 / 新規 | 実測した現状 |
|---|---|---|---|
| R1 | 118 件の直接 `it(` が公開入口 `resolveScope` 経由で同一結果を返す | **既存** | `core-domain/tests/scope-resolver.test.ts`、`resolve()` helper（137-145 行）が `resolveScope` を呼ぶ。**書き換え禁止** |
| R2 | `it.each` 9 宣言（223 / 462 / 865 / 900 / 1082 / 1329 / 2063 / 2084 / 2135 行）が同一結果を返す | **既存** | 同上 |
| R3 | 固定点意味論（排他 winner の disable / override 後の再選択、operation feedback、SCC、収束）が保たれる | **既存** | 18 件（951 / 973 / 996 / 1032 / 1066 / 1150 / 1194 / 1277 / 1453 / 1471 / 1521 / 1533 / 1588 / 1616 / 1656 / 1889 / 1906 / 1921 行）。design §8（713-739 行）に裁定済み保全として明記 |
| R4 | 共通 pipeline に asset type の分岐が入らない | **既存を拡張** | `asset-type-contracts.test.ts:368-382` の source scan。**現状 1 ファイル固定なので、分割した時点で新 seam が無検査になる。glob 拡張は本フェーズの成果物**（§2 参照）。実測: 現行 `resolution/` の 4 ファイルすべてで `assetType\s*[!=]==?\s*"` と `switch\s*\([^)]*assetType` は 0 件 |
| R5 | `core-domain` が host 能力に触れない / 依存方向が保たれる | **既存・追加作業なし** | `core-domain/tests/dependency-boundary.test.ts` は `import.meta.glob("../src/**/*.ts")` で走査するため、新 seam file を自動的に含む。R4 との違いに注意 — こちらは `**` なので窓が開かない |
| R6 | `core-domain` の公開面は `src/index.ts` の re-export が正 | **既存** | `core-domain/tests/**` が `../src/index.ts` 以外から公開 API を引いていないこと。確認: `grep -n 'from "\.\./src/[a-z/-]*\.ts"' core-domain/tests/*.ts` の非 index 行が 0 件 |

**新規テストは書かない。** Phase A は振る舞い保存であり、`rules/refactoring.md` の
「同一のテストスイートが前後で緑」が証明の一方である。新しい assertion を足すと、
何を保存したのかが曖昧になる。

---

## 4. 証明成果物（統合 commit に記載する）

1. **normalise-and-sort source comparison が `0 missing / 0 added`。**
   design §10.1（816-830 行）の正規化規則 6 項をそのまま適用する。比較対象は
   「旧 `scope-resolver.ts` の extraction manifest に記載した semantic body」と
   「移送先 owner の body」。`pipeline.ts` の合成コードと contract DTO は比較対象外。
   **比較 script はリポジトリの production / test tree へ置かない**（作業ブランチのみ）。
   差分が出たら allowlist 化せず、owner の割当てか extraction manifest を修正して再比較する。
2. **extraction manifest** — 旧 873-2287 行の各 helper / state / nested type が、どの新 owner の
   どのシンボルへ移ったかの一対一表。1 の比較単位を定義するので、比較より先に作る。
3. `pnpm -r test` で既存 118 + 9 が緑。
4. `bash ~/.claude/scripts/run-gate.sh` が exit 0（4 step すべて PASS）。
5. `git grep -c resolveScopeFixedPoint` が 0。`scope-resolver.ts` が存在しない。

---

## 5. 実装上の注意（Ledger 由来）

`core-domain/src/resolution/ledger.md` の 10 エントリはすべて本フェーズで移送される。特に:

- **capability context は冒頭で 1 度だけ `validateCapabilityContext` した結果を、候補構造検証と
  依存評価の両方へ渡す。** 検証側だけ context 無しで呼ぶと、definition に無い feature を要求する
  候補が構造検証を通り、評価側が `invalid_request` を返して
  `throw new Error("Validated capability dependencies must evaluate successfully.")` に落ちる。
  `CoreFailure` ではなく例外になるので consumer からは resolver のクラッシュに見える。
  **seam 1 と seam 5 に分かれるので、この単一検証を pipeline が値で渡す形にすること。**
- **`selectUnbeaten` の空集合は「勝者不在」であって「相反」ではない。** rank cycle で空になっても
  全 action が `disable` なら conflict にせず output 順で coalesce する。
- **`dependencyOutcomes` の失敗種別は component 単位で union してから各メンバーへ配る。**
  union の対象は 2 つあり両方が要る — メンバー自身の失敗と、いずれか 1 メンバーが component 外へ
  張るエッジ経由で受け取る失敗。どちらか一方を落とすと診断そのものが結果から消える。
- **軸語彙は 2 つあり 8 個が改名・1 個が同名**（`ASSET_SCOPE_AXES` の kebab と `RESOLUTION_AXES`
  の camel、`task-type` → `taskTypeId` は非自明）。**両者とも string キーなので、取り違えても
  typecheck も gate も緑のまま通る。** `axis-mapping.ts` はこの対応を 1 箇所へ集約するために作る。
- **exclusive winner は「他のどの候補にも負けない候補が一意ならそれ、いなければ conflict」で
  選ぶ。候補を段階的に脱落させる形にしない。** directory 特則と一般 key は混在集合に対して
  非推移で、先に脱落させると自分では勝てない候補を足すだけで勝者が変わる。

`AGENTS.md` の Traps では次が効く:

- **`tsconfig.base.json` に `noUnusedLocals` は無い。** 使われなくなった import を消し忘れても
  typecheck は緑。**helper を別ファイルへ切り出す変更は、追加側と削除側を別の完了項目として
  数え、削除側を `grep -c` で確認する。**
- **`shared` は build を持たないので相対 import 指定子は `.ts` で書く。** `.js` だと typecheck も
  test も緑のまま素の Node が `ERR_MODULE_NOT_FOUND` で落ちる（gate の node-resolution step が検出）。
- **vitest は型を消して実行するので、`exactOptionalPropertyTypes` 違反はテストを緑にしたまま
  typecheck だけを落とす。** optional 欄を持つ値は「キーごと置かない」条件付きスプレッドで組む。
