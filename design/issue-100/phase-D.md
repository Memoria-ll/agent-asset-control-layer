# Phase D — 明示 execution context と、理由 / 競合の構造化

issue #100 / 統合ブランチ `integration/issue-100`。着地方法: **PR**（1 本）。
**挙動変更フェーズ**。証明は「新規テストの先行 red → 実装後 green」＋ JSON Schema 照合。

Phase A / B の「同一スイート緑」はここでは証明にならない。**既存テストの期待値は
契約が変わる箇所で変わる** — それが正常であり、変わらないことを証明にしない。

---

## 1. 読む範囲（親設計。ここが規範。転記せず原文を読め）

| 章 | 行範囲 | 内容 |
|---|---|---|
| §6 request / response の shape | 413-440 | `ResolveRequest.context` / `ResolvedContextDto.context` の形 |
| §6 理由 DTO | 441-495 | `ResolutionReason` の全 arm（**この形が正**） |
| §6 競合 DTO | 496-513 | `ConflictDto` の 8 kind（**この形が正**） |
| §6 Capability の wire 境界 | 514-518 | capability 側の欄 |
| §6 version と JSON Schema | 519-532 | `CONTRACT_VERSION` と schema 出力 |
| §12 U1 / U2 / U3 / U4 / U5 / U6 / U9 / U10 / U12 | — | すべて**裁定済み**。再検討するな |

要件は `.requiments/agent-asset-control-layer-requirements-decomposed.md` の
RES-001 / RES-002 / RES-016 / RES-018、WFL-006 / WFL-007、CAP-006 / CAP-007。

---

## 2. 裁定済みで、この phase が実装するもの

### 2-1. context union（ユーザー裁定 2026-09-04）

```
ResolutionContextInput = {
  executionMode: "advisory_preparation" | "development_execution"
  workflow:
    | { kind: "none" }
    | { kind: "standalone"; skillId: SkillId }
    | { kind: "selected"; workflowId; stageId }
  projectId?, taskTypeId?, roleId?, providerId?, runtimeId?, modelId?, directory?
}
```

- **必須は `executionMode` と `workflow` だけ。残る軸は optional のまま。**
  出荷済みの `AgentExecutionDto`（`shared/src/sessions.ts:59-73`）が同じ 7 軸を
  optional で持ち、`WorkflowBinding` に `standalone` arm があるため、9 軸を required に
  すると `standalone` 実行が resolve 不能になる。
- **parse 時の cross-arm 制約は 1 本だけ** —
  `development_execution` かつ `workflow.kind === "none"` を `invalid_request` にする（WFL-007）。
- **matching 意味論は変えない。** `workflow.kind: "none"` のとき workflow / stage selector を
  持つ候補を scope mismatch にしない。軸の不在は現行どおり neutral
  （`scope-matching.ts` の `if (requestValue === undefined) continue` と同じ結果）。
  WFL-006 が制限するのは実行可能な行為であって asset 集合ではなく、issue 本文の境界表は
  それを Execution authorization 境界（#101）へ割り当てている。

### 2-2. 理由 / 競合の構造化

設計 §6（441-513 行）の形をそのまま実装する。特に:

- **`matchedAxes` は公開する。`rank` とその構成要素は公開しない**
  （`ResolutionRank` / `matchingAxisCount` / `scopePrecedence` / `directoryDepth` /
  `sourceLayerPrecedence`）。`SCOPE_PRECEDENCE.stageId = 45` は要件の precedence 表に
  Stage 行が無いための補間値であり、未確定値を required な公開欄に固定しない。
- **`matchedAxes` の配列順は現行 `RESOLUTION_AXES` 順を公開契約として固定する。**
  存在必須・空配列可。
- **degraded は `kind: "included"` のまま。** `kind === "included"` が context membership の
  唯一の信号であるという root Ledger の不変条件を wire でも維持する。
  `kind: "unavailable"` は hard failure のみで `availability: "unavailable"` に固定。
- **Phase C が用意した内部 cause を投影する。** `capability_unavailable` と
  `capability_not_allowed` は既に `DependencyCause` にあり、
  `dependency-evaluation.ts` が component 単位の union で決めている。**Phase D は
  投影するだけで、判別ロジックを書き直すな。**

### 2-3. `CONTRACT_VERSION` を `0.5.0` にする

`checkContractCompatibility` は MAJOR / MINOR の不一致をすべて incompatible とするので、
`0.4.x` の consumer は非互換になる。**外部 consumer は実測 0 件**なので移行層は作らない。
旧 `scope` を受ける alias を設けるな。

---

## 3. 変更するサイト（着手時に `git grep -n` で再確認せよ）

| 領域 | ファイル |
|---|---|
| context 契約 | `shared/src/resolved-context.ts`（`ResolutionScopeInput` → context union、`ResolvedContextDto.scope` → `context`）、`shared/src/resolution.ts`（`ResolveRequest.scope` → `context`）、`shared/src/index.ts` |
| 理由 / 競合 | `shared/src/status.ts`（`ResolutionReason` / `ConflictDto`） |
| schema / version | `shared/src/json-schema.ts`（registry は 31 / 33 行付近）、`shared/src/contract-version.ts` |
| shared のテスト | `shared/tests/`（`strict-object.test.ts` が `ResolutionScopeInput` を参照している） |
| core-domain の入口 | `core-domain/src/resolution/resolution-context.ts`、`candidate-validation.ts`、`resolution-types.ts` |
| 投影 | `core-domain/src/resolution/result-assembly.ts`（`toResolutionReasonDto` / `toResolutionConflictDto`） |
| core-domain のテスト | `core-domain/tests/scope-resolver.test.ts`（`resolve()` helper が `parseResolveRequest({ scope })` を呼ぶ） |

**`resolveScope` の consumer は 0 件だが、`parseResolveRequest`（shared の契約面）は
package をまたいで消費されている**（実測 13 ファイル）。`scope` → `context` はこれら全部に及ぶ。

| 消費側 | 備考 |
|---|---|
| `core/scripts/verify-node-resolution.mjs`（21-26 行） | **gate の node-resolution step 本体。落とすと gate が赤になる** |
| `core/tests/shared-contract.test.ts`（7 行〜） | 契約消費の smoke |
| `vscode-extension/tests/shared-contract.test.ts`（13 行〜） | 同上 |
| `shared/tests/strict-object.test.ts`（10 / 18 / 40 / 59 行） | `ResolutionScopeInput` を直接組む |
| `shared/tests/serialization-roundtrip.test.ts`（152-153 行） | omitted / explicit-undefined の往復 |
| `shared/tests/errors.test.ts` | |
| `core-domain/tests/scope-resolver.test.ts`（143 / 147 / 153 行） | `resolve()` helper |
| `core-domain/tests/resolution-context.test.ts`（7 / 30 行） | |
| `core-domain/tests/asset-type-contracts.test.ts`（141 行） | |

**`SkillId` は `shared/src/identifiers.ts` に存在しない。この phase で足す**
（設計 §6 の 525 行が `shared/src/index.ts` へ `SkillId` / `ExecutionMode` を公開すると定めている）。

route の追加は #12。

---

## 4. スコープガード

### やらないこと

- **`TaskId` / `workflowRevision` / `provenance` を契約へ入れない**（#110 / #13 / #14）。
- **公開 reason に `rank` を入れない。**
- **旧 `scope` の alias / 変換関数を作らない。**
- **matching 意味論を変えない**（2-1 の 3 点目）。
- **capability の判別ロジックを書き直さない**（Phase C の内部 cause を投影するだけ）。
- **`core/` と `vscode-extension/` の production code を触らない。** ただし契約消費の
  テスト（`core/tests/shared-contract.test.ts`、`vscode-extension/tests/shared-contract.test.ts`）と
  **gate step の `core/scripts/verify-node-resolution.mjs` は更新が要る** — `scope` を組んでおり、
  放置すると gate が落ちる。Resolve route は足さない（#12）。
- `resolution/` の 7 seam 構造を変えない。

---

## 5. 赤証明

**予測を先に固定し、件数・顔ぶれ・機構を測ってから実装する。**
契約変更なので既存テストの期待値も変わる。**変わった既存ケースは全数を列挙し、
1 件ずつ「契約が変わったから」を示せ** — 1 件でも説明できないものがあれば実装が違う。

新規テストは少なくとも次を含む（設計 §9 の 777-788 行も読め）:

| # | 内容 |
|---|---|
| D1 | `development_execution` + `workflow.kind: "none"` が `invalid_request` になる |
| D2 | `advisory_preparation` + `selected` と `development_execution` + `standalone` は**受理**される |
| D3 | `workflow.kind: "none"` で workflow / stage selector を持つ候補が neutral 評価される（scope mismatch にならない） |
| D4 | `matchedAxes` が `RESOLUTION_AXES` 順で、matched axis が無ければ空配列 |
| D5 | 公開 reason に rank 系の欄が存在しない（strict object が拒否する） |
| D6 | `ConflictDto` の 8 kind が strict union として往復する |
| D7 | denied capability が `cause: "capability_not_allowed"` として公開される（Phase C の内部 cause の投影） |
| D8 | `0.4.x` と `0.5.0` が `checkContractCompatibility` で incompatible になる |

**JSON Schema 側も検査する。** `shared/tests/json-schema.test.ts` の strict object 検査は
root の `oneOf` までしか展開せず nested object へ降りない（root Ledger）。
**新しい nested union（reason の `detail`、conflict の各 arm）の `additionalProperties` は
個別 assertion で pin せよ。**

---

## 6. 証明条件

1. §5 の新規テストが実装前に赤（予測した件数と機構で）、実装後に green。
2. 期待値が変わった既存ケースが全数列挙され、1 件ずつ契約変更で説明できる。
3. JSON Schema と parser が一致する（nested の strictness を個別 pin）。
4. `CONTRACT_VERSION` が `0.5.0`、`0.4.x` が incompatible。
5. `bash ~/.claude/scripts/run-gate.sh` が exit 0（4 step すべて PASS）。

---

## 7. PR 本文で裁定にかける項目

- **denied と missing が同一候補に混在したときの cause の優先順位。**
  Phase C が fail-closed（`capability_not_allowed` 優先）で実装し、component 単位の union で
  決めている。Phase D で wire enum に載るので、ここで初めて外部観測される。
  **覆すなら Phase D のうちに。**

`permission` を 2 値で確定してよいかは**実測で解決済み** — #82 の完了条件は
「available=true / allowed=false を表現・判定できる」で 2 値を求めており、
`preferred` / `required` は #82 でも dependency 強度側である。3 値化は不要。

---

## 8. 繰延

| 項目 | 入口 |
|---|---|
| degraded 側 denied の理由の構造化 | #92 |
| 同一 Capability を複数 MCP が同時提供する場合の選好と畳み規則 | #82 |
| Task を scope 軸へ昇格するか | #110 |
| workflow revision | #13 |
| provenance | #14 |
| Resolve route と capability snapshot の transport | #12 |
