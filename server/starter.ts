import { assetSchema, type AssetInput } from './domain.ts';

export function starterAssets(): AssetInput[] {
  const roles = [
    ['orchestrator', 'Orchestrator', '選択されたWorkflowの範囲で割り当てと遷移を判断する。'],
    ['specifier', 'Specifier', '要求と制約を明文化し、検証可能な仕様を作成する。'],
    [
      'specification-reviewer',
      'Specification reviewer',
      '仕様の不足、矛盾、検証可能性を確認する。',
    ],
    ['implementer', 'Implementer', '確定仕様を実装し、必要な検証結果を記録する。'],
    ['reviewer', 'Reviewer', '成果物の品質と要求への適合を確認する。'],
    ['code-reviewer', 'Code reviewer', 'コード、テスト、回帰リスクを根拠に基づいて確認する。'],
  ].map(([id, name, content]) => ({ id, name, content, type: 'role', scope: { role: [id] } }));
  const stages = [
    [
      'intake',
      '受付・計画',
      'orchestrator',
      'brief',
      '対象Issue、要求、対象範囲、対象外、受け入れ条件、検証方法、不明点を記載した',
      '例: 対象 #123 / 要求: CLIに挨拶を追加 / 対象外: 配布方式の変更 / 受け入れ条件: 名前あり・なしで所定の文言を出力 / 検証: CLIの入出力テスト / 不明点: なし',
    ],
    [
      'specification',
      '仕様策定',
      'specifier',
      'specification',
      '入力・出力、異常時の挙動、制約、受け入れ条件ごとのテストを定義した',
      '要求と対応付けた仕様、境界条件、失敗時の挙動、検証手順を記載する。',
    ],
    [
      'specification-review',
      '仕様レビュー',
      'specification-reviewer',
      'specification-review',
      '仕様の不足・矛盾・検証可能性を確認し、指摘の対応結果を記録した',
      '確認した仕様の範囲、根拠付きの指摘、修正要否、残る不明点を記載する。',
    ],
    [
      'implementation',
      '実装・テスト',
      'implementer',
      'test-results',
      '要求に対応する変更を実装し、検証コマンド・結果・未検証範囲を記録した',
      '変更ファイル、要求との対応、実行コマンド、成功・失敗したテスト、制約を記載する。',
    ],
    [
      'pull-request',
      'Pull Request',
      'implementer',
      'pull-request',
      '変更目的・差分・検証結果を記載したPull Requestを作成した',
      'Pull RequestのURLと、変更目的・検証結果・残る注意点を記載する。',
    ],
    [
      'code-review',
      'コードレビュー',
      'code-reviewer',
      'code-review',
      '変更とテストを確認し、未対応の指摘と受け入れ可否を記録した',
      '確認した変更、根拠と影響を伴う指摘、対応状況、受け入れ可否を記載する。',
    ],
  ];
  const reviews = [
    [
      'refactoring-review',
      '重複、責務の分離、依存方向、状態管理、変更容易性を確認する。挙動を保つ最小の改善と、その検証方法を示す。',
    ],
    [
      'architecture-review',
      'モジュール境界、公開契約、データの流れ、依存方向、障害時の挙動、拡張時の制約を確認する。設計変更の利点と移行コストを示す。',
    ],
    [
      'security-review',
      '入力検証、認証・認可、信頼境界、秘密情報、コマンドやHTMLへの入力混入を確認する。到達可能な攻撃経路、影響、具体的な対処を示す。',
    ],
    [
      'test-review',
      '要求とテストの対応、境界値、異常系、回帰の検出力、非決定的な失敗、検証の独立性を確認する。見逃す不具合と追加すべき検証を示す。',
    ],
  ];
  return [
    ...roles,
    {
      id: 'feature-development',
      type: 'task-type',
      name: 'Feature development',
      content: '要求を満たす変更と検証を行う。',
      scope: { taskType: ['feature-development'] },
    },
    {
      id: 'issue-boundary',
      type: 'rule',
      name: 'Issueの変更範囲',
      description: 'Issue開発の実装時に適用する方針',
      content: 'Issueの要求範囲に変更を限定する。追加改善は別の提案として記録する。',
      scope: { workflow: ['issue-development'], role: ['implementer'] },
    },
    {
      id: 'review-evidence',
      type: 'rule',
      name: 'レビューの根拠',
      content: '指摘には具体的な根拠と影響を記載する。未確認の推測は事実と区別する。',
      scope: { role: ['reviewer', 'code-reviewer', 'specification-reviewer'] },
    },
    {
      id: 'issue-development',
      type: 'workflow',
      name: 'Issue development',
      description: 'Issueを仕様策定から実装・コードレビューまで進める、編集可能なスターター。',
      content:
        '各Stageの成果物と完了条件を確認し、定義済みの遷移を選択する。成果物にはファイルパス、URL、または結果本文を記録する。\n\n' +
        stages
          .map(([, name, , artifact, , guidance]) => `### ${name}: ${artifact}\n${guidance}`)
          .join('\n\n'),
      workflow: {
        developmentCapable: true,
        entryRole: 'orchestrator',
        entryStage: 'intake',
        completionCriteria: ['コードレビューが完了している'],
        stages: stages.map(([id, name, role, artifact, criterion], i) => ({
          id,
          name,
          role,
          taskType: 'feature-development',
          expectedOutput: [artifact],
          completionCriteria: [criterion],
          canComplete: i === stages.length - 1,
          transitions:
            i === stages.length - 1
              ? [
                  { to: 'implementation', kind: 'return', requiredArtifacts: [] },
                  { to: id, kind: 'retry', requiredArtifacts: [] },
                ]
              : [
                  { to: stages[i + 1][0], kind: 'advance', requiredArtifacts: [artifact] },
                  ...(i > 0
                    ? [{ to: stages[i - 1][0], kind: 'return', requiredArtifacts: [] }]
                    : []),
                  { to: id, kind: 'retry', requiredArtifacts: [] },
                ],
        })),
      },
    },
    ...reviews.map(([id, focus]) => ({
      id,
      type: 'skill',
      name: id.split('-').join(' '),
      description: focus,
      activation: 'on-demand',
      skill: {
        executionMode: 'standalone',
        executionPermission: 'read-only',
        expectedOutput: [`${id}-report`],
        completionCriteria: ['確認範囲、根拠と影響を伴う指摘、未検証範囲を記録した'],
      },
      content:
        focus +
        '\n指定された対象を調査し、観測事実・根拠・改善候補を記載する。指摘がない場合も確認範囲と未検証範囲を示す。リポジトリの変更は開始しない。',
    })),
    {
      id: 'journal',
      type: 'skill',
      name: 'Journal',
      activation: 'on-demand',
      content:
        '実行Snapshotに結びつけて、摩擦・不足・成功・改善の種を記録する。scopeは確定しない。',
    },
    {
      id: 'journal-review',
      type: 'skill',
      name: 'Journal review',
      activation: 'on-demand',
      content:
        'ユーザーが開始したReviewのJournalとSnapshotを読み、観測scopeと提案scopeを分離する。変更理由と根拠を提示し、aacl_review_submitで提案する。承認前にAssetを変更しない。',
    },
  ].map((a) => assetSchema.parse(a));
}
