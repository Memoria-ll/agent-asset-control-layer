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

### レイヤ / seam mapping

- logic unit（テスト対象）: `core-domain/src/`（domain semantics と失敗語彙）、
  `core/src/` のうち `config/` `logging/` `http/router.ts` `http/responses.ts` と
  composition root の `index.ts`、`shared/src/`、`vscode-extension/src/` のうち
  VS Code API に依存しない client / view model。
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
  でしか出どころを区別できない。1 つの root について判断する消費側（save の可用性判定、
  resolver、HTTP ハンドラ）は必ず `source.rootId` で絞る。絞らないと、繋がっていない personal /
  project root 1 つで健全な root まで使えなくなる (#58)
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
