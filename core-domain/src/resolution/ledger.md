# Ledger — core-domain/src/resolution

置き場の規則は root `AGENTS.md` の `## Ledger` にある。

## Traps

- **scope resolver の operation は、merge と dependency closure の両方を生き残った issuer だけが適用できる。**
  exclusive loser と unavailable issuer は target を変更せず、issuer が別 operation の target になって
  最終的に生き残れない場合も同じ扱いにする。相反する operation の下位 issuer は
  `operation_conflict` を evaluation と aggregate `conflicts` の両方へ残す。同一 `AssetId` の
  異なる source layer 間で issuer が自分の ID を明示 target にする override / disable は
  pair 単位の overlay relation として duplicate identity 判定より先に扱い、複数の lower layer
  target にはそれぞれ適用する。dependency closure は merge 後・dependency 前の状態から
  operation 後に再評価し、operation issuer の cycle は conflict として残す (#71)。operation
  discovery は pre-operation reason を変更せず、unavailable issuer を除いた残りを安定するまで
  再評価する。operation 後に eligible へ戻った issuer も discovery 対象へ加え、同一パスで
  複数の operation cycle をすべて conflict として残す。operation cycle graph は最終 dependency
  closure で available と判定された issuer の action だけから構成し、provisional action だけで
  cycle を確定しない。依存失敗の分類は scope mismatch の候補ではなく matched candidate を
  先に判定する。dependency closure は再帰せず canonical SCC と反復処理で評価し、operation
  cycle を除いた最終状態で依存を再評価する。operation の依存 feedback が安定しない場合は、
  operation を無視した included issuer を返さず conflict として残す。

- **mandatory candidate の dependency failure が cycle と別の failure を同時に含む場合は、両方の conflict を残す。**
  primary cause の選択で `dependency_cycle` を隠さない (#71)

- **scope resolver の evaluations の同順位は candidate の全 semantic field で決定する。**
  `AssetId` / revision / sourceId / rank が同じでも、operation、merge、selector、requires などの
  意味が異なる candidate を入力順へ委ねない (#71)

- **scope resolver は全 candidate の構造検証を完了し、全 structurally-valid candidate の同一 asset identity（`assetId` + `revision`）に payload（`assetType` / `loadingTier`）の整合性を適用してから、invalid-directory partition と identity map を行う。**
  構造不正な runtime snapshot の要素を resolver 内で dereference せず、同じ operation tie に
  参加する全 issuer を conflict evaluation と一致させる。`assetType` と `loadingTier` は
  `ASSET_TYPES` と `LOADING_TIERS` の membership を runtime で検証する。

- **`resolveScope` の候補構造検証と fixed point の capability 評価には、同じ capability context を
  渡す**（どちらも `evaluateCapabilityDependenciesInValidatedContext` に、冒頭で 1 度だけ
  `validateCapabilityContext` した結果を渡す）。検証側だけ context 無しで呼ぶと、definition に
  無い feature を要求する候補が構造検証を通り、fixed point 側が `invalid_request` を返して
  `throw new Error("Validated capability dependencies must evaluate successfully.")` に落ちる
  — `CoreFailure` ではなく例外になるので、consumer からは resolver のクラッシュに見える。
  scope 外の候補も検証対象で、scope が決めるのは「どれが適用されるか」であって
  「どれが妥当か」ではない (#9)

- **`dependencyOutcomes` で候補ごとに持たせる失敗種別は、component 単位で union してから
  各メンバーに配る。** union の対象は 2 つあり、**両方**が要る: メンバー自身が持つ失敗と、
  いずれか 1 メンバーが component 外へ張るエッジ経由で受け取る失敗。conflict は mandatory
  候補についてしか materialize されず、per-edge の伝播は component 内部エッジを飛ばすため、
  どちらか一方でも落とすと SCC 内の非 mandatory 候補側にしか無い失敗が mandatory 候補へ
  伝わらず、**診断そのものが結果から消える**（cycle と dependency_failure だけが残り、原因の
  capability 名が出ない）。依存先 component は先に materialize され自身の到達を閉じているので、
  この 1 パスが不動点になる。capability 側は `componentFailedCapabilities`、requirement 側は
  `componentHasNonCycleFailure` がこの役目を持つ (#9)

## Invariants / identity keys

- **Asset Type 契約違反の落とし方は「候補 1 枚で判定できるか」で決まる。** 1 枚で判定できる違反
  （その Type が許さない operation / exclusive merge）は `validateCandidate` に置き
  `invalid_request` で snapshot 全体を失敗させる。2 候補以上を突き合わせて初めて判る違反
  （cross-Type の override / disable / exclusive group）は候補単位の reason +
  `asset_type_conflict` にし、target は変更しない。この境界は既存の構造検証と意味的衝突の
  分かれ方と同じで、**新しい Type 規則を足すときも同じ問いで置き場所を決める** (#75)

- **cross-Type の判定は「関係が表現可能か」なので、突き合わせる候補を絞り込む前に置く。**
  operation の cross-Type 判定は `matchedById` が持つ target id の全候補に対して行い、
  そこから適用可能な target へ絞る。要求関係 (`requires`)・mandatory 保護・target 個数・
  適用可能性（exclusive merge に負けた候補など）はいずれも「関係が表現可能である」ことを
  前提にした規則なので、絞り込み後に判定すると cross-Type 関係が
  `operation_conflict` や無検出に化ける (#75)

- **exclusive winner は「他のどの候補にも負けない候補が一意ならそれ、いなければ conflict」で
  選ぶ。候補を段階的に脱落させる形にしない。** directory 特則（両者が directory 一致なら
  priority → 最深 path → specificity）と一般 key（specificity → 軸 precedence → depth →
  source layer）は混在集合に対して非推移で、先に脱落させると **自分では勝てない候補を足す
  だけで勝者が変わる** — `/repo`+role+model が `/repo/src/deep` に深さで脱落し、勝てるはず
  だった相手の role+model が勝つ。directory 軸に一致したかは `scopePrecedence` が directory の
  rank を含むかで判定する。`directoryDepth > 0` では root 一致 (depth 0) と directory selector
  無しを区別できない (#76)

- **`selectUnbeaten` の空集合は「勝者不在」であって「相反」ではない。** operation の issuer
  選択では、rank cycle で空になっても全 action が `disable` なら conflict にせず output 順で
  coalesce する — 相反しない disable を conflict にすると target が有効なまま残る。
  `exclusive_tie` の explanation は同順位と cycle の両方を指す文言にする (#76)

- **解決結果で「context に載るか」を表す信号は `CandidateReason.kind` 1 つしかない。**
  `resolveScope` は候補ごとに reason を 1 個返し、消費側は `kind === "included"` で絞る。
  したがって **degraded は `kind: "included"` のまま degradation 欄を載せて返す** —
  `kind: "unavailable"` にすると optional 依存の欠落が候補を黙って context から消し、
  「degraded は載るが能力が落ちた状態」を表現できなくなる。`availability: "unavailable"` を
  作るのは required capability の hard failure だけ (#9)
