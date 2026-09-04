# Phase C — available と allowed の分離

issue #100 / 統合ブランチ `integration/issue-100`。着地方法: **PR**。
**初めての挙動変更フェーズ**であり、証明は「新規テストの赤証明 → 実装後 green」。
Phase A / B の「同一スイート緑」はここでは証明にならない。

---

## 1. 要件

`.requiments/agent-asset-control-layer-requirements-decomposed.md`:

- **CAP-006** — 「Tool/MCP が接続されていることと使用許可されていることを別状態として扱うこと。
  **検証条件: available=true, allowed=false を表現可能。**」（出典 §32）
- **CAP-007** — 「MCP/Tool に available / allowed / preferred / required を区別可能とすること。
  検証条件: Resolver が権限制約を含めて実行可能性を判定できる。」
- **RES-012** — 「fallback dependency が成立した場合、fallback 採用と理由を返すこと。
  検証条件: Primary unavailable 時に**許可された** fallback へ切替可能。」

`preferred` / `required` は **dependency の強度**であって offer の状態ではない。根拠は
**CAP-004（出典 §31）**「Capability/MCP 依存に required / optional / preferred / fallback を
設定できること」で、実装も `CapabilityDependency.strength`
（`core-domain/src/capabilities/dependencies.ts:24-32`）がこれに一致する。
**§32 は根拠にならない** — 原文（`requirements.md:1160-1164`）は「『接続されている』と
『使用を許可されている』を分離する」の 1 行だけで、`preferred` / `required` に言及がない。

同一 capability を複数 MCP が同時提供する場合の選好は、offer が provider を同定しない
現行モデルでは表現できず、**#82** の Scope が所有する。Phase C では扱わない。

裁定済み（2026-09-04）: **第三の「未観測」状態は作らない。**

---

## 2. 実測した現状

| 事実 | 出典 |
|---|---|
| `CapabilityOffer` は `{ capabilityId, features }` の 2 欄で permission を持たない | `capabilities/dependencies.ts:35-38` |
| `capabilityAvailable` は boolean を返し、呼び出しは 2 箇所（primary と fallback）だけ | 同 396-404、470 / 473 |
| offer の正規化・検証は `validateCapabilityContext` の 1 箇所で、`offers.push({ capabilityId, features })` と**組み直す** | 同 242-266（push は 265） |
| offer の重複キーは `JSON.stringify([offerId, features])` で permission を含まない | 同 259 |
| 失敗理由は `reasons: readonly string[]` の散文。`capabilityReasonText` が組み立て、現在すべて `is unavailable.` で終わる | 同 51-61、406-416 |
| 内部 cause は `"capability_unavailable"` にハードコードされている | `resolution/dependency-evaluation.ts:67`、`:317` |
| offer 構築はテストのヘルパ 2 箇所だけ。インライン構築は 0 件 | `capabilities.test.ts:41-44`、`scope-resolver.test.ts:63-66` |

### wire に何が出ているか（**ここは最初の版で書き誤っていた**）

| 経路 | 実際に consumer が受け取るもの | 出典 |
|---|---|---|
| required の hard failure | `{ kind: "unavailable", explanation: "The candidate is unavailable because a requirement failed.", availability }` の**固定文**。capability ID も理由の散文も**出ない** | `resolution/result-assembly.ts:300` |
| optional / preferred の degraded | `explanation` に `reason.degradedInfo.reasons.join(" ")` が**連結される**。つまり `capabilityReasonText` の文がそのまま consumer に届く | 同 288-291 |
| mandatory 候補の conflict | `conflictExplanation` が `failedCapabilities` の ID を散文に載せる | 同 281 |

したがって Phase C 後の観測可能性は**非対称**になる — denied と未接続の区別は
**degraded 候補では散文として consumer に届き、required hard failure では届かない**。
これは Phase C の欠陥ではなく、理由を機械可読にする作業（Phase D と #92）の対象である（§8）。

---

## 3. 採る形

```ts
export type CapabilityOffer = {
  readonly capabilityId: CapabilityId;
  readonly features: readonly CapabilityFeatureId[];
  readonly permission: "allowed" | "denied";
};
```

- **`permission` は必須欄。** optional にして「省略＝allowed」にすると、root `AGENTS.md`
  Ledger が `capabilityContext` について記録しているのと同じ「省略が特定の値として黙って
  評価される」罠を capability 側に再生産する。producer に必ず表明させる。
- **`boolean` ではなく literal union。** 真偽値は false が既定値にも見え、境界を
  enumerated shape で書く既存方針とも合わない。

### offer の存在を available の符号化とする（親設計からの変更）

親設計 `design.md:366` / `:546` / `:839` / `:853` / `:866` は
`availability: "available" | "unavailable"` と `permission` の**直積**で観測すると書いている。
**Phase C はこれを畳み、`availability` 欄を作らない。** 表現できる状態は
「offer 無し = 未接続」「offer あり + allowed」「offer あり + denied」の 3 つになる。

理由: `availability` 欄に読み手が無い。`AGENTS.md` の shared 規約
「consumer が実行時に必要とするものは、その都度足す。将来必要になるかもしれないものを
憶測で先に足すこともしない」を capability 側にも適用する。「設定済みだが現在未接続」を
producer が表明したくなったら、その producer（#82）が来る変更で足せる。
**この乖離は同じ変更で `design.md` の 5 箇所を書き換えて解消する**
（`rules/phased-delivery.md`「設計文書は実践が乖離する phase で修正する」）。

### `capabilityAvailable` を三値にする

理由文を「未接続」と「許可されていない」に書き分けるには、predicate が boolean では足りない。
**新しい層は作らず、この 1 関数の戻り値を三値にする。**

```ts
type CapabilityUsability = "usable" | "denied" | "missing";
```

- `missing` — features を満たす offer が 1 件も無い
- `denied` — features を満たす offer はあるが、`permission === "allowed"` のものが無い
- `usable` — features を満たしかつ allowed の offer がある

**複数 offer が混在する場合はこの存在量化がそのまま述語になる**
（`capabilities.test.ts:94-103` の C6 が features 違いの複数 offer を持つ形）。

### 内部 cause を分岐させる（Phase D の受け皿を Phase C で埋める）

`design.md:481-486` は Phase D の wire に `cause: "capability_unavailable" | "capability_not_allowed"`
を出すと決めている。しかし内部 cause は `dependency-evaluation.ts:67` / `:317` で
`"capability_unavailable"` にハードコードされており、判別材料が
`CapabilityDependencyOutcome`（`dependencies.ts:57-60`）に無い。

**判別材料を作るところまでを Phase C が持つ。** `CapabilityDependencyOutcome` の失敗アームに
失敗種別を載せ、`dependency-evaluation.ts` の 2 箇所で内部 cause を分岐させる。
`shared/` は無変更、`CONTRACT_VERSION` は据え置き、`resolution-types.ts` の内部 union に
1 値を足すだけで収まる。Phase D はこの内部値を投影するだけになる。

**denied と missing が同一候補に混在したときは `capability_not_allowed` を優先する（fail-closed）。**
permission の拒否は policy の表明であり、接続不足として報告すると「なぜ進められないか」を
過小に伝えるため。**この優先順位は Phase D で wire に出た時点で外部観測されるので、
Phase D のユーザー裁定項目として §8 に挙げる。**

### 重複キーは変えない（新しい制約ではなく現状の維持）

`JSON.stringify([offerId, features])` のままにする。同一 capability・同一 features の 2 件は
**permission 導入以前からすでに** `duplicate_capability_offer` で拒否されている
（`dependencies.ts:259-263`）。Phase C はこの制約を新設しない。

理由は「矛盾だから」ではない — **offer が provider を同定しないので 2 件は区別できず、
複数 MCP の統合（どちらの permission を採るか）は producer（#82）の責務**だからである。
畳み規則そのものはどこにも定義されていない。§7 で Ledger に 1 行残す。

### 既存の理由文はバイト単位で据え置く

`capabilities.test.ts:221` と `:235` が
`'Capability "filesystem" with optional strength is unavailable.'` を逐語 pin している。
**未接続側の文は 1 バイトも変えず、denied 側の文だけを新設する。**
両方書き換えると既存が赤になり、原因を誤診する。

---

## 4. スコープガード

### やること

- `CapabilityOffer` に必須欄 `permission` を足す。
- `validateCapabilityContext` の offer 正規化（`dependencies.ts:242-266`）で `permission` を
  検証・正規化する。**不正値・欠落は新しい detail code `invalid_capability_permission` で
  拒否する** — 既存テストはすべて `code` を assert しているので、code の命名は仕様の一部。
- `capabilityAvailable` を三値化し、呼び出し 2 箇所（`:470` primary、`:473` fallback）を直す。
- `capabilityReasonText` に denied 経路の文を新設する（未接続側は据え置き）。
- `CapabilityDependencyOutcome` の失敗アームに失敗種別を足し、
  `dependency-evaluation.ts:67` / `:317` の内部 cause を分岐させる。
- テストヘルパ（`capabilities.test.ts:41-44`、`scope-resolver.test.ts:63-66`）に
  `permission` を渡せるようにし、既定は `"allowed"`。
  **既定値を持たせてよいのはテストヘルパだけで、production の型には持たせない。**
- **新規テスト T1〜T6**（§5）。
- `design.md` の「直積」5 箇所と Phase D の触る箱を実際に合わせる（§3）。

### やらないこと

- **`shared/` を触らない。`CONTRACT_VERSION` を上げない。** wire DTO は Phase D。
- **公開 reason を構造化しない。** Phase D。
- **`capabilitySnapshot` を required にしない。** Phase D。
- **`availability` 欄を作らない。第三の「未観測」状態も作らない。**
- `resolution/` の pipeline 構造を変えない。`core/`、`vscode-extension/` を触らない。

---

## 5. 新規テストと赤証明

**赤証明は 3 段に分ける。** 1 つの中間状態で全部を赤にすることはできない —
T4 の赤は validator 未修正を要求し、既存 C4 の緑は validator 修正済みを要求するためである。

| 段 | 状態 | 赤になるもの（予測） |
|---|---|---|
| 段1 | 型に `permission` を足しただけ | T1 / T2 / T3 / T4 と、**既知赤の C4**（計 5 件） |
| 段2 | validator を更新 | T1 / T2 / T3（計 3 件）。T4 と C4 は green |
| 段3 | predicate 三値化 + reason + cause 分岐 | 0 件（全 green） |

**段1 で C4 が赤になるのは既知**である。`validateCapabilityContext` は offer を
`offers.push({ capabilityId, features })` と組み直すので、型だけ足した状態では permission が
落ち、`capabilities.test.ts:76-77` の `toEqual([offer("filesystem", ["read"])])` が
ヘルパ側とだけ不一致になる。**これを「predicate を広げすぎた合図」と誤診しないこと。**

| # | 新規テスト | 何を pin するか | 赤になる機構 |
|---|---|---|---|
| T1 | `permission: "denied"` の offer は required 依存を満たさない | CAP-006 の `available=true, allowed=false` | predicate 未修正の段では denied な offer が依存を**満たしてしまう** |
| T2 | `permission: "denied"` の offer は optional 依存を degraded にする | 許可されない依存が degraded 経路へ落ちる | 同上 |
| T3 | denied の失敗理由が未接続の文と**別の文**である | CAP-006 の「別状態として扱う」 | predicate 未修正の段では denied 側の理由が**そもそも生成されない**（両者が同文になるのではない） |
| T4 | `permission` を欠いた offer が `invalid_capability_permission` で拒否される | 省略が黙って allowed に倒れないこと | validator 未修正の段では拒否されない。**型が必須欄なのでテスト側にキャストが要る** |
| T5 | 同一 capability・同一 features で permission だけ違う 2 件が `duplicate_capability_offer` | provider を同定しないモデルの帰結 | **赤にできない（両側 green）。赤証明ではなく特性化 pin として置く** |
| T6 | primary が denied のとき、許可された fallback へ切り替わり degraded になる | **RES-012 の「許可された fallback」** | predicate 未修正の段では primary が満たされてしまい fallback へ行かない |

T6 は既存 C8 / C18 / C19（`capabilities.test.ts:115-131, 258-285`）の permission 版である。

**既存スイートは実装後に緑**であること。母集団は `core-domain` の **231 件**
（`scope-resolver.test.ts` の `it()` 118 / `it.each` 9 宣言 と、
`capabilities.test.ts` の `it()` 18 / `it.each` 1 宣言 を含む）。
ヘルパ既定 `"allowed"` により、permission を明示しない既存ケースの結果は 1 件も変わらない。

---

## 6. 証明条件

1. §5 の 3 段が**予測どおりの件数と機構で**赤になる（段1 = 5 件、段2 = 3 件、段3 = 0 件）。
2. 実装後に T1〜T6 が green。
3. 既存 231 件が green。**既存ケースの結果は 1 件も変わらない。**
4. `shared/` の diff が 0 行、`CONTRACT_VERSION` が `0.4.0` のまま。
5. `bash ~/.claude/scripts/run-gate.sh` が exit 0（4 step すべて PASS）。

---

## 7. Ledger

該当は 2 件で、**どちらも caller に宛てた注意であり、違反が黙って通る**ので
root `AGENTS.md` の `## Ledger` へ置く（箱ではない。root の判定条件の連言を両方満たす）。
既存の #9 エントリ（`capabilityContext` 省略＝提供 0 件）の近傍が読者動線として自然。

1. `CapabilityOffer.permission` は必須欄で、producer が畳んだ後の値を渡す。
   省略や既定値に頼る形にしない。
2. offer は provider を同定しないので、同一 capability・同一 features の 2 件は
   permission が違っても `duplicate_capability_offer` で拒否される。
   **複数 MCP の統合（どちらの permission を採るか）は producer 側の義務**であり、
   畳み規則は Resolver 側に無い。

---

## 8. 繰延と、ユーザー裁定が要る項目

### 繰延（入口を明記する）

| 項目 | 入口 |
|---|---|
| required hard failure で denied / 未接続を機械可読に公開する | #100 Phase D（`design.md:481-486` の `cause: "capability_not_allowed"`） |
| degraded 側 denied の理由を構造化して Extension へ公開する | **#92**「[改善][大規模] Capability degradation の理由を Extension へ構造化して公開する」 |
| 同一 Capability を複数 MCP が同時提供する場合の選好と畳み規則 | #82 |

### Phase D で裁定にかける項目

- **denied と missing が同一候補に混在したときの cause の優先順位。**
  Phase C は fail-closed（`capability_not_allowed` 優先）で実装するが、Phase D で
  wire enum に載った時点で外部観測されるので、そこで裁定する。
- **`permission` を 2 値で確定してよいか。** Phase D が wire enum に載せた後の第 3 値追加は
  `AGENTS.md`「enum への値追加は破壊的変更」に該当し `CONTRACT_VERSION` bump を伴う。
  **#82 の owner に「2 値で足りるか」を Phase D 着地前に確認する。**

### 記録が無い既存の設計境界

**CAP-001 の検証条件「同一 Capability を異なる MCP で満たせる」は、2 つが同時接続している
状況では現行の offer モデルで表現できない。** これは Phase C の欠陥ではなく既存の境界だが、
どこにも記録されていない。#82 へ 1 行足すか、独立 issue（`[調査][要裁定]`）にする。
