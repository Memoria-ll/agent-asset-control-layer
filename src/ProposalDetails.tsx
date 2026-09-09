import type { ProposalItem, Context, Scope, Journal } from '../server/domain.ts';
import { Badge } from './ui.tsx';

export const changeLabel = (kind: string) =>
  ({
    added: '追加',
    updated: '更新',
    removed: '削除',
    'scope-changed': 'Scope変更',
    'relation-changed': 'Relation変更',
    'no-change': '変更なし',
  })[kind] ?? kind;
function ScopeFacts({
  scope,
  observed = false,
}: {
  scope: Scope | Context | null;
  observed?: boolean;
}) {
  if (scope === null) return <p className="muted small-text">削除</p>;
  return (
    <div className="scope-facts">
      {Object.entries(scope).length ? (
        Object.entries(scope).map(([key, value]) => (
          <span key={key}>
            {key}: {Array.isArray(value) ? value.join(' / ') : value}
          </span>
        ))
      ) : (
        <span>{observed ? '記録された条件なし' : 'Global / 制限なし'}</span>
      )}
    </div>
  );
}
export function ProposalDetails({ item, journals }: { item: ProposalItem; journals: Journal[] }) {
  return (
    <div className="proposal-details">
      <div className="button-row wrap">
        {item.changeKinds.map((kind) => (
          <Badge key={kind}>{changeLabel(kind)}</Badge>
        ))}
      </div>
      <p>
        <strong>理由: </strong>
        {item.reason}
      </p>
      {item.evidenceMode === 'legacy-review' && (
        <p className="muted small-text">旧形式の提案です。根拠はReview全体で共有されています。</p>
      )}
      <div className="proposal-scopes">
        <div>
          <h4>Observed scope · 観測した範囲</h4>
          {item.observedScopes.map((s, i) => (
            <ScopeFacts key={i} scope={s} observed />
          ))}
        </div>
        <div>
          <h4>Proposed scope · 提案する範囲</h4>
          <ScopeFacts scope={item.proposedScope} />
          {item.proposedRelations && (
            <>
              <p className="small-text">
                依存: {item.proposedRelations.dependencies.join(', ') || 'なし'}
              </p>
              <p className="small-text">
                競合: {item.proposedRelations.conflicts.join(', ') || 'なし'}
              </p>
            </>
          )}
        </div>
      </div>
      <div className="proposal-evidence">
        <strong>Evidence · 根拠</strong>
        <p>{item.evidence.explanation}</p>
        {item.evidence.journalIds.map((id) => (
          <div key={id}>
            <code>{id}</code>
            <p className="small-text">
              {journals.find((j) => j.id === id)?.observation ?? 'Journalの本文は取得できません。'}
            </p>
          </div>
        ))}
        <details>
          <summary>根拠Snapshot {item.evidence.snapshotIds.length}件</summary>
          {item.evidence.snapshotIds.map((id) => (
            <p key={id}>
              <code>{id}</code>
            </p>
          ))}
        </details>
      </div>
    </div>
  );
}
