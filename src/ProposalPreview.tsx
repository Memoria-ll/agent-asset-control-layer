import { useEffect, useState } from 'react';
import type { Core } from '../server/core.ts';
import type { Asset } from '../server/domain.ts';
import { api } from './api.ts';
import { DiffView } from './AssetHistory.tsx';
import { WorkflowFlow } from './RunViews.tsx';
import { ContractDetails } from './AssetContracts.tsx';

type Preview = ReturnType<Core['reviewPreview']>;
function WorkflowDetails({ asset }: { asset: Asset }) {
  if (!asset.workflow) return null;
  return (
    <section aria-label="提案のWorkflow構造">
      <h4>{asset.name} · 工程と遷移</h4>
      <p>
        開始工程: {asset.workflow.entryStage} · 開発操作:{' '}
        {asset.workflow.developmentCapable ? '許可' : '参照のみ'}
      </p>
      <WorkflowFlow workflow={asset} />
      {asset.workflow.stages.map((s) => (
        <div key={s.id} className="form-section">
          <h4>
            {s.name} · {s.id}
          </h4>
          <p>
            担当: {s.role} · 作業種別: {s.taskType ?? '指定なし'}
          </p>
          <p>
            必須Asset: {s.requiredAssets.join(', ') || 'なし'} · 必須Capability:{' '}
            {s.requiredCapabilities.join(', ') || 'なし'}
          </p>
          <p>成果物: {s.expectedOutput?.join(', ') || '指定なし'}</p>
          <p>完了条件: {s.completionCriteria.join(' / ') || 'なし'}</p>
          {s.transitions.length ? (
            <ul>
              {s.transitions.map((edge) => (
                <li key={`${edge.kind}:${edge.to}`}>
                  {
                    { advance: '次へ', return: '差し戻し', retry: '再試行', reject: '却下' }[
                      edge.kind
                    ]
                  }{' '}
                  → {asset.workflow!.stages.find((next) => next.id === edge.to)?.name ?? edge.to} ·
                  必要成果物: {edge.requiredArtifacts.join(', ') || 'なし'}
                </li>
              ))}
            </ul>
          ) : (
            <p>この工程で完了します。</p>
          )}
        </div>
      ))}
      <p>Workflow全体の完了条件: {asset.workflow.completionCriteria.join(' / ') || 'なし'}</p>
    </section>
  );
}
export function ProposalPreview({
  reviewId,
  revisionKey,
  onReady,
}: {
  reviewId: string;
  revisionKey: string;
  onReady: (ready: boolean) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPreview(null);
    setError('');
    onReady(false);
    api<Preview>(`/reviews/${encodeURIComponent(reviewId)}/preview`)
      .then((value) => {
        if (active) {
          setPreview(value);
          onReady(true);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [reviewId, revisionKey, onReady]);
  if (error)
    return (
      <div className="error" role="alert">
        変更内容を取得できません: {error}
      </div>
    );
  if (!preview) return <p role="status">変更内容を読み込み中…</p>;
  return (
    <section aria-label="承認前の変更内容">
      <h3>承認前の変更内容</h3>
      {preview.map(({ before, after, diff }) => (
        <section key={diff.assetId} className="proposal-change">
          <h3>
            {after?.name ?? before?.name} · {before ? `比較元 r${before.revision}` : '新規作成'}
            {!after && ' · 削除'}
          </h3>
          <DiffView result={diff} compact />
          {after && <ContractDetails asset={after} />}
          {before?.workflow && (
            <details>
              <summary>変更前のWorkflow</summary>
              <WorkflowDetails asset={before} />
            </details>
          )}
          {after?.workflow && <WorkflowDetails asset={after} />}
        </section>
      ))}
    </section>
  );
}
