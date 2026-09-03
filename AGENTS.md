# AGENTS.md

Agent Asset Control Layer — AI開発アセットの単一の source of truth と context resolution を担う
local-first Core、およびその Workbench となる VS Code Extension。

## コマンド

- 依存導入: `pnpm install`
- Core 起動: `pnpm start:core`（= `pnpm --filter @aacl/core start`）。既定の待受は
  `http://127.0.0.1:7420`、稼働確認は `GET /health`
- テスト: `pnpm -r test`（gate の test step と同一コマンド）
- 品質ゲート: `bash ~/.claude/scripts/run-gate.sh`（canonical。判定条件は `gate.json` が唯一の正）

## Architecture

### 実行・配布形態

- Core service は host 直実行の Node プロセス（localhost）。docker compose 既定からの逸脱 —
  理由は「逸脱・未定」に記載。
- Core はビルド段を持たず `node src/main.ts` で起動する（Node の type stripping に依存する）。
  待受は `AACL_CORE_HOST` / `AACL_CORE_PORT` で変えられ、既定は `127.0.0.1:7420`。
  `AACL_CORE_HOST` が受け付けるのは `127.0.0.1` / `localhost` / `::1` の 3 値で、
  Core が認証を持つまで待受はループバックに閉じる。LAN 公開は #21 / #25 で認証と同時に決める。
  設定値が範囲外なら既定へ落とさず起動失敗し exit code 1 を返す。
- Phase 1 = single-user localhost、Phase 2 = single-user remote / multi-PC、Phase 3 = multi-user team。
  remote / team 運用を local 利用の前提条件にしない。
- 現時点は自分用ツール。`rules/distributed-app.md` の品質バーは未発効。
- バージョンは root `package.json` の `version`。`0.0.0` のため `project-stage.sh` は `dev` を返す
  （保存データの破壊的変更が許される状態）。配布を始める前に実バージョンへ更新する。

### package 構成と依存方向

- pnpm workspaces の monorepo。package は `shared` / `core-domain` / `core` / `vscode-extension`
  の 4 つ。
- root `package.json` の `engines.node` は、lockfile 上の全依存の `engines` の積集合を宣言する。
  依存を追加・更新したら `pnpm-lock.yaml` の `engines:` を見て範囲を更新する
  （宣言だけが広いと、範囲内の Node で gate が動かない）。
- 依存方向は一方向: `core-domain` → `shared`、`core` → `shared` + `core-domain`、
  `vscode-extension` → `shared`。
  `shared` は workspace package に依存しない。外部依存は schema library (`zod`) 1 つに限る。
  `core` と `vscode-extension` は相互に依存しない。
- **`core-domain` は host 能力に触れない。** `node:*` を import せず、`@types/node` も持たない
  （`core-domain/tsconfig.json` に `types` を書かない）。外部 SDK・VS Code・Tauri は
  `dependencies` にも import にも現れない。`@types/node` は `core` の devDependency に置き、
  `core/tsconfig.json` の `types: ["node"]` で有効にする。この非対称は意図的で、
  「domain は host 能力に触れない」を型解決と依存解決の両方で強制する。
  pnpm の package 境界は権限境界ではなく root の依存は全 package から解決するため、
  `core-domain/tests/dependency-boundary.test.ts` が manifest の直接依存と
  `core-domain/src/**` の import 指定子（static / side-effect / re-export / 動的）を
  全数走査して機械判定する。
- **`zod` は `shared` の実装詳細であり、公開契約の一部ではない。**
  `shared/src/index.ts` は zod 値を 1 つも公開しない — schema も、その集合も、
  `$ZodError` を引数に取る関数も internal。公開面は **TypeScript の型**（ビルドで消える）と、
  **素の JavaScript の関数・データ**だけで構成する。
  これにより `core` / `vscode-extension` が zod 依存を持たずに済み、その「依存が無い」ことが
  「Extension が DTO / schema を再定義しない」を review でなく依存解決で強制する。
  同時に validator が差し替え可能なまま残る（zod/mini の採用自体が実測による選択だった）。
  `contract-surface.test.ts` が index の実行時 export を全数走査して機械判定する。
- **consumer が実行時に必要とするものは、その都度 `shared` が素の JS export として足す。**
  検証が要るなら `parse*` を、集合の列挙が要るならメンバー配列を追加する
  （閉じた値集合は `AS_CONST` 配列を正とし、`z.enum` をそこから作る — `schema._zod` を読ませない）。
  schema をまとめて配る形は採らない。将来必要になるかもしれない `parse*` を憶測で先に足すこともしない。
- `shared` 自身のテストは `../src/<module>.ts` を直接 import してよい — この制約が縛るのは
  consumer package であって、パッケージ内部ではない。
- `shared` は Core / Extension 間の契約面。DTO・schema・serialization・error / version contract のみを置く。
  domain semantics と実装ロジックは置かない。
- `shared` は Core 実装にも VS Code API にも依存しない。
- Extension は Core domain 実装を複製しない。API DTO / schema を Extension 内で再定義しない。

### 公開契約の境界

- `shared/src/` の公開型が公開契約。network / IPC 境界を越える型は明示的な serialization schema を持つ。
- `shared/src/` の公開契約は `zod/mini` の schema が単一の正で、TypeScript の型は `z.infer` で導出する。
  境界 DTO はすべて `z.strictObject`（未知キーを拒否する）。
  serialization schema は `contractJsonSchemas()` が返す JSON Schema draft 2020-12。
- 境界 DTO は成立し得ない状態を parse させない。負の件数・自己矛盾する enum の組合せ・
  否定状態を説明する空配列/空文字列は、型が通っても契約違反として reject する。
  表示文字列と理由・説明の欄は `NonEmptyString`。optional な配列は「省略＝無し」で表現するため、
  存在するなら `minLength(1)` を持つ。空が実状態である欄（`ResolvedAssetDto.body` の空ファイル、
  `CoreErrorDetail.path` の空キー・全体指定）は制約せず、その理由を欄のコメントに書く。
- **このルールが及ぶのは JSON Schema に出力できる制約まで。** 2 欄を比較する順序制約
  （`endedAt >= startedAt` 等）は draft 2020-12 に対応キーワードが無く、構造を変えないと
  表現できない。契約形の変更を伴うため、その場で `z.refine` を足さず issue に切り出す（#48）。
- **JSON Schema に出せる制約は、parse 側と schema 側の両方を書く。** `zod/mini` の
  `.check(z.refine(...))` は parse でしか効かず `z.toJSONSchema()` には何も出さないので、
  対応キーワードを `.register(z.globalRegistry, { ... })` で併記する（配列の一意性なら
  `{ uniqueItems: true }`）。片方だけだと、schema 駆動の消費側が Core の拒否する定義を
  受理する。`shared/tests/contradictory-states.test.ts` の schema 側 describe が検査面。
- 相互排他な組合せは `z.discriminatedUnion` のアームに分ける。cross-field の `z.refine` は
  使わない — parser では効くが `z.toJSONSchema()` の出力に一切現れず、schema 駆動の consumer が
  同じ値を通してしまう（実測）。union の JSON Schema は `additionalProperties` を root でなく
  `oneOf` の各アームに持つため、schema を検査するテストは root だけを見ない。
- 契約全体のバージョンは `shared` の `CONTRACT_VERSION` 1 つ。互換判定は
  `checkContractCompatibility()`。enum への値追加と required 欄の追加は破壊的変更。
- Core API の request / response・error・version contract は公開契約。
- Core の稼働確認は `GET /health`（`HEAD` も 200）。返すのは `shared` の `VersionInfo`
  （`{ contractVersion }` の 1 欄）で、Core の実装バージョンは載せない — consumer が契約でなく
  実装で分岐できてしまうため。URL にバージョン prefix を持たない。バージョン軸は
  `CONTRACT_VERSION` 1 本。
- Core のエラー応答は `CoreErrorDto` 準拠で、`code` は `CORE_ERROR_CODES` の値。
  例外の内容は応答に載せず、ログの `core.request_failed` に出す。
- `AACL_CORE_HOST` / `AACL_CORE_PORT` は利用者可視の設定名。改名は公開契約の変更。
- Asset の source of truth は人間可読なファイルシステムファイル。その形状は公開契約 —
  変更は `save-schema-check` を通す。
- `core/` 内部の domain model、`vscode-extension/` の view model / UI state は内部配線。
  `core` の内部 domain model と `shared` の公開 DTO は分離してよい。
- **`core-domain` の公開面は `core-domain/src/index.ts` の re-export が正。** consumer は
  `@aacl/core-domain` からしか解決しないため、module に `export` を足しただけの型・関数は
  consumer から到達できない。package 内のテストは module を直接 import できる（`shared` と
  同じ扱い）ので、**テストが緑でも re-export の欠落は見えない**。公開 API を足す変更は同じ
  変更で `index.ts` に re-export を足し、その API を使うテストは `../src/index.ts` から
  import して欠落を落とす。module の `export` は package 内の module 間で使うためにも張る
  （`ordering.ts` の `codeUnitCompare` のように index に載せないものがある）ので、
  `export` を落とすのは同一ファイル内でしか使わないものだけ (#94)

### レイヤ / seam mapping

- logic unit（テスト対象）: `core-domain/src/`（domain semantics と失敗語彙）、
  `core/src/` のうち `main.ts` を除くすべて（`assets/` `catalog/` `config/` `http/`
  `internal/` `logging/` `workflow/` と composition root の `index.ts`）、`shared/src/`、
  `vscode-extension/src/` のうち VS Code API に依存しない client / view model。
- view-glue（テスト対象外）: `core/src/main.ts`（`process.env` / stdout / signal だけを持つ
  host glue）、`vscode-extension/src/` のうち VS Code API へ直接触れる面
  （activation / lifecycle、command 登録、webview 配線）。
- `core/src/index.ts` は composition root で副作用を持たない。import しても listen しない。
  起動の副作用は `main.ts` だけが持つ。gate の node-resolution step が `index.ts` を
  素の Node から import してこの性質ごと検査する。
- テストは各 package の `tests/` に置き、vitest で走らせる（`pnpm -r test`）。
  4 package すべてが `test` script を持つ。
- gate: `bash ~/.claude/scripts/run-gate.sh`

### 逸脱・未定

- docker compose 既定からの逸脱: Core は利用者のファイルシステム・git 履歴・keychain に直接触れ、
  かつ Windows と WSL の双方から同一 localhost Core として見える必要がある。
  bind mount とパス変換を Core の契約面へ載せないため host 直実行とする。
- `gate.json` は 4 step。`min_count` は typecheck / test が package 数 4 を固定値で持ち、
  node-resolution が `resolution: OK` の行数 3 を持つ。package を増減させるときは
  同じ変更で 3 箇所すべてを更新する。test step は package 数だけを固定し、テスト本数は固定しない。
- workspace-packages step が期待 package 名の集合と各 package の `typecheck` / `test` script の
  存在を検査する。`min_count` は下限比較で package 名を見ず、`pnpm -r` は script を持たない
  package を黙って skip する（出力は `Scope: N of M workspace projects` で root を除外）ため、
  数を数えるだけでは「package が実行対象から丸ごと外れた」状態を緑にしてしまう。
- node-resolution step は素の Node による `@aacl/shared` / `@aacl/core-domain` /
  `core/src/index.ts` の解決を検査する（下記 Traps 参照）。
- 未定: Core UI（Tauri 2 shell、#19）の package 位置。
- 未定: `vscode-extension` の bundling（esbuild）と extension manifest
  （`engines.vscode` / activation / contributes）。#31 で決める。

## Ledger

### Traps

- `shared` は build を持たず `exports` が `./src/index.ts` を指すため、**相対 import 指定子は
  `.ts` で書く**。`.js` で書くと `pnpm -r typecheck` も `pnpm -r test` も緑のまま、素の Node が
  `ERR_MODULE_NOT_FOUND` で落ちる — vitest は自前のリゾルバを使うのでこの壊れ方を検知できない。
  Core は host 直実行なので実害がある。gate の node-resolution step がこの経路を実測する。
  型除去に依存するので `engines.node` の下限は 22.18（既定で有効になった版）(#47)
- `exports` を `dist` に向けると `pnpm -r typecheck` は exit 0 のまま、`pnpm -r test` だけが
  `core` と `vscode-extension` で `Failed to resolve entry for package "@aacl/shared"` を出して
  落ちる (#46)
- 境界の値集合（`ASSET_TYPES` 等）の正は #2 の Canonical Asset model。#2 Scope が初期 type として
  Skill / Rule / Role / Workflow / Task Type / Policy / Guardrail / Knowledge の 8 個を挙げており、
  `ASSET_TYPES` はこれと一致している。README の製品説明はこれより広い語（templates / checklists /
  capability bindings）を含むが型の正ではない。**#2 が type を増やしたら同じ変更で `ASSET_TYPES` を
  更新する** — enum への値追加は破壊的変更 (#47)
- asset file の `type:` と `tier:` は `ASSET_TYPES` / `LOADING_TIERS` を**そのまま**正としている。
  `shared/tests/enum-values.test.ts` が両者を逐語で pin し、その assertion message が
  "Changing enum values requires bumping CONTRACT_VERSION." である。**on-disk の type / tier を
  増やすと、wire DTO が何も変わらなくても `CONTRACT_VERSION` の bump を伴う破壊的変更になる** (#2)
- asset frontmatter の未知 top-level key は validation error になる。`mandatory` / `priority` /
  `disable` / `override` も v1 では拒否される。**#4 がこれらの directive を導入するときは
  asset schema version（`schema-version:`）の bump が要る** — v1 parser は未知 version を
  `incompatible_contract` で拒否し、暗黙の migration を行わない (#2)
- `core` は `@types/node` を devDependency に持ち、かつ `core/tsconfig.json` に
  `"types": ["node"]` を書く。`typeRoots` を指定しても自動発見は効かず、`node:*` の import が
  `error TS2591` になって gate の typecheck step（`must_not_match: "error TS[0-9]{4}"`）を落とす。
  `core-domain` にはどちらも置かない — それが「domain は host 能力に触れない」の型側の強制手段 (#1)
- `node:http` のリクエストハンドラ内で throw すると `uncaughtException` になり、**その接続には
  応答が返らずクライアントがハングする**（500 にはならない）。transport は必ず例外境界で捕まえて
  `internal` の `CoreErrorDto` を返す。`server.on("error")` は **`listen()` と同じ同期ターン内**で
  登録する — `setImmediate` / `setTimeout` を挟むと `EADDRINUSE` がハンドラに届かず
  `uncaughtException` でプロセスが落ちる（`listen()` の前後は無関係で、ターンが同じかだけが効く） (#1)
- 境界 DTO は `z.strictObject`。`z.object` でも既定の `z.toJSONSchema` は
  `additionalProperties: false` を書くため、公開 schema を読んでも差が出ない。差を捕まえるのは
  `io: "input"` と `io: "output"` の突き合わせだけで、`contractSchemas` から到達しない schema
  （`CompatibilityResult` / `DegradedInfo`）はこの網の外にある (#46)
- `AssetListResult.failures` は **全 managed root の診断が混ざった 1 本の列**で、`source.rootId`
  でしか出どころを区別できない。**1 つの root について判断する消費側は、結果を絞るのではなく
  `scanRoot` でその root だけを走査する。** 絞り込みが効くのは全 root の走査が終わったあと
  なので、応答しないマウント上の root が 1 つあると健全な root の処理がその完了を待たされる
  — `list()` を呼んで `rootId` で filter する形では防げない (#58)
- `save` の直列化キーは **`resolve()` した root ディレクトリ**で、chain は module スコープに
  置く。`rootId` はインスタンスごとのラベルにすぎず、同じディレクトリに別の `rootId` を付けた
  store を 2 つ作れるので、キーには使えない。これにより `expectedRevision` は
  **同一 Core プロセス内のすべての store インスタンスにまたがって**守られる。正規化は字句的
  なので symlink 別名と大小非区別 FS の綴り違いは別キーになる (#60)。プロセス外の writer は
  revision 比較と rename の間に割り込めるままで、そちらは #59 (#58)
- **一時ファイル + rename の atomic write は対象の inode ごと差し替えるので、保存後の mode は
  一時ファイル側のものになる。** 対象の mode を引き継ぐことと、**それを `open` の第 3 引数で
  与えること**の両方が要る。umask は与えた mode を削るだけなので、狭い mode は生成時に
  確定するが、書き込み後の `chmod` では**内容が緩い mode で存在する窓**が開く（実測: 既定
  `open` は umask 22 で `0644` を作り、`0600` への `chmod` はその後）。広げる側は書き込み後の
  `chmod` でしか実現できず、そちらは元の mode へ戻すだけなので窓にならない。rename 方式で
  既存ファイルを更新する箇所（Runtime Store など別の永続化を足すときも）すべてに効く (#58)
- **managed root の同一性判定は `resolve()` による字句正規化までしか見ていない。** symlink 別名と
  大小非区別 FS の綴り違いは別 root として受理され、同じ物理ファイルが 2 つの論理 source として
  list される。duplicate 検査は `rootId` で絞っているので診断も出ない。#4 の override / disable は
  「同じ id を別 root で宣言する」で成立させるので、**この重複は実在しない override 候補として
  #4 の判定に直接混入する**。完全な identity 判定は #60 (#58)
- **`save` が受理する `relativePath` は Windows でも成立する名前に限る**（禁止文字 `< > " | ? *`、
  制御文字、末尾のピリオド/空白、予約デバイス名 `CON` / `PRN` / `AUX` / `NUL` / `CONIN$` /
  `CONOUT$` / `COM1-9` / `COM¹²³` / `LPT1-9` / `LPT¹²³` を、末尾空白を落とした stem の
  完全一致で拒否）。**数字は 1 始まりで、`COM0` / `LPT0` は予約ではないので受理する。**
  **`list` にはこの制限が効かない** — 正本は
  human-readable filesystem なので、手で置かれた名前はそのまま読む。したがって
  「list に出た asset の `relativePath` を、そのまま save に渡し直せるとは限らない」。
  read-modify-write する消費側はこの非対称を前提にすること (#58)
- **`tsconfig.base.json` に `noUnusedLocals` は無い。** 使われなくなった import を消し忘れても
  `pnpm -r typecheck` は緑のまま通る。**helper を別ファイルへ切り出す変更は、追加側と削除側を
  別の完了項目として数え、削除側を `grep -c` で確認する** — 追加だけが着地した状態を gate は
  捕まえない (#5)
- **vitest は型を消して実行するので、`exactOptionalPropertyTypes` 違反はテストを緑にしたまま
  `pnpm -r typecheck` だけを落とす。** テストが通ったことは型が通ったことを意味しない。
  optional 欄を持つ値は「キーごと置かない」条件付きスプレッドで組み立てる —
  `{ key: undefined }` も、optional 欄を持つ DTO の丸ごとスプレッドも代入できない (#5)
- **`Array.isArray` は union から `readonly string[]` を除去しない。** `AssetFieldValue`
  （`string | readonly string[]`）を絞るのに使うと、false 分岐に配列が残って scalar 側が
  `string` にならない。`typeof value === "string"` で判別する (#5)
- **branded ID どうしの変換は `as` 1 回では通らない**（2 つの brand は重ならない）。
  `asset.id as string as RoleId` のように一度 `string` へ広げる。
  plain string からの brand 付与（`makeAssetRevision` の `as AssetRevision`）は 1 回で通るので、
  同じ書き方だと思って書くと落ちる (#5)
- **`AgentExecutionRecord.providerId` は、指定された Runtime / Model 定義の `providerId` と一致する必要がある。**
  各 ID の存在確認だけでは、別 Provider に属する実行先の組合せを通してしまう (#66)
- **専用の execution-target catalog は `readFile` の前に `stat().isFile()` を通す。**
  `readFile` の errno だけでは FIFO・デバイス・ソケットなどの非通常ファイルを読み取り開始前に分類できない (#66)
- **`AgentExecutionRecord` を DTO input へ投影するときは `tryParseAgentExecutionDto` で runtime validation する。**
  `Timestamp` の静的型は実行時の ISO datetime 検証を代替しない (#66)
- **managed root を読む面は、失敗 detail の `path` をファイル位置へ書き換える** —
  `core/src/internal/diagnostics.ts` の `withFilePath` が唯一の実装で、asset store と
  catalog loader が共有する。ファイル位置を message に足す形にしない。消費側が
  「片方は path、片方は散文」を解釈し分ける羽目になる。**複数ファイルにまたがる失敗
  （別 root の同一 id 重複など）だけは path が1件を指せないので message が担う** (#5)
- **9軸の scope には語彙が2つあり、8個が改名・1個が同名。** on-disk 側は
  `core-domain/src/assets.ts` の `ASSET_SCOPE_AXES`（`project` / `workflow` / `stage` /
  `task-type` / `role` / `provider` / `runtime` / `model` / `directory`）、resolver 側は
  `core-domain/src/resolution-context.ts` の `RESOLUTION_AXES`（`projectId` … `modelId` と
  `directory`）。`task-type` → `taskTypeId` は kebab→camel の非自明な変換。**両者とも
  string キーなので、対応を取り違えても typecheck も gate も緑のまま通る。**
  `CanonicalAsset.scope` を candidate へ投影する面（#4）はこの表を明示的に持つこと (#3)
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
- **workflow instance と agent execution の link は双方向で、その鏡像はすでに契約にある** —
  `WorkflowStateDto.linkedAgentExecutionIds` と `AgentExecutionDto.workflowBinding`
  （`shared/src/sessions.ts`）が互いを指し、producer 側は `core-domain/src/agent-execution.ts` の
  `AgentExecutionRecord` が保持している。**Workflow State の「1 file を rename すれば
  State と link が同時に確定する」という原子性は #7 の範囲でだけ成立する** — #20 が
  Agent Execution を永続化した時点で 2 document の更新になり、そこは transaction /
  idempotency を別に設計する必要がある (#7)
- **`shared/tests/json-schema.test.ts` の strict object 検査は root の `oneOf` までしか展開せず、
  nested object property へは降りない。** 境界 DTO が nested object を持つとき
  （`WorkflowDefinitionDto` の stage / transition など）、その strictness は汎用網の**外**にある。
  registry に登録しただけでは検査されないので、nested の `additionalProperties` は
  個別 assertion で pin する (#7)
- **公開 `ConflictDto` は `{ explanation, involvedAssetIds }` の 2 欄で `kind` を持たず、
  `CoreErrorDetail.code` は `NonEmptyString` である。** したがって内部
  `ResolutionConflict` に kind を足しても公開契約は変わらず、`CONTRACT_VERSION` の bump も要らない。
  漏れは `conflictExplanation` の網羅 switch がコンパイル時に捕まえる。逆に、conflict の種別を
  Extension 側へ機械可読に渡す必要が出たときは、そこが初めて公開契約の変更になる (#75)
- **`ResolveScopeInput.capabilityContext` の省略は「capability が要らない」ではなく
  「提供が 0 件」として評価される。** 渡し忘れた caller は capability dependency を持つ候補の
  required をすべて hard failure にし、その候補を context から落とす。型は optional なので
  コンパイルも gate も通る。resolver を配線する面（#12 / #82）はこの欄を必ず埋めること (#9)
- **`resolveScope` の候補構造検証と fixed point の capability 評価には、同じ capability context を
  渡す**（どちらも `evaluateCapabilityDependenciesInValidatedContext` に、冒頭で 1 度だけ
  `validateCapabilityContext` した結果を渡す）。検証側だけ context 無しで呼ぶと、definition に
  無い feature を要求する候補が構造検証を通り、fixed point 側が `invalid_request` を返して
  `throw new Error("Validated capability dependencies must evaluate successfully.")` に落ちる
  — `CoreFailure` ではなく例外になるので、consumer からは resolver のクラッシュに見える。
  scope 外の候補も検証対象で、scope が決めるのは「どれが適用されるか」であって
  「どれが妥当か」ではない (#9)
- **`dependencyOutcomes` の伝播は component 内部エッジを飛ばすので、状態ごとの失敗種別を
  足したら component 単位の union も同じ変更で足す。** conflict は mandatory 候補についてしか
  materialize されないため、union を忘れると SCC 内の非 mandatory 候補が持つ失敗は
  mandatory 候補へ伝わらず、**診断そのものが結果から消える**（cycle と dependency_failure だけが
  残り、原因の capability 名が出ない）。requirement 失敗側は `componentHasNonCycleFailure` が、
  capability 側は `componentFailedCapabilities` がこの役目を持つ (#9)

### Invariants / identity keys

- **`AssetRevision` は `sha256:${sha256Hex(serializeCanonicalAsset(asset))}`
  （`core/src/assets/filesystem-store.ts` の `makeAssetRevision`）で、
  `serializeCanonicalAsset` は frontmatter と body の両方を含む
  （`core-domain/src/assets.ts`、戻り値は `${lines.join("\n")}\n${asset.body}`）。
  したがって「同 revision ⇒ 同 body」が成り立つ。** Resolver の
  exact-duplicate fold（同一 id・同一 revision の candidate を1件へ畳み、layer → sourceId 順で
  代表を選ぶ）が安全なのはこの性質のためで、revision を mtime や uuid に変えると
  **body 内容の暗黙の後勝ちに化ける**。revision の作り方を変えるときは resolver の
  dedup を同じ変更で見直すこと (#3)
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
- **Type 固有の意味論は `core-domain/src/asset-type-contracts.ts` の
  `Record<AssetType, AssetTypeContract>` にだけ置く。** 網羅はコンパイル時の義務であり
  runtime 検査を持たない。contract 自身は `assetType` 欄を持たない — Record のキーが唯一の
  型表明で、キーと中身が食い違う registry を書けなくするため。`ASSET_TYPES` に値を足すと
  この Record がビルドを落とす。共通 pipeline 側の type 分岐禁止は
  `core-domain/tests/asset-type-contracts.test.ts` の source scan が機械判定する
  （**走査対象は `scope-resolver.ts` 1 ファイルのみ** — `workflow.ts` や `catalog.ts` には
  正当な type 比較がある） (#75)
- **Type 固有 metadata（Skill の kind、Workflow の stage / transition）は Type contract の
  検証対象になっていない。** `AssetCandidate` が `CanonicalAsset.metadata` を運んでおらず、
  `metadata.*` は `isLowerKebabToken` を満たす任意キーを受理する開いた名前空間で、許可値集合が
  まだ存在しないため。保存欄が決まってから有効化する (#87) (#75)
- **`ExecutionInstanceId` は全 Definition を通じて一意（#50 裁定2）。** State のファイル名が
  instance id 単独 (`workflows/<id>.json`) なのはこの一意性に依る。同居する `workflowId` は
  名前空間ではなく**所属不一致の検出用**で、`readStoredState` が突き合わせて
  `instance_workflow_mismatch` を返す。schema は opaque 値の一意性を検査できないので、
  独自に発番する producer 側がこの一意性を負う (#7)
- **State store は execution instance id を「受け取らず」「組み立てる」。** 注入口は乱数部分だけ
  (`newInstanceSuffix`) で、`instance-<suffix>` の合成と検査は store が持つ。契約が文字集合を
  縛らないため、id を丸ごと受け取る形は「契約上妥当だがファイル名として使えない値」を
  無限に生む（空白・接頭辞・デバイス名・大小文字衝突・長さ・Unicode 正規化で 5 ラウンド分の
  指摘が出た）。**検査は正規化ではなく拒否**で行う — 小文字化や NFC 変換で畳むと、相異なる
  id が 1 ファイルに写像されて一意性が壊れる (#7)
- **ファイル名の安全性は「明示的な英数字集合」で決める — 禁止則の積み上げでは閉じない。**
  大文字禁止 + NFC 必須でも σ と ς は同じ文字に case-fold するため、両方が 1 ファイルを指す。
  case pair も正規化形も持たない集合 (`[a-z0-9-]`) だけが次の一手を許さない (#7)
- **Core が作る階層だけを検査対象にする。** state directory とその配下は store の所有物なので
  実ディレクトリであることを要求できるが、設定されたルートより上の祖先は運用者のもの。
  ルートから全祖先を辿る検査は OS 提供の symlink (macOS の `/var`) を弾き、そのために
  パスを両セパレータで分割する必要が生じて、backslash を含む POSIX ディレクトリ名を壊す (#7)
- **解決結果で「context に載るか」を表す信号は `CandidateReason.kind` 1 つしかない。**
  `resolveScope` は候補ごとに reason を 1 個返し、消費側は `kind === "included"` で絞る。
  したがって **degraded は `kind: "included"` のまま degradation 欄を載せて返す** —
  `kind: "unavailable"` にすると optional 依存の欠落が候補を黙って context から消し、
  「degraded は載るが能力が落ちた状態」を表現できなくなる。`availability: "unavailable"` を
  作るのは required capability の hard failure だけ (#9)
