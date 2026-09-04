# Issue #100 設計: v12責務境界に基づくResolverの削除・再構成

## 1. 設計の前提となる実測

以下は 2026-09-04 にこの worktree を検索・計測して確定した事実で、設計全体の前提である。
行数・宣言数・利用箇所・識別子数はいずれも実測値であり、不存在の検索は複合正規表現と
各識別子の `git grep -F` の二通りで確認した。行番号は実装の現物に対する参照である。

| 実測した事実 | 設計上の扱い |
|---|---|
| `resolveScopeFixedPoint` は `core-domain/src/resolution/scope-resolver.ts` の 873-2287 行（1,415 行）。ファイル全体は 2,299 行で、2289-2291 行の `resolveScope` が公開入口として委譲する | この範囲を固定点実装の分解対象とし、公開入口の責務を新しい合成ルートへ移す |
| `core-domain/tests/scope-resolver.test.ts` の直接 `it(` 宣言は 118 件、`it.each` 宣言が 9 件で、ソース上の宣言総数は 127 件 | 分類表は直接 `it(` の 118 行で合計を管理し、9 件のパラメータ化宣言も補足表に全件記載して分類と移動先を失わせない |
| `git grep -F 'resolveScope'` の該当は `core-domain/src/index.ts`、Resolver 内、`scope-resolver.test.ts`、`asset-type-contracts.test.ts` のみ。`core/src` と `vscode-extension/src` に呼出しは無い | 本 issue では Core HTTP route と Extension client の配線を新設しない。公開面の型更新は #12 / #31 の入口として定義し、現時点の consumer 移行数は 0 件とする |
| `ExecutionMode`、`executionMode`、`taskId`、`workflowRevision`、`revisionId` は追跡対象ファイルに 0 件。`ResolutionScopeInput` は 9 軸をすべて optional（`shared/src/resolved-context.ts:43-71`） | `executionMode` と workflow selection を独立した明示軸として導入し、`projectId` を含む残りの scope 軸は optional のまま扱う。`standalone` の skill 選択を表現し、`TaskId`、`workflowRevision`、`provenance` は今回の公開契約へ入れない |
| `CapabilityOffer` は `capabilityId` と `features` だけ（`core-domain/src/capabilities/dependencies.ts:35-43`。Phase B で `resolution/` から移設）。`capabilityAvailable` も catalog と offer の存在だけを検査する（同:396-404） | available と allowed を capability 側の観測値として分離し、Resolver は検証済み観測値を消費する。catalog / permission 判定を Resolver の pipeline へ複製しない |
| 内部 `CandidateReason` は matched axes、rank、failed requirements、failed capabilities を持つ一方、公開 `ResolutionReason` は説明と一部 ID へ縮約され、`ConflictDto` は `explanation` と `involvedAssetIds` の 2 欄だけ（`shared/src/status.ts:59-103`） | 構造化された理由・競合 DTO を公開契約として定義し、Core API / Preview が文字列の再解析なしに投影できる形にする。`rank` は公開欄に含めない |

## 2. 調査した事実と設計の適用範囲

### 調査した実行経路

1. 現在の唯一の Resolver 公開入口は `core-domain/src/index.ts:75-96` から re-export された `resolveScope` である。`resolveScope` は `scope-resolver.ts:2289-2291` で `resolveScopeFixedPoint` を直接呼ぶ。`core-domain` の公開面は `src/index.ts` が正であり、module 直 import を consumer に許さないという AGENTS.md の規約に従う。
2. `core-domain/tests/scope-resolver.test.ts:137-143` の `resolve()` helper は `parseResolveRequest` で scope を parse し、公開入口 `resolveScope` を呼ぶ。したがって Resolver の既存挙動を pin する主経路は実際の公開入口を通っている。
3. 同テストの `candidateFromCanonicalAsset`（同:92-101）は on-disk の `project` / `workflow` / `stage` / `task-type` 等を resolver 側の `projectId` / `workflowId` / `stageId` / `taskTypeId` 等へ手作業で投影している。これは production の Candidate producer ではなく test helper であるため、移行後の mapping test はこの helper を正とせず、実際の Candidate projection を公開入口へ通す。
4. Core の現在の起動経路は `core/src/index.ts:30-112` の settings → Registry reconcile → HTTP listen で、`@aacl/core-domain` から import しているのは failure helper / type だけ（同:1-5）である。HTTP route は `core/src/http/router.ts:6-18` の `/health` のみで、Resolver request の route はまだ存在しない。Extension の transport-neutral client も `vscode-extension/src/project-client.ts:8-12` の project initialize / discover だけである。
5. 固定点関数の中では、入力・全候補検証が `scope-resolver.ts:873-965`、scope match と初期状態が `986-1069`、SCC と依存評価が `1082-1477`、operation graph と固定点が `1478-1904`、再選択と最終理由が `1906-2270`、出力整列が `2272-2286` に混在している。これが 7 seam と合成ルートを分ける直接の根拠である。

### 正とする要求・規約

要求の正は `.requiments/agent-asset-control-layer-requirements-decomposed.md` の SYS-004（45-53 行）、SYS-008（74-80 行）、AST-002（92-96 行）、RES-001〜018（190-298 行）、WFL-004 / WFL-006 / WFL-007（514-536 行）、CAP-001〜007（564-604 行）と、`.requiments/agent-asset-control-layer-requirements.md` §13（797-865 行）/ §29-32（1090-1163 行）/ §33（1166-1174 行）/ §34（1178-1194 行）である。特に次を pipeline の受入条件へ固定する。

- RES-005 の順序（scope match → protection / disable → priority / specificity / precedence → dependency → conflict / merge → ordering / materialization → reasons）。
- RES-006〜009 の priority・scope precedence・compound specificity・mandatory protection。
- RES-010〜012 の required / optional / fallback の結果と理由。
- RES-013〜018 の directory ranking、last-read winner の禁止、type-specific conflict / merge、順序非依存、workflow 推測禁止。
- WFL-004 / WFL-006 / WFL-007 の「遷移は Orchestrator / User」「workflow なしは Advisory / Preparation」「Development Execution への自動昇格なし」。
- §7 の Standalone Skill は、明示された execution permission があれば repository mutation を許す実行選択として表現する。Resolver はこの選択を保持し、実行許可の判定は Orchestrator / User 側へ渡す。
- SYS-008 と §33 の明示入力のみを適用する決定論、および §34 の resolution explainability（今回適用された理由）と provenance（binding が存在する理由）の分離。

### 適用範囲と編集境界

この設計が対象にする成果物は `core-domain` の Resolver pipeline と、その公開型を載せる `shared` の contract である。候補の filesystem 読み込み、Core の HTTP route、Extension の UI / transport は現在の実行経路にないため、この issue の実装範囲に含めない。新しい route や Preview adapter は #12 / #31 の実装で、今回定義する公開 DTO を consumer が使う。

この設計書以外は編集しない。quality gate、`pnpm -r test`、アプリ / server の起動は行わず、証拠はファイル読取りと `git grep`、行数計測だけに限定する。

## 3. 責務分割と新規結合

### 7 seam と判断の所有者

`core-domain/src/resolution/scope-resolver.ts` を細かい helper の集合として残さず、次の 7 seam と、判断を持たない composition root `pipeline.ts` に分ける。seam 間の値はすべて戻り値で渡し、共有 mutable map / set を seam の外へ漏らさない。

| seam | 配置する箱 / module | 所有する判断 | 受け取る値 → 返す値 | この境界にする理由 |
|---|---|---|---|---|
| 1. context / candidate validation | `core-domain/src/resolution/candidate-validation.ts` | 明示実行コンテキストの整合、scope の正規化、候補の構造・type/tier・rule・directory、同一 identity の payload、capability 宣言、exact duplicate | `ResolveScopeInput` → `AssetResult<ValidatedResolutionInput>` | 構造が壊れた値を scope applicability や graph へ入れると、invalid と out-of-scope が混ざる。全候補を scope 分割より先に検証する規則をここで一度だけ担保する |
| 2. scope matching | `core-domain/src/resolution/scope-matching.ts` | 軸間 AND、同一軸 selector 間 OR、directory の祖先一致、`workflow.kind: "none"` における workflow / stage selector の neutral 評価、matched / mismatched 軸 | `ValidatedResolutionInput` → `ScopeMatchSet` | scope は「適用可能か」だけを決め、winner・disable・dependency を決めない。適用可能性と優先順位を別々にテストできる。未指定 request value は現行 `if (requestValue === undefined) continue` と同じ neutral 規則で評価する |
| 3. protection / overlay | `core-domain/src/resolution/protection-overlay.ts` | mandatory の保護、同一 ID の higher-layer overlay、override / disable edge、issuer が生存している場合だけ action を有効化する規則、operation graph の conflict / cycle | `ScopeMatchSet` と反復時の `OverlayEvaluationInput` → `ProtectionOverlayGraph` / `OverlayEvaluation` | operation は候補の scope match でも type merge でもなく、候補同士の状態変化である。全 target 候補を narrowing 前に graph 化し、必須保護をここで適用する |
| 4. ranking / precedence | `core-domain/src/resolution/ranking-precedence.ts` | explicit priority、specificity、scope precedence vector、directory 特則、source layer、unbeaten selection と tie | `ScopeMatchSet` + `ProtectionOverlayGraph` → `RankedResolution` | 比較関係は directory を含むと非推移になる。逐次 elimination を置かず、比較器と unbeaten 集合を独立させることで、入力順に依存する winner を作らない |
| 5. dependency evaluation | `core-domain/src/resolution/dependency-evaluation.ts` | requires の SCC、required / optional / preferred / fallback、capability outcome、own failure と outgoing edge failure の union、operation 後の closure | `DependencyEvaluationInput` → `DependencyEvaluation` | dependency は candidate の存在・operation の結果を観測するが、それを scope や type contract へ逆流させない。capability 側の判定結果を読み取り専用の値として消費する |
| 6. type-specific conflict / merge / ordering | `core-domain/src/resolution/type-resolution.ts` | `AssetTypeContractRegistry` による許可 operation / merge policy / execution profile、exclusive/additive の最終 materialize、type-specific conflict、canonical output order | `TypeResolutionInput` → `TypeResolution` | AST-002 の type 固有意味論を共通 if/switch に散らさず、registry の contract だけを通して適用する。dependency が確定した後に、実際に context へ載る集合を決める |
| 7. result / reason assembly | `core-domain/src/resolution/result-assembly.ts` | candidate ごとの唯一の reason、degraded を included として保持、conflict の canonical dedup / sort、internal reason から public DTO への投影 | `StableResolutionState` → `ResolutionResult` と `ResolutionReason` / `ConflictDto` | ここは説明と serialization の面であり、結果を再び選択へ戻さない。Core API / Preview が文字列を再解釈せず表示できる情報をここで固定する |

`pipeline.ts` は上記 seam を呼ぶ順序、反復、終了条件、`AssetResult` の failure short-circuit だけを所有する。priority の値、mandatory の意味、dependency の失敗理由、conflict の採否は pipeline に書かない。これにより composition root を読んでも domain rule の別実装が発生しない。

### 新規結合の明示宣言と依存方向の検査対象

| 追加する結合（方向） | 目的 | AGENTS.md の宣言との整合 |
|---|---|---|
| `resolution/pipeline.ts` → 7 seam modules | 各 stage を値で直列 / 反復合成する | 同一 `core-domain` package 内の結合で、package 方向を変えない |
| `resolution/candidate-validation.ts` → `shared`、`asset-type-contracts.ts`、`capabilities` の validation | wire 型、type contract、capability snapshot を一度に検証する | `core-domain → shared` は許可済み。`core-domain` は Node / host API を import しない |
| `resolution/dependency-evaluation.ts` → `core-domain/src/capabilities/` の snapshot / evaluator | Capability 側が決めた available / allowed を Resolver が読む | Resolver → Capability の一方向に固定し、Capability module → Resolver の import は作らない |
| `resolution/asset-type-contracts.ts` → `resolution/resolution-types.ts` | `ResolutionOperation` の共通型を取得する | 現行の `asset-type-contracts.ts` → `scope-resolver.ts` 型依存を共通型へ移し、pipeline との循環を解く |
| Candidate projection / `candidate-validation.ts` / `scope-matching.ts` → `resolution/axis-mapping.ts` | on-disk の kebab 軸を resolver の camel 軸へ一度だけ対応付け、`matchedAxes` の public projection を同じ語彙で検査する | 同一 `core-domain` package 内の一方向結合。mapping table は `shared` へ移さず、`core-domain → shared` の package 方向を増やさない |
| `resolution/type-resolution.ts` → `asset-type-contracts.ts` と `ordering.ts` | registry に従う merge と deterministic order | 同じ `core-domain` 内。type 固有判断を contract へ集約する既存方針を維持 |
| `resolution/result-assembly.ts` → `shared` | public reason / conflict DTO へ投影する | `core-domain → shared` の既存方向。`shared → core-domain` は追加しない |
| `core-domain/src/index.ts` → `resolution/pipeline.ts`、model、projection | `@aacl/core-domain` の到達可能な公開面を保つ | index の re-export が正という規約に従う。テストも index 経由だけにする |
| `core` / `vscode-extension` → 新 Resolver module | 今回は追加しない | 実測で consumer は 0 件。将来 Core は `core → core-domain + shared`、Extension は `vscode-extension → shared` の既存方向から接続する |

Capability の新しい `core-domain/src/capabilities/` は package を増やさない内部箱である。フォルダ規約に従い、実装時は同箱の `ledger.md` と root `AGENTS.md` の Ledger 一覧を追加し、Resolver 箱から移す capability producer の事実を重複記載しない。

### resolution Ledger の全エントリと移管先

`core-domain/src/resolution/ledger.md` の 10 エントリを全件、次のように seam の責務へ割り当てる。行番号は現在の Ledger の実測位置であり、実装時に読み直して判断を先送りする欄ではない。

| Ledger entry | 現在の load-bearing 規則（出典） | 新 pipeline の所有 seam |
|---|---|---|
| L1 | surviving issuer だけが merge 後に operation を適用、same-ID overlay は duplicate より先、dependency closure は merge / operation の後、operation cycle / SCC / feedback を最終状態まで評価（`core-domain/src/resolution/ledger.md:7-22`） | graph の発見と issuer 保護は protection/overlay、SCC と closure は dependency evaluation、反復と終了は pipeline、最終 conflict は result assembly |
| L2 | mandatory candidate の cycle と他の failure を同時に保持（同:24-25） | dependency evaluation が複数 failure を union し、result assembly が conflict を別々に materialize |
| L3 | evaluation tie は全 semantic fields で比較し input order を使わない（同:27-29） | candidate validation の semantic identity と ranking の canonical comparator |
| L4 | 全候補の structure を invalid-directory partition より先に検証し、同一 identity の payload と runtime type/tier を検査（同:31-34） | candidate validation。scope matching は invalid candidate を検証済みと仮定した値だけ受け取る |
| L5 | 同じ capability context で一度だけ validate し、validated context の dependency evaluation を使う。out-of-scope も validate（同:36-43） | candidate validation の snapshot validation / dependency normalization と dependency evaluation の read-only consumption |
| L6 | `dependencyOutcomes` は component 自身と outgoing edge の failure を union し、capability と requires の両方を保持（同:45-53） | dependency evaluation。`failedRequirements` / `failedCapabilities` の順序と原因をここで canonicalize |
| L7 | type contract violation は単独なら candidate invalid、pairwise なら candidate reason と `asset_type_conflict`、target を変更しない（同:57-62） | candidate validation と type-specific conflict/merge。pairwise conflict を operation side effect として扱わない |
| L8 | cross-type relation は candidate narrowing 前に全 matchedById target candidates で確認（同:64-69） | protection/overlay の graph construction。ranking / exclusive winner の後で target 候補を探し直さない |
| L9 | exclusive winner は unique unbeaten、逐次排除をしない。directory は特別比較で一般 rank は非推移（同:71-78） | ranking/precedence。directory 判定は precedence 100 の値で行い、empty unbeaten は type conflict ではなく次の L10 へ渡す |
| L10 | `selectUnbeaten` が空なら winner なし、disable action は coalesce、output order は canonical、tie は tie + cycle を説明（同:80-83） | ranking の unbeaten 判定、protection/overlay の coalesce、result assembly の output / explanation。winner なしを自動選択へ変換しない |

既存の root Ledger で Resolver に直接効く `AssetRevision` の SHA-256 identity / exact duplicate fold（`AGENTS.md:429-437`）、type contract の `Record<AssetType, ...>` と type 分岐 scan（同:439-451）、degraded を `kind: included` とする信号（同:453-458）、scope 軸名の mapping（同:366-372）は、上記 L3 / L4 / L7 / L9 / L10 と重複させず root の横断規約として維持する。capability context 省略を 0 offers とする現行 trap（同:388-391）は、新しい必須 snapshot の規約へ更新する対象である。

### root Ledger へ反映する採用制約

設計と同時に root `AGENTS.md` の該当 Ledger を次の制約へ書き換える。設計文書は引用を残す場所ではなく、実装時に同期すべき採用文面を持つ。

- 公開 `ConflictDto.kind` は閉じた conflict kind 集合であり、各 arm の required 欄と JSON Schema がその集合の正である。kind の arm 追加・削除、required 欄の追加、kind 固有欄の型変更は breaking contract として `CONTRACT_VERSION` を bump する。consumer は `explanation` の再解析ではなく kind とその arm を読む。
- `ResolveScopeInput.capabilitySnapshot` は required input である。#12 の HTTP / IPC adapter は Capability owner が返した snapshot を同じ transport exchange で運び、validated snapshot を domain call へ渡す。transport に snapshot 欄がある場合は欠落を `invalid_request` とし、空 snapshot は Capability owner が明示した 0 offers の値として運ぶ。adapter が omission を空 snapshotへ変換する既定値は設けない。この境界を満たすため、#12 の route 配線は capability snapshot の transport field と parser を同じ変更で追加する。

### 軸語彙と `matchedAxes` の契約

`ResolutionAxisName` と `RESOLUTION_AXES` は `core-domain/src/resolution/` に残し、`shared` はこれらを export しない。公開 reason の `matchedAxes` は `NonEmptyString[]` として表現し、内部の axis name を result assembly が文字列へ投影する。これにより `ASSET_SCOPE_AXES`（kebab）と `RESOLUTION_AXES`（camel）の 2 語彙を維持し、3 つ目の公開軸語彙を導入しない。

`core-domain/src/resolution/axis-mapping.ts` に次の 9 組の mapping table を置く。`core-domain/tests/axis-mapping.test.ts` は #4 の実 Candidate projection とこの表を通し、各組を逐語比較する。

| on-disk `ASSET_SCOPE_AXES` | resolver `RESOLUTION_AXES` |
|---|---|
| `project` | `projectId` |
| `workflow` | `workflowId` |
| `stage` | `stageId` |
| `task-type` | `taskTypeId` |
| `role` | `roleId` |
| `provider` | `providerId` |
| `runtime` | `runtimeId` |
| `model` | `modelId` |
| `directory` | `directory` |

`matchedAxes` の配列順は現行 `RESOLUTION_AXES` の順（`projectId`, `workflowId`, `stageId`, `taskTypeId`, `roleId`, `providerId`, `runtimeId`, `modelId`, `directory`）を公開契約として固定する。result assembly の public projection test が実際の `resolveScope` 結果でこの順を検査し、順序変更は `CONTRACT_VERSION` の breaking change として扱う。matched axis がない場合は空配列を許容する。

## 4. データフロー

### 外部入力から結果までの値の流れ

pipeline は次の型を通る。`AssetResult` の failure は validation stage で止まり、候補ごとの `invalid_directory` は stage 1 の値として後段を通って最終 evaluations に残る。この二つを同じ `throw` / `catch` 経路にしない。

| stage | seam | 入力型 | 出力型 | seam を越えて持ち越す明示値 |
|---|---|---|---|---|
| 0 | public composition | `ResolveScopeInput` | `AssetResult<ResolutionResult>` | `context`、候補 snapshot、type contracts、capability snapshot |
| 1 | context / candidate validation | `ResolveScopeInput` | `AssetResult<ValidatedResolutionInput>` | `ValidatedExecutionContext`、`NormalizedResolutionScope`、`ValidatedCandidate[]`、`InvalidDirectoryCandidate[]`、`ValidatedCapabilitySnapshot`、`AssetTypeContractRegistry` |
| 2 | scope matching | `ValidatedResolutionInput` | `ScopeMatchSet` | candidate key、matched axes、mismatched axes、directory depth、match status |
| 3a | protection / overlay graph construction | `ScopeMatchSet` | `ProtectionOverlayGraph` | 全 matched target 候補、issuer / target / operation、same-ID overlay relation、mandatory protection、out-of-scope / invalid target observation |
| 4 | ranking / precedence | `ScopeMatchSet + ProtectionOverlayGraph + ResolutionIterationState` | `RankedResolution` | candidate key → `ResolutionRank`、unbeaten set、exclusive group decision、operation issuer precedence order |
| 3b | protection / overlay evaluation（反復呼出し） | `OverlayEvaluationInput`（ranked candidates、active keys、eligible issuer keys） | `OverlayEvaluation` | status map、applied action set、operation conflicts、operation cycles、next issuer eligibility |
| 5 | dependency evaluation | `DependencyEvaluationInput`（active candidates、overlay result、capability snapshot） | `DependencyEvaluation` | candidate key → required / soft / capability outcome、SCC IDs、failed requirement IDs、failed capability IDs、degradation、next eligibility |
| 6 | type-specific conflict / merge / ordering | `TypeResolutionInput`（rank、overlay、dependency、contracts） | `TypeResolution` | included keys、overridden / disabled status、type conflicts、materialized order、selection feedback |
| 7 | result / reason assembly | `StableResolutionState`（stage 1〜6 の最終値） | `ResolutionResult`、public reason / conflict DTO | 各 candidate の exactly-one reason、canonical conflict list、`outcome`、normalized scope、explicit execution context |

3a は relation の発見であり、3b は rank と現在の eligibility を適用した状態変化である。同じ seam の二段階を分けることで、L8 の「narrowing 前に全 target を見る」と、L1 の「surviving issuer だけが action を適用する」を同時に満たす。3b は 4 → 3b → 5 → 6 の反復内で呼ばれ、seam module が別 seam を直接呼び出すことはない。

`workflow.kind: "none"` の値は stage 1 で workflow / stage の request value を未指定として正規化し、stage 2 は該当 selector を neutral に評価する。したがって workflow / stage selector を持つ candidate は scope mismatch にならず、candidate 集合は現行 `scope-resolver.ts:452` の `if (requestValue === undefined) continue` と同じになる。実行可能な行為の制限はこの値を受け取る Orchestrator / User の execution authorization 境界で判定する。

### 固定点の反復状態と終了

**この節の `ResolutionIterationState` は Phase A では採用していない。** Phase A は `states` 配列・`Map` / `Set`・再代入される `let` 群という現行の表現のまま seam へ渡した。表現の作り替えは振る舞いを保存する変更ではなく、同一スイート緑もソース比較もどちらも証明として成立しなくなるためである。決定論の要求 RES-017 は現行表現に対して `case 15-m: pins fixed-point invariants for every candidate permutation` が pin している。採否は seam が実在するようになった今、内部表現の判断として後続フェーズで決める。

composition root が保持する反復値は次の一つの値として受け渡す。

```text
ResolutionIterationState {
  activeCandidateKeys: SortedSet<CandidateKey>
  eligibleOperationIssuerKeys: SortedSet<CandidateKey>
  selectedExclusiveKeys: SortedSet<CandidateKey>
  overlayStatuses: SortedMap<CandidateKey, OverlayStatus>
  dependencyOutcomes: SortedMap<CandidateKey, DependencyOutcome>
  materializationFeedback: SortedSet<FeedbackKey>
}
```

実際の実装では上記は readonly collection として表し、キーは assetId・revision・source layer・sourceId の canonical tuple を code-unit 順に直列化する。次の状態の canonical key が既出なら、例外や last-write winner にせず、該当 exclusive group / operation graph の conflict を `ResolutionConflict` として確定する。これにより operation cycle、dependency cycle、selection/dependency feedback が入力順や Map insertion order へ逃げない。

反復の意味は次の通りである。

1. stage 3a が全 relation と protection を固定し、stage 4 が priority → specificity → scope precedence → directory 特則 → source layer の順で比較する。
2. stage 3b が選択された issuer の action だけを active candidate 集合へ適用する。mandatory target に対する disable は保護 conflict として状態に残す。
3. stage 5 が operation 後の active graph を SCC 単位で評価する。required failure は unavailable、soft failure は included + degraded とし、capability outcome は requires と同じ dependency outcome へ合流させる。
4. stage 6 が type contract に従って merge / conflict / output order を確定し、active key または issuer eligibility が変わった場合だけ stage 4 へ戻す。
5. state key が変化しなくなったら stage 7 が組み立てる。既出 key、空の unbeaten、独立 failure、issuer が消えた operation failure は、それぞれ L10 の規則に従う。

この反復が持つ state は候補集合の有限な canonical key 上だけで変化し、再帰 call stack を使わない。10,000 件の dependency chain / operation graph は SCC と heap / queue の反復で扱い、stack depth に依存しない。

## 5. 7 seam の型定義

### 5.1 明示実行コンテキスト（shared の正）

`shared/src/resolution-context.ts`（既存 `resolved-context.ts` から分離してもよい）を schema の単一の正とする。以下は設計上の型形であり、実装は `zod/mini` の `z.strictObject` と `z.discriminatedUnion` から導出する。

```text
ExecutionMode = "advisory_preparation" | "development_execution"

WorkflowSelection =
  | { kind: "none" }
  | { kind: "standalone"; skillId: SkillId }
  | { kind: "selected"; workflowId: WorkflowId; stageId: StageId }

ResolutionContextInput = {
  executionMode: "advisory_preparation" | "development_execution"

  workflow:
    | { kind: "none" }
    | { kind: "standalone"; skillId: SkillId }
    | { kind: "selected"; workflowId: WorkflowId; stageId: StageId }

  projectId?: ProjectId
  taskTypeId?: TaskTypeId
  roleId?: RoleId
  providerId?: ProviderId
  runtimeId?: RuntimeId
  modelId?: ModelId
  directory?: DirectoryPath
}
```

object の必須欄は `executionMode` と `workflow` であり、`projectId`、`taskTypeId`、`roleId`、`providerId`、`runtimeId`、`modelId`、`directory` は optional のまま保持する。`shared/src/sessions.ts:59-73` の `AgentExecutionDto` は `projectId` / `stageId` / `taskTypeId` / `roleId` / `providerId` / `runtimeId` / `modelId` をすべて `z.optional` として出荷済みであり、`core-domain/src/workflow.ts:582-587` の `WorkflowEvaluationInput` も `roleId` / `taskTypeId` を optional にして transition を評価する。この形は existing execution context の optional 軸と整合し、development で 9 軸を一括 required にする変更を避ける。

parse は `executionMode` と `workflow.kind` を組み合わせた strict union として実装し、cross-arm の拒否条件を一つに固定する。`executionMode === "development_execution"` かつ `workflow.kind === "none"` のときだけ `invalid_request` とし、それ以外の組合せ（advisory + none / standalone / selected、development + standalone / selected）は受理する。`workflow.kind: "none"` は未指定値、空文字、暗黙 discovery、既読順から復元しない明示値である。

`standalone` は §7（`.requiments/agent-asset-control-layer-requirements.md:664-668`）の Standalone Skill を表し、`skillId` と明示 execution permission の関係を保持する。repository mutation の許可は Orchestrator / User が決め、Resolver は permission を推測しない。`workflowRevision` と `TaskId` はこの入力にも公開契約にも置かず、workflow revision は #13、Task identity / mapping は #110 / #4 の owner 境界で扱う。

内部では selected arm を `workflowId` / `stageId` / `projectId` へ投影した `NormalizedResolutionScope` と、元の `ValidatedExecutionContext` を別々に保持する。`kind: "none"` は `workflowId` / `stageId` を scope へ投影せず、scope matching は未指定 request value の現行規則に従って workflow / stage selector を neutral に評価する。`WorkflowSelection` の種別は execution authorization へ渡す明示状態として保持する。

### 5.2 seam 1〜2 の型

```text
ResolveScopeInput = {
  context: ResolutionContextInput
  snapshot: ResolutionSnapshot
  contracts?: AssetTypeContractRegistry       // omission は default registry の選択だけ
  capabilitySnapshot: CapabilityResolutionSnapshot // empty array は明示的な empty state
}

ValidatedCandidate = {
  candidate: AssetCandidate
  candidateKey: CandidateKey
  normalizedDirectorySelectors: readonly NormalizedDirectory[]
  normalizedCapabilityDependencies: readonly CapabilityDependency[]
  semanticIdentity: SemanticCandidateIdentity
}

InvalidDirectoryCandidate = {
  candidate: AssetCandidate
  candidateKey: CandidateKey
  diagnostics: readonly CoreErrorDetail[]
}

ValidatedResolutionInput = {
  execution: ValidatedExecutionContext
  scope: NormalizedResolutionScope
  candidates: readonly ValidatedCandidate[]
  invalidDirectoryCandidates: readonly InvalidDirectoryCandidate[]
  capabilitySnapshot: ValidatedCapabilitySnapshot
  contracts: AssetTypeContractRegistry
}

ScopeMatch =
  | { candidate: ValidatedCandidate; matched: true; matchedAxes: readonly ResolutionAxis[]; rankSeed: RankSeed }
  | { candidate: ValidatedCandidate; matched: false; mismatchedAxes: readonly ResolutionAxis[] }

ScopeMatchSet = {
  matched: readonly ScopeMatch[]
  mismatched: readonly ScopeMatch[]
  invalidDirectory: readonly InvalidDirectoryCandidate[]
}
```

candidate-validation は `AssetRevision` と全 semantic fields（operation、merge、selector、requires、capability dependency）で duplicate を判定し、同じ id + revision の payload 不一致を separate conflict として残す。scope matching は `NormalizedResolutionScope` だけを読み、candidate の metadata や capability catalog を再解釈しない。

### 5.3 seam 3〜4 の型

```text
OverlayEdge = {
  issuer: CandidateKey
  target: CandidateKey | { assetId: AssetId; observation: "out_of_scope" | "missing" | "invalid" }
  operation: "override" | "disable"
  protectedTarget: boolean
}

ProtectionOverlayGraph = {
  nodes: readonly CandidateKey[]
  edges: readonly OverlayEdge[]
  sameIdOverlayPairs: readonly { issuer: CandidateKey; target: CandidateKey }[]
  mandatoryProtected: ReadonlySet<CandidateKey>
}

OverlayEvaluationInput = {
  graph: ProtectionOverlayGraph
  ranked: RankedCandidate[]
  activeCandidateKeys: ReadonlySet<CandidateKey>
  eligibleIssuerKeys: ReadonlySet<CandidateKey>
}

OverlayEvaluation = {
  statuses: ReadonlyMap<CandidateKey, OverlayStatus>
  appliedActions: readonly AppliedOverlayAction[]
  operationConflicts: readonly ResolutionConflict[]
  operationCycles: readonly OperationCycle[]
  nextEligibleIssuerKeys: ReadonlySet<CandidateKey>
}

ResolutionRank = {
  explicitPriority: number
  matchingAxisCount: number
  scopePrecedence: readonly number[]
  directoryDepth: number
  sourceLayerPrecedence: 0 | 1 | 2
}

RankedResolution = {
  candidates: readonly RankedCandidate[]
  exclusiveGroups: ReadonlyMap<string, readonly CandidateKey[]>
  unbeatenByGroup: ReadonlyMap<string, readonly CandidateKey[]>
  operationIssuerOrder: readonly CandidateKey[]
}
```

ranked candidate を winner と同義にしない。`unbeatenByGroup` が 1 件なら候補、0 件なら候補集合、2 件以上なら tie であり、dependency / operation の結果を見て stage 6 が materialize する。mandatory は rank の低さで弱めず、graph の `mandatoryProtected` と type resolution の conflict へ二重に渡す。

### 5.4 seam 5 の型

Capability producer の観測値は `core-domain/src/capabilities/` の `CapabilityResolutionSnapshot` として定義する。

```text
DependencyEvaluationInput = {
  candidates: readonly ValidatedCandidate[]
  activeCandidateKeys: ReadonlySet<CandidateKey>
  overlay: OverlayEvaluation
  capabilitySnapshot: ValidatedCapabilitySnapshot
}

CapabilityOffer = {
  capabilityId: CapabilityId
  features: readonly CapabilityFeatureId[]
  availability: "available" | "unavailable"
  permission: "allowed" | "denied"
}

CapabilityResolutionSnapshot = {
  catalog: CapabilityCatalog
  offers: readonly CapabilityOffer[]
}

CapabilityDependencyOutcome =
  | {
      ok: true
      degradation?: DegradedInfo
      degradedCapabilities?: readonly CapabilityDegradation[]
    }
  | {
      ok: false
      failedCapabilities: readonly CapabilityFailure[]
      reasons: readonly NonEmptyString[]
    }

CapabilityFailure = {
  capabilityId: CapabilityId
  cause: "unavailable" | "not_allowed"
  strength: "required" | "optional" | "preferred" | "fallback"
}

DependencyEvaluation = {
  byCandidate: ReadonlyMap<CandidateKey, CandidateDependencyOutcome>
  stronglyConnectedComponents: readonly (readonly CandidateKey[])[]
  failedRequirements: ReadonlyMap<CandidateKey, readonly AssetId[]>
  failedCapabilities: ReadonlyMap<CandidateKey, readonly CapabilityFailure[]>
  nextEligibleCandidateKeys: ReadonlySet<CandidateKey>
}
```

`availability` は provider が接続 / offer 可能か、`permission` は現行 project / role / policy で利用を許可されるかを表す。`available && permission` を初めて成功 predicate とする。`CapabilityDependency.strength` の required / optional / preferred / fallback は依存元が要求する強度であり、offer の状態へコピーしない。これが CAP-004、CAP-006、CAP-007 の境界である。Resolver は catalog を再構成したり permission を推論したりせず、capability module が返した snapshot を同じ context の全候補で共有する。

Capability state は `availability: "available" | "unavailable"` と `permission: "allowed" | "denied"` の直積で観測する。未観測という第三状態は設けず、offer に存在しない capability は snapshot validation が `unavailable` として分類する。明示的な空 snapshot は「提供 0 件」の観測値であり、未観測を表す代替値ではない。

### 5.5 seam 6〜7 と composition の型

```text
TypeResolutionInput = {
  ranked: RankedResolution
  overlay: OverlayEvaluation
  dependencies: DependencyEvaluation
  contracts: AssetTypeContractRegistry
  candidates: readonly ValidatedCandidate[]
}

TypeResolution = {
  included: ReadonlySet<CandidateKey>
  statuses: ReadonlyMap<CandidateKey, "included" | "overridden" | "disabled" | "conflicted" | "unavailable">
  conflicts: readonly ResolutionConflict[]
  orderedCandidates: readonly CandidateKey[]
  feedback: readonly FeedbackKey[]
}

StableResolutionState = {
  input: ValidatedResolutionInput
  matches: ScopeMatchSet
  graph: ProtectionOverlayGraph
  ranked: RankedResolution
  overlay: OverlayEvaluation
  dependencies: DependencyEvaluation
  typeResolution: TypeResolution
}

ResolutionResult = {
  context: ValidatedExecutionContext
  scope: NormalizedResolutionScope
  evaluations: readonly ResolutionEvaluation[]
  outcome: "resolved" | "conflicted"
  conflicts: readonly ResolutionConflict[]
}
```

`ResolutionResult` は Core-domain の内部結果であり、`resolvedAt`、body、token cost を持たない。`result-assembly` が各内部 reason を exactly one にし、`toResolutionReasonDto` / `toResolutionConflictDto` / `toResolutionConflictDetails` を担当する。これは現行の `scope-resolver.ts:825-869` にある projection を同 seam へ移す方針である。

## 6. 公開契約の再設計

### 契約の所有範囲

network / IPC を越える型は `shared/src/`、Resolver の意味論と内部状態は `core-domain/src/` に置く。`core-domain` の `ResolutionResult` をそのまま wire に出さず、`result-assembly` の projection と将来の Core adapter が `shared` DTO を構成する。これで `shared` に domain algorithm を持ち込まず、Extension が Resolver を複製せずに済む。

### request / response の shape

現行 `shared/src/resolution.ts:34-49` の `ResolveRequest.scope` と、`shared/src/resolved-context.ts:113-121` の `ResolvedContextDto.scope` を次の形へ置き換える。旧 `scope` を受け付ける optional alias や `resolveScopeFixedPoint` 呼出し wrapper は設けない。

```text
ResolveRequest {
  context: ResolutionContextInput
  ide?: IdeContextInput
  loadingTiers?: LoadingTier[]       // 存在時は minItems 1
}

ResolvedContextDto {
  context: ResolutionContextDto       // parsed ResolutionContextInput
  assets: ResolvedAssetDto[]
  conflicts: ConflictDto[]
  cost: ContextCostDto
  resolvedAt: Timestamp
}

ResolveResponse {
  resolvedContext: ResolvedContextDto
}
```

`context` は request と結果の双方で同じ explicit execution state を運ぶ。内部の `scope` projection（9 matching axes）と `context` は重複 wire 欄にしない。`standalone` の `skillId` は workflow selection の一部として運び、execution permission の判定は Orchestrator / User が担う。`TaskId`、`workflowRevision`、`provenance` は今回の pipeline に読み手がないため、この公開契約の欄へ追加しない。Task は #110 / #4、workflow revision は #13、provenance は #14 の owner が必要な時点で形を定める。

`ResolvedAssetDto` は現行の asset identity / content / reason の欄を保ち、binding の出所を表す `provenance` は今回の required 欄へ追加しない。resolution explainability は `reason` が担い、source-of-truth の provenance は #14 の契約として別に設計する。

### 理由 DTO

`shared/src/status.ts` の `ResolutionReason` は説明文字列だけでなく、内部 reason の機械可読な決定値を次の strict discriminated shape で伝える。全 arm に `explanation: NonEmptyString` を置く。

```text
ResolutionReason =
  | {
      kind: "included"
      explanation: NonEmptyString
      matchedAxes: NonEmptyString[]
      degradedInfo?: DegradedInfo
      degradedCapabilities?: CapabilityDegradationDto[]
    }
  | {
      kind: "excluded"
      explanation: NonEmptyString
      detail:
        | { cause: "scope_mismatch"; matchedAxes: NonEmptyString[] }
        | { cause: "invalid_directory"; diagnostics: CoreErrorDetail[] }
        | { cause: "resolution_conflict"; conflict: ConflictDto }
    }
  | {
      kind: "overridden"
      explanation: NonEmptyString
      overriddenBy: AssetId
      mergeGroup: NonEmptyString
    }
  | {
      kind: "disabled"
      explanation: NonEmptyString
      disabledBy: AssetId
    }
  | {
      kind: "unavailable"
      explanation: NonEmptyString
      availability: "unavailable"
      detail:
        | {
            cause: "missing_requirement" | "requirement_out_of_scope" |
              "requirement_disabled" | "requirement_overridden" |
              "requirement_cycle" | "requirement_invalid"
            failedRequirements: AssetId[]
          }
        | {
            cause: "capability_unavailable" | "capability_not_allowed"
            failedCapabilities: NonEmptyString[]
            failedRequirements?: AssetId[]
          }
    }
```

公開 reason の winner 説明欄は `matchedAxes` のみとし、`ResolutionRank`、`matchingAxisCount`、`scopePrecedence`、`directoryDepth`、`sourceLayerPrecedence` は internal evaluation に留める。`matchedAxes` は存在必須・空配列可の `NonEmptyString[]` とし、excluded の scope mismatch detail も同じ field で一致した軸を表す。内部 `ResolutionAxisName` の値を public DTO が受けるときは result assembly が `NonEmptyString` へ変換する。

degraded は `kind: "included"` のまま `degradedInfo` を持つ。`kind: "unavailable"` は hard failure のみで `availability: "unavailable"` に固定する。これにより `kind === "included"` が context membership の唯一の信号であり、optional / preferred capability の欠落が context から消えないという root Ledger の不変条件を wire でも維持する。

### 競合 DTO

現行の 2 欄 `ConflictDto`（`AGENTS.md:382-386`）を、内部 `ResolutionConflict` の全 arm を表す閉じた machine-readable kind の strict union として投影する。

```text
ConflictDto =
  | { kind: "exclusive_tie"; explanation: NonEmptyString; mergeGroup: NonEmptyString; involvedAssetIds: AssetId[] }
  | { kind: "mandatory_conflict"; explanation: NonEmptyString; involvedAssetIds: AssetId[] }
  | { kind: "operation_conflict"; explanation: NonEmptyString; targetAssetId: AssetId; involvedAssetIds: AssetId[] }
  | { kind: "duplicate_identity"; explanation: NonEmptyString; assetId: AssetId; involvedAssetIds: AssetId[] }
  | { kind: "dependency_cycle"; explanation: NonEmptyString; involvedAssetIds: AssetId[] }
  | { kind: "dependency_failure"; explanation: NonEmptyString; failedRequirement: AssetId; involvedAssetIds: AssetId[] }
  | { kind: "asset_type_conflict"; explanation: NonEmptyString; involvedAssetIds: AssetId[] }
  | { kind: "capability_failure"; explanation: NonEmptyString; failedCapabilities: NonEmptyString[]; involvedAssetIds: AssetId[] }
```

各 `involvedAssetIds` と `failedCapabilities` は `minItems: 1`、`mergeGroup` と説明は `NonEmptyString` とする。`ConflictDto.kind` の 8 値は閉じた公開集合として固定し、arm 追加・削除、required 欄の追加、kind 固有欄の型変更を breaking contract として扱う。`ConflictDto` は reason の `resolution_conflict` detail から参照できるが、reason 側で別の説明文・ID 順を作らない。canonical ID 順、conflict kind 順、kind 固有 key 順は result-assembly の一箇所だけで決める。

### Capability の wire 境界

今回の Resolver は Core 内の domain call として `CapabilityResolutionSnapshot` を required input に受ける。現行 HTTP route は health だけで、Capability snapshot を送る request route が 0 件である。#12 が process 境界を設ける時点では、Capability owner の `catalog` / `offers` と `available` / `allowed` を同じ transport exchange で運ぶ wire DTO を `shared` に登録し、adapter が validated snapshot を domain call へ渡す。transport 欄の欠落は `invalid_request` とし、Capability owner が返した明示的な空 snapshotだけを 0 offers として渡す。これが root Ledger の omission trap を wire 境界で解消するための必須配線である。


### version と JSON Schema

`shared/src/contract-version.ts:25` の `CONTRACT_VERSION` は `0.4.0` から `0.5.0` へ上げる。理由は required な explicit context、`scope` から `context` への変更、execution mode / workflow selection、reason / conflict の required discriminator と欄追加が旧 consumer と非互換になるためである。`TaskId`、`workflowRevision`、`provenance`、reason の rank はこの version の公開欄へ含めない。per-schema version、URL version prefix、Core implementation version は追加しない。health は既存規則どおり `{ contractVersion: "0.5.0" }` のみを返す。

`shared/src/json-schema.ts:30-68` の `contractSchemas` の登録対象は `ResolveRequest`、`ResolveResponse`、`ResolvedContextDto` のままとし、context / reason / conflict は親 schema に inline する。`ResolutionContextInput` と excluded / unavailable / conflict の各 union arm は `z.discriminatedUnion` の arm とし、各 arm の `additionalProperties: false` と required 欄を JSON Schema に出す。parse 側だけの cross-field refine は使わない。追加する schema test は、(1) development + no workflow、(2) advisory + selected workflow、(3) unavailable + available、(4) reason detail の required field 欠落、(5) conflict arm の余分な欄、(6) context / result の unknown key を parser と生成 schema の双方で拒否する。

`shared/src/index.ts` には `SkillId`、`ExecutionMode`、`ResolutionContextInput`、workflow selection、reason / conflict 型、`EXECUTION_MODES` を re-export する。schema 値や zod 値は export せず、必要な runtime 関数は既存の `parseResolveRequest` / `parseResolveResponse` / `parseResolvedContextDto` の範囲に留める。`core-domain/src/index.ts` には新 pipeline と projection の公開型を全て re-export し、直接 module import を新設しない。

reason / conflict に載せる capability identifier は `NonEmptyString` として投影し、`CapabilityId` / `CapabilityFeatureId` の domain brand を shared へ拡張しない。`ResolutionAxisName` と `RESOLUTION_AXES` は core-domain に残し、mapping table と実 Candidate projection の機械検査は §3 の `axis-mapping.ts` / test が担う。on-disk `ASSET_SCOPE_AXES` は別語彙のままなので、`project→projectId`、`task-type→taskTypeId` などの mapping は型の似た string を頼らず明示表として管理する。

この contract change は Core API route の実装を含まない。route がまだ存在しないため、今回の変更時点で通信の status code や URL の挙動は変えないが、将来 consumer が health で互換性を判定する時点から 0.4.x consumer は incompatible になる。

## 7. 既存不変条件と影響範囲

### 維持する不変条件と変更する境界

| 不変条件 | 実装上の owner | 要件 / 実測根拠 | 切替後の扱い |
|---|---|---|---|
| scope 軸間は AND、同一軸 selector は OR | scope matching | `scope-resolver.ts:442-488`、RES-003 / RES-004 | 維持。`workflow.kind: "none"` では workflow / stage request value を未指定として扱い、selector candidate は現行どおり neutral に評価する。実行可能な行為の制限は #101 の authorization owner が担う |
| priority → specificity → scope precedence、directory は特則、unbeaten は逐次排除しない | ranking / precedence | `scope-resolver.ts:381-431`、RES-006〜008 / RES-013、Ledger L9 | 維持。stage の現行値 45 も維持し、Task に新しい順位は与えない |
| mandatory は rank より強く、mandatory target への disable を許さない | protection / overlay + type resolution | `scope-resolver.ts:243-250`、case 8 / 10-h、RES-009 | 維持。保護 conflict と per-candidate reason を両方返す |
| exact duplicate の代表は同一 id + revision の semantic 一致後、layer → sourceId | candidate validation | `scope-resolver.ts:303-351`、`AGENTS.md:429-437` | 維持。revision は `serializeCanonicalAsset` の SHA-256 identity とし、mtime / input order に置換しない |
| 同一 id + revision でも semantic meaning が違えば duplicate conflict | candidate validation | `scope-resolver.ts:303-323`、Ledger L3 / L4 | 維持。capability relation、operation、selector、requires も比較対象にする |
| type 固有の許可は `Record<AssetType, AssetTypeContract>` に集約 | type-specific conflict / merge / ordering | `asset-type-contracts.ts:41-48`、`AGENTS.md:439-446`、AST-002 | 維持。共通 pipeline の asset type 分岐は増やさない |
| required failure は unavailable、soft capability failure は included + degraded | dependency evaluation + result assembly | `AGENTS.md:453-458`、RES-010〜012 | 維持。public reason でも `kind: included` を membership signal とする |
| capability context は全候補で同一、validate は一度 | candidate validation + dependency evaluation | `resolution/ledger.md:36-43`、`scope-resolver.ts:873-896` | `capabilitySnapshot` を必須値にし、明示 empty snapshot と omission を区別する |
| capability state は available / unavailable と allowed / denied の 2 軸 | capabilities + dependency evaluation | CAP-006、`core-domain/src/resolution/capabilities.ts:35-43` | 4 通りの直積を観測し、第三の未観測状態を作らない。offer 不在は unavailable、explicit empty snapshot は 0 offers として扱う |
| 共通 pipeline の asset type 分岐を type contract registry の外へ置かない | asset-type-contracts + source scan | root `AGENTS.md` Ledger #75、`core-domain/tests/asset-type-contracts.test.ts:368-382` | Phase A で `../src/resolution/*.ts` を glob し、7 seam の新ファイルを含む全 source を同じ機械検査へ入れる |
| 全候補の structure / type / capability declaration を scope 除外より先に検証 | candidate validation | `scope-resolver.ts:905-965`、Ledger L4 / L5、case S14 | 維持。out-of-scope candidate も invalid feature を隠さない |
| output と conflict は canonical order、candidate input permutation に不依存 | ranking + result assembly | `scope-resolver.ts:736-809`、`2272-2286`、RES-017 | 維持。ID / revision / source / rule の tuple と kind 固有 key で sort する |
| resolution result は semantic fields のみで、time / body / cost を持たない | result assembly | case 17.5 result clock boundary（`scope-resolver.test.ts:2295-2302`） | 内部 result では維持。wire `ResolvedContextDto` は Core adapter が `resolvedAt` / body / cost を別途付与する |
| directory は POSIX absolute lexical value のみ | candidate validation + scope matching | `resolution-context.ts:62-115`、RES-013 | 維持。Node path API、Windows drive、backslash の変換は core-domain に入れない |
| Core-domain は host 能力に触れない | 全 seam | `AGENTS.md:121-129` | 維持。`node:*`、VS Code、Tauri、filesystem API を新 module に import しない |

### 影響範囲（start / end の対）

| 接合面 | 現在の start → end | 切替後の start → end | bypass 防御と実測影響 |
|---|---|---|---|
| 公開 Resolver 入口 | `core-domain/src/index.ts:75-80` → `scope-resolver.ts:2289-2291` | `core-domain/src/index.ts` → `resolution/pipeline.ts` の `resolveScope` | `core-domain/tests` の public import は index 経由。`resolveScope` の tracked consumer は index と `scope-resolver.test.ts` / `asset-type-contracts.test.ts` の 2 test fileだけで、Core / Extension は 0 件 |
| Resolver input | `shared/src/resolution.ts:34-40` の `scope` → `resolution-context.ts:118-170` の 9 optional axes | `ResolveRequest.context` → candidate-validation の `ValidatedExecutionContext + NormalizedResolutionScope` | strict union は `development_execution` + `workflow.kind: "none"` だけを `invalid_request` とし、他の mode / workflow selection 組合せを受理する。旧 `scope` alias は作らず、旧 shape の silent acceptance を防ぐ |
| on-disk scope mapping | test-only `candidateFromCanonicalAsset`（`scope-resolver.test.ts:87-125`）→ `resolve()`（同:137-145） | #4 の実 Candidate producer → `AssetCandidate` → pipeline | 現在 production の CanonicalAsset→Candidate producer は tracked code に存在せず、現在の mapping assertion は helper の結果を検査している。今回の Resolver は mappingを再実装せず、test helper を正としない |
| candidate validation | `scope-resolver.ts:905-965` → `states` / `invalidStates`（同:966-1060） | candidate-validation → `ValidatedResolutionInput` → scope matching | invalid-directory は candidate-level value、structural invalid は request failure として経路を分離。全候補先行検証を保持 |
| scope / rank | `matchesScope`（同:442-488）→ `selectUnbeaten`（同:427-431） | scope-matching → ranking-precedence | `workflow.kind: "none"` の selector 評価は現行の undefined request value と同じ neutral。comparison を一つの fixed-point closure に埋め込まない。directory の非推移性と input order independence を ranking の test seam に固定 |
| operation | nested `OperationPass` / `evaluatePlan` / `runCurrentOperation`（同:1071-1904）→ `finalPass.statuses`（同:2143-2179） | protection-overlay graph → overlay evaluation → type materialization feedback | operation issuer、target、cycle、protection を explicit edge/value で渡す。消滅した issuer の failure を最終 conflict に残さない規則を維持 |
| dependency | `dependencyOutcomes` と `evaluateCapabilityDependenciesInValidatedContext`（同:1181-1477）→ `finalReasons`（同:2182-2223） | capability snapshot validation → dependency-evaluation → result assembly | capability evaluator を candidate ごとに再検証しない。requires / capability failures の union と SCC が同じ candidate state を見る |
| type semantics | `asset-type-contracts.ts:1-72` と Resolver の validation / selection が相互に参照 | resolution-types → asset-type-contracts / type-resolution | operation 型を common model へ移し import cycle を解消。type contract へは pipeline からだけ入力し、type 名の共通分岐を増やさない |
| public reason / conflict | `CandidateReason` → `toResolutionReasonDto`（`scope-resolver.ts:106-153,825-869`）→ `shared/src/status.ts:70-103` | result-assembly → structured `ResolutionReason` / `ConflictDto` → `ResolvedContextDto` | reason 文字列の再解析を consumer に要求しない。public reason は `matchedAxes`、public conflict は閉じた `kind` と failure IDs を運び、internal rank は wire 欄へ投影しないため canonical precedence の未確定値を契約へ固定しない |
| public response | `ResolvedContextDto.scope`（`shared/src/resolved-context.ts:108-128`） | `ResolvedContextDto.context`（explicit execution state）→ future Core adapter | 現在 Core HTTP は `/health` のみで response consumer は 0 件。新 route は #12 の範囲に残し、今回の変更で network handler を増やさない |
| capability state | `CapabilityResolutionContext` optional `catalog + offers`（`capabilities.ts:40-43`）→ `capabilityAvailable` | Capability module の `CapabilityResolutionSnapshot`（availability / permission）→ dependency-evaluation | `available` と `allowed` を別欄にし、required / preferred は dependency strength に残す。省略 default の bypass を必須 input で封じる |
| result identity / dedup | `makeAssetRevision` の serialized canonical asset → Resolver exact duplicate fold | 同じ SHA-256 revision → candidate-validation semantic fold | `AssetRevision` を mtime / uuid に変える設計は採らない。body の暗黙後勝ちを防ぐ既存 invariant を維持 |
| ledger / index | root AGENTS + `core-domain/src/resolution/ledger.md` → 現行 module 内の nested helpers | root AGENTS + resolution Ledger + 新 capabilities Ledger → 各 owner module | 10 resolution entries は全件上表へ移管。新箱の追加は root Ledger 一覧と箱 Ledger の両方を更新する必要がある |

Core HTTP の start path（`core/src/index.ts:30-112`）と Extension の ProjectClient（`vscode-extension/src/project-client.ts:8-12`）はこの変更の start / end に入るが、Resolver consumer ではないため行動を変更しない。

### ゼロ件予測の自己照合

「consumer 0 件」「route 0 件」という述語は、現在の tracked code だけを母集団にして実測した。新設する `resolution/pipeline.ts` と 7 seam は内部実装であり、これら自身が public consumer として数えられないことを明記する。新設 `core-domain/src/capabilities/` は pipeline が読む producer-side value の owner だが、外部 package consumer ではない。したがって、現在の外部 consumer 0 件という数へ新設要素を二重計上していない。

`shared` に新しい `SkillId` / context / reason / conflict を宣言する。今回の実測 consumer は 0 件のままとし、#12 / #31 の配線時に `core → core-domain + shared`、`vscode-extension → shared` として参照を計上する。`TaskId`、`workflowRevision`、`provenance` はこの新設要素の数へ含めず、各 owner issue の契約として後段で計上する。

## 8. 118テスト全件の分類表

### 集計方法と分類の定義

母集団は`core-domain/tests/scope-resolver.test.ts` の行頭空白を除く直接 `it(` 宣言である。実測は 118 件（同ファイル 194〜2578 行）。`it.each` は 9 宣言（同 223、462、865、900、1082、1329、2063、2084、2135 行）で、直接宣言数には含めないが、下の補足で全件を扱う。

- `残す`: Resolver が担う意味論の behavior-pinning test。物理的には seam 別 test file へ分割してよいが、実行は `@aacl/core-domain` の `resolveScope` 公開入口から行う。
- `移す`: Capability / public contract / Candidate projection など別 owner の test。移動後はその owner の実入口と、Resolver を通る関係について必要な integration test を分ける。
- `削除`: 新しい責務で保護する behavior がなく、代替 test も必要としないもの。該当なしとする。test helper `candidateFromCanonicalAsset` は削除対象だが、それを呼ぶ test case は実 data path へ移すため、test row の削除には数えない。

記号は `V`=candidate validation、`M`=scope matching、`O`=protection / overlay、`R`=ranking / precedence、`D`=dependency evaluation、`T`=type-specific resolution、`A`=result assembly、`P`=shared public contract、`I`=pipeline integration である。要件 ID は `.requiments/agent-asset-control-layer-requirements-decomposed.md` の ID、`§34` は explainability / provenance の separation を示す。

| # | source test name（行） | 要件 ID | 分類 | 移動先 / seam owner |
|---:|---|---|---|---|
| 1 | `case 0: resolves an empty snapshot without implicit candidates or conflicts`（194） | RES-001, RES-017 | 残す | I / V |
| 2 | `case 0-c: returns invalid_request for a structurally invalid candidate`（202） | RES-005 | 残す | V |
| 3 | `case 0-d: validates structure before excluding an invalid-directory candidate`（212） | RES-005, RES-014 | 残す | V |
| 4 | `case 0-b: keeps different global meanings conflicted when every axis is unknown`（237） | RES-014, RES-017 | 残す | R / T |
| 5 | `pins all nine asset-scope to resolution-scope axis mappings`（264） | RES-002, RES-003 | 移す | #4 Candidate projection test。現行 helper の mapping assertion を Resolver test の正にしない |
| 6 | `case 1: includes a global candidate without selectors`（317） | RES-003, RES-018 | 残す | M |
| 7 | `case 2: matches any selected role and excludes an outsider`（329） | RES-004 | 残す | M |
| 8 | `case 3: reports only the mismatched axis and treats an unknown selector axis as neutral`（345） | RES-003, RES-004, RES-017 | 残す | M |
| 9 | `case 4: does not let an unspecified model affect matching or specificity`（360） | RES-003, RES-006 | 残す | M / R |
| 10 | `case 5: normalizes directory scope and matches descendants but not sibling prefixes`（372） | RES-003, RES-013 | 残す | V / M |
| 11 | `case 5-b: gives a root directory candidate precedence over an unscoped candidate`（389） | RES-013 | 残す | R |
| 12 | `case 6: chooses the deepest matching directory in an exclusive group`（409） | RES-013 | 残す | R |
| 13 | `case 20: matches a project source by its project selector`（438） | RES-003 | 残す | M |
| 14 | `case 7: compares explicit priority before matching specificity`（450） | RES-006 | 残す | R |
| 15 | `case 22: compares the second scope-precedence vector element`（505） | RES-007 | 残す | R |
| 16 | `case 23: prefers the deeper matching directory across a scope-axis boundary`（526） | RES-008, RES-013 | 残す | R |
| 17 | `case 24: prefers a directory candidate over a role-only candidate`（549） | RES-007, RES-013 | 残す | R |
| 18 | `case 25: compares directory priority before depth and source layer`（570） | RES-013 | 残す | R |
| 19 | `case 26: keeps equal directory-special keys conflicted`（604） | RES-013, RES-014 | 残す | R |
| 20 | `case 27: gives explicit priority precedence over source layer`（626） | RES-006 | 残す | R |
| 21 | `case 28: gives scope vector precedence over source layer`（644） | RES-007 | 残す | R |
| 22 | `case 29: uses source layer as the final rank tie-break`（662） | RES-007 | 残す | R |
| 23 | `case 30: keeps the spoiler set conflicted and selects the unbeaten spoiler pair`（690） | RES-014 | 残す | R |
| 24 | `case 31: reports the X/Y/Z precedence cycle for every candidate permutation`（731） | RES-014, RES-017 | 残す | R / I |
| 25 | `case 32: applies directory precedence to operation issuer selection`（764） | RES-007, RES-013 | 残す | O / R |
| 26 | `case 33: keeps all-disable provenance stable when a lower-ranked directory issuer is present`（795） | RES-013, RES-016 | 残す | O / A |
| 27 | `case 34: coalesces all-disable issuers that form the X/Y/Z precedence cycle`（821） | RES-014, RES-016 | 残す | O / R |
| 28 | `case 8: preserves a mandatory target and reports a mandatory disable conflict`（840） | RES-009, RES-014 | 残す | O / A |
| 29 | `case 9: applies an explicit override only to its target in the same merge group`（853） | RES-005, RES-009 | 残す | O |
| 30 | `case 9-c: keeps an unrelated same-ID candidate in duplicate conflict`（883） | RES-014 | 残す | V / O |
| 31 | `case 10: keeps additive assets and resolves the exclusive subgroup`（921） | RES-015 | 残す | T |
| 32 | `case 10-b: does not apply an operation from an exclusive loser`（936） | RES-005, RES-009 | 残す | O / R |
| 33 | `case 10-c: reselects an exclusive loser after the winner is disabled`（951） | RES-005, RES-014 | 残す | O / R / D |
| 34 | `case 10-d: reselects after an exclusive winner is overridden`（973） | RES-005, RES-014 | 残す | O / R / D |
| 35 | `case 10-e: reselects a healthy lower candidate after winner dependency failure`（996） | RES-010, RES-014 | 残す | D / O / R |
| 36 | `case 10-e-1: lets the surviving lower issuer update the old winner provenance`（1016） | RES-016 | 残す | O / A |
| 37 | `case 10-f: reports a canonical conflict for a selection/dependency feedback cycle`（1032） | RES-014, RES-017 | 残す | I / R |
| 38 | `case 10-g: retains an exclusive winner operation conflict when no fallback exists`（1050） | RES-014, RES-016 | 残す | O / A |
| 39 | `case 10-g-1: reselects after a non-mandatory winner operation conflict`（1066） | RES-005, RES-014 | 残す | O / R |
| 40 | `case 10-g-3: retains the winner operation conflict when every fallback is unavailable`（1103） | RES-010, RES-014, RES-016 | 残す | O / D / A |
| 41 | `case 10-h: protects a mandatory exclusive winner from fallback`（1131） | RES-009 | 残す | O |
| 42 | `case 10-i: reselects after an operation cycle and reports only the final graph conflict`（1150） | RES-014, RES-016 | 残す | O / R / A |
| 43 | `case 10-j: reports no stable selection when fallback satisfies the old winner requirement`（1176） | RES-014 | 残す | O / D / R |
| 44 | `case 10-o: keeps independent dependency failures out of selection feedback`（1194） | RES-010, RES-014 | 残す | D / R |
| 45 | `case 10-k: does not retain disable provenance from an issuer removed by fallback`（1220） | RES-012, RES-016 | 残す | O / D / A |
| 46 | `case 10-l: retains a fallback operation conflict when the old winner has an independent dependency failure`（1240） | RES-010, RES-014, RES-016 | 残す | O / D / A |
| 47 | `case 10-m: classifies a requirement from a reselected target by its current disabled status`（1277） | RES-010, RES-014, RES-016 | 残す | D / O / A |
| 48 | `case 10-n: keeps a surviving disabler actionable when the remaining exclusive tie omits the old winner`（1304） | RES-009, RES-014 | 残す | O / R |
| 49 | `case 11: projects a tie conflict and its per-asset details`（1347） | RES-016, §34 | 移す | `core-domain/tests/result-assembly.test.ts` と `shared/tests` の public conflict schema |
| 50 | `case 12: exposes public reasons for mismatch, disable, override, and unavailable states`（1366） | RES-016, §34 | 移す | `result-assembly` projection + `shared/tests`。文字列からの再判定を残さない |
| 51 | `case 13: makes conflict and evaluation order independent of candidate order`（1386） | RES-017 | 残す | I / R / A |
| 52 | `case 14-a: marks a missing requirement unavailable without a resolver conflict`（1399） | RES-010 | 残す | D |
| 53 | `case 14-b: detects a self requirement cycle after parsing`（1406） | RES-010, RES-014 | 残す | D |
| 54 | `case 14-c: detects a two-asset requirement cycle`（1413） | RES-010, RES-014 | 残す | D |
| 55 | `case 14-d: reports different meanings for the same source identity as a conflict`（1424） | RES-014 | 残す | V |
| 56 | `case 14-e: orders same-identity candidates by their remaining meaning`（1436） | RES-017 | 残す | V / A |
| 57 | `case 14-f: re-evaluates dependents after a same-ID overlay resolves`（1453） | RES-010, RES-014 | 残す | O / D |
| 58 | `case 14-g: re-runs operation discovery for a dependent revived by an overlay`（1471） | RES-005, RES-010 | 残す | O / D |
| 59 | `case 14-h: canonicalizes dependency-cycle diagnostics across candidate order`（1493） | RES-010, RES-017 | 残す | D / A |
| 60 | `case 15-a: fails a dependency whose target is outside the requested scope`（1510） | RES-010 | 残す | D / M |
| 61 | `case 15-b: does not revive a disabled dependency`（1521） | RES-010 | 残す | D / O |
| 62 | `case 15-b-1: re-evaluates a surviving issuer after removing an unavailable blocker`（1533） | RES-010, RES-014 | 残す | D / O |
| 63 | `case 15-b-2: does not let an unavailable issuer disable its target`（1555） | RES-010, RES-014 | 残す | O / D |
| 64 | `case 15-b-2-a: excludes an unavailable issuer before operation cycle detection`（1568） | RES-010, RES-014 | 残す | O / D |
| 65 | `case 15-b-3: rolls back an operation when its issuer loses a required target`（1588） | RES-005, RES-010 | 残す | O / D |
| 66 | `case 15-b-4: reports a cycle between operation issuers`（1601） | RES-014, RES-016 | 残す | O / A |
| 67 | `case 15-b-7: reports a non-convergent dependency feedback operation`（1616） | RES-014, RES-017 | 残す | I / O |
| 68 | `case 15-b-8: diagnoses dependents from the final operation-cycle state`（1637） | RES-010, RES-014 | 残す | D / O / A |
| 69 | `case 15-b-5: keeps an operation chain deterministic while recomputing blocked issuers`（1656） | RES-005, RES-017 | 残す | O / D |
| 70 | `case 15-b-6: reports every disjoint operation cycle`（1675） | RES-014, RES-016 | 残す | O / A |
| 71 | `case 15-c: does not redirect a dependency from an overridden loser to its winner`（1697） | RES-010, RES-014 | 残す | D / O |
| 72 | `case 15-d: classifies a disabled in-scope requirement before an out-of-scope alternative`（1709） | RES-010 | 残す | D / M |
| 73 | `case 15-d-2: classifies a disabled matched requirement before an invalid alternative`（1726） | RES-005, RES-010 | 残す | V / D |
| 74 | `case 15-e: failed op issuer disabled`（1743） | RES-005, RES-010 | 残す | O / D |
| 75 | `case 15-f: leaves a direct requirement target available to its issuer`（1761） | RES-010 | 残す | D |
| 76 | `case 15-g: drops an operation failure when dependency closure disables its issuer`（1788） | RES-010, RES-016 | 残す | O / D / A |
| 77 | `case 15-h: traverses a long dependency chain without recursion`（1809） | RES-010, RES-017 | 残す | D |
| 78 | `case 15-h-1: traverses a long operation graph without recursion`（1827） | RES-005, RES-017 | 残す | O |
| 79 | `case 15-i: reconciles operation groups independent of candidate order`（1849） | RES-014, RES-017 | 残す | O / I |
| 80 | `case 15-j: runs dependent closure after operation failure`（1870） | RES-010, RES-014 | 残す | O / D |
| 81 | `case 15-k: runs dependent closure after final operation feedback`（1889） | RES-010, RES-014 | 残す | O / D |
| 82 | `case 15-l: stabilizes unrelated operations after resolving a cycle`（1906） | RES-014, RES-017 | 残す | O / I |
| 83 | `case 15-m: pins fixed-point invariants for every candidate permutation`（1921） | RES-014, RES-017 | 残す | I |
| 84 | `case 16: keeps a healthy candidate included beside an unavailable candidate`（1989） | RES-010, RES-011 | 残す | D / A |
| 85 | `case 17: retains a mandatory dependency failure as a conflict`（2001） | RES-010, RES-016 | 残す | D / A |
| 86 | `case 17-b: retains a dependency cycle alongside an earlier dependency failure`（2013） | RES-010, RES-014, RES-016 | 残す | D / A |
| 87 | `case 17-c: retains a dependency failure when the cycle sorts first`（2026） | RES-010, RES-014, RES-016 | 残す | D / A |
| 88 | `case 17-d: propagates a non-cycle failure across a dependency cycle`（2045） | RES-010, RES-014 | 残す | D / A |
| 89 | `case 17.5 directory trailing slash: returns the normalized request scope`（2073） | RES-002, RES-017 | 残す | V / M |
| 90 | `case 17.5 candidate directory rejection: excludes only the invalid candidate`（2094） | RES-005, RES-014 | 残す | V / M |
| 91 | `case 17.5-a: checks identity payload consistency before invalid-directory partition`（2116） | RES-005, RES-014 | 残す | V |
| 92 | `case 17.5 empty selector element: rejects it as an invalid candidate snapshot`（2146） | RES-005 | 残す | V |
| 93 | `case 17.5 invalid merge shape: rejects an exclusive candidate without a merge group`（2158） | AST-002, RES-005 | 残す | V / T |
| 94 | `case 17.5 out-of-scope operation target: reports an operation conflict without disabling the target`（2171） | RES-005, RES-014 | 残す | O |
| 95 | `case 17.5 operation conflict: records a lower-ranked operation that loses to another kind`（2182） | RES-006, RES-014 | 残す | O / R |
| 96 | `case 17.5 operation tie: marks a lower-ranked contrary issuer conflicted`（2208） | RES-014 | 残す | O / R |
| 97 | `case 17.5 candidate order: sorts same-rank additive evaluations by AssetId`（2233） | RES-017 | 残す | R / A |
| 98 | `case 17.5 exact duplicate: chooses the project/source-a representative`（2244） | RES-017 | 残す | V |
| 99 | `case 17.5 full DTO projection: accepts a result projected through the shared response schema`（2256） | RES-016, §34 | 移す | `core-domain/tests/result-assembly.test.ts` + `shared/tests` |
| 100 | `case 17.5 conflict detail carrier: uses canonical IDs in detail order`（2279） | RES-016, §34 | 残す | A |
| 101 | `case 17.5 result clock boundary: contains only semantic result fields`（2295） | RES-016 | 移す | A / P。内部 result と wire context の境界を別 test にする |
| 102 | `S1: marks a missing required capability unavailable`（2304） | CAP-004, CAP-007 | 移す | `core-domain/tests/capabilities.test.ts` の capability entry point |
| 103 | `S2: retains a candidate with an optional capability degradation`（2319） | CAP-004, CAP-007, RES-011 | 移す | Capability boundary。Resolver には degraded issuer の integration test を残す |
| 104 | `S3: retains a candidate with a preferred capability degradation`（2333） | CAP-004, CAP-007 | 移す | Capability boundary |
| 105 | `S4: records adoption of a fallback for a required capability`（2346） | CAP-004, CAP-007, RES-012 | 移す | Capability boundary。fallback adoption の DTO は result integration で pin |
| 106 | `S5: marks a required capability unavailable when its fallback is also absent`（2370） | CAP-004, CAP-007, RES-010 | 移す | Capability boundary |
| 107 | `S6: treats an omitted capability context as an empty offer set`（2390） | CAP-006, CAP-007 | 移す | Capability boundary。新契約では explicit empty snapshot の test へ置換 |
| 108 | `S7: does not apply an operation from a hard-failed capability issuer`（2402） | CAP-006, RES-005, RES-010 | 残す | O / D |
| 109 | `S8: applies an operation from a soft-degraded capability issuer`（2415） | CAP-006, RES-011 | 残す | O / D / A |
| 110 | `S9: records a mandatory capability failure as a conflict`（2428） | CAP-007, RES-010, RES-016 | 残す | D / A |
| 111 | `S10: does not combine features from separate offers`（2444） | CAP-005, CAP-006 | 移す | Capability boundary。offer 単位の feature containment |
| 112 | `S11: treats same-identity candidates with different capability relations as a conflict`（2457） | CAP-004, RES-014 | 残す | V |
| 113 | `S12: rejects capability dependencies on a type outside the capability policy`（2475） | AST-002, CAP-001 | 残す | V / T。type contract registry が owner |
| 114 | `S13: rejects an undeclared capability feature on an in-scope candidate`（2489） | CAP-005, RES-005 | 移す | Capability declaration validation。Resolver は validated dependency を消費 |
| 115 | `S14: rejects an undeclared capability feature on a candidate outside the scope`（2508） | CAP-005, RES-005 | 残す | V。scope 除外前の全候補 validation を守る integration |
| 116 | `S15: roots capability context diagnostics at the input field`（2524） | CAP-006, CAP-007 | 移す | Capability snapshot parser / public input diagnostics |
| 117 | `S16: propagates a capability failure across a dependency cycle`（2535） | CAP-007, RES-010, RES-016 | 残す | D / A |
| 118 | `S17: propagates a capability failure a single cycle member requires from outside`（2558） | CAP-007, RES-010, RES-016 | 残す | D / A |

集計: `残す 104`、`移す 14`、`削除 0`、合計 `118`。削除 test が 0 件なので、現行 118 件の behavior protection を削除によって失わせる設計ではない。移した 14 件は owner の入口へ移し、Resolver に必要な cross-seam assertion を残す。

### 固定点意味論を pin する 18 件の裁定済み保全

次の 18 件の保全根拠は、v12 条文の直接要求ではなく、#71 / #76 で確立した Resolver の実装意味論（排他 winner の disable / override 後の再選択、operation feedback、SCC、収束判定）である。ユーザー裁定により、これらを巨大クロージャの実装形から分離した後も v12 Resolver の責務として維持する。表の要件 ID は分類上の対応を示し、保全理由そのものは #71 / #76 とこの裁定である。

| source line | test | 保全する意味論 |
|---:|---|---|
| 951 | `case 10-c: reselects an exclusive loser after the winner is disabled` | disable 後の排他再選択 |
| 973 | `case 10-d: reselects after an exclusive winner is overridden` | override 後の排他再選択 |
| 996 | `case 10-e: reselects a healthy lower candidate after winner dependency failure` | dependency failure 後の再選択 |
| 1032 | `case 10-f: reports a canonical conflict for a selection/dependency feedback cycle` | selection / dependency feedback cycle の conflict |
| 1066 | `case 10-g-1: reselects after a non-mandatory winner operation conflict` | operation conflict 後の再選択 |
| 1150 | `case 10-i: reselects after an operation cycle and reports only the final graph conflict` | operation cycle 後の再選択と最終 conflict |
| 1194 | `case 10-o: keeps independent dependency failures out of selection feedback` | 独立 failure の feedback 分離 |
| 1277 | `case 10-m: classifies a requirement from a reselected target by its current disabled status` | 再選択後の current disabled status |
| 1453 | `case 14-f: re-evaluates dependents after a same-ID overlay resolves` | same-ID overlay 後の dependent 再評価 |
| 1471 | `case 14-g: re-runs operation discovery for a dependent revived by an overlay` | overlay 後の operation discovery 再実行 |
| 1521 | `case 15-b: does not revive a disabled dependency` | disabled dependency の非復活 |
| 1533 | `case 15-b-1: re-evaluates a surviving issuer after removing an unavailable blocker` | blocker 除去後の issuer 再評価 |
| 1588 | `case 15-b-3: rolls back an operation when its issuer loses a required target` | required target 喪失時の operation rollback |
| 1616 | `case 15-b-7: reports a non-convergent dependency feedback operation` | 非収束 feedback の診断 |
| 1656 | `case 15-b-5: keeps an operation chain deterministic while recomputing blocked issuers` | operation chain 再計算の決定性 |
| 1889 | `case 15-k: runs dependent closure after final operation feedback` | 最終 operation feedback 後の dependent closure |
| 1906 | `case 15-l: stabilizes unrelated operations after resolving a cycle` | cycle 解決後の無関係 operation 安定化 |
| 1921 | `case 15-m: pins fixed-point invariants for every candidate permutation` | candidate permutation ごとの収束不変条件 |

この 18 件の行は分類表で全て `残す` とし、RES-005 / RES-014 / RES-017 などの汎用 IDを貼るだけの扱いにしない。各 test は protection-overlay、dependency-evaluation、pipeline の反復 seam に跨る integration pin として移設先を決める。分類表の `削除 0` はこの裁定済み意味論を含む 118 件全体に適用する。

### 母集団外 `it.each` 9 宣言の補足

直接 `it(` 118 件の合計を壊さず、パラメータ化された宣言も omission しないための補足である。9 件すべて Resolver の残存 behavior として保持する。

| source line | parameterized test | cases / owner |
|---:|---|---|
| 223 | `case 0-e: rejects an unknown %s` | `assetType` / `loadingTier`、V |
| 462 | `case 21: chooses the higher-precedence axis for $name` | role-model / stage-model、R |
| 865 | `case 9-b: accepts a same-ID %s overlay from a higher source layer` | override / disable、O |
| 900 | `case 9-d: applies a stacked %s overlay to every lower layer` | override / disable、O |
| 1082 | `case 10-g-2: lets a fallback winner %s the old conflict winner` | disable / override、O / R |
| 1329 | `%s: leaves a non-total exclusive rank as a conflict` | case 11 / case 11-b、R / A |
| 2063 | `%s: treats an unknown capability or fallback requirement as missing` | case 18 / case 19、D |
| 2084 | `case 17.5 directory rejection: rejects %s` | 5 invalid path forms、V |
| 2135 | `case 17.5 candidate directory post-normalization: canonicalizes %j` | 2 normalization sets、V |

## 9. テスト方針

### seam ごとのテスト責務

テストは実装 helper を直接呼ばず、Resolver の behavior は `@aacl/core-domain` の `resolveScope`、public projection は同 index の `toResolutionReasonDto` / `toResolutionConflictDto`、wire contract は `@aacl/shared` の parse / `contractJsonSchemas` を入口にする。`core-domain/tests` の公開 API import は `../src/index.ts` だけという既存規約を維持する。

| seam / owner | 負うテスト | 駆動する実入口 | 局所再実装を避ける方法 |
|---|---|---|---|
| context / candidate validation | 118 表の 2-3、30、55-56、89-93、98、112-115、`it.each` の case 0-e / directory rejection / post-normalization | `resolveScope` に malformed candidate / `ResolveScopeInput` を渡す | `validateCandidate` や directory helper を直接 import しない。`parseResolveRequest` と `resolveScope` の failure / detail を観測する |
| scope matching | 6-13、25 の target applicability、60、72、89-90 | `resolveScope` | `matchesScope` をテスト用に写さず、候補 snapshot と explicit context の結果 reason を比較する |
| protection / overlay | 26-29、32-48、57-58、61-76、94-96、108-109、parameterized overlay 群 | `resolveScope` | operation graph を作る内部 helper を呼ばない。候補の input 順を permutation して public result を比較する |
| ranking / precedence | 11-27、51、79、95-97、parameterized case 21 / non-total rank | `resolveScope` | comparator の戻り値ではなく winner / tie / canonical evaluation order を観測する |
| dependency evaluation | 52-54、57-88、84-88、110、117-118、parameterized case 18 / 19 | `resolveScope` に explicit capability snapshot を渡す | SCC / queue をテストで再実装しない。required failure、cycle、dependency closure、reason / conflict の最終値を検査する |
| type-specific conflict / merge / ordering | 4、31、93、112-113、移行後の type contract cases | `resolveScope` | asset type 名による test-side分岐を増やさず、injected `AssetTypeContractRegistry` と result を通して registry の意味を pin する |
| result / reason assembly | 26-27、36、38、40、42、45-47、49-50、99-101 | `resolveScope` → public projection → `parseResolvedContextDto` | explanation の文字列を再パースしない。structured field と shared schema の両方を同じ result から検査する |
| Capability boundary（移動 14 件のうち S1-S6 / S10 / S13 / S15） | required / optional / preferred / fallback、offer 単位 feature、available / allowed、input diagnostics | Capability module の `validateCapabilitySnapshot` / dependency entry point を `core-domain/src/index.ts` から駆動 | `capabilityAvailable` の複製を作らず、producer snapshot の実値を入力する。Resolver 側には S7-S9 / S16-S17 の関係 test を残す |
| shared public contract | context union、SkillId、reason / conflict union、strictness、JSON Schema の oneOf / required / additionalProperties | `@aacl/shared` の公開 parse 関数と `contractJsonSchemas()` | zod schema を test file に複製しない。parser と生成 schema の同じ field を照合する。TaskId / workflowRevision / provenance / reason rank は今回の schema に追加しない |
| WFL authorization | no-workflow の明示状態、Standalone Skill の execution permission、transition ownership | #101 の Orchestrator / User-facing public entry | Resolver は selection state を渡し、workflow 遷移や repository mutation の許可を代替しない。現在 owner の実入口が未実装なので、今回の 118 件には authorization test を追加せず #101 の seam test とする |
| asset-type source guard | 新設 seam を含む共通 pipeline の asset type 分岐禁止 | `core-domain/tests/asset-type-contracts.test.ts` の `import.meta.glob` source scan | glob を `../src/resolution/*.ts` へ広げ、source 集合全体を走査する。空集合の判定も新 glob の形へ合わせる |

### 新規テストの先行 red と behavior pinning

契約変更を先に実装する前に、次の新規テストを現行コードに対して red になることを確認してから実装する（この設計作業では実行しない）。

1. `ResolveRequest` の `context` 必須、`development_execution` + `workflow.kind: "none"` 拒否、advisory + selected workflow と development + standalone を受理。
2. `WorkflowSelection` の `none` / `standalone` / `selected` の strict shape、`SkillId`、全 optional axis、unknown key 拒否。
3. `ResolutionReason` の included `matchedAxes`、scope mismatch detail、unavailable failed IDs、`ConflictDto.kind` の全 armと strictness。reason rank 欄、TaskId、workflowRevision、provenance 欄を受ける入力は契約外として拒否する。
4. capability offer の `availability` と `permission` を別々に評価し、`available: true, permission: denied` を `capability_not_allowed` として説明するケース。
5. `workflow.kind: "none"` context で workflow / stage selector candidate を neutral に評価するケース、`standalone` の `skillId` と明示 execution permission を Orchestrator 境界へ渡すケース。

view-separated な分岐を含む Resolver は、上記の red test と、既存 118 direct + 9 parameterized declaration の green regression の両方を負う。各 test は result を `resolveScope` の実公開入口から受け、candidate mapping のローカル再実装や capability evaluator の写しを test fixture に持たせない。

### asset type source scan の拡張

現行 `core-domain/tests/asset-type-contracts.test.ts:368-382` は `import.meta.glob<string>("../src/resolution/scope-resolver.ts")` で 1 ファイルを読み、`assetType\s*[!=]==?\s*"` と `switch\s*\([^)]*assetType` を検査している。Phase A の分割と同じ変更で glob を `import.meta.glob<string>("../src/resolution/*.ts")` へ拡張し、7 seam と supporting module を含む resolution 配下の `.ts` 全体を検査対象にする。

source 集合の読み込み後は `source === undefined` の判定を、glob が返した file map のキー集合が空である場合の throw へ書き換える。新 glob は現行 4 ファイル（`asset-type-contracts.ts`、`capabilities.ts`、`resolution-context.ts`、`scope-resolver.ts`）を含み、実測した両禁止パターンは各ファイル 0 件なので、拡張直後の scan は green になる。分割後に追加される seam file も同じ map で検査され、source scan の対象外になる窓を作らない。

### 既存テストの移行後の配置

`scope-resolver.test.ts` は単一 2,579 行の fixture / assertion 集合から、`resolution-pipeline.test.ts`、`candidate-validation.test.ts`、`scope-matching.test.ts`、`protection-overlay.test.ts`、`ranking-precedence.test.ts`、`dependency-evaluation.test.ts`、`type-resolution.test.ts`、`result-assembly.test.ts` へ責務単位で分割する。分割は分類上の `残す` を減らさず、public entry を変えない。`移す` 14 件は capability / shared / #4 の owner test へ移し、Resolver 側の関係 test を別に残す。

`candidateFromCanonicalAsset`（`scope-resolver.test.ts:87-125`）は削除し、#4 に production Candidate producer が定義された時点で mapping 表をその実 producer へ通す。今回の 118 件の row 5 は削除ではなく移動として数えた。production producer が存在しない現状を、test helper の存在で埋めない。

## 10. 切替と削除の手順

### switch-over と削除の順序

統合ブランチ上の Phase A から順に、次の状態を完成させる。比較用の旧実装・harness は作業ブランチの一時検査にだけ使い、統合ブランチおよび default branch の成果物へ含めない。

1. `resolution-types.ts` と 7 seam の型を定め、現行 contract の入力形で candidate validation → scope matching → protection / overlay → ranking → dependency → type resolution → result assembly の値の流れを成立させる。固定点の state key、SCC、operation feedback、再選択、収束終了条件はこの時点で pipeline の値の反復として表す。
2. extraction manifest に旧 `scope-resolver.ts` の意味論 body と新 owner の対応を記録し、§10.1 の normalise-and-sort source comparison を作業ブランチ上で実行する。比較結果が 0 missing / 0 added になるまで分割の境界を修正する。比較 script / harness は commit 対象にしない。
3. `core-domain/src/index.ts` の `resolveScope` を `pipeline.ts` の一つの実装へ切り替え、118 direct cases と `it.each` 9 宣言の全 fixture を同じ public entry から通す。新旧出力の突合は Phase A の source proof と既存 behavior regression のために行い、比較用の第二 public entry は公開しない。
4. Phase A の同じ変更で `core-domain/tests/asset-type-contracts.test.ts:368-382` の glob を `../src/resolution/*.ts` へ広げ、file map が空のときの throw へ判定を更新する。現行 4 ファイルの禁止パターン 0 件を基準に、新設 seam file を検査対象へ含める。
5. source comparison と既存 regression の proof を得た後、`scope-resolver.ts:873-2287` の `resolveScopeFixedPoint`、旧 nested type / Map / SCC / operation / selection helper、test-only `candidateFromCanonicalAsset` を owner module / 実 data path へ移し、旧 file と旧 symbol を削除する。`core-domain/src/index.ts` は新 module を直接 re-export する。
6. Phase B で capability の型検証・依存観測を `core-domain/src/capabilities/` へ移す。移設は逐語で、型・意味論・省略時の扱いをすべて据え置く。`capabilitySnapshot` を required value にするかは Phase D が context union と一緒に決める — 省略の扱いを変えることは振る舞いの変更であり、Phase B の証明条件（同一スイート緑）と両立しない。available / allowed の分離は Phase C で行う。
7. Phase C で `availability` と `permission` を別軸にし、`available && allowed` を成功 predicate とする。第三の未観測状態を作らず、新規 capability test を先行 red として置いてから実装し、integration test と quality gate を green にする。
8. Phase D で `ResolveRequest.context` / `ResolvedContextDto.context`、independent execution mode + workflow selection、structured reason / conflict を `shared` の strict schema へ切り替える。scope→context の DTO commit と reason / conflict DTO commit は分割できるが、version bump は最後の一回だけに置き、`CONTRACT_VERSION` を `0.5.0` にする。旧 `scope` alias、TaskId、workflowRevision、provenance、reason rank は追加しない。
9. 各 owner の public re-export、root / box Ledger、JSON Schema、dependency-boundary を同期し、old file / old symbol / direct import / comparison harness の検索結果を 0 件にする。各 Phase の終端で canonical quality gate が green であることを進行条件とする。

### 10.1 Phase A の normalise-and-sort source comparison

証明の比較単位は「旧 `scope-resolver.ts` の extraction manifest に記載した semantic body」と「その body を移した新 owner の body」である。新規の `pipeline.ts` の orchestration、contract DTO、`asset-type-contracts.ts` など既存 module の未移設部分は比較対象から除き、分割で移った意味論だけを比較する。sort は行の multiset を保持し、同一行の重複数も比較する。

`rules/refactoring.md` の normalise-and-sort に合わせ、両側へ次の同じ正規化を順に適用する。

1. CRLF を LF へ正規化し、空行を落とす。
2. 各行の whitespace（indent、space、tab）を落とす。文字列 literal、identifier、operator、comment の文字は保持する。
3. TypeScript の `import` 宣言は、開始行から終端の `;` までを構造行として落とす。`import type`、複数行 import、side-effect import も同じ扱いにする。
4. `export` は executable declaration の prefix からだけ落とし、後続の function / const / object body は保持する。`type` alias と `interface` の型宣言は、宣言開始から alias の `;` または balanced body の終端までを構造行として落とす。型宣言内に runtime initializer がある場合はこの規則を適用せず、initializer を semantic line として保持する。
5. 行全体が `{`、`}`、`},`、`];`、`);`、`,`、`;` など delimiter だけで構成される閉じ括弧・構造行を落とす。` } else { `、object property、call、return、条件式、assignment を含む行は制御やデータの意味を持つため保持する。
6. 残った行を code-unit lexicographic order へ sort し、旧側から新側への missing / added を multiplicity 付きで比較する。期待値は `0 missing / 0 added` であり、行を黙って allowlist 化しない。差分が出た場合は owner の allocation か extraction manifest を修正して再比較する。

この規則は import / export の配置差、型宣言の配置差、indent、空行、閉じ括弧の所在を証明から除外し、実行文・literal・条件・return・呼出し・assignment・comment の消失や追加を検出する。Phase A の PR はこの比較結果と 118 direct + `it.each` 9 宣言の regression を proof artifact として示し、比較 script 自体は repository の production / test tree へ置かない。

### switch / delete の安全条件

| 時点 | 公開入口 | その時点で存在する成果物 | quality gate の条件 |
|---|---|---|---|
| Phase A 終端 | `index.ts` → `pipeline.resolveScope` | 7 seam、pipeline、拡張済み source scan。旧 file / old symbol は削除済み | normalise-and-sort が 0差分、既存 118 + `it.each` 9 が green、typecheck / package boundary が green |
| Phase B 終端 | 同じ public entry | capabilities box と required `capabilitySnapshot`。availability / permission は current semantics | 同一 suite green、capability owner の移動後 test と explicit empty snapshot が green |
| Phase C 終端 | 同じ public entry | availability / permission の直積と dependency outcome | 新規 capability tests の先行 red → 実装後 green、全既存 integration と gate green |
| Phase D 終端 | `ResolveRequest.context` → new pipeline → `ResolvedContextDto.context` | strict context / reason / conflict schema、`CONTRACT_VERSION=0.5.0` | 新規 tests の先行 red → parser / projection 実装後 green、JSON Schema 照合と gate green |
| Ledger / export 同期後 | `core-domain/src/index.ts` と `shared/src/index.ts` | stale re-export / stale Ledger / comparison harness なし | old symbol / old file / direct import の検索 0 件、dependency-boundary と node resolution を含む gate green |

この設計作業では quality gate を実行しない。上表の各 Phase proof は実装側と orchestrator が担当する。

## 11. フェーズ分割案と証明条件

フェーズは振る舞い保存と挙動変更を分離し、各段階の証明対象を一つにする。統合ブランチ `integration/issue-100` を default branch から切り、各 Phase 用の branch をその直前の統合状態から作って PR で統合する。default branch へは最終統合 PR の完了まで旧実装・比較 harness・中間契約を載せず、比較 script は Phase A の作業ブランチ上だけで実行する。

| phase | 内容 | 触る箱 | 証明条件 |
|---|---|---|---|
| A | 7 seam へのファイル分割。契約は据え置き。§9 の glob 拡張を同じ成果物に含め、`resolveScopeFixedPoint` の意味論を `pipeline.ts` と各 seam へ移し、public `resolveScope` を `pipeline.ts` が持つ。**着地済み（`47d07aa`、9 ユニット）** | `core-domain/src/resolution/`、`core-domain/src/index.ts`、`core-domain/tests/`、`core-domain/src/resolution/ledger.md`、root `AGENTS.md` | 正規化比較で missing 17 / added 128。missing はすべて引数が増えた呼び出し行・シグネチャ行と委譲ラッパ削除の 2 行で、対応する added と 1 対 1 に紐づき、ロジック行の消失は 0。`scope-resolver.test.ts` は無変更で core-domain 231 件 green。glob は新 seam を含み、`graph.ts` への違反注入で当該ファイルを名指しして赤になることを確認済み。gate 4 step PASS |
| B | capabilities 箱への移設のみ。`resolution/capabilities.ts` を `core-domain/src/capabilities/` へ逐語で移し、型・意味論・省略時の扱い・`required` / `optional` / `preferred` / `fallback` を据え置く。Resolver → Capability の一方向 import に固定する | `core-domain/src/capabilities/`、`core-domain/src/resolution/`、`core-domain/src/index.ts`、capabilities Ledger、root `AGENTS.md` | 同一スイート green（`core-domain` 231 件、テストファイルは無変更）。`core-domain/src/index.ts` の re-export 名の集合が不変。dependency direction / host 禁止 green |
| C | available / allowed 分離。`CapabilityOffer` を availability と permission の直積で観測し、`available && allowed` を成功 predicate とする。第三の未観測状態を作らない | `core-domain/src/capabilities/`、`core-domain/src/resolution/dependency-evaluation.ts`、`core-domain/tests/`、capabilities Ledger | 新規 capability tests の赤証明を先に得てから実装し、実装後にその tests、既存 Resolver integration、explicit empty snapshot が green。available / allowed 各組合せと capability reason が一致する |
| D | context union（`executionMode` + optional project axis + workflow selection）と reason / conflict 構造化。`scope` → `context`、`matchedAxes`、閉じた conflict kind を `shared` strict schema に定め、`CONTRACT_VERSION` を `0.5.0` とする | `shared/src/`、`shared/tests/`、`core-domain/src/resolution/`、`core-domain/tests/`、両 package の index、`json-schema.ts`、root Ledger | 新規 context / reason / conflict tests の赤証明を先に得てから実装し、parser と JSON Schema の照合が green。`development_execution` + `kind:none` だけを拒否し、advisory + selected / development + standalone を受理。既存 118 + `it.each` 9 の behavior pin と public projection が green |

Phase D は分割可能だが、一つの phase として実施する。外部 consumer は実測 0 件であり、scope→context の置換と reason / conflict の構造化は独立した DTO で別 commit にできる。二つの commit を同じ Phase D branch の PR に載せ、version bump は最後の commit で一回だけ行うことで、default branch には中間契約を出さず、parser / schema / projection の一組の proof を保つ。

### phase 間の state と切り戻し境界

Phase A の終端で固定点意味論を新しい値の反復へ移し、Phase B は capability の owner だけを交換する。Phase C は capability state の観測軸を増やし、Phase D は wire DTO の shape と version を更新する。各 phase の終端は次表の state と quality gate green を同時に満たす。

| state | public entry | phase 完了時の state | 次 phase へ進める条件 |
|---|---|---|---|
| A | `core-domain/src/index.ts` → `resolution/pipeline.ts` | 7 seam、pipeline、拡張 source scan、old resolver file / symbol の削除。公開 contract は現行 shape | normalise-and-sort 0差分、118 + supplemental 9 green、source scan / typecheck / package boundary green |
| B | 同じ `resolveScope` | capability snapshot の validation / observation が capabilities box に集約。current availability semantics を維持 | 同一スイート green、explicit empty snapshot と全 S1-S17 owner test green |
| C | 同じ `resolveScope` | availability / permission の直積、dependency outcome、capability reason が確定 | 新規 capability tests の赤証明 → 実装後 green、既存 behavior pin と gate green |
| D | `ResolveRequest.context` → pipeline → `ResolvedContextDto.context` | strict context / reason / conflict、`CONTRACT_VERSION=0.5.0` | 新規 contract tests の赤証明 → parser / JSON Schema / projection green、既存 118 + 9 green |

切り戻しは各 Phase の統合 PR単位で行う。次 Phase の branch は直前 state の統合 commit から切り、Phase A の削除後に旧 file を復活させる fallback や、Phase D で旧 `scope` と新 `context` を同時に受ける互換層は成果物へ持ち込まない。今回の design worker は quality gate を実行していない。

## 12. ユーザー裁定が要る項目

ここは実装可否ではなく、外部 consumer が観測する contract / result / selection semantics を独立させる一覧である。今回の追加制約についてはユーザー裁定が完了しており、表の状態を実装時に再選択しない。要件が方向を指定している項目も、wire の field 名・enum・拒否範囲・winner の変化は外部から観測できるため、内部実装の可否と分離して記録する。

| # | 裁定対象 | 現行の実測 | 採用値 | 外部から観測できる影響 | 状態 |
|---:|---|---|---|---|---|
| U1 | 固定点 / feedback の意味論 | `scope-resolver.ts:951,973,996,1032,1066,1150,1194,1277,1453,1471,1521,1533,1588,1616,1656,1889,1906,1921` に再選択・feedback・SCC・収束の pin がある | #71 / #76 で確立した意味論を v12 Resolver の責務として保全し、巨大クロージャと共有可変状態だけを分割する | disable / override / dependency failure / operation cycle 後の winner、feedback、最終 conflict、収束結果を維持する | 裁定済み |
| U2 | request / result の欄名 | `ResolveRequest.scope` と `ResolvedContextDto.scope` が存在（`shared/src/resolution.ts:34-40`、`resolved-context.ts:113-121`） | 両方を `context` へ置換し、explicit execution context を同じ値で返す | 旧 payload は strict parse で拒否され、Core / Extension の wire adapter は `0.4.x` と `0.5.0` の互換を同時成立させない | 裁定済み |
| U3 | execution mode と workflow selection | 現行 `ExecutionMode` / `executionMode` は 0 件。`shared/src/sessions.ts:40-47` は standalone binding を持つ | `executionMode` と `workflow.kind` を独立軸にし、`none` / `standalone(skillId)` / `selected(workflowId, stageId)` を受理する。development + none だけを `invalid_request` とする | mode、workflow selection、拒否範囲が consumer の UI / permission 分岐と request validation に現れる | 裁定済み |
| U4 | project / 残りの scope 軸 | `AgentExecutionDto` の project / stage / taskType / role / provider / runtime / model は全て optional（`shared/src/sessions.ts:59-73`）。`WorkflowEvaluationInput` の role / taskType も optional（`core-domain/src/workflow.ts:582-587`） | `projectId?`、`taskTypeId?`、`roleId?`、`providerId?`、`runtimeId?`、`modelId?`、`directory?` を optional のまま保持する。development で 9 軸を一括 required にしない | 不足した旧 request の扱いは context contract に従い、workflow selection だけが development の cross-arm 必須条件になる | 裁定済み |
| U5 | no-workflow の matching | `scope-resolver.ts:452` は request value が undefined のとき selector を neutral にする | `workflow.kind: "none"` は workflow / stage request value を未指定として扱い、workflow / stage selector candidate を neutral に評価する。実行可能な行為は #101 が判定する | Advisory / Preparation の candidate 集合、reason、conflict は現行 neutral 挙動を保つ。execution authorization の結果は #101 の外部境界で現れる | 裁定済み |
| U6 | Standalone Skill | `WorkflowBinding` に standalone arm があり（`shared/src/sessions.ts:40-47`）、§7 は明示 permission がある場合の repository mutation を定義する | `standalone` に `skillId` を持たせ、明示 execution permission を Orchestrator / User へ渡す | standalone execution と repository mutation permission を consumer が区別できる | 裁定済み |
| U7 | `available` と `allowed` | 現行 `CapabilityOffer` に状態欄はなく、catalog + offer の存在だけを検査する | capability offer に availability と permission の 2 軸を持たせ、`available && allowed` を成功 predicate とする。未観測という第三状態は作らない | 接続状態と policy 許可を別々の reason / dependency result として観測できる | 裁定済み |
| U8 | capability snapshot の transport | 現行 HTTP route は `/health` の GET / HEAD だけで Resolve route は 0 件。domain input の snapshot は required とする | #12 の HTTP / IPC adapter が Capability owner の snapshot を同じ transport exchange で運び、欠落を `invalid_request`、明示 empty を 0 offers として domain へ渡す | route が将来追加された時、adapter が omission を空 snapshotへ変換するかどうかが公開 request validation として現れる | 裁定済み |
| U9 | reason の構造化 | 内部 reason は rank を持つが、現行 public reason は説明と一部 ID に縮約される | public reason は `matchedAxes` のみを axis explainability 欄として持ち、rank / rank component は internal に留める。`matchedAxes` の順序は現行 `RESOLUTION_AXES` 順で固定する | Preview / Extension は文字列再解析なしに matched axis を表示でき、rank の未確定値を契約へ依存しない | 裁定済み |
| U10 | conflict kind の公開 | 現行 `ConflictDto` は `explanation` / `involvedAssetIds` の 2 欄（`AGENTS.md:382-386`） | 8 種類の `kind` を閉じた strict union で公開し、arm ごとの target / merge group / failed IDs を保持する | consumer が conflict 種別で表示・再試行を分けられる。kind の arm 追加・削除、required 欄追加、kind 固有欄変更は breaking になる | 裁定済み |
| U11 | TaskId / workflowRevision / provenance | 現行 Resolver に `TaskId` / `workflowRevision` は 0 件、`ResolvedAssetDto` に provenance はない | 3 つとも今回の公開契約へ入れない。Task は #110 / #4、workflow revision は #13、provenance は #14 の owner が必要な時点で定める | 今回の consumer は新欄を受けず、各 owner issue の導入時に別の contract change として観測される | 裁定済み |
| U12 | contract version | `CONTRACT_VERSION` は `0.4.0`（`shared/src/contract-version.ts:25`） | `0.5.0`、per-schema version / URL prefix は追加しない | 0.4.x と 0.5.0 の health compatibility は incompatible になる | 裁定済み |

上記は public behavior の裁定であり、7 seam の module 分割、固定点 state key、SCC の非再帰実装、old file の削除順は裁定対象ではない。118 件の分類は test deletion が 0 件なので、既存 behavior protection の削除に関する裁定項目は発生しない。

candidate 集合を `kind: "none"` で狭める案は今回の採用値に含めない。将来その案を提示する場合は、実装判断とは別にユーザー裁定へ出し、例えば `taskTypeId` だけを selector に持つ Rule は `kind: "none"` でも match するため、workflow / stage selector のみを除外する規則が落としすぎ・落とし足りないどちらを生むかを具体例で示す。

## 13. 未確認

以下は検索・読取りだけでは決められず、設計で勝手に埋めなかった事項である。採用済みの境界と、owner issue に残る決定を分離する。今回の設計で contract へ入れないと確定した欄を、未確定欄として再導入しない。

| 未確認事項 | 現物から確定できた範囲 | 残る影響 / 扱い |
|---|---|---|
| #4 の CanonicalAsset → AssetCandidate production producer の module / directives source | `git grep` では `CanonicalAsset` の parser / serializer / catalog / workflow 投影と、Resolver の `AssetCandidate` 定義しかなく、production producer は 0 件。現行 mapping は `scope-resolver.test.ts:87-125` の test helper | row 5 は #4 の Candidate projection owner へ移す。`axis-mapping.ts` の 9 組を実 producer と機械検査する。directives / source merge 順と最終 file 位置は未確認 |
| #82 Capability producer が返す catalog / offer / permission の実装 owner | `core-domain/src/capabilities/dependencies.ts:11-43` は catalog / offer の型と validation を持つが、permission や `available` 欄はなく、#82 の producer module は存在しない | `core-domain/src/capabilities/` を snapshot 境界とする。producer の policy source、permission の計算順、wire DTO の最終位置は未確認。Resolver は snapshot の観測値を読む |
| #101 の Orchestrator / User-facing authorization entry | requirements は WFL-004 で owner を Orchestrator / User と指定するが、現行 tracked code の workflow module は state / transition domain を持ち、Resolver request と接続する実行入口はない | `kind: "none"` の neutral matching、`standalone` の skill selection、development + none の parse rejection は #100 で固定する。transition decision、repository mutation の execution permission、専用 test driver は #101 で確定する |
| #10 の materialization / body / token cost adapter | 現在の Core は asset store / catalog / workflow loader を持つが、`core/src/index.ts:30-112` に Resolver consumer や resolved-context adapter はない。内部 `ResolutionResult` の clock / body / cost なしは既存 test で確定 | result assembly の public projection と Core adapter の最終結合位置は未確認。今回 wire shape だけを定義し、body load policy / token estimator は #10 で扱う |
| #12 の Resolve HTTP route と Capability snapshot の transport field | `core/src/http/router.ts:16-18` は `/health` の GET / HEAD だけで、Resolve route は検索結果 0 件 | snapshot を同一 transport exchange で運ぶこと、欠落を `invalid_request`、explicit empty を 0 offers とすることは #100 で固定する。route 名、status mapping、snapshot DTO の最終 nesting / network serialization は #12 で確定する |
| Task の domain identity と asset scope 化 | 現行 repo に `TaskId` / `taskId` は 0 件。on-disk / resolver scope は 9 軸で、precedence 表に Task の行がない | TaskId は今回の context / public DTOへ入れず、Task identity / candidate mapping は #110 / #4 の ownerへ渡す。Task を第 10 scope 軸へ昇格する場合の発行 / rename / save-schema は未確認 |
| workflow revision と snapshot の cross-field 検証 | 現行 Resolver に `workflowRevision` / `revisionId` は 0 件。今回の `WorkflowSelection.selected` は `workflowId` / `stageId` だけを持つ | `workflowRevision` を context / public DTO から外し、比較対象そのものを今回の pipeline に入れないため、この cross-field 問題は今回消える。workflow revision は #13 Execution Snapshot が導入時に定義する。#13 が context の revision と snapshot 内 workflow asset revision を再導入する時点では、AGENTS.md の cross-field `z.refine` 禁止と JSON Schema 表現不能の問題が再燃するため、構造または別 validation contract を未確認事項として確定する |
| provenance の公開形 | 現行 `ResolvedAssetDto` に source layer / source id はない（`shared/src/resolved-context.ts:73-92`） | 今回の `ResolvedAssetDto` に provenance を追加せず、#14 が source-of-truth の provenance 欄と公開範囲を定める。#14 導入時の version / schema 影響は未確認 |
| Stage precedence の canonical value | 現行 `SCOPE_PRECEDENCE.stageId` は 45（`scope-resolver.ts:373-391`）。requirements の precedence table は Stage 行を持たない | internal ranking は behavior preservation のため現行 45 を使う。public reason は rank を持たないためこの値を wire contract へ固定しない。canonical table が Stage を別順位に置く場合の internal winner 変化は未確認 |
| `it.each` の runtime expansion 数 | source declaration は 9 件、直接 `it(` は 118 件、合計 source declaration は 127 件と測定した。test command を実行していないため、各 parameter array の実行 invocation 数は未確認 | 必須分類表の合計は直接宣言 118 で管理し、9 宣言は補足表で全件 ownership を記載した。実行件数を 118 と同一視しない |
| worktree 外の public consumer | tracked repo の `git grep` で Core / Extension consumer は 0 件だが、公開 package を外部で import する利用者は filesystem search から観測できない | contract version 0.5.0 と health compatibility を breaking boundary として明示する。外部配布 consumer の移行数・移行時期は未確認 |

この設計書の未確認表は、設計判断を先送りするための「実装時に確認」欄ではない。現物がないため所有者を確定できない箇所と、今回採用した safe boundary を記録する欄である。
