**AACL 総合改善インプット — 目標とする使い方、実操作、README、要求の照合**

対応後の実装と検証範囲は[実装確認表](improvement-implementation-2026-09-09.md)、現在の操作方法は[運用ガイド](mcp-operations.md)に記載しています。以下は評価当時の記録と改善要求です。

2026年9月9日。対象はコミット `c194fbc` と開発要件v13です。

**方針更新:** この資料の作成後、ユーザーから「既存環境からの自動導入、AIによる初回整理、MCPを中心とする日常操作、上位から下位への資産の紐づけ」という方向が示されました。[具体化した設計案](//wsl.localhost/Ubuntu/home/owner/dev/aacl/docs/mcp-first-onboarding-and-asset-relations.md)を追加しています。以下の実操作の記録は維持し、改善後の操作は、UIを必須の経由点にしない方針で読み替えます。Workflowを開発工程の最上位とする位置づけは維持します。

**AACLの目標は、「自分で選んだ開発方法を、短い指示で繰り返し使い、その結果を根拠に改善できること」に置くのがよいと考えます。** 要求ファイルはこの方向を明確にしています。一方、READMEは資産管理とContextの配布を強く打ち出しています。実操作では、設定、AIへの引き継ぎ、実行の確認、改善提案の間を利用者が手作業でつなぐ場面がありました。中心的な改善対象は、この目標と一連の操作との距離です。

本資料では、初期版か将来版かを評価理由にしません。目標とする運用に必要か、どのような体験を実現すべきかで判断します。要求の明記がない改善案も、利用者の目的に必要であれば提案します。ただし、確認済みの挙動、文書間の不整合、設計上の提案は区別します。

根拠は、[要求の目的と操作例](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:60)、[READMEの導入](//wsl.localhost/Ubuntu/home/owner/dev/aacl/README.md:7)、[初回利用・運用試験の全記録](C:/Users/owner/.codex/visualizations/2026/09/09/01a08537-4015-7752-a6cb-2e72b3650c37/aacl-first-use-report.md)です。

**評価の前提と、前回の見解の修正**

実操作はREADMEだけを事前知識として、空の環境から行いました。人間の操作はブラウザーUI、AIの操作はMCPというAI向けのツール接続経由に限定しました。その後、要求ファイルを全文読み、照合しました。実装コードから操作方法を補完していません。

24のユースケースを試し、公開MCPツール19種類すべてを使用しました。保存した呼び出しは62回分です。5件の実行、20件のAsset、2件のJournal、1件の承認済みReviewが対象です。スターター後半の成果物は状態遷移を試すための模擬記録です。複数モデルが実際に実装・テスト・PR作成を分担する一連の開発は検証していません。

本資料では、Workflowを「再利用する作業手順と工程の定義」、Roleを「担当する責務」、Assetを「Workflow・Skill・Ruleなどの管理対象」、Contextを「AIへ渡す作業情報と指示」と呼びます。Snapshotは「ある時点で解決・保存したContext」、Journalは「実行から得た観測」、Reviewは「その観測などに基づく変更案の検討」です。Coreは正本と実行状態を管理するサービス、RuntimeはAIを実際に動かす環境です。

前回のREADME評には、修正すべき点があります。

| 前回の見解 | 要求を踏まえた判断 |
|---|---|
| 既存Skillの利用を中心に据え、Workflowを後に回す案 | 取り下げます。要求はWorkflowを利用体験と改善の中心にしています。最初のWorkflowを作りやすくし、短い指示で使えるようにする方向が適切です。 |
| 新規Asset作成にもJournalを経由するのは遠回りです | 維持します。実行からの改善と、ユーザーが新しい方法を定義する行為には別の入口が必要です。ユーザーの決定権と承認は維持できます。 |
| Coreと実行環境の境界がわかりにくいです | 責務の分離自体は要求の意図に合っています。改善対象は、接続、引き継ぎ、実行状況の確認を利用者がつなぐ負担です。 |
| 完了と差し戻しの扱いが不自然です | 維持します。要求は再試行・拒否・差し戻しと完了状態を求めています。終了判定を「次の工程がないこと」に結び付ける必要はありません。 |
| 指示文と強制できる制約の境界が曖昧です | 要求には、機械的に強制できる安全策は指示文だけに依存しないという原則があります。必要なのは、各Runtimeで実際に何を強制できるかという運用上の契約です。 |

根拠: [Workflowを中心にする設計思想](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:120)、[安全策の配置と強制](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:228)、[Workflowの表現要件](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:506)。

**目標とする利用体験**

次の表は、要求を踏まえて本資料が提案する到達点です。「人間のUI」と「AIのMCP」は、同じ作業と状態を扱う二つの入口として設計します。通常操作は会話とMCPで完結させます。UIの列は、必要なときに利用できる確認・手動操作を示します。人間による判断が必要な場合も、会話で内容を確認して承認できる経路を用意します。

| やりたいこと | 人間がUIでできること | AIがMCPでできること | 到達点 |
|---|---|---|---|
| 自分の開発方法を用意する | 目的を記入し、工程・担当・モデル・変更範囲を確認して保存します。 | 依頼に基づき、既存資産を調べてWorkflow候補を提案します。 | 実行済みのJournalがなくても、最初のWorkflowを作れます。 |
| いつもの作業を始める | Workflowと今回の対象を選びます。 | 明示されたWorkflowと追加指示から、設定済みの条件で開始します。 | 保存済みの方針を毎回再入力せず、不足だけを開始前に解消できます。 |
| レビューで修正が必要になる | 指摘と根拠を確認し、差し戻せます。 | 許可された工程へ戻り、必要な成果物を再取得できます。 | 修正、再レビュー、完了まで進められます。 |
| 人間とAIが交互に関わる | 状態と根拠を閲覧し、必要な判断だけを行います。 | 同じ実行の最新状態を取得し、担当作業を継続します。 | 閲覧だけでは実行状態が変わらず、更新の競合は明示されます。 |
| 自分の手順を改善する | 実行結果から関連する観測と変更案を確認し、承認します。 | ユーザーの依頼で観測を集め、変更理由と適用先を提案します。 | 変更の承認後、次の実行で改善効果を確かめられます。 |
| 過去の判断を調べる | 完了根拠、担当、適用設定、変更理由を同じ実行からたどれます。 | 必要な実行や改訂だけを取得できます。 | 人間もAIも、何を根拠に進めたかを再確認できます。 |

この体験を支える原則として、**ユーザーが決めるべき方針は明示し、決めた方針の再適用は自動化する**ことを推奨します。モデルの候補を取得すること、保存済みの割り当てを再利用すること、適用条件を検証することは、ユーザーの開発方針を勝手に推測することとは区別できます。

**改善項目**

以下の「高」は、中心的な運用を妨げる、または適用結果・完了判断への信頼に関わる項目です。「中」は、反復利用の手間や移行・調査の負担を大きくする項目です。実装時期の区分ではありません。各項目の確認条件は、今後の検証案であり、今回実施済みの試験ではありません。

**I-01｜READMEの中心を、資産管理から「自分の開発方法を使う体験」へ移します。優先度: 高。文書間の重点の乖離です。**

要求では、Workflowを選び、今回固有の指示だけを渡すことが中心です。READMEは、散在する知識を一元管理し、必要なContextを配る説明から始まります。そのため、READMEだけを読むと、まずSkill・Ruleを登録する管理ツールとして理解しやすくなります。私自身も、この理解からSkill中心への変更を提案してしまいました。

READMEの冒頭には、何を短縮し、何を繰り返せるかを置くべきです。その後に、初回の手順作成、日々の実行、観測に基づく改善を示します。AssetやResolverの説明は、この使い方を支える仕組みとして続けます。Resolverは、明示した条件から適用する資産を決める機能です。

**確認条件:** READMEだけを読んだ利用者が、「最初に自分のWorkflowを用意する」「普段はWorkflowと対象を指定する」「困った点を記録し、承認した改善を次回に使う」の三つを説明でき、実際の入口を見つけられます。

根拠: [要求の目的](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:60)、[READMEの基本概念](//wsl.localhost/Ubuntu/home/owner/dev/aacl/README.md:40)、[READMEの初回手順](//wsl.localhost/Ubuntu/home/owner/dev/aacl/README.md:351)。

**I-02｜実行前の手順作成を、Journalからの改善と分けます。優先度: 高。要求の入口不足と、実際の操作負担です。**

READMEのAIによるAsset作成は、セッション開始、引き継ぎ、Journal記録、人間によるReview開始、AIによる提案、承認という手順です。新規利用者の「こういう進め方をWorkflowにしてほしい」にも、実行後の観測を記録する仕組みを通ります。要求は初期作成をユーザー所有としていますが、依頼に基づく下書き支援の流れを十分に定めていません。

「新しく手順を作る」「既存の手順を依頼に基づいて変える」「実行の観測から改善する」を別の開始理由として扱うことを提案します。提案、差分表示、承認、変更履歴の仕組みは共用できます。新規作成の根拠はユーザーの依頼として保存し、実行観測を装うJournalは不要にします。

Workflow候補には、既存Roleの再利用、必要なSkill・Rule、モデル割り当ての不足をまとめて示します。会話で確認・承認でき、必要ならUIでも詳細を確認できるようにします。

**確認条件:** 空の環境から「仕様レビューとコードレビューを含む手順を作りたい」と依頼すると、実行開始やJournal作成をせずに提案へ進めます。保存前に工程と権限を確認でき、承認後にそのWorkflowを明示して起動できます。

根拠: [方針と初期作成の所有者](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:139)、[Coreの正本と作成者の区別](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:731)、[Journalの目的](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1399)、[現在のAI作成手順](//wsl.localhost/Ubuntu/home/owner/dev/aacl/README.md:392)。

**I-03｜AIが対象と設定を調べ、依頼された操作を完結できるMCPを用意します。優先度: 高。提供される操作範囲の不足です。**

今回の公開ツールとリソースには、Projectやモデルの一覧・登録、Project固有の例外設定の編集、Journal全体の一覧、Review開始を扱う入口がありませんでした。Project名ではセッション開始に失敗し、内部IDでは成功しました。AIが次の操作に必要なIDや設定を調べるために、人間のUI操作へ戻る場面があります。

MCPには、登録済み対象の検索、不足設定の診断、明示的な登録依頼、変更案の作成、ユーザー依頼によるReview開始が必要です。AIに最終承認権限を与える必要はありません。検索結果にはID、表示名、Projectルート、利用可能なモデル、設定済みの割り当てを返します。同名候補が複数ある場合は、勝手に選ばず区別できる情報を示します。

**確認条件:** AIはUIから内部IDを転記してもらわず、対象の特定、設定不足の説明、依頼された変更まで進められます。承認が必要な変更も会話で確認でき、UIへの移動を必須にしません。会話を始めただけではProject登録や開発方針の変更が起きません。

根拠: [Projectは明示的に初期化する要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1203)、[ユーザーが開始するJournal Review](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1434)、[MCPツール定義](C:/Users/owner/.codex/visualizations/2026/09/09/01a08537-4015-7752-a6cb-2e72b3650c37/mcp-tool-catalog.json)、[リソース一覧](C:/Users/owner/.codex/visualizations/2026/09/09/01a08537-4015-7752-a6cb-2e72b3650c37/mcp-resources.json)。Project指定の失敗はMCP記録の8件目です。

**I-04｜Workflowの開始から実際のAI作業までを接続します。優先度: 高。目標と現在の運用経路との隔たりです。**

UIで実行を作れた後、AIがモデル名を指定して引き継ぐと、モデル未登録で停止しました。登録後は成功しました。また、現在の通常手順では、実行作成後に依頼文をコピーし、接続したAIへ渡します。READMEはこの挙動を正しく説明していますが、短い指示で一貫した工程を使う目標には、さらに接続の設計が必要です。

開始前に、Project、選択済みWorkflow、保存済みのモデル割り当て、必要な外部ツール、接続状態を検証します。不足があれば修正先と候補を示します。登録済みの方針は再利用し、毎回の選び直しを求めません。

実行環境との接続機能は、Workflowと今回の指示をCoreへ渡し、必要なContextを取得してAIへ届けます。Coreがモデル呼び出しを担当する必要はありません。UIには「準備済み」「AIへの送信待ち」「AIが作業開始を報告」「結果を受信」「人間の判断待ち」を区別して示すことを提案します。引き継ぎの取得だけで、AIが実作業を開始したとは判定しません。

**確認条件:** 初回接続を済ませた利用者が、明示したWorkflowと追加指示から開始できます。未登録モデルは作業開始前に解消できます。接続切れやAIの失敗後も同じ実行から再開でき、依頼が二重送信された場合に二重実行を防げます。

根拠: [短い指示からの利用目標](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:68)、[AI間の引き継ぎ要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1047)、[現在の接続・開始手順](//wsl.localhost/Ubuntu/home/owner/dev/aacl/README.md:358)。未登録モデルの失敗と復帰はMCP記録の4・5件目です。実際の複数モデルによる開発の自動進行は、今回未検証です。

**I-05｜完了、差し戻し、改訂後の再開を、作業として自然に扱います。優先度: 高。確認済みの進行上の問題と、復帰方法の不足です。**

スターターの最終コードレビューには次の遷移がなく、UIでは完了・中止だけが表示され、MCPから実装へ戻る操作も拒否されました。READMEでは、差し戻しを設ける場合は別の完了工程を用意する仕様になっています。要求は再試行・拒否・差し戻しと完了状態を求めますが、この終了方式までは要求していません。

完了できる条件と、差し戻せる遷移を独立して定義することを推奨します。最終レビューで合格なら完了、修正が必要なら実装へ戻る構成を、そのまま表せるべきです。差し戻し後は、変更した成果物に対するレビューと完了根拠を取り直せる必要があります。工程図の形を合わせるためだけの完了工程は不要にします。

さらに、試験環境でWorkflowをr2に修正・承認しても、既存実行はr1に固定され、差し戻しはできませんでした。改訂を固定する挙動は正しいです。そのうえで、旧版のまま続けるか、変更点を確認して新版から再開するかを利用者が選べる必要があります。新版への再開では旧実行との関連を保持し、再利用する成果物と再確認する根拠を明示します。

**確認条件:** スターターで「レビュー不合格、実装修正、再レビュー、完了」をUI・MCPの両方から実行できます。Workflowの修正で過去のSnapshotは変わりません。修正版で再開する際に、古い承認や完了根拠が無条件に新しい成果物へ引き継がれません。

根拠: [Workflowの要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:506)、[改訂を記録する要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1037)、[READMEの終了方式](//wsl.localhost/Ubuntu/home/owner/dev/aacl/README.md:372)、[最終工程の画面](C:/Users/owner/.codex/visualizations/2026/09/09/01a08537-4015-7752-a6cb-2e72b3650c37/03-terminal-code-review.png)。MCP記録の27・28・35〜37件目で確認しました。

**I-06｜適用条件の入力を正規化し、不一致を修正できる説明を返します。優先度: 高。確認済みの挙動差と、要求の指定不足です。**

Project内の `src` を対象にしたRuleは、Contextのdirectoryを `src/components` とすると適用されました。同じProjectルートに続く絶対パスでは除外されました。Project登録・引き継ぎでは絶対パスを扱うため、AIが絶対パスを渡すことは自然です。ここで必要なRuleが外れると、利用者は自分の設定を信頼しにくくなります。

要求に、directoryの基準、相対パスと絶対パスの扱い、CoreとRuntimeのOSが異なる場合の対応を加えるべきです。明示したProjectを基準に、同じ場所を表す入力を同じ条件へ変換します。Project外や変換不能なパスは、単なる条件不一致と区別します。WindowsとWSLの対応は、ホスト情報や明示した対応関係に基づいて扱います。

除外理由には「どの条件が」「どの入力と」「なぜ一致しなかったか」を返します。現在の複合条件全体の不一致という表示だけでは、Projectを直すのかdirectoryを直すのか判断できません。

**確認条件:** 明示した同一Project内で、対応する相対・絶対パスが同じ適用結果になります。入力欄とMCP定義にパスの基準が書かれています。不一致の条件、期待値、入力値をUI・MCPで確認できます。OS間の対応も別途試験します。

根拠: [決定論的な解決と説明の要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:841)、[Windows・WSLから同じCoreを使う要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1700)、[不一致の表示](C:/Users/owner/.codex/visualizations/2026/09/09/01a08537-4015-7752-a6cb-2e72b3650c37/08-rule-exclusion-reason.png)。MCP記録の15・16件目です。今回の試験は入力文字列による解決結果の比較であり、OS間の実ファイル対応やシンボリックリンクは検証していません。

**I-07｜AIへ渡す応答全体を、必要十分な情報にします。優先度: 高。要求の目的に反する確認済みの挙動です。**

20件のAssetがある状態で、空の条件からContextを解決しました。選択されたAssetは0件、Context本文も0文字でした。しかしMCP応答には、除外した20件のAsset本文も入り、応答文字列全体は14,038文字でした。選択Contextを小さくしても、ツールの返答で不要な指示がAIへ届いています。

通常の返答は、適用する本文、採用した改訂、簡潔な判断理由を中心にします。対象外の本文は要求時だけ取得できる形にします。全件の説明が必要なUIや診断用には、詳細表示を残せます。

また、5件の実行を返す一覧は10,710文字でした。単一実行の取得や一覧の絞り込みがなく、最新versionを知りたいだけでも全実行を取得します。実行一覧には要約と検索・件数制限を設け、個別の詳細取得を分けることを推奨します。

**確認条件:** 通常の解決応答に、対象外Assetの本文が含まれません。指定実行の最新状態だけを取得できます。計測では、解決したContextとMCP応答全体を分け、実際にAIへ渡した量を把握できます。

根拠: [必要十分なContextの要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:216)、[段階的な読込の要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:915)、[READMEのContext配布方針](//wsl.localhost/Ubuntu/home/owner/dev/aacl/README.md:135)。MCP記録の46・52件目です。文字数は今回の応答文字列の長さで、トークン数や料金ではありません。

**I-08｜完了の根拠を、人間が成果物と照合できるようにします。優先度: 高。確認済みのUI上の不足です。**

自作Workflowの完了時に、2件の完了条件へ具体的な根拠を入力しました。完了後のUIでは成果物と条件名は読めましたが、根拠本文の閲覧入口が見つかりませんでした。MCPには保存されているため、データ消失ではありません。実行を完了できることに加え、人間が完了判断を再確認できる必要があります。

完了画面では、条件、根拠、対応する成果物と改訂、記録者、時刻を並べます。再試行や差し戻しがあった場合は、どの試行の根拠かを区別します。「AIが満たしたと報告した条件」と「テスト等で機械的に確認した条件」も区別すべきです。

**確認条件:** 完了した実行を開くと、入力した根拠をUIから読め、MCPと同じ内容を確認できます。成果物を修正した後は、修正前の根拠を現在の合格証拠として表示しません。

根拠: [完了条件を含む引き継ぎ要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1047)、[記録と完了後の閲覧の説明](//wsl.localhost/Ubuntu/home/owner/dev/aacl/README.md:369)、[完了画面](C:/Users/owner/.codex/visualizations/2026/09/09/01a08537-4015-7752-a6cb-2e72b3650c37/05-completed-run.png)。根拠の保存はMCP記録の45件目で確認しました。

**I-09｜閲覧、実行準備、実行状態の更新を区別します。優先度: 中。確認済みの操作上の混乱です。**

AIが引き継ぎを取得した後、人間がUIでHandoffを取得すると、実行のversionが2から3になりました。AIがversion 2で完了しようとすると競合で拒否され、最新状態の読込後は成功しました。競合防止は機能しています。一方、閲覧に見える操作でAIの更新が無効になることは、共同作業の負担です。

「保存済みの引き継ぎを見る」と「現在の条件で新しい引き継ぎを作る」を明確に分けます。後者には更新される内容を表示します。工程状態とContext取得記録のどちらを変更したかが、UIとMCPの両方でわかる契約にします。

**確認条件:** 保存済み情報の閲覧だけでは実行versionが変わりません。実際に状態が変わった場合は、AIが対象実行の最新状態と変更点を取得して継続できます。競合を検出する仕組みは維持します。

根拠: [現在のHandoffとversionの契約](//wsl.localhost/Ubuntu/home/owner/dev/aacl/README.md:365)。MCP記録の53〜55件目で、競合と復帰を確認しました。

**I-10｜適用結果を変える設定にも、変更理由と復元を用意します。優先度: 高。確認済みの閲覧上の不足と、要求の対象範囲の曖昧さです。**

Project overlayというProject固有の例外設定で、共通Ruleを無効化できました。Project内だけ除外されることも確認できました。しかし、確認したChange History一覧にこの操作はありませんでした。モデル設定についても、確認した一覧には変更履歴がありませんでした。別の場所に履歴が保存されているかは未確認です。

同じWorkflowでも、例外設定やRoleとモデルの割り当てが変われば、AIへ渡す内容や担当が変わります。Asset本文だけを履歴管理しても、なぜ実行結果が変わったかを説明しきれません。

履歴と復元の対象には、Asset本文、適用条件、関係、Project固有の例外、モデル割り当てなど、実効的な開発方針を含めることを提案します。変更前後、理由、承認者を記録し、実行側では適用した設定の版を保持します。

**確認条件:** 「このProjectだけレビューRuleを外した」理由と実施者をたどれます。設定を復元でき、復元は新しい変更として残ります。過去の実行では当時の適用結果を読み続けられます。

根拠: [Project overlayの要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1185)、[Snapshotの適用設定](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1267)、[変更理由と履歴の要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1296)。例外の適用結果はMCP記録の38・39件目です。

**I-11｜既存Skillを、使えるまとまりとして取り込み、配布します。優先度: 中。確認済みの移行負担と、要求の具体性不足です。**

単一のSKILL.mdは取り込めました。しかし本文の `references/checklist.md` という参照は文字列として残るだけで、補助ファイルをまとめて取り込むUIは見つかりませんでした。生成結果にも参照先ファイルはありませんでした。取り込み時の名前はファイル由来のSKILLで、IDも手入力が必要でした。

Codex向けの生成では4ファイルが得られましたが、ダウンロードは個別です。Skillファイル名はSKILL.mdとなり、画面にあるフォルダー構造へ手作業で配置する必要がありました。READMEどおりの挙動でも、使える状態への移行に負担が残っています。

取り込みは、本文・補助ファイル・対応するメタデータを一つのまとまりとして扱うことを推奨します。対応しない内容は取り込み前に示します。名前とIDは候補を出し、利用者が確定します。生成側もフォルダー構造を保持した一括取得か、明示操作による配置を提供します。正本はCoreに維持し、生成物には由来と改訂を記録します。

**確認条件:** 対応対象とする補助ファイル付きSkillを取り込み、別の空Projectへ生成しても参照が成立します。未対応部分は黙って欠落しません。再生成時に、Coreの版と配置済みの版の差を確認できます。

根拠: [Native importの要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1143)、[生成物は正本ではないという要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1135)、[READMEの生成手順](//wsl.localhost/Ubuntu/home/owner/dev/aacl/README.md:376)、[生成画面](C:/Users/owner/.codex/visualizations/2026/09/09/01a08537-4015-7752-a6cb-2e72b3650c37/07-generated-files.png)。フォルダー単位の対応範囲は要求に具体化されていないため、明文違反とは断定しません。

**I-12｜実行を探し、そのWorkflowの改善までたどれる画面にします。優先度: 中。確認済みの識別・探索の負担と、目標との隔たりです。**

5件の実行のうち、単独Skillと通常の相談がいずれもAdvisoryと表示されました。権限上の分類として共通でも、利用者が探すときには「何を使った実行か」が必要です。Project・状態・Skillによる絞り込みも見つかりませんでした。JournalのSnapshot選択では、同じ工程・同じ分の記録が同一表示になり、選びにくい場面がありました。

実行一覧には、WorkflowまたはSkillの名前、Project、状態、現在工程、更新時刻を表示します。相談というモード名だけで実行内容を代表させません。Snapshotは実行名、工程、試行、モデル、識別できる時刻とIDを示します。

要求が主要表示とするWorkflow画面には、工程だけでなく、その版の実行、差し戻し、関連Journal、変更案、承認済み変更を関連付けて表示します。「このWorkflowのどこを改善するか」を起点に調べられるようにします。

**確認条件:** 同じSkillを複数Projectで繰り返しても、目的の実行をUI・MCPで絞れます。Workflowの詳細から、問題の実行、根拠となるJournal、対応する変更案と承認結果をたどれます。

根拠: [Workflow中心ビューの要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1366)、[Sessionの識別情報](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1656)、[実行一覧の画面](C:/Users/owner/.codex/visualizations/2026/09/09/01a08537-4015-7752-a6cb-2e72b3650c37/11-after-restart.png)。大量データでの応答速度や長期の探索時間は未測定です。

**I-13｜改善の判断に使えるよう、観測の意味と比較条件を定めます。優先度: 高。要求を実際の改善へつなげるための設計補強です。**

要求はWorkflowの改訂前後で、品質とContextコストを比較することを目指しています。今回、改訂の固定、Journal、推定Context量などの表示は確認できました。ただし、これらの記録があることだけでは、実際に作業が良くなったと判断できません。

手動の引き継ぎ取得でもSnapshotが増えるため、Snapshotの件数を実作業の回数として扱うべきではありません。実行準備、AIの試行、レビュー結果、差し戻し、完了を別の出来事として記録する必要があります。Journalも、対象の試行や失敗に結び付けやすくします。

今回の試験では、開始時のモデル未登録エラーについて、私が後のコードレビュー工程のSnapshotにJournalを付けました。これは試験者の関連付けであり、アプリによる自動誤記録ではありません。この記録を工程別に集計すると、原因が生じた工程とずれます。入力支援と観測の確認が必要だと判断した具体例です。

比較ではWorkflowの版に加え、モデル、関連Assetの改訂、Projectの例外設定、作業規模などの差を確認できるようにします。件数、対象期間、未完了・中止の扱いを示します。Context量の減少だけを改善成功とせず、欠陥や差し戻し、人間の介入も併せて読みます。

**確認条件:** 閲覧回数と実行試行数が分かれます。Journalの観測時点と記録時点を区別できます。変更前後の対象件数と条件差が読めます。実際の作業結果を伴う複数実行から、改善案の効果と未確定な点を説明できます。

根拠: [Workflow単位の観測](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:301)、[コスト指標](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1525)、[改訂前後を別の実行群として比較する要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1566)。Journalの関連付けはMCP記録の29件目です。品質改善の実測は今回行っていません。

**要求ファイル自体で決め直したいこと**

要求の大きな方向は一貫しています。ただし、目標とする製品を設計するには、次の判断を明文化する必要があります。

**1. Workflowと単独Skillの開発権限を、一つの規則に統一します。**

要求の設計思想では、リポジトリ変更を伴う開発にはDevelopment-capable Workflowが必要です。一方、Skillの定義と実行モードの節では、単独Skillに明示的な権限があればリポジトリ変更を許可する設計も述べています。このままでは、同じ変更をWorkflow経由では拒否し、Skill経由では許可する解釈が生じます。

本資料の推奨は、開発権限の単位をWorkflowに統一し、短い作業には1工程のWorkflowを認めることです。実際に1工程のWorkflowは作成・完了できました。単独Skillは調査やレビュー等の範囲を担当し、開発中には選択済みWorkflowの権限内で利用します。AACL内の下書き作成、Projectへのファイル変更、外部サービスへの投稿など、変更対象ごとの許可も定義します。

根拠: [Workflowを必須とする記述](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:155)、[Skill側の権限記述](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:541)、[単独Skillによる変更の記述](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:692)。

**2. 方針の明示と、毎回の手入力を区別します。**

ユーザーが方針を所有する原則は維持すべきです。そのうえで、下書きをAIに依頼する、候補から選ぶ、承認済みのモデル割り当てを再利用することを、正式な操作として認めます。「ユーザー定義」を、全項目の手入力や実行ごとの再指定として実装しないようにします。

要求には、初回に決めるもの、Workflowに保存するもの、今回だけ指定するもの、開始時に検証するものを分けて書くとよいです。具体的なモデル名を挙げた方針は、製品に固定する規則か、ユーザー設定の一例かも明記します。

根拠: [ユーザー所有の方針](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:139)、[現在のRole・Model方針](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:571)、[モデル割り当ての所有者](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1638)。

**3. 開発操作を禁止できる範囲を、Runtimeごとの契約にします。**

Coreが許可されないMCP操作を拒否することと、外部のAIが持つファイル編集やシェル操作まで止めることは、異なる保証です。今回確認したのは、Workflowなしの開発Handoffが拒否されることです。外部Runtimeの独自操作まで強制的に止められるかは未検証です。

要求には、制約をCoreで検証するもの、Runtime側で強制するもの、指示文として渡すものに分けた対応表が必要です。Workflowの必須制約を実行環境が強制できない場合は、開始前にわかり、対応する環境を選べる設計を推奨します。接続済みという状態だけで、必要な制約も満たしたと扱わないことが重要です。

根拠: [強制できる安全策の要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:245)、[接続と許可の区別](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1227)、[Coreと実行環境の境界](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:449)。

**4. 保存する情報の一覧に加え、利用者が何を完結できるかを書きます。**

要求には、Snapshotの保存項目、履歴の構造、画面の表示項目が詳しくあります。一方、それらを使って「中断から再開する」「旧版の実行を修正版で続ける」「完了判断を読み返す」「改善の効果を判断する」という操作の完結条件は補強できます。

特に、Contextを解決した時点、Runtimeへ届けた時点、AIが試行した時点、結果を受け取った時点を区別すべきです。READMEはSnapshotを開発Contextの記録として説明しています。この限界を保ちつつ、実作業の記録との関連を要求に加えると、実行状況と改善指標の意味が揃います。

根拠: [Snapshotの要求](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1267)、[Workflow State](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md:1037)、[READMEのSnapshotの説明](//wsl.localhost/Ubuntu/home/owner/dev/aacl/README.md:231)。

**目標から逆算した確認シナリオ**

以下は、今後の改善を評価するために本資料で作成したシナリオです。機能の存在だけでなく、利用者の目的が最後まで達成できることを確認します。

| シナリオ | 確認する一連の操作 | 主な対応項目 |
|---|---|---|
| 自分の方法を初めて登録する | 空の環境で目的を伝え、Workflow案を作り、担当・モデル・権限を確認して承認し、初回実行を始めます。架空の実行観測は作りません。 | I-01〜04 |
| 翌日、同じ方法を再利用する | 再接続後、Workflowと今回の対象を指定します。保存済みの方針が再利用され、前回と異なる設定だけを確認できます。 | I-03、04、10 |
| コードレビューで不合格になる | 実際の試験用変更をレビューし、実装へ戻し、修正後に再レビューして完了します。完了の根拠を後から読めます。 | I-05、08 |
| 人間とAIが交互に操作する | 人間が閲覧している間もAIが継続できます。双方が更新した場合は競合を検出し、最新状態から復帰できます。 | I-07、09 |
| Contextの適用を調べる | Projectとdirectoryを指定し、適用・除外の条件を確認します。表記の差だけで必要なRuleが外れません。 | I-06、07 |
| 手順の不備を直して作業を続ける | 旧版の実行で問題を見つけ、Workflow修正案を承認します。過去を残し、必要な成果物と確認項目を選んで新版から再開します。 | I-02、05、10 |
| 既存Skillを移して使う | 補助ファイル付きSkillを取り込み、別Projectへ配布して実行します。欠落や未対応部分を移行前に確認できます。 | I-11 |
| 改善の効果を調べる | 同じWorkflowの複数実行から問題を選び、変更を承認して次の版を使います。品質・手間・Context量の変化と比較条件を確認します。 | I-08、10、12、13 |

成功の指標には、開始までの手動受け渡し回数、繰り返し入力する設定項目、停止後の復帰手順、完了根拠を探す操作数も含めることを推奨します。数値目標は実測後に設定します。現時点で根拠のない削減率や所要時間は置きません。

**改善に取り組む順序**

実装時期による免除ではなく、他の設計が依存する判断と、運用を止める問題から順に扱うことを推奨します。

1. **製品の約束を揃えます。** Workflowを中心にするREADME、単独Skillの権限、ユーザー所有と作成支援の関係、CoreとRuntimeが保証する範囲を明文化します。
2. **開始・修正・完了を一続きにします。** 初回のWorkflow提案、設定の事前確認、MCPからの探索、実行環境との接続、差し戻しと改訂後の再開を設計します。
3. **適用と判断を信頼できるようにします。** パスと適用条件、応答全体の情報量、完了根拠の閲覧、閲覧と更新の区別、実効設定の履歴を整えます。
4. **反復利用と改善を成立させます。** 実行の検索、既存Skillの移行、Workflowに関連する観測の表示、実試行に基づく比較を整えます。

順序が後の項目も、目標とする製品には必要です。たとえばSkill移行が主要な導入経路ならI-11を先に扱うなど、実際の利用者の開始地点に応じて着手順を調整します。

**維持したい、実際に機能していた点**

今回の操作では、Project固有の適用、Workflowなしの開発操作の拒否、根拠なしの遷移の拒否、仕様レビューからの差し戻し、Workflow作成途中のRole追加、AIの提案と人間の承認、改訂差分と復元、過去のSnapshotの保持、Core再起動後の記録の保持が機能しました。

これらは目標を支える基礎です。操作負担を減らす際にも、明示した適用条件、ユーザーの決定権、変更の承認、過去の記録の不変性を維持します。必要な改善は、判断を失わせることではなく、判断に必要な情報を揃え、承認済みの方針を繰り返し使えるようにすることです。

**根拠の所在と検証上の限界**

- [要求ファイル](//wsl.localhost/Ubuntu/home/owner/dev/aacl/agent-asset-control-layer-requirements.md)と[README](//wsl.localhost/Ubuntu/home/owner/dev/aacl/README.md)を、目的と記述の根拠にしました。
- [初回利用・運用試験](C:/Users/owner/.codex/visualizations/2026/09/09/01a08537-4015-7752-a6cb-2e72b3650c37/aacl-first-use-report.md)に、24ユースケースと従来の12指摘があります。
- 本資料の「MCP記録のN件目」は、[呼び出し原記録](C:/Users/owner/.codex/visualizations/2026/09/09/01a08537-4015-7752-a6cb-2e72b3650c37/mcp-events.json)の配列を先頭から1件目として数えた位置です。
- [UI操作の応答記録](C:/Users/owner/.codex/visualizations/2026/09/09/01a08537-4015-7752-a6cb-2e72b3650c37/ui-events.json)、[MCPツール定義](C:/Users/owner/.codex/visualizations/2026/09/09/01a08537-4015-7752-a6cb-2e72b3650c37/mcp-tool-catalog.json)、[再起動後の保存データ](C:/Users/owner/.codex/visualizations/2026/09/09/01a08537-4015-7752-a6cb-2e72b3650c37/trial-summary-data.json)も参照しました。
- 実際の複数モデルによる開発、Claude向けファイルの実配置、stdio接続、長期・大量データ運用、外部Runtimeの操作強制、破損からの復旧は未検証です。ツール19種類の使用は、これらの目標を達成した証明ではありません。
- 本資料は総合的な改善案です。README、要求、アプリの実装は変更していません。
