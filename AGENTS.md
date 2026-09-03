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

### Project identity / initialization

- Project identity の正は `<project-root>/.aacl/project.json`。Marker は
  `{ "schemaVersion": 1, "projectId": "project-<suffix>" }` の strict object で、`projectId` は
  `^project-[a-z0-9-]+$` に一致し全長128文字以内とする。Core は `[a-z0-9-]` の suffix から ID を
  組み立てる。Git repository root は参照せず、init に渡された directory を Project root とする。
- `pnpm project:init -- [project-root]` が明示 init の入口で、root script は Core の Node entrypoint を
  元の cwd から直接起動する。CLI は pnpm の `--` separator を引数境界として 1 回だけ正規化する。
  path の省略時と相対 path は pnpm が設定する `INIT_CWD`（直接 Node 実行時は `process.cwd()`）を
  基準に解決し、絶対 path はそのまま受理する。配布形態の確定前なので executable 名は持たない。
  未初期化 workspace の discovery は filesystem を変更せず `uninitialized` を返す。
- discovery は workspace から filesystem root まで親を辿り、最寄りの `.aacl` で停止する。
  その directory または Marker が不正なら `invalid` を返し、上位 Project へ抜けない。この探索で
  候補は 1 件に定まるため `ambiguous` は契約に持たない。workspace の stat が `ENOENT` または
  `ENOTDIR` の場合は `invalid_request`、その他の stat 障害は `unavailable` とする。
- Registry は `~/.aacl-state/project-registry.json` の JSON 索引で、Project root path ごとに
  `pending` / `bound` / `mismatch` を保持する。Marker が同じ `project-id` を持つ別 path は同一
  Project として追加 binding できる。異なる ID は既存 binding を上書きせず `mismatch` にする。
  Marker は identity の正、Registry は Marker から再構築できる索引として扱う。
- init は Registry の `pending`、`.aacl` directory、Marker の排他的・原子的作成、`bound` の順に
  進む。既存の `pending` ID だけを再利用する。Marker 不在を確認した `prepare` は、対象 root の既存
  `mismatch` entry を提案 ID の `pending` entry へ置き換え、Marker が存在する identity mismatch は
  `conflict` として拒否する。
  `prepare` は `.aacl` directory の `dev` / `ino` を返し、Marker の temp file 作成と hard link の前後で
  directory identity と temp descriptor/path identity を同期検査する。directory が差し替わったときは
  元の identity と一致する temp path だけを best-effort cleanup の対象とし、作成失敗時の空 directory も
  元の directory identity と一致するときだけ削除する。Marker 作成と `bound` 遷移を
  完了させない。hard link 後は directory と installed Marker の identity を再読取りし、source guard を
  Registry の read-modify-write commit 直前まで渡す。
  Marker への hard link と直後の directory/Marker identity 検証を作成の commit とし、一時ファイル名の cleanup 失敗では
  `pending` へ戻さず `bound` まで進める。`pending` entry は内部状態として保持し、Core 起動時の
  reconcile と次回 discovery は Marker を読み直して `bound` または `mismatch` を確定する。
- Registry の read-modify-write 全体は、Registry 専用ディレクトリ内の恒久 regular lock file と
  `fs-native-extensions@1.5.1` の OS native exclusive FD lock（Linux は `F_OFD_SETLK`、macOS は
  `flock`、Windows は `LockFileEx`）で保護する。取得は lock file を
  `open` してから `tryLock` を monotonic deadline まで bounded polling し、既定の timeout は5秒とする。
  lock file の作成・取得途中で失敗した場合は FD と polling timer を必ず閉じ、判定不能な状態は
  `lock_unavailable` として fail-closed にする。
  この lock は advisory であり、同じ lock protocol を守る Core process 間の read-modify-write を排他する。
  同じ権限で protocol 外から Registry JSON を直接書き換える process はこの保護対象に含めない。
  lock file は取得前に regular file として検査し、取得後は descriptor の `fstat` と path の `lstat` の
  `dev` / `ino` を照合する。atomic persist は temp file 書込み後、rename 直前にも同期 identity guard を
  実行し、検査を通過したときだけ commit する。guard は偶発的な path replacement を検知し、解放処理は
  replacement path に触れず native FD のみを解放する。guard と rename の間にある protocol 外 writer との競合は
  advisory lock の保護範囲外とする。
  プロトコル参加者は lock file を unlink / rename せず、release は native unlock と FD close をこの順で必ず
  試みる。異常終了時も OS が lock を解放し、恒久 file は残る。unlock / close の cleanup failure は、callback
  が完了して commit 済みの結果を反転させない。owner process が生存中は pause の長さに関係なく native
  lock が保持され、競合側は timeout / fail-closed とする。
  Marker reconciliation は Registry 文書の読込み後に lock 下で開始する各 entry の照合を専用 child process で行い、
  monotonic clock による5秒の全体 deadline を持つ。deadline 超過時は child の stream を閉じて handle を `unref` し、SIGKILL を送り、
  親は child の終了を待たず Registry を変更せず `degraded/timeout` を返す。child の起動・終了・JSON framing の
  失敗は `unavailable` observation として扱う。Core は
  `core.project_registry_reconcile_degraded` を warning で記録して listen と health を開始する。Registry JSON の
  破損、read/write、lock 取得の失敗は `project-registry` stage の startup failure として listen を開始せず、
  起動結果は `settings` / `project-registry` / `listen` の stage で分類する。Registry と Marker は regular file を
  確認してから読み取る。Marker reader は `.aacl` を初回 `lstat` で real directory と確認して `dev` / `ino` を保持し、
  POSIX で nonblocking・no-follow open した descriptor の `fstat`、descriptor からの内容読取り、Marker path の
  読取り後 fresh `lstat` を順に行う。その後 `.aacl` を fresh `lstat` し、real directory かつ初回と同じ `dev` / `ino`
  の場合だけ Marker を採用する。この検査は discovery、init、startup reconciliation の全 Marker 読取り経路に適用し、
  directory の symlink・非 directory・identity 変更は `invalid_project_directory`、検査障害は `unavailable` とする。
  valid Marker の directory/Marker identity token は service の binding と initialization に保持し、Registry の
  persist 前および戻り値直前に同期 guard を行う。startup reconciliation の child は両 identity を返し、親は
  entry の反映と Registry persist の直前に同じ source を再検査し、検査できない observation を既存 entry のまま保持する。
  reconciliation は persist 成功後にも同じ guard を実行し、失敗は commit 済みでも `source_changed` の
  `unavailable` として返す。
  guard と Marker の open/link の間にある同一権限の protocol 外 writer との競合は保証対象外とする。
  SIGINT / SIGTERM の handler は `startCore` の await 前に登録し、起動中の停止要求を
  保持する。停止要求後は reconcile の child timeout と cleanup を完了してから listen 済みの Core を close し、
  `core.listening` と startup failure event を記録しない。
- `ProjectInfoDto` と `ProjectDiscoveryDto` の Marker 由来 ID 欄は Marker 固有の schema
  （`^project-[a-z0-9-]+$`、全長128文字以内）を共有する。`invalid` discovery の nested failure code は
  実際の探索経路に対応する `invalid_request` または `unavailable` とする。Registry の `mismatch` entry は
  異なる `projectId` と `markerProjectId` の組合せで表現し、同一 ID の durable entry は
  `invalid_registry` に分類する。
- Project Init / discovery / Marker は `shared` の公開 DTO。VS Code Extension は transport-neutral な
  `ProjectClient` 境界から同じ操作を使う。HTTP route は #12 の範囲で追加する。

### package 構成と依存方向

- pnpm workspaces の monorepo。package は `shared` / `core-domain` / `core` / `vscode-extension`
  の 4 つ。
- root `package.json` の `engines.node` は、lockfile 上の全依存の `engines` の積集合を宣言する。
  依存を追加・更新したら `pnpm-lock.yaml` の `engines:` を見て範囲を更新する
  （宣言だけが広いと、範囲内の Node で gate が動かない）。
- 依存方向は一方向: `core-domain` → `shared`、`core` → `shared` + `core-domain`、
  `vscode-extension` → `shared`。
  `shared` は workspace package に依存せず、runtime 外部依存は schema library (`zod`) だけを持つ。
  `core` の Project Registry は `fs-native-extensions@1.5.1` と Node filesystem API による OS native FD lock を使用する。
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
  consumer から到達できない。TypeScript は module 直 import を通すので、**テストが緑でも
  re-export の欠落は見えない**。公開 API を足す変更は同じ変更で `index.ts` に re-export を
  足す。**`core-domain/tests/**` が公開 API を引くのは `../src/index.ts` からに限る** —
  module を直接引いてよいのは index に載せない内部だけで、現状その該当は 0 件（`grep -n
  'from "\.\./src/[a-z/-]*\.ts"' core-domain/tests/*.ts` の非 index 行が 0 であることで確認
  できる）。これが consumer の到達可能性をテストで担保する唯一の手段になる。
  module の `export` は package 内の module 間で使うためにも張る
  （`ordering.ts` の `codeUnitCompare` のように index に載せないものがある）ので、
  `export` を落とすのは同一ファイル内でしか使わないものだけ (#94)

### フォルダ構成

- 変更が閉じる単位でフォルダを切る。**箱 = package の成果物ソースを直接持つディレクトリ**で、
  `core/src/` 直下の機能ディレクトリ、`core-domain/src/resolution/`、
  各 package の `src/` / `tests/` 直下がこれにあたる。
- **ビルド・検証スクリプトのディレクトリ（`scripts/` / `core/scripts/`）は箱を持たない。**
  `verify-workspace-packages.mjs` と `verify-node-resolution.mjs` は gate step の実装で、
  検査対象は package 横断（package 名の集合、素の Node による解決）なので、そこで学んだ
  事実は定義上 root にしか置けない。編集時に読むのは root の `## Ledger` と、
  gate の構成を述べた `### 逸脱・未定` である。
- テストツリーは分離のまま、実装が機能で割れたら同じ単位でミラーする。
  `core/tests` / `core-domain/tests` / `shared/tests` は現状フラットなので、
  それぞれ 1 箱として扱う。
- `core` / `core-domain` の境界は host 能力の有無で、
  `core-domain/tests/dependency-boundary.test.ts` が機械判定する（下記「package 構成と依存方向」）。
- Ledger はこの単位で `ledger.md` に分割する（`## Ledger`）。
- 観察中: `core/src/config` / `http` / `logging` は独立して変更された実績がない
  （3 つとも変更 1 回、しかも同一コミット）。**次に `http` へエンドポイントを足すとき、
  `config` と `logging` が同時に動くかで、この 3 分割が変更の単位と合っているかを判定する。**
- 観察中: Ledger の内訳は root 26 件 / 箱 18 件で、**箱をまたぐ事実の方が多い**。
  19 箱のうち 12 箱がエントリ 0 件。この比率が「箱の切りすぎ」なのか「このドメインでは
  箱をまたぐ結合が本質的に多い」のかで取るべき手が逆になるため、#108 で測る。

### レイヤ / seam mapping

- logic unit（テスト対象）: `core-domain/src/`（domain semantics と失敗語彙）、
  `core/src/` のうち `main.ts` を除くすべて（`assets/` `catalog/` `config/` `http/`
  `internal/` `logging/` `projects/` `types/` `workflow/` と composition root の `index.ts`）、`shared/src/`、
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

Ledger は箱ごとに分割している。**編集するファイルが属する箱の `ledger.md` と、この
`## Ledger` の両方を読む。** 箱に閉じる事実はその箱の `ledger.md`、2つ以上の箱に
またがる事実とリポジトリ全体の規約はここに置く。同じ事実を両方に置かない —
守備範囲が変わったときは移す。箱を持たないディレクトリ（`scripts/` / `core/scripts/`、
`### フォルダ構成` 参照）のファイルを編集するときは、この `## Ledger` だけを読む。

**置き場は「その事実に違反しうる編集がどの箱で起きるか」で決める。** 事実が語る対象が
この箱にあっても、義務の発火点（別の箱の宣言を更新する、caller として欄を埋める、
src の変更に対してテストを足す）が箱の外にあるなら、それは箱をまたぐ事実なので
ここに置く — 違反する側の編集者はその箱の `ledger.md` を読まないため、箱に置くと
**まさに違反が起きる瞬間に見えない**。

**発火点は「現時点の呼び出し箇所」ではなく「その義務を負いうる編集の場所」で数える。**
`core/src/index.ts` から export される面の consumer 向け注意（呼び出し側が前提にすべき
非対称、caller が埋める欄）は、箱外の呼び出しが今 0 件でも箱をまたぐ事実として
ここに置く — 公開契約の consumer は箱の外にしか存在しえず、最初の呼び出しを書く編集が
まさに注意を必要とする編集だからである。同様に、未着手の issue が発火点になる事実
（「#4 が配線するとき」「保存欄が決まってから」）は、その issue が触る箱で数える。

**ただし「公開 re-export されている」だけでは箱をまたがない。** 判定は 2 条件の連言で、
**エントリが caller に宛てた注意であること**（caller が果たす義務・caller が前提にすべき
挙動）と、**違反が黙って通りうること**（typecheck も gate も緑のまま誤った値・誤った状態に
なる書き方が存在する）の両方が要る。箱が自分のコードをどう書くかを述べたエントリは、
そこに出てくる型がすべて公開 re-export でも箱に残る — 読者は実装者であって caller では
ない。逆に、**どう書いても必ず**ビルドが落ちるなら root どころか Ledger に載せる必要が
ない（`project-ledger.md` の entry 条件）。**「一部の書き方はコンパイラが捕まえる」は
除外理由にならない** — 捕まらない書き方が 1 つでもあれば、Ledger が守るのはその 1 つで
ある。判定は型を読んで決めず、両方の書き方を実際にコンパイルして確かめる。

- `core/src/ledger.md`
- `core/src/assets/ledger.md`
- `core/src/catalog/ledger.md`
- `core/src/config/ledger.md`
- `core/src/http/ledger.md`
- `core/src/internal/ledger.md`
- `core/src/logging/ledger.md`
- `core/src/projects/ledger.md`
- `core/src/types/ledger.md`
- `core/src/workflow/ledger.md`
- `core/tests/ledger.md`
- `core-domain/src/ledger.md`
- `core-domain/src/resolution/ledger.md`
- `core-domain/tests/ledger.md`
- `shared/src/ledger.md`
- `shared/src/internal/ledger.md`
- `shared/tests/ledger.md`
- `vscode-extension/src/ledger.md`
- `vscode-extension/tests/ledger.md`

### Traps

- `shared` は build を持たず `exports` が `./src/index.ts` を指すため、**相対 import 指定子は
  `.ts` で書く**。`.js` で書くと `pnpm -r typecheck` も `pnpm -r test` も緑のまま、素の Node が
  `ERR_MODULE_NOT_FOUND` で落ちる — vitest は自前のリゾルバを使うのでこの壊れ方を検知できない。
  Core は host 直実行なので実害がある。gate の node-resolution step がこの経路を実測する。
  型除去に依存するので `engines.node` の下限は 22.18（既定で有効になった版）(#47)

- `exports` を `dist` に向けると `pnpm -r typecheck` は exit 0 のまま、`pnpm -r test` だけが
  `core` と `vscode-extension` で `Failed to resolve entry for package "@aacl/shared"` を出して
  落ちる (#46)

- asset file の `type:` と `tier:` は `ASSET_TYPES` / `LOADING_TIERS` を**そのまま**正としている。
  `shared/tests/enum-values.test.ts` が両者を逐語で pin し、その assertion message が
  "Changing enum values requires bumping CONTRACT_VERSION." である。**on-disk の type / tier を
  増やすと、wire DTO が何も変わらなくても `CONTRACT_VERSION` の bump を伴う破壊的変更になる** (#2)

- 境界の値集合（`ASSET_TYPES` 等）の正は #2 の Canonical Asset model。#2 Scope が初期 type として
  Skill / Rule / Role / Workflow / Task Type / Policy / Guardrail / Knowledge の 8 個を挙げており、
  `ASSET_TYPES` はこれと一致している。README の製品説明はこれより広い語（templates / checklists /
  capability bindings）を含むが型の正ではない。**#2 が type を増やしたら同じ変更で `ASSET_TYPES` を
  更新する** — enum への値追加は破壊的変更 (#47)

- `core` は `@types/node` を devDependency に持ち、かつ `core/tsconfig.json` に
  `"types": ["node"]` を書く。`typeRoots` を指定しても自動発見は効かず、`node:*` の import が
  `error TS2591` になって gate の typecheck step（`must_not_match: "error TS[0-9]{4}"`）を落とす。
  `core-domain` にはどちらも置かない — それが「domain は host 能力に触れない」の型側の強制手段 (#1)

- **一時ファイル + rename の atomic write は対象の inode ごと差し替えるので、保存後の mode は
  一時ファイル側のものになる。** 対象の mode を引き継ぐことと、**それを `open` の第 3 引数で
  与えること**の両方が要る。umask は与えた mode を削るだけなので、狭い mode は生成時に
  確定するが、書き込み後の `chmod` では**内容が緩い mode で存在する窓**が開く（実測: 既定
  `open` は umask 22 で `0644` を作り、`0600` への `chmod` はその後）。広げる側は書き込み後の
  `chmod` でしか実現できず、そちらは元の mode へ戻すだけなので窓にならない。rename 方式で
  既存ファイルを更新する箇所（Runtime Store など別の永続化を足すときも）すべてに効く (#58)

- **`tsconfig.base.json` に `noUnusedLocals` は無い。** 使われなくなった import を消し忘れても
  `pnpm -r typecheck` は緑のまま通る。**helper を別ファイルへ切り出す変更は、追加側と削除側を
  別の完了項目として数え、削除側を `grep -c` で確認する** — 追加だけが着地した状態を gate は
  捕まえない (#5)

- **vitest は型を消して実行するので、`exactOptionalPropertyTypes` 違反はテストを緑にしたまま
  `pnpm -r typecheck` だけを落とす。** テストが通ったことは型が通ったことを意味しない。
  optional 欄を持つ値は「キーごと置かない」条件付きスプレッドで組み立てる —
  `{ key: undefined }` も、optional 欄を持つ DTO の丸ごとスプレッドも代入できない (#5)

- **branded ID どうしの変換は `as` 1 回では通らない**（2 つの brand は重ならない）。
  `asset.id as string as RoleId` のように一度 `string` へ広げる。
  plain string からの brand 付与（`makeAssetRevision` の `as AssetRevision`）は 1 回で通るので、
  同じ書き方だと思って書くと落ちる (#5)

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
  `core-domain/src/resolution/resolution-context.ts` の `RESOLUTION_AXES`（`projectId` … `modelId` と
  `directory`）。`task-type` → `taskTypeId` は kebab→camel の非自明な変換。**両者とも
  string キーなので、対応を取り違えても typecheck も gate も緑のまま通る。**
  `CanonicalAsset.scope` を candidate へ投影する面（#4）はこの表を明示的に持つこと (#3)

- **workflow instance と agent execution の link は双方向で、その鏡像はすでに契約にある** —
  `WorkflowStateDto.linkedAgentExecutionIds` と `AgentExecutionDto.workflowBinding`
  （`shared/src/sessions.ts`）が互いを指し、producer 側は `core-domain/src/agent-execution.ts` の
  `AgentExecutionRecord` が保持している。**Workflow State の「1 file を rename すれば
  State と link が同時に確定する」という原子性は #7 の範囲でだけ成立する** — #20 が
  Agent Execution を永続化した時点で 2 document の更新になり、そこは transaction /
  idempotency を別に設計する必要がある (#7)

- **公開 `ConflictDto` は `{ explanation, involvedAssetIds }` の 2 欄で `kind` を持たず、
  `CoreErrorDetail.code` は `NonEmptyString` である。** したがって内部
  `ResolutionConflict` に kind を足しても公開契約は変わらず、`CONTRACT_VERSION` の bump も要らない。
  漏れは `conflictExplanation` の網羅 switch がコンパイル時に捕まえる。逆に、conflict の種別を
  Extension 側へ機械可読に渡す必要が出たときは、そこが初めて公開契約の変更になる (#75)

- **`ResolveScopeInput.capabilityContext` の省略は「capability が要らない」ではなく
  「提供が 0 件」として評価される。** 渡し忘れた caller は capability dependency を持つ候補の
  required をすべて hard failure にし、その候補を context から落とす。型は optional なので
  コンパイルも gate も通る。resolver を配線する面（#12 / #82）はこの欄を必ず埋めること (#9)

- `AssetListResult.failures` は **全 managed root の診断が混ざった 1 本の列**で、`source.rootId`
  でしか出どころを区別できない。**1 つの root について判断する消費側は、結果を絞るのではなく
  `scanRoot` でその root だけを走査する。** 絞り込みが効くのは全 root の走査が終わったあと
  なので、応答しないマウント上の root が 1 つあると健全な root の処理がその完了を待たされる
  — `list()` を呼んで `rootId` で filter する形では防げない (#58)

- **`shared/tests/json-schema.test.ts` の strict object 検査は root の `oneOf` までしか展開せず、
  nested object property へは降りない。** 境界 DTO が nested object を持つとき
  （`WorkflowDefinitionDto` の stage / transition など）、その strictness は汎用網の**外**にある。
  registry に登録しただけでは検査されないので、nested の `additionalProperties` は
  個別 assertion で pin する (#7)

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

- **`AgentExecutionRecord.providerId` は、指定された Runtime / Model 定義の `providerId` と一致する必要がある。**
  各 ID の存在確認だけでは、別 Provider に属する実行先の組合せを通してしまう (#66)

- **`Array.isArray` は union から `readonly string[]` を除去しない。** `AssetFieldValue`
  （`string | readonly string[]`）を絞るのに使うと、false 分岐に配列が残って scalar 側が
  `string` にならない。`typeof value === "string"` で判別する (#5)

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

- **Type 固有の意味論は `core-domain/src/resolution/asset-type-contracts.ts` の
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

- **解決結果で「context に載るか」を表す信号は `CandidateReason.kind` 1 つしかない。**
  `resolveScope` は候補ごとに reason を 1 個返し、消費側は `kind === "included"` で絞る。
  したがって **degraded は `kind: "included"` のまま degradation 欄を載せて返す** —
  `kind: "unavailable"` にすると optional 依存の欠落が候補を黙って context から消し、
  「degraded は載るが能力が落ちた状態」を表現できなくなる。`availability: "unavailable"` を
  作るのは required capability の hard failure だけ (#9)

- **`ExecutionInstanceId` は全 Definition を通じて一意（#50 裁定2）。** State のファイル名が
  instance id 単独 (`workflows/<id>.json`) なのはこの一意性に依る。同居する `workflowId` は
  名前空間ではなく**所属不一致の検出用**で、`readStoredState` が突き合わせて
  `instance_workflow_mismatch` を返す。schema は opaque 値の一意性を検査できないので、
  独自に発番する producer 側がこの一意性を負う (#7)
