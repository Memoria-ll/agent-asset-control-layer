# GUIDE_THIS_TREE.md — core-domain/src/resolution

この guide は `core-domain/src/resolution/` 以下に適用する。

## Local invariants

- operation は merge と dependency closure の両方を生き残った issuer だけが適用する。operation 後の dependency feedback は安定するまで再評価し、cycle や不安定状態を conflict として保持する。
- 全 candidate の構造を検証し、同一 asset identity の payload 整合性を確認してから scope partition と identity map を作る。scope 外であることは構造検証を省略する理由にしない。
- capability context は入力検証と dependency 評価で同じ検証済み値を共有する。SCC 内の failure と SCC 外への edge から得た failure は component 単位で統合して全 member に反映する。
- fixed-point iteration で更新される `Map`、`Set`、配列は seam 作成時に capture せず、各呼出し時の値を渡す。
- 同順位の deterministic order は candidate の全 semantic field で決め、入力順に依存させない。
- Asset Type 単体で判定できる違反は input validation、複数 candidate の関係で決まる違反は candidate reason と conflict にする。cross-Type relation は applicability で候補を絞る前に判定する。
- Type 固有 semantics は `asset-type-contracts.ts` の `Record<AssetType, AssetTypeContract>` に集約し、共通 pipeline へ Type 分岐を置かない。
- exclusive winner は他の全 candidate に負けない candidate が一意な場合だけ選ぶ。非推移な比較を段階的な脱落処理へ変換しない。
- degraded candidate は `kind: "included"` のまま degradation を付ける。required capability の hard failure だけを unavailable にする。

## Change considerations

- on-disk scope axis と resolution context axis は名前が異なるため、`CanonicalAsset.scope` から candidate への投影は明示的な対応表で行う。
- `ResolveScopeInput.capabilityContext` の省略は offer 0 件を意味する。resolver を実行経路へ配線する caller は現在の capability context を明示的に渡す。
- `ResolutionResult.context.directory` は caller の入力表現、`scope.directory` は matching 用の正規化表現。再現には前者、同一性判定には後者を使う。
- capability offer は provider identity を持たない。同一 capability と features の複数 offer は duplicate とし、producer が permission を `allowed` / `denied` に畳んで渡す。
