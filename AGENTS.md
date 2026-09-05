# AGENTS.md

Agent Asset Control Layer（AACL）は、AI 開発アセットの単一の source of truth と context
resolution を担う local-first Core と、その Workbench となる VS Code Extension で構成する。

## コマンド

- 依存導入: `pnpm install`
- Core 起動: `pnpm start:core`（既定 `http://127.0.0.1:7420`、稼働確認 `GET /health`）
- テスト: `pnpm -r test`
- 品質ゲート: `bash ~/.claude/scripts/run-gate.sh`（`gate.json` が判定条件の唯一の正）

## subtree guide

- root `AGENTS.md` は repository-wide の指示だけを持つ。
- `GUIDE_THIS_TREE.md` は、そのファイルが置かれたディレクトリ以下に適用する local invariant、
  known trap、change consideration を持つ。
- 作業対象ごとに、祖先ディレクトリにある `GUIDE_THIS_TREE.md` を上位から順に読む。
  複数の subtree を変更する場合は、それぞれの祖先 guide を読む。
- 同じ事実を root と subtree guide、または複数の guide に重複させない。適用範囲が変わった
  ときは、事実を新しい最小の共通 subtree へ移す。
- guide の置き場所は、その事実が説明する対象ではなく、その制約に違反しうる編集箇所すべてで
  決める。caller / producer の義務も含め、全編集箇所から祖先参照で到達できる最小の共通 subtree に置く。
- guide にはコードやテストから直接復元できない現在の制約だけを書く。実装の逐語説明、
  issue 固有の経緯、テストケースの説明は置かない。

## Architecture

### 実行・配布形態

- Core は利用者のファイルシステム、git 履歴、keychain に直接触れる host 直実行の Node
  process。ビルド段を持たず Node の TypeScript type stripping で起動する。
- Phase 1 は single-user localhost、Phase 2 は single-user remote / multi-PC、Phase 3 は
  multi-user team。remote / team 運用を local 利用の前提条件にしない。
- Core が認証を持つまでは loopback だけで待ち受ける。`AACL_CORE_HOST` / `AACL_CORE_PORT`
  は利用者可視の設定名であり、変更は公開契約の変更として扱う。設定値が不正なら既定値へ
  代替せず、startup failure として exit code 1 を返す。
- root `package.json` の `version` が配布バージョンの正。`0.0.0` の間は保存データの破壊的変更を
  許容する development stage とする。

### package と依存方向

- pnpm workspace は `shared` / `core-domain` / `core` / `vscode-extension` の 4 package。
- 依存方向は `core-domain` → `shared`、`core` → `shared` + `core-domain`、
  `vscode-extension` → `shared`。`core` と `vscode-extension` は相互に依存しない。
- `shared` は Core / Extension 間の transport-neutral な公開契約だけを持つ。domain semantics、
  Core 実装、VS Code API には依存しない。
- `core-domain` は host 能力に触れず、`node:*`、`@types/node`、外部 SDK、VS Code、Tauri に
  依存しない。host 能力と外部 I/O は `core` が持つ。
- Extension は Core domain 実装や API DTO / schema を再定義せず、`shared` の契約を使う。

### Project identity

- Project identity の正は `<project-root>/.aacl/project.json`。Marker は schema version 1 の
  strict object で、`projectId` は `^project-[a-z0-9-]+$`、全長128文字以内とする。Git repository
  root ではなく、init に指定された directory を Project root とする。
- discovery は workspace から filesystem root へ向かい、最寄りの `.aacl` で確定する。
  その Project marker が不正でも上位 Project へ抜けない。
- `~/.aacl-state/project-registry.json` は Marker から再構築できる索引であり、identity の正にしない。
- Project Init / discovery / Marker の境界値には `shared` の公開 DTO を使う。

### 公開 contract

- `shared/src/` の公開型が公開契約。network / IPC / filesystem 境界を越える値には明示的な
  serialization schema を持たせ、TypeScript 型は schema から導出する。
- 境界 DTO は成立し得ない状態を parse させない。JSON Schema で表せる制約は parser と
  draft 2020-12 schema の両方へ反映する。
- `zod` は `shared` の実装詳細。consumer へは TypeScript 型と素の JavaScript の関数・データだけを
  export し、consumer が必要とする runtime validator や値集合をその都度明示的に追加する。
- 契約全体のバージョンは `shared` の `CONTRACT_VERSION` だけで管理する。enum 値、union arm、
  required 欄の追加を含む境界 DTO の変更は contract version を更新する。
- Asset の source of truth は人間可読な filesystem file。その on-disk shape も公開契約であり、
  変更時は `save-schema-check` を通す。
- Core API の request / response / error / version は公開契約。`GET /health` は
  `{ contractVersion }` を返す。`HEAD /health` は同じ status / headers を body なしで返す。

### レイヤと検証

- logic unit は `core-domain/src/`、`shared/src/`、`core/src/main.ts` 以外の `core/src/`、および
  VS Code API に依存しない Extension の client / view model。変更時は実データ経路を通るテストで
  behavior を固定する。
- view glue は `core/src/main.ts` と、VS Code API に直接触れる Extension の activation、lifecycle、
  command / webview 配線。
- テストは各 package の `tests/` に置き、Vitest で実行する。最終判定は canonical gate を使う。

## Repository-wide change considerations

- root `package.json` の `engines.node` は、Core が TypeScript source を直接実行できる Node 24.12.0 以上の
  runtime 条件と、lockfile 上の全依存の `engines` の積集合を満たす。24.12.0 は TypeScript type stripping が
  stable になった最小 runtime であり、依存更新時も下限をこれ未満へ広げない。
- source を直接実行するため、TypeScript の相対 import 指定子は `.ts` で書く。
- `resolveScope` を実行経路へ配線する caller は `capabilityContext` を明示的に渡す。省略は
  capability offer が 0 件であることを意味する。
- `ResolutionResult.context.directory` は caller の入力表現、`scope.directory` は matching 用の
  正規化表現。再現には前者、同一性判定には後者を使う。
- capability offer は provider identity を持たない。同一 capability と features の offer は
  producer が permission を `allowed` / `denied` に畳み、1件として渡す。
- on-disk scope axis と resolution context axis は名前が異なる。`CanonicalAsset.scope` から
  resolution candidate への projection は明示的な対応表で行う。
- scope matching は context に載っていない軸の selector を中立として読み飛ばす。候補が宣言した
  適用条件は、その軸が context にあるときだけ絞り込みに効く。宣言を必須条件として扱わせたい
  candidate projector は、この経路だけでは表現できない (#121)。
- `ResolutionSnapshot` を組み立てる producer は、Asset Type contract に反する候補を渡す前に
  除いて診断として返す。`resolveScope` は候補1件の構造違反で snapshot 全体を
  `invalid_request` にするため、1つの不正な入力が他の全候補の解決を止める。判定対象は
  `AssetTypeContract` のうち、その producer が出力しうる値を持つ全欄。merge policy だけを
  見て `allowedOperationKinds` を見落とすと、`resolveScope` 側の同名判定が snapshot 全体を
  落とす経路が残る。
- Asset の on-disk 位置は適用条件そのもの。project root から読んだ Asset を投影する producer は
  `AssetProjectionSource.owningProjectId` を渡す。省略すると project A のファイルが project B の
  候補になり、型検査もゲートも黙って通る。宣言 `scope.project` は所属 project との積を取り、
  空になる候補は診断として除く。
- 解決指定を type 固有の欄へ載せる Asset Type は、汎用投影へ渡す前にその値を asset 欄へ解決する。
  `toAssetCandidate` は `CanonicalAsset` の欄しか読まないので、type 固有表現は無言で 0 件扱いになる。
  現に Skill の優先度は `metadata.priority` にあり、asset の `priority` directive とは別欄。
- Skill を指名する値は `SkillId`、Asset 層が索く値は `AssetId`。公開 API の引数と
  `CanonicalSkill.skillId` は前者で受け、Asset store を呼ぶ直前に `skillAssetId` /
  `asSkillId` で変換する。両 brand とも値制約は非空文字列だけなので、変換を各所で直接
  cast すると片方向の取り違えが型検査を素通りする。
- `AssetRevision` は canonical frontmatter と body を直列化した内容の hash。同じ revision を同じ
  内容として畳む resolver の前提なので、serializer、revision 生成、resolver deduplication は一体で見直す。
- `ExecutionInstanceId` は全 Workflow Definition を通じて一意。`workflowId` は namespace ではなく、
  保存済み state の所属不一致を検出する値として扱う。
- `WorkflowStateDto.linkedAgentExecutionIds` と `AgentExecutionDto.workflowBinding` は双方向の link。
  片側を生成・変更する producer は対応する鏡像も維持する。
- package を増減するときは workspace package 検査と `gate.json` の typecheck / test /
  node-resolution の期待数を同じ変更で更新する。
- `tsconfig.base.json` は `noUnusedLocals` を有効にしていない。コード移動では追加元に残った
  import / helper を別途確認する。
- `exactOptionalPropertyTypes` を守り、optional 欄が無い値はキー自体を省略する。
