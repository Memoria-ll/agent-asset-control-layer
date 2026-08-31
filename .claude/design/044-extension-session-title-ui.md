# #44 Extension Session title rename / suggest-only UI 設計

- Design ID: `AACL-DESIGN-044`
- 対象 issue: [#44 `[Post-MVP][Extension][Sessions] AI Session title rename / suggest-only UI`](https://github.com/Memoria-ll/agent-asset-control-layer/issues/44)
- 状態: Post-MVP の VS Code Extension UI と UI 非依存 view model を定義する設計
- 主題: initial auto title の表示、Human rename、AI rename / suggest-only 結果の表示、human-pinned title 操作、任意 title history 表示
- 対象ファイル: `.claude/design/044-extension-session-title-ui.md` のみ

## 1. 目的

Session title を VS Code Workbench で確認・編集できるようにする。Extension は Core が
返す Session metadata と title operation の結果を UI へ投影し、Human の明示操作と AI
suggestion の状態を混同しない。

この設計で成立させることは次のとおりである。

1. Session 作成後の initial auto title の進行中・適用済み・利用不可を表示できる。
2. Human は AI title policy、pending suggestion、現在の pin state に関係なく rename 操作を開始できる。
3. `allowed` の AI rename 結果と `suggest-only` の AI suggestion を current title と別に表示できる。
4. Human は pending suggestion を accept または reject できる。
5. Human は title を pin / unpin でき、pinned title の保護状態を確認できる。
6. Core が返した pinned title を AI 操作の成功結果として表示しない。
7. title history が有効な場合だけ、title の構造化された採用履歴を任意に表示できる。
8. optimistic concurrency、refresh、Core unavailable、offline、response error を UI state として表現できる。
9. Chat transcript、prompt、assistant output、tool output、credential を title UI の metadata payload に混ぜない。
10. #20、#28、#33、#41、#42 が所有する semantics を Extension に複製せず、#44 の UI 責務を限定する。
11. Post-MVP の title 機能を MVP Session の作成・close・resume の成立条件にしない。

## 2. Issue 本文から確定する要求

### 2.1 Scope

GitHub の #44 本文から、UI が扱う Scope を次のように確定する。

| Issue の要求 | #44 の採用仕様 |
| --- | --- |
| initial auto title 表示 | Core metadata の initial title state と AI result を header / Session list に投影する |
| human rename UI | current Session の Human rename action と入力状態を提供する |
| AI rename 結果表示 | Core が適用した AI title と適用状態を current title として表示する |
| suggest-only 結果表示 | pending suggestion を current title と別の候補表示として扱う |
| human-pinned title 操作 | pin / unpin の状態表示と Human 操作を提供し、AI apply の結果を保護する |
| optional title history | history が利用可能な Session だけ read-only panel で表示できる |

### 2.2 完了条件を検証可能な形へ変換した要求

- `allowed` と `suggest-only` のどちらでも、Human rename の entry point が表示され、AI policy を理由に disabled にならない。
- Human rename は Core の write permission、Session existence、revision precondition を満たせば成功し、成功 response の canonical title を表示する。
- pending suggestion は current title を置換せず、accept / reject action の対象として表示する。
- unpinned Session の pending suggestion に対する accept は、Core の成功 response を受けた場合だけ current title を更新する。
- reject は title text、ownership、pin state を変更せず、suggestion の canonical lifecycle だけを更新する。
- pinned title への AI automatic apply または accept は、title mutation 成功として扱わない。
- pinned title を変更する場合は Human rename と明示的な pin / unpin intent を送る。
- stale revision、別 Session の response、遅延 response、response parse failure は current title を上書きしない。
- Core unavailable / offline 中の rename draft は保持し、durable save 完了前に保存済み title と表示しない。
- title history が disabled / unavailable の場合、history panel は空の成功状態と解釈せず利用不可状態を表示する。
- title UI の response、local cache、log、notification に transcript 本文、prompt、tool output、credential、secret を含めない。

### 2.3 UI における「常に実行できる」の意味

Human rename の「常に実行できる」は、AI policy、pending suggestion、current ownership、
pin state が入力開始を妨げないことを意味する。Core disconnected / offline の場合は
ネットワーク越しの durable commit が成立しないため、UI は draft を保持して再送可能な
状態を表示する。接続不能を成功として表示する local-only title commit は採用しない。

## 3. 調査した現行状態

### 3.1 README.md から確認できる製品境界

README は次の責務を示している。

- Core は source-of-truth semantics、Session、Execution、Snapshot、history、diagnostics を管理する。
- VS Code extension は Core に接続する everyday workbench であり、表示と入力の interface を提供する。
- Runtime adapter は Claude Code / Codex などの runtime と Core を接続する。
- transcript と reusable Asset semantics は異なる data として扱う。
- Human-approved evolution を保ち、AI が重要な変更を暗黙に確定しない。

したがって、current title、title ownership、pin、suggestion lifecycle、title history の
canonical value は Core の response を正とする。Extension は表示・入力・操作結果の投影を
担い、title policy の判定主体にならない。

### 3.2 AGENTS.md から適用する制約

本設計では、セッション開始時に読み込まれた `AGENTS.md` の次の制約を適用する。

- `shared/src/` の公開型が Core / Extension 間の契約面であり、network / IPC 境界を越える型は serialization schema を持つ。
- 境界 DTO は `z.strictObject` または strict な discriminated-union arm とし、型は schema から導出する。
- Extension は DTO / schema を再定義せず、`@aacl/shared` の named parser と plain export を利用する。
- contract version は `CONTRACT_VERSION` 一つで管理し、境界 DTO の追加・変更は契約変更として扱う。
- Core の error response は `CoreErrorDto` に従い、Extension は structured error を UI state へ写像する。
- Core の domain semantics は `core-domain`、transport と persistence の配線は `core`、VS Code API 依存部分は view glue に分ける。
- `core/src/index.ts` は副作用を持たない composition root であり、Extension UI の state を Core が保持しない。
- 仕様にない supported range、offline persistence、history retention、表示文言の値は `{TODO:confirm}` として残す。

### 3.3 現行 shared 実装

現在の `shared/src/sessions.ts` の `SessionDto` は概念上次の shape である。

```text
SessionDto {
  sessionId
  createdAt
  updatedAt
  projectId?
  agentExecutionIds
  snapshotIds
}
```

現行 `SessionDto` には title、ownership、pin、policy、suggestion、metadata revision、
history はない。`shared/src/index.ts` は `SessionDto` の型と parser、`CONTRACT_VERSION`、
JSON Schema registry を公開しているが、title 専用 DTO や parser はまだ存在しない。

title UI が依存する `SessionMetadataDto`、`SessionTitleSuggestionDto`、history projection、
rename / accept / reject request の exact field、identifier brand、enum、JSON Schema は
#28 と #46 の契約作業で追加する。#44 はその shape を Extension 内で再定義しない。

### 3.4 現行 Core 実装とテスト

現行 `core/src/http/router.ts` は `/health` の GET / HEAD だけを match する。`responses.ts`
は `VersionInfo` と `CoreErrorDto` の response を持ち、HTTP route は Session metadata
operation をまだ公開していない。`core/src/index.ts` は server を起動する composition root
であり、title repository、Session metadata service、title operation は未実装である。

現行の `core/tests/` は health、router、listener、response、settings を検証する。title の
Core API、revision conflict、suggestion lifecycle、history response の test は実装時に追加する。

### 3.5 現行 Extension 実装とテスト

現行 `vscode-extension/src/index.ts` は空の module である。`vscode-extension/package.json`
は `@aacl/shared` だけを依存に持ち、zod や VS Code API はまだ依存にない。現行 test は
`parseResolveRequest` と `CONTRACT_VERSION` を consumer として利用する shared contract
test だけであり、title view model、Core client、UI glue は未実装である。

この設計は実装ファイルを変更しない。実装時も、VS Code API に直接触れない title reducer / mapper
と、command・webview・notification に触れる view glue を分離する。

## 4. 関連設計書から引き継ぐ契約

### 4.1 #20 Core Session metadata と Execution linkage

- Session identity、lifecycle、Execution / Snapshot link、保存・取得の authority は Core にある。
- Session metadata は transcript 本文ではなく、構造化された Session 属性である。
- Session と Agent Execution は別 identity、別 lifecycle である。
- Session が閉じているか、存在するか、rename 可能かは Core response を正とする。
- metadata write は expected revision と conflict を扱い、Extension の last-write-wins を採用しない。

#44 は Session lifecycle を定義せず、Core が提供する Session metadata projection を表示する。

### 4.2 #28 Core session/title policy

#28 が所有する title semantics は次のとおりである。

- title state、ownership、pin、`allowed` / `suggest-only` policy を Core が決定する。
- Human rename は AI policy から独立した title mutation である。
- suggestion の生成、pending、approval、apply、reject、stale、expiry の意味を Core が持つ。
- pinned title に AI が自動 apply または承認 apply することはできない。
- title revision、metadata revision、operation key、idempotency、history persistence を Core が検証する。
- title API の logical operation と response projection は #12 / #46 の契約へ接続する。

#44 はこれらの rule を再計算せず、success / conflict / protected / stale の response を
view model へ投影する。

### 4.3 #33 Multi-session Chat UI

- Chat tab と Core `SessionId` の対応付け、Session list、selected tab、header の配置は #33 が所有する。
- #44 は header 内の title region、rename affordance、pin control、suggestion action、history panel の title surface を所有する。
- tab selection は title mutation ではない。
- Session 切替時は `SessionId` と view generation を確認し、旧 Session の response を新 Session に適用しない。
- transcript の保存・streaming・restore は title metadata と別の runtime data lifecycle である。

#33 の header は #44 の title view model を受け取り、独自の title state を保持しない。

### 4.4 #41 Extension Journal Input UI

- Journal は Observation を入力する UI であり、Chat transcript と別の保存先・lifecycle を持つ。
- Journal の current Session reference は title ownership、pin、suggestion approval を変更しない。
- Journal entry、Review、Proposal は title rename、suggestion accept / reject、history read を暗黙に起動しない。
- Journal panel が title を表示する場合は Core の read projection を利用し、title UI の mutation command を借用しない。

### 4.5 #42 Extension settings / status UI

- Core、Project、Runtime、Model、connection profile の状態表示と profile operation は #42 が所有する。
- #44 は `connected`、`disconnected`、`incompatible`、`reconnecting` を title operation の実行条件として参照する。
- Runtime / Model の選択値や表示名を title UI が固定文字列として持たない。
- #42 の settings panel で title policy を編集することは #44 の Scope ではない。Session title policy の意味は #28、設定 surface の配置は関連設計で確定する。

## 5. 適用範囲と Post-MVP 境界

### 5.1 #44 が所有するもの

1. Session list / Chat header における title display projection
2. Human rename の input、validation state、submit、success / error display
3. pin / unpin control の display と Human mutation request projection
4. pending AI suggestion の candidate display、accept / reject action
5. initial auto title の loading、pending、applied、unavailable display
6. optional title history panel の read-only display
7. title operation に関する UI state、request generation、stale response discard
8. Core connection state を反映した title operation の offline / reconnect behavior
9. `CoreErrorDto` を UI message state へ写像する pure module
10. #33 の selected Session と title view model の binding

### 5.2 #44 が所有しないもの

| 対象 | 所有 | #44 の扱い |
| --- | --- | --- |
| Session identity / lifecycle | #20 / Core | `SessionId` と Core response を利用する |
| title policy / ownership / pin invariant | #28 / Core domain | Core result を表示し、判定を再実装しない |
| DTO / parser / JSON Schema / version | #46 / shared | `@aacl/shared` の公開面を利用する |
| HTTP / MCP route、status、framing | #12 / Core | UI 非依存 client port の裏側へ委譲する |
| Session list、tab、selected state | #33 | title surface を selected tab に提供する |
| Journal input / Review | #41 / #16 | Session reference の read projection だけを利用する |
| Core / Project / Runtime / Model settings | #42 | connection と catalog 状態を参照する |
| Runtime prompt、transcript selection、model invocation | #11 / #38 | AI candidate の表示対象だけを受け取る |
| title candidate の生成 | Runtime adapter / #28 boundary | Extension 内で生成しない |
| history persistence、retention、audit | #28 / Core | read projection を表示する |

### 5.3 MVP との境界

#44 は Post-MVP である。MVP の #20 Session create / list / get / close / resume と
Execution linkage は、title generation、title rename UI、suggestion approval、title
history が未提供でも成立する。

MVP の既存 `SessionDto` に title fields を暗黙追加しない。Post-MVP title projection は
#28 / #46 が定める dedicated metadata response または contract version を更新した response
で提供する。Extension は title が存在しない MVP response を parse error や fake title に変換しない。

## 6. 用語と authority

| 用語 | UI 上の意味 | authoritative source |
| --- | --- | --- |
| current title | Core が現在採用している title | Session metadata response |
| initial auto title | Session 初期状態から生成される AI candidate / 適用結果 | #28 Core title operation |
| Human rename | Human が text と pin intent を指定する mutation | Core Session metadata API |
| AI rename | `allowed` policy で Core が candidate を自動適用した結果 | Core response |
| suggestion-only | candidate を表示し、Human accept まで current title を変更しない mode | Core title policy |
| title ownership | `system`、`human`、`ai` の採用主体 | Core title state |
| pinned title | Human が固定した current title | Core title state |
| pending suggestion | accept / reject が可能な candidate | Core suggestion projection |
| title history | title mutation の structured read projection | Core history API |
| title draft | UI で編集中の未送信入力 | Extension local view model |
| title operation | rename、pin / unpin、accept、reject の一回の request | Core API operation |
| transcript | user message、assistant output、stream、tool event の runtime data | Extension / Runtime |

Extension は authority の異なる値を一つの `title` string へ結合しない。current title、
draft、suggestion、history は view model 上でも別 field として持つ。

## 7. Title state の表示モデル

### 7.1 Core の title state を表示する規則

#28 の Core title state は概念上次の形を持つ。exact wire field は #46 で確定する。

```text
SessionTitleState =
  {
    state: "pending-initial"
    titleRevision
    updatedAt
  }
  |
  {
    state: "ready"
    text: NonEmptyString
    ownership: "system" | "human" | "ai"
    pinned: boolean
    titleRevision
    updatedAt
  }
```

Extension は `pending-initial` を empty string として表示せず、title がまだ未確定である
ことを示す専用 display state へ投影する。placeholder の文言、locale、表示時間、aria label
は `{TODO:confirm}` とする。

### 7.2 Current title の表示

`ready` の current title は次の属性を UI に投影する。

- title text
- ownership の表示状態
- pinned indicator
- title revision に対応する freshness
- Human rename draft の dirty state
- Core metadata revision を含む operation checkpoint

ownership の表示名、pin icon、tooltip、AI / Human の badge の有無は `{TODO:confirm}`。
Extension は `ownership: "human"` から `pinned: true` を推測しない。

### 7.3 Initial auto title

Initial auto title は次の display state を持つ。

| Core / operation state | UI 表示 |
| --- | --- |
| Session metadata が `pending-initial` | 生成中または未確定の title surface |
| candidate が pending | candidate panel。current title は変更しない |
| `allowed` で apply 成功 | current title として表示し、ownership を Core response どおり表示 |
| `suggest-only` で生成成功 | suggestion として表示し、accept / reject を提供 |
| generation unavailable | title state と AI result unavailable を分けて表示 |
| stale / protected | current title を維持し、候補の操作可能性を Core result どおり表示 |
| Core disconnected | last known title と freshness を分けて表示 |

Core が initial candidate を生成できない場合、Extension は last prompt の先頭や transcript
の一部から title を補完しない。未設定表示と generation failure は distinct state とする。

### 7.4 AI apply 済み title

`allowed` の AI apply が成功した場合は、Core の response に含まれる current title、ownership、
pin、title revision、metadata revision を一体で投影する。text だけを local state に反映し、
pin や ownership を前回値のまま残す部分更新は行わない。

### 7.5 Pinned title

`pinned: true` の current title は UI で固定状態として表示する。AI candidate が存在しても、
candidate text を header title に投影しない。Human は pinned title の text を rename でき、
pin を維持するか明示的に解除できる。

unpinned へ戻す操作は AI suggestion の accept と結合した暗黙操作にしない。Human が pin control
または rename dialog で明示的に unpin intent を確定し、Core の成功 response を受けてから次の
AI accept を行う。

## 8. Suggestion lifecycle の表示

### 8.1 Core lifecycle と UI lifecycle

Core の canonical suggestion status は #28 / #46 が所有する。概念上の遷移は次のとおりである。

```text
candidate generated
  -> pending
       ├─ accept -> approved -> applied
       ├─ reject -> rejected
       ├─ current revision changed -> stale
       └─ retention / validity expired -> expired
```

`approved` と `applied` が同一 atomic operation 内で返る場合、UI は accept button の local
loading を success と解釈せず、Core response の canonical status を表示する。

### 8.2 Suggestion card

Suggestion card は少なくとも次を表示できる。

- candidate text
- current Session の `sessionId` に対応すること
- suggestion status
- generatedAt / updatedAt
- current title との区別
- current pin state
- accept / reject action の availability
- stale、protected、unavailable、incompatible の structured state

source、runtime、model、source Execution reference、候補の最大長を表示するかは
`{TODO:confirm}`。表示する場合も Core の projection にある値だけを利用する。

### 8.3 Accept

Accept は suggestion ID と optimistic concurrency token を Core に渡す明示操作である。

- pending 以外の suggestion を成功として current title に適用しない。
- unpinned かつ current revision 条件を満たす場合だけ、Core success response を current title に反映する。
- current title が pinned の場合、UI は title mutation 成功を表示しない。
- pinned 状態からの適用には、Human の explicit unpin と別の accept operation を要求する。
- accept request の応答が stale / protected / conflict なら candidate を current title に置き換えない。
- accept retry は operation key と request fingerprint の規則に従い、二重適用を表示しない。

### 8.4 Reject

Reject は suggestion を採用しないことを Core に記録する Human operation である。

- reject 成功は current title、ownership、pin、title revision を変更しない。
- reject の response を受けるまで suggestion card は pending として表示する。
- rejected suggestion は current title list に表示しない。
- rejected status の保持期間、history panel への表示、再表示操作は `{TODO:confirm}`。
- reject の failure は suggestion を rejected と仮表示せず、retry または error state に留める。

却下された候補の理由、説明文、生成本文以外の transcript context は title UI の表示対象に
しない。status と Core の structured error を表示に利用する。

### 8.5 複数 suggestion

同一 Session に複数の pending suggestion が存在する場合の card の最大表示数、並び順、同時
accept の扱いは `{TODO:confirm}`。UI は候補を一つの current title に自動統合せず、suggestion
ID 単位の操作として Core に渡す。

## 9. Human rename と pin 操作

### 9.1 Rename dialog

Rename dialog は current title、編集 draft、pin control、save / cancel action、Core sync state
を持つ。current title が `pending-initial` でも rename entry point は利用できる。

dialog の logical fields は次のとおりである。

```text
RenameTitleDraft {
  sessionId
  text
  pinIntent: "preserve" | "pin" | "unpin"
  baseMetadataRevision
  baseTitleRevision
  dirty
}
```

exact field name、pin intent の wire mapping、text の trim、Unicode normalization、最大長、
空白だけの扱いは #28 / #46 で決め、未確定値は `{TODO:confirm}` とする。UI の local draft は
Core DTO の代替ではない。

### 9.2 Human rename の availability

Human rename control は次の状態でも表示する。

- AI policy が `allowed`
- AI policy が `suggest-only`
- current ownership が `system`、`human`、`ai`
- current title が pinned
- pending suggestion が存在する
- initial title が pending

Core disconnected / incompatible では save を durable success と表示せず、dialog draft を
保持して再接続状態を案内する。接続不能時にも input 開始を禁止するか、draft を再起動後まで
保持するかは `{TODO:confirm}`。

### 9.3 Pin / unpin

Pin operation は title text と ownership の authority を持つ Human rename operation の
pin intent として扱う。

| Human intent | Core が返す状態 |
| --- | --- |
| pin を維持して text を変更 | 新しい Human title、`pinned: true` |
| unpinned title を pin | Human title、`pinned: true` |
| pinned title の text を変更 | Human title、`pinned: true` |
| pinned title を unpin | Human title、`pinned: false` |
| pin intent 省略 | Core の規則に従って現在 pin を維持 |

Extension は `pinned` を local toggle だけで確定しない。Core の成功 response を受けた後に
current title と pin indicator を更新する。

### 9.4 Cancel と reset

cancel は local draft を破棄し、Core metadata を変更しない。reset は Core の現在 projection
を取得して draft を再構成する明示操作とする。dialog を閉じただけで rename request や pin
mutation を送らない。

## 10. Core Session metadata API の UI 契約

### 10.1 UI 非依存 client port

Extension の pure module は HTTP client や VS Code API を直接参照せず、次の logical port を利用する。

```text
SessionTitleClient {
  getSessionMetadata(input): Promise<Result<SessionMetadataProjection>>
  listTitleSuggestions(input): Promise<Result<TitleSuggestionProjection[]>>
  renameSessionTitle(input): Promise<Result<SessionMetadataProjection>>
  acceptTitleSuggestion(input): Promise<Result<TitleMutationResult>>
  rejectTitleSuggestion(input): Promise<Result<TitleSuggestionProjection>>
  getTitleHistory(input): Promise<Result<TitleHistoryProjection>>
}
```

method 名は UI port の候補であり、HTTP route、MCP tool name、Core application service nameを
固定するものではない。#12 の transport adapter は同じ protocol-neutral application API を
呼び、#46 の named parser を通過した値だけを port の success result とする。

### 10.2 Read projection

UI が必要とする logical read projection は次のとおりである。

```text
SessionMetadataProjection {
  sessionId
  title: SessionTitleState
  aiTitlePolicy
  metadataRevision
  titleHistoryAvailability
  pendingTitleSuggestionCount
  updatedAt
}
```

`SessionMetadataProjection` は current title の表示に必要な最小値を返す。transcript、prompt、
assistant output、tool output、Asset body、credential は含めない。project / runtime / model
の表示は #33 / #42 の既存 projection と接続し、title response に重複して保存しない。

### 10.3 Rename request

#28 の logical request に合わせ、UI client は概念上次を送る。

```text
RenameSessionTitleRequest {
  sessionId
  text
  pin?
  expectedMetadataRevision
  operationKey
}
```

`pin` 省略、`true`、`false` の意味は Core が解釈する。Extension は `pin` の省略を false
へ変換しない。operation key は opaque value として生成し、title text や UI label に使わない。

### 10.4 Accept / reject request

```text
AcceptTitleSuggestionRequest {
  sessionId
  suggestionId
  expectedMetadataRevision
  operationKey
}

RejectTitleSuggestionRequest {
  sessionId
  suggestionId
  expectedMetadataRevision
  operationKey
}
```

exact request field、suggestion revision の別 token、reject の metadata revision 更新有無は
`{TODO:confirm}`。UI は取得した suggestion の Session ID と selected Session ID が一致
することを送信前に確認し、Core の所属検証を省略しない。

### 10.5 API response の適用

mutation success response は mutation 後の canonical projection を含む。Extension は
response の title、ownership、pin、revisions、suggestion status を一緒に view model へ
適用する。request body の local draft を response text と部分的に merge しない。

success response が metadata projection を返さず operation result だけを返す形を採る場合、
UI は別の get operation を行って canonical projection を取得する。この response shape と
追加 GET の要否は `{TODO:confirm}`。

### 10.6 API route と status

HTTP method、path、MCP-facing operation、status code、retry header、request body framing は
#12 が所有する。#44 は `CoreErrorDto.code` を次の UI state に写像する。

| Core error code | UI state |
| --- | --- |
| `invalid_request` | input error または contract input error |
| `not_found` | Session missing / suggestion missing |
| `conflict` | revision conflict、protected、operation fingerprint conflict |
| `unavailable` | Core unavailable、offline、retryable |
| `incompatible_contract` | incompatible、operation disabled、reconnect guidance |
| `internal` | unexpected error、retry / diagnostics guidance |

protected title を独立の error code にするか `conflict` の detail code とするかは #28 / #46
で確定する。Extension は error message の文字列一致で判定しない。

## 11. Optimistic concurrency と idempotency

### 11.1 Revision の保持

title view model は次を別々に保持する。

- `metadataRevision`: Session metadata の conditional write token
- `titleRevision`: current title の revision
- `suggestionId`: candidate identity
- `requestGeneration`: UI で response を判定する sequence
- `operationKey`: 一つの mutation を識別する retry key

Extension は title revision と metadata revision を一つの numeric counter として再構成しない。
exact type と wire encoding は #28 / #46 の公開 contract を利用する。

### 11.2 Request creation

Mutation request を作る時点で、pure module は selected Session の `sessionId`、current
metadata revision、対象 suggestion ID、operation key、request generation を snapshot する。
dialog が開いている間に refresh が成功した場合、draft は dirty state を保ち、古い revision
で blind submit しない。

### 11.3 Conflict

Core が conflict を返した場合の UI 順序は次のとおりである。

1. local draft と current canonical projection を保持する。
2. conflict state を表示する。
3. remote の title、pin、ownership、revision を確認できる refresh action を提供する。
4. local draft を自動的に Core value へ上書きしない。
5. retry は新しい expected revision と新しい operation key で明示的に作る。

Conflict 解決 UI の比較表示、local を優先する再送 button、merge 表示の詳細は `{TODO:confirm}`。
Extension は last-write-wins を実装しない。

### 11.4 Retry

transport timeout、Core unavailable、process restart 後の不確実な response では、同一
operation key と同じ request fingerprint を使って Core の idempotency 規則に従う。異なる
payload で同じ operation key を再利用した場合は local success に変換せず conflict として扱う。

reject と accept の同時操作、rename と accept の順序、operation status query の有無は
`{TODO:confirm}`。UI は不確実な状態で二つの mutation を自動連続実行しない。

## 12. Refresh、Session 切替、stale response

### 12.1 Refresh の種類

title UI は次の refresh trigger を区別する。

| trigger | 説明 |
| --- | --- |
| initial load | selected Session の metadata / suggestion を最初に取得する |
| explicit refresh | Human が現在 Session の canonical state を再取得する |
| reconnect refresh | #32 が connected / compatible になった後に再取得する |
| mutation follow-up | mutation success 後に必要な read projection を取得する |
| Session switch | #33 の selected Session generation に応じて対象を切り替える |

### 12.2 Refresh の merge 規則

- clean な view model は最新の Core projection へ置換する。
- dirty な Human draft は canonical refresh で削除しない。
- pending mutation がある field は response identity を確認してから更新する。
- suggestion list は current title field へ merge せず、suggestion collection として更新する。
- history response は current title の success state を決める source にしない。
- Core disconnected 中の last known projection は `current` ではなく `stale` として表示する。

### 12.3 Session generation

selected Session が変わるたびに Extension の session generation を増やす。response を適用
するには、少なくとも次が一致しなければならない。

- current `SessionId`
- current session generation
- request generation
- operation identity
- response の対象 identity

一致しない response は破棄し、別 Session の title、suggestion、history、error に利用しない。

### 12.4 Concurrent Session update

別の Extension instance、Core UI、Runtime integration が同じ Session title を更新した場合、
Core の metadata revision が authority となる。Extension は自分の cached title を canonical
とみなさず、conflict または refresh result を表示する。

## 13. Offline、connection、error state

### 13.1 Connection state の入力

#32 / #42 の connection coordinator が提供する `connected`、`disconnected`、`incompatible`、
`reconnecting` を title coordinator の入力にする。#44 は connection handshake、contract
compatibility、profile persistence を実装しない。

### 13.2 Title UI state

```text
TitleSurfaceState
  ├─ unavailable
  ├─ loading
  ├─ ready
  ├─ editing
  ├─ submitting
  ├─ conflict
  ├─ stale
  ├─ offline-draft
  └─ error
```

この UI state は Core の title state と別である。例えば `offline-draft` は Core Session が
closed であることを意味せず、`conflict` は title text が不正であることだけを意味しない。

### 13.3 Offline の read

offline 中に local cache がある場合、last known current title、ownership、pin、suggestion
status を stale として表示できる。cache を Core の current state と表示しない。cache を保持
するか、保存範囲、暗号化、再起動後 retention、最大件数は `{TODO:confirm}`。

cache がない場合は Session ID など既知の参照だけを保持し、title text を推測しない。history
panel は cached history を current history と表示しない。

### 13.4 Offline の Human rename

Human が offline 中に rename input を開始した場合、draft を編集できる。save は `offline-draft`
または `retry-pending` として保持し、Core durable write が完了するまで current title の
canonical display を変更しない。offline local draft を Core Session metadata として扱うかは
`{TODO:confirm}`。

### 13.5 Offline の AI action

Extension は offline 中に AI candidate を生成しない。既存の pending suggestion の accept /
reject は Core の operation を送れないため、retryable state として保持する。再接続後の
operation lookup、同一 key retry、Human confirmation の順序は `{TODO:confirm}`。

### 13.6 Error display

Error state は current title display と別 region に表示する。Core error message は plain text
として escape し、HTML、Markdown、URI、stack trace として解釈しない。retryable かどうかは
Core error code と connection state の mapping を利用し、文字列の推測を行わない。

## 14. UI 非依存 view model

### 14.1 View model の論理形

```text
SessionTitleViewModel {
  sessionId
  selectionGeneration
  current:
    state: "pending-initial" | "ready" | "missing" | "stale"
    text?
    ownership?
    pinned?
    titleRevision?
    metadataRevision?
    freshness: "current" | "stale" | "unknown"
  draft:
    state: "clean" | "editing" | "submitting" | "offline-draft" | "conflict"
    text?
    pinIntent?
    baseMetadataRevision?
    error?
  suggestions:
    loading: boolean
    items: TitleSuggestionItemViewModel[]
    error?
  history:
    state: "unknown" | "available" | "disabled" | "loading" | "ready" | "unavailable" | "error"
    entries: TitleHistoryItemViewModel[]
    error?
  connection:
    "connected" | "disconnected" | "incompatible" | "reconnecting"
  lastError?
}
```

この shape は UI 内部の候補であり、公開 DTO ではない。view model は title text、suggestion
text、history entry を区別し、Core の response shape をそのまま component の state に公開しない。

### 14.2 Suggestion item

```text
TitleSuggestionItemViewModel {
  suggestionId
  sessionId
  text
  status: "pending" | "approved" | "applied" | "rejected" | "stale" | "expired"
  actionState: "available" | "accepting" | "rejecting" | "protected" | "disabled" | "error"
  baseTitleRevision
  createdAt
  appliedTitleRevision?
  error?
}
```

`actionState` は request 中の UI state であり、Core suggestion `status` の代替ではない。
Core が `protected` を canonical status に含めない場合は CoreErrorDto の detail を local
action state に写像する。UI が status enum を独自追加して shared contract と競合させない。

### 14.3 Action と reducer

pure module の action は概念上次のとおりである。

```text
titleLoadStarted
titleLoadSucceeded
titleLoadFailed
renameStarted
renameTextChanged
renamePinChanged
renameSubmitted
renameSucceeded
renameFailed
suggestionsLoaded
suggestionAcceptStarted
suggestionAcceptSucceeded
suggestionAcceptFailed
suggestionRejectStarted
suggestionRejectSucceeded
suggestionRejectFailed
historyLoadStarted
historyLoaded
historyFailed
connectionChanged
sessionSelected
```

reducer は action の target Session ID、selection generation、operation identity を確認する。
Core title rule、pin protection、policy、revision comparison の semantic decision は reducer
に置かない。

### 14.4 Mapper

Core response から view model への mapper は次を保証する。

- `pending-initial` と `ready` を別 display state にする。
- current title と pending suggestion を異なる field に投影する。
- ownership と pinned を response どおり保持する。
- unknown / invalid response は success projection を返さず response error へ写像する。
- stale response は reducer に渡す前、または reducer の identity guard で破棄する。
- history disabled / unavailable を空 history と同じ表示にしない。

### 14.5 View model の不変条件

1. `current.state = "ready"` のときだけ current text を表示する。
2. suggestion の text は current text の代用にならない。
3. `current.pinned = true` のとき、AI success action は current text を変更しない。
4. dirty draft があるとき、refresh response は draft text を自動消去しない。
5. selected Session の変更後、旧 generation の operation result を current view model に適用しない。
6. Core error を受けた mutation は canonical success state へ遷移しない。
7. `offline-draft` は Core durable write の成功を表さない。
8. title history の entry は current title の authority にならない。

## 15. View glue と画面構成

### 15.1 Title surface

#33 の Chat header / Session list に提供する title surface は次の論理領域を持つ。

```text
Session title surface
  ├─ current title + ownership + pin indicator
  ├─ title freshness / sync status
  ├─ rename action
  ├─ pin / unpin action
  ├─ initial title progress or unavailable state
  ├─ pending suggestion summary
  └─ optional history entry point
```

Session list では title text と sync / pin indicator を compact projection として表示し、
candidate text や transcript preview を title として表示しない。詳細な accept / reject は
selected Session の header または title panel に配置する。最終 layout、keyboard shortcut、
context menu、accessible name、表示件数は `{TODO:confirm}`。

### 15.2 Human rename interaction

1. #33 が selected Session の `SessionId` と title view model を渡す。
2. 利用者が rename action を選択する。
3. view glue が pure reducer に `renameStarted` を dispatch する。
4. 利用者が text と pin intent を入力する。
5. local validation が成功したら Core client port に request を渡す。
6. response を parser で検証し、identity が一致すれば reducer に成功 action を渡す。
7. component は canonical current title と canonical pin indicator を表示する。

### 15.3 Suggestion interaction

1. suggestion response を受け、current title と別の card に投影する。
2. pending candidate だけを accept / reject action の対象にする。
3. accept / reject 中は対象 card を submitting とし、同じ operation の二重送信を防ぐ。
4. success response が current Session と一致した場合だけ card status と current title を更新する。
5. protected / stale / conflict では current title を維持し、card に structured state を表示する。

### 15.4 Pinned interaction

1. pinned indicator を current title の属性として表示する。
2. AI candidate の存在を pinned title の変更として表示しない。
3. Human が rename を確定するとき、pin intent を明示的に保持・設定・解除できる。
4. unpin success response を受けるまで AI accept の automatic chaining を開始しない。
5. Core が protected result を返した場合、UI は AI title apply success を表示しない。

### 15.5 History panel

history panel は read-only であり、entry の text、ownership、pin、採用時刻、revision など
Core が返す structured fields を表示する。history entry から current title を直接復元・変更
する operation は #44 の Scope に含めない。restore / rollback、history retention、page size、
sort order、entry の display fields は `{TODO:confirm}`。

### 15.6 VS Code API 境界

VS Code command、webview、tree view、notification、quick pick、input box は view glue に
閉じる。pure module は DOM、VS Code API、HTTP、filesystem、Runtime SDK を import しない。
component が `SessionTitleState` の rule を直接判定せず、mapper と reducer の result を表示する。

## 16. Transcript と runtime data の境界

### 16.1 Title UI が受け取る data

title UI が受け取るのは、Core metadata response、suggestion projection、history projection、
CoreErrorDto、connection state、selected Session identity である。

### 16.2 Title UI に渡さない data

次の値は title API request、title history response、title view model、log、notification に
含めない。

- user prompt の全文
- assistant output の全文
- streaming chunk
- tool call / tool output
- Asset body、protected file body
- provider credential、token、secret
- Runtime の raw response、prompt template
- transcript の全文またはその自動抜粋

AI candidate の生成に transcript context が必要な場合、その選択と provider への送信は #11 /
#38 の Runtime adapter が所有する。Extension は candidate text と Core が返す provenance
reference だけを表示する。transcript の一部を title placeholder に再利用しない。

### 16.3 Session ID と transcript reference

`SessionId` は Core metadata API の対象 identity であり、transcript file name、native runtime
session ID、webview state key を兼ねない。#33 の tab と transcript store は各自の reference
mapping を持ち、title UI は transcript store を直接呼ばない。

## 17. Security と privacy

### 17.1 Access control

Human rename、pin / unpin、accept、reject は Core の authorization boundary を通る。Extension
は button を表示しても permission を独自に付与しない。permission denied は CoreErrorDto の
structured result として表示し、成功 title に投影しない。

Session list に含まれる title、suggestion、history の閲覧権限、team scope、remote Core の
access policy は #21 / #23 / #25 と Core authorization の裁定に従う。#44 は role や user ID の
permission rule を複製しない。

### 17.2 Untrusted candidate display

AI candidate text、history text、Core error message は untrusted plain text として扱う。
Extension は HTML、Markdown、command、URI、VS Code link として自動解釈せず、表示 context に
応じた escaping を行う。title text から command、file path、設定値を実行しない。

候補 text の最大長、制御文字、改行、Unicode normalization、禁止文字は #28 / #46 の contract
validation を正とし、Extension は同じ rule を別実装しない。入力時の早期 validation は UX の
ために行えるが、Core validation の代替にはならない。

### 17.3 Secret と transcript の保護

title operation の request、response、history、audit projection、error notification に
secret actual value、credential、prompt、transcript を含めない。Core が返した title text
自体に secret が含まれる場合の scanning、保存可否、redaction policy は `{TODO:confirm}`。

### 17.4 Cache と local draft

offline cache / draft を有効にする場合、保存場所、暗号化、workspace isolation、multi-window
共有、clear 操作、保持期間は `{TODO:confirm}`。未確定の local value を Core-backed title
として表示しない。Extension の local state は Core の source of truth にならない。

## 18. State transition と処理フロー

### 18.1 Initial load

```text
selected Session
  -> load metadata / suggestions
      ├─ success -> map current title + suggestion
      ├─ not_found -> missing Session
      ├─ unavailable -> stale / unavailable
      ├─ incompatible -> incompatible
      └─ parse failure -> contract error
```

### 18.2 Initial auto title

```text
Session create / first turn
  -> Core title state pending-initial
  -> Runtime adapter candidate result
      ├─ allowed + apply success -> current title ready
      ├─ suggest-only -> pending suggestion
      ├─ pinned / stale -> current title unchanged
      └─ unavailable / error -> title state + generation error
```

Extension は candidate generation trigger、prompt assembly、policy decision を実行せず、
Core / Runtime の result を表示する。

### 18.3 Human rename

```text
ready or pending-initial
  -> editing
  -> local validation
      ├─ invalid -> editing + input error
      └─ valid -> submitting
          ├─ success -> canonical current title
          ├─ conflict -> conflict + draft retained
          ├─ unavailable -> offline-draft / retryable
          ├─ not_found -> missing Session
          └─ response error -> error + draft retained
```

### 18.4 Accept suggestion

```text
pending suggestion
  -> accepting
      ├─ applied -> current title + suggestion applied
      ├─ protected -> current title unchanged
      ├─ stale -> current title unchanged + suggestion stale
      ├─ conflict -> current title unchanged + refresh required
      ├─ unavailable -> retryable
      └─ error -> suggestion action error
```

### 18.5 Reject suggestion

```text
pending suggestion
  -> rejecting
      ├─ rejected -> current title unchanged + suggestion rejected
      ├─ stale / not_found -> canonical response display
      ├─ conflict -> refresh required
      ├─ unavailable -> retryable
      └─ error -> pending / error
```

### 18.6 Pin / unpin

```text
current title
  -> Human rename with pin intent
      ├─ pin success -> ready + pinned
      ├─ unpin success -> ready + unpinned
      ├─ conflict -> draft retained
      ├─ unavailable -> offline-draft
      └─ error -> current canonical value retained
```

### 18.7 Session switch

1. #33 が selected Session を更新し、selection generation を増やす。
2. title coordinator が現在の request を target identity 付きで無効化する。
3. 新しい Session の metadata、suggestion、必要なら history を取得する。
4. 旧 Session の response は parse できても discard する。
5. new selected Session の current title と candidate を別々に表示する。

## 19. Core / shared / Extension の責務分担

### 19.1 `shared`

`shared` は次を公開する。

- `SessionMetadataDto` 相当の title metadata 型
- title state、ownership、policy、suggestion status、history availability の契約語彙
- title / suggestion / history の request / response DTO
- identifier、revision、operation key の input / output type
- named parser、plain value array、JSON Schema、contract version
- CoreErrorDto を含む boundary validation

`shared` は title policy decision、candidate generation、repository、transcript、VS Code API を所有しない。

### 19.2 `core-domain`

`core-domain` は次を所有する。

- Human rename の policy-independent semantics
- pin / unpin invariant
- AI apply の policy、pin、revision、permission precondition
- suggestion accept / reject lifecycle
- stale、protected、conflict、idempotency の domain result
- title history / audit entry の domain shape

`core-domain` は zod、HTTP、filesystem、Runtime SDK、VS Code API、secret store を import しない。

### 19.3 `core`

`core` は次を所有する。

- Session repository と title repository の wiring
- Session existence、authorization、revision、operation record の接続
- title metadata application service
- Runtime adapter からの candidate submission boundary
- durable transaction と history read policy
- HTTP / MCP-facing response、status、CoreErrorDto mapping

Core は Extension の selected tab、dialog、draft、view model を管理しない。

### 19.4 `vscode-extension` pure module

pure module は次を所有する。

- shared parser を通った response の view model projection
- title draft、suggestion action、history loading の reducer
- Session generation、operation identity、stale response guard
- connection / CoreErrorDto の UI state mapping
- current title、suggestion、history、draft の分離

pure module は title policy、pin protection、revision comparison、Core repository を複製しない。

### 19.5 `vscode-extension` view glue

view glue は次を所有する。

- #33 header / list への title surface 配置
- input box、quick pick、button、menu、webview、notification の接続
- keyboard focus、accessibility、loading affordance、error notification
- #32 / #42 の connection status 表示との接続
- #41 Journal panel へ read-only title projection を渡す配線

view glue は Core DTO を独自に parse する schema や title rule を持たない。

## 20. Testable seam と検証シナリオ

### 20.1 Shared contract tests

実装時に `shared/tests/` へ次を追加する。

- `SessionMetadataDto`、title state、suggestion、history の strict object を parse できる。
- `pending-initial` と `ready` の必須 / 禁止 fields が JSON Schema と parser で一致する。
- `allowed`、`suggest-only`、ownership、suggestion status の閉じた値集合を検証する。
- 空 title、空白だけの title、未知 key、不正 revision、Session ID mismatch の入力を reject する。
- title metadata、suggestion、history の JSON round-trip が成立する。
- `contractJsonSchemas()` に title DTO が登録される。
- Extension が zod schema value を直接 import せず、named parser を利用できる。

### 20.2 Extension pure logic tests

実装時に `vscode-extension/tests/` へ次を追加する。

- `pending-initial` を専用 placeholder state に投影し、empty title を作らない。
- current title と pending suggestion を別 field に投影する。
- `allowed` / `suggest-only` のどちらでも Human rename action を disabled にしない。
- system / human / ai ownership と pinned flag を Core response どおりに表示する。
- pending suggestion の accept success の後だけ current title を置き換える。
- reject success が current title、ownership、pin、title revision を変えない。
- pinned title への protected response が title mutation success にならない。
- explicit unpin success の前に AI accept を自動送信しない。
- stale、conflict、unavailable、incompatible、not_found、internal を対応する view state へ写像する。
- selected Session generation が変わった後の旧 response を破棄する。
- dirty rename draft を refresh response が上書きしない。
- offline draft を canonical saved title として表示しない。
- retry の同一 operation identity と異なる operation identity を区別する。
- history disabled / unavailable / empty success を別 state に投影する。

### 20.3 Core API integration tests

Core 実装時に次を検証する。

- Session metadata read が current title、ownership、pin、revision を返す。
- Human rename が両 AI policy で成功する。
- pinned title の Human rename が pin intent どおりに成功する。
- `allowed` + unpinned + current revision の candidate が apply される。
- `suggest-only` の candidate が pending になり、current title が維持される。
- pending suggestion の accept が成功した場合だけ title、ownership、revision が更新される。
- reject が suggestion lifecycle だけを更新し、title metadata を変更しない。
- pinned title への automatic apply / accept が protected / conflict result になる。
- stale metadata revision、stale suggestion、異なる Session の suggestion を success にしない。
- 同じ operation key の retry が一つの mutation に収束する。
- 異なる fingerprint の operation key 再利用を conflict にする。
- title、suggestion、history、audit の durable write atomicity を保つ。
- history disabled で current metadata を取得でき、history text を返さない。

### 20.4 Extension / #33 integration tests

- 複数 tab が同じ `SessionId` の canonical title projection を表示する。
- Session switch 中の旧 title response が新しい selected Session に混ざらない。
- Session list の compact title と selected header の detail title が同じ Core projection を参照する。
- title rename の成功で #33 の tab label / header が更新される。
- pending suggestion が tab title を直接置換しない。
- pinned indicator と ownership badge が response と一致する。
- tab detach / close が title operation の Core mutation を暗黙に発行しない。

### 20.5 Extension / #41 / #42 integration tests

- Journal panel が read-only Session title projection を表示できる。
- Journal create / Review が title rename、pin、accept、reject、history load を起動しない。
- #42 の disconnected / reconnecting / incompatible が title operation state に反映される。
- settings refresh が title draft、pending suggestion、selected Session を別 Session に混ぜない。

### 20.6 Transcript / security tests

- title request に prompt、assistant output、tool output、transcript body が含まれない。
- title response、history、CoreErrorDto、UI notification に credential / secret / raw provider response が含まれない。
- candidate と error message が markup / command / URI として実行されない。
- Session ID の取り違え、suggestion 所属不一致、権限拒否を成功表示しない。

### 20.7 Canonical gate

実装時は repository root の canonical command を使用する。

```text
bash ~/.claude/scripts/run-gate.sh
```

typecheck、test、node-resolution、workspace package 検査を通過することを完了条件とする。
文書作成のみの本作業でも、完了時にファイルの行末・末尾空白を確認する。

## 21. 実装反映順序

1. #46 と #28 で title metadata、suggestion、history、revision、error detail の contract を確定する。
2. `shared` に DTO、parser、plain value array、JSON Schema、contract version の変更を追加する。
3. #20 の Session repository と #28 の title domain service を Core に接続する。
4. #12 の Core API adapter に read / rename / accept / reject / history operation を追加する。
5. Extension の Core client port と pure view model / reducer / mapper を追加する。
6. #33 の header / list / selected Session lifecycle に title surface を接続する。
7. #42 の connection state と #41 の read-only Session reference を接続する。
8. optimistic concurrency、offline draft、stale response、security の test を追加する。
9. canonical gate と行末・末尾空白検査を実行する。

exact package path、route path、VS Code UI framework、local persistence、表示文言は各依存 issue の
裁定後に実装する。

## 22. 完了条件

### 22.1 Issue #44 の機能条件

- [ ] Session list / header に initial auto title の state が表示される。
- [ ] `allowed` でも `suggest-only` でも Human rename を開始できる。
- [ ] Human rename success 後に Core canonical title、ownership、pin、revision が表示される。
- [ ] pending AI suggestion と current title が別に表示される。
- [ ] unpinned pending suggestion を accept でき、success response 後だけ current title が更新される。
- [ ] pending suggestion を reject でき、current title が変わらない。
- [ ] pinned title を表示できる。
- [ ] Human が pinned title を rename でき、pin 維持 / unpin を明示できる。
- [ ] pinned title が AI automatic apply / accept で上書きされない。
- [ ] title history が有効なとき read-only 表示できる。
- [ ] title history が disabled / unavailable のとき状態を区別して表示できる。

### 22.2 同期・障害条件

- [ ] expected revision と operation key を使って rename / accept / reject を送る。
- [ ] conflict、stale、protected、unavailable、incompatible、not_found、internal を成功 title と区別する。
- [ ] refresh が dirty draft を上書きしない。
- [ ] Session 切替後に旧 response が現 selected Session へ混ざらない。
- [ ] offline draft は durable saved title と表示されない。
- [ ] reconnect 後に title state を refresh できる。

### 22.3 境界・品質条件

- [ ] Extension が `@aacl/shared` の title contract と named parser を利用し、DTO / schema を再定義しない。
- [ ] title policy、pin invariant、suggestion decision が Extension の pure module に存在しない。
- [ ] transcript、prompt、assistant output、tool output、credential、secret が title payload / UI log に含まれない。
- [ ] #20 / #28 / #33 / #41 / #42 の責務境界が integration test で確認できる。
- [ ] MVP Session lifecycle が title UI の提供有無に依存しない。
- [ ] canonical gate が pass する。

## 23. 未確定事項（`{TODO:confirm}`）

1. `SessionMetadataDto` を既存 `SessionDto` から分離する exact wire shape。
2. `SessionTitleState` の discriminator、field name、identifier brand。
3. title revision、metadata revision、suggestion revision の型と wire encoding。
4. `allowed` / `suggest-only` policy の exact enum name。
5. `SessionTitleSuggestionDto` の source、provenance、status、期限 field。
6. accept / reject の exact request / response DTO と parser 名。
7. protected title の error code と `CoreErrorDto.details` の detail code。
8. mutation success response が canonical metadata を inline するか、別 read を必要とするか。
9. title history の availability response、entry fields、pagination、sort order。
10. rejected / stale / expired suggestion を history panel に表示するか。
11. history retention、audit retention、title text の保存期間。
12. title text の最大長、改行、制御文字、Unicode normalization。
13. candidate text の secret scanning、redaction、禁止内容の扱い。
14. initial auto title の trigger、generation unavailable の display state。
15. placeholder、badge、pin icon、button、error、accessibility の表示文言。
16. Session list と Chat header の title action 配置。
17. keyboard shortcut、focus order、confirmation dialog の有無。
18. 複数 pending suggestion の最大表示数、並び順、同時操作規則。
19. disconnected / incompatible 中の draft retention と再起動後 persistence。
20. offline cache の保存場所、暗号化、workspace isolation、clear、retention。
21. reconnect 後の pending operation lookup、retry、Human confirmation の順序。
22. conflict 解決 UI の local draft / remote title 比較表示。
23. Session close 中、closed Session、resume 中の title action availability。
24. title history の restore / rollback を別 issue とするか。
25. #42 settings UI で Session title policy を表示・編集するか。
26. #41 Journal panel が title history を read-only 表示するか。
27. #33 tab label の title freshness / pending badge の表示規則。
28. title UI が `sourceExecutionId` や runtime / model display を表示するか。
29. title response の local cache と webview / extension host 間の共有範囲。
30. `CONTRACT_VERSION` の bump 値と既存 `SessionDto` consumer の移行手順。

## 24. 関連 issue と設計書

| issue / 設計 | #44 との関係 |
| --- | --- |
| #20 `Session metadata と Agent Execution linkage` | Session identity、lifecycle、metadata persistence、Execution link を所有する |
| #28 `Session title rename / suggest-only` | title policy、ownership、pin、suggestion lifecycle、Core metadata API semantics を所有する |
| #33 `Multi-session Chat UI` | Chat tab、Session list、selected Session、header の配置と切替を所有する |
| #41 `Extension Journal Input UI` | Journal input、Observation、Review、current Session reference を所有する |
| #42 `Extension settings / status UI` | Core / Project / Runtime / Model と connection profile の status surface を所有する |
| #12 `localhost Core API と MCP-facing interface` | HTTP / MCP transport、route、status、framing、application adapter を所有する |
| #31 `VS Code Extension bundling / manifest` | Extension package、bundle、manifest、実行入口を所有する |
| #32 `Extension-Core connection state` | connected、disconnected、reconnecting、incompatible の state を所有する |
| #38 `Claude / Codex runtime bridge` | Runtime transcript、candidate generation、provider-specific adapter boundary を所有する |
| #46 `Shared contract` | title DTO、parser、JSON Schema、contract version を公開契約として確定する |

この文書が定義するのは #44 の Extension title UI と UI 非依存配線である。Core semantics、
transport、runtime、Session lifecycle、Journal、settings の実装・契約は各所有 issue の設計を正とする。
