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
    ['intake', '受付・計画', 'orchestrator', 'brief'],
    ['specification', '仕様策定', 'specifier', 'specification'],
    ['specification-review', '仕様レビュー', 'specification-reviewer', 'specification-review'],
    ['implementation', '実装・テスト', 'implementer', 'test-results'],
    ['pull-request', 'Pull Request', 'implementer', 'pull-request'],
    ['code-review', 'コードレビュー', 'code-reviewer', 'code-review'],
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
      content: '各Stageの成果物と完了条件を確認し、定義済みの遷移を選択する。',
      workflow: {
        developmentCapable: true,
        entryRole: 'orchestrator',
        entryStage: 'intake',
        completionCriteria: ['コードレビューが完了している'],
        stages: stages.map(([id, name, role, artifact], i) => ({
          id,
          name,
          role,
          taskType: 'feature-development',
          completionCriteria: [`${name}の結果を確認した`],
          transitions:
            i === stages.length - 1
              ? []
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
    ...['refactoring-review', 'architecture-review', 'security-review', 'test-review'].map(
      (id) => ({
        id,
        type: 'skill',
        name: id.split('-').join(' '),
        description: 'Advisory Modeで使う単独レビュー',
        activation: 'on-demand',
        content:
          '指定された対象を調査し、観測事実・根拠・改善候補を記載する。リポジトリの変更は開始しない。',
      }),
    ),
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
