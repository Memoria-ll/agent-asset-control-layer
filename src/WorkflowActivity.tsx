import { useState } from 'react';
import type { Asset } from '../server/domain.ts';
import type { Overview } from './api.ts';
import { Badge, statusLabel } from './ui.tsx';
import { exactTime, executionLabel } from './RunEvidence.tsx';

export function WorkflowActivity({
  workflow,
  data,
  onRun,
  onReview,
  onChange,
}: {
  workflow: Asset;
  data: Overview;
  onRun: (id: string) => void;
  onReview: (id: string) => void;
  onChange: (id: string) => void;
}) {
  const [revision, setRevision] = useState('');
  const runs = data.runs.filter(
    (r) =>
      r.workflow?.id === workflow.id && (!revision || String(r.workflow.revision) === revision),
  );
  const journals = data.journals.filter(
    (j) =>
      j.context.workflow === workflow.id && (!revision || String(j.workflowRevision) === revision),
  );
  const journalIds = new Set(journals.map((j) => j.id));
  const reviews = data.reviews.filter((r) => r.journalIds.some((id) => journalIds.has(id)));
  const changes = data.changesets.filter(
    (c) =>
      c.sourceJournals.some((id) => journalIds.has(id)) ||
      c.changes.some(
        (change) =>
          change.id === workflow.id &&
          (!revision ||
            String(change.after?.revision) === revision ||
            String(change.before?.revision) === revision),
      ),
  );
  const revisions = [
    ...new Set([
      workflow.revision,
      ...data.runs.filter((r) => r.workflow?.id === workflow.id).map((r) => r.workflow!.revision),
    ]),
  ].sort((a, b) => b - a);
  return (
    <section className="workflow-activity" aria-label="Workflowの実行と改善">
      <div className="section-head compact">
        <h3>実行から改善をたどる</h3>
        <select
          aria-label="Workflowの観測対象版"
          value={revision}
          onChange={(e) => setRevision(e.target.value)}
        >
          <option value="">すべての版</option>
          {revisions.map((r) => (
            <option key={r} value={r}>
              r{r}
              {r === workflow.revision ? '（現在）' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="activity-columns">
        <section>
          <h4>
            実行 <Badge>{runs.length}件</Badge>
          </h4>
          {runs.map((run) => (
            <button key={run.id} className="activity-link" onClick={() => onRun(run.id)}>
              <strong>{run.title}</strong>
              <span>
                r{run.workflow?.revision} · {statusLabel(run.status)} · {executionLabel(run)}
              </span>
              <span>
                {run.events.filter((event) => event.kind === 'return').length}回の差し戻し ·{' '}
                {run.attempts?.length ?? 0}件のAI試行
              </span>
              <small>{exactTime(run.updatedAt)}</small>
            </button>
          ))}
          {!runs.length && <p className="muted">この版の実行はありません。</p>}
        </section>
        <section>
          <h4>
            Journal <Badge>{journals.length}件</Badge>
          </h4>
          {journals.map((journal) => (
            <details className="activity-journal" key={journal.id}>
              <summary>{journal.observation}</summary>
              <p>{journal.possibleCause}</p>
              <p className="small-text">
                工程: {journal.context.stage ?? '未記録'} · 試行: {journal.attemptId ?? '未記録'} ·
                r{journal.workflowRevision}
              </p>
              <p className="small-text">
                観測: {journal.observedAt ? exactTime(journal.observedAt) : '未記録'} · 記録:{' '}
                {exactTime(journal.createdAt)}
              </p>
              <button className="button small" onClick={() => onRun(journal.runId)}>
                関連する実行を開く
              </button>
              {reviews
                .filter((review) => review.journalIds.includes(journal.id))
                .map((review) => (
                  <button
                    key={review.id}
                    className="button small"
                    onClick={() => onReview(review.id)}
                  >
                    {review.reason} · {statusLabel(review.status)}
                  </button>
                ))}
            </details>
          ))}
          {!journals.length && <p className="muted">関連する観測はありません。</p>}
        </section>
        <section>
          <h4>Review・承認済み変更</h4>
          {reviews.map((review) => (
            <button key={review.id} className="activity-link" onClick={() => onReview(review.id)}>
              <strong>{review.reason}</strong>
              <Badge>{statusLabel(review.status)}</Badge>
            </button>
          ))}
          {changes.map((change) => (
            <button key={change.id} className="activity-link" onClick={() => onChange(change.id)}>
              <strong>{change.summary}</strong>
              <span>
                {change.actor} · {exactTime(change.approvedAt)}
              </span>
            </button>
          ))}
          {!reviews.length && !changes.length && (
            <p className="muted">関連する提案・変更はありません。</p>
          )}
        </section>
      </div>
      <p className="muted small-text">
        実行は開始時のWorkflowの版に固定されています。版を絞っても作業規模・モデル・適用資産の違いは残るため、件数だけで改善効果を判断できません。
      </p>
    </section>
  );
}
