import { useState } from 'react';
import {
  Plus,
  ScanLine,
  Check,
  X,
  GitCommitHorizontal,
  RotateCcw,
  ExternalLink,
} from 'lucide-react';
import type { Overview } from './api.ts';
import type { Review, Journal, ChangeSet } from '../server/domain.ts';
import { Badge, CopyButton, Empty, Field, Json, Modal, relativeDate, statusLabel } from './ui.tsx';
import { ProposalDetails, changeLabel } from './ProposalDetails.tsx';
import { RevisionDiff } from './AssetHistory.tsx';
import { ProposalPreview } from './ProposalPreview.tsx';
import { AssetCosts } from './AssetCosts.tsx';
import { snapshotLabel, exactTime } from './RunEvidence.tsx';
import { WorkflowComparison } from './WorkflowComparison.tsx';

type Mutate = (route: string, body: unknown) => Promise<any>;
export function JournalModal({
  data,
  snapshotId,
  onClose,
  mutate,
}: {
  data: Overview;
  snapshotId?: string;
  onClose: () => void;
  mutate: Mutate;
}) {
  const [snapshot, setSnapshot] = useState(snapshotId ?? data.snapshots[0]?.id ?? '');
  const [kind, setKind] = useState('friction');
  const [observation, setObservation] = useState('');
  const [cause, setCause] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attemptId, setAttemptId] = useState('');
  const [observedAt, setObservedAt] = useState('');
  const selectedSnapshot = data.snapshots.find((s) => s.id === snapshot);
  const attempts =
    data.runs
      .find((r) => r.id === selectedSnapshot?.runId)
      ?.attempts?.filter((a) => a.snapshotId === snapshot) ?? [];
  return (
    <Modal title="Journalを記録" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await mutate('/journals', {
              snapshotId: snapshot,
              kind,
              observation,
              possibleCause: cause,
              ...(attemptId ? { attemptId } : {}),
              ...(observedAt ? { observedAt: new Date(observedAt).toISOString() } : {}),
            });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="実行Snapshot">
          <select
            required
            value={snapshot}
            onChange={(e) => {
              setSnapshot(e.target.value);
              setAttemptId('');
            }}
          >
            <option value="" disabled>
              選択してください
            </option>
            {data.snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {snapshotLabel(s, data)}
              </option>
            ))}
          </select>
        </Field>
        <div className="callout">
          Workflow・Role・Model・Asset revisionは、選択したSnapshotから記録されます。
          観測した問題が発生した工程を選んでください。後の工程を選ぶと、観測の対象も変わります。
        </div>
        <div className="form-grid">
          <Field label="観測対象の試行">
            <select value={attemptId} onChange={(e) => setAttemptId(e.target.value)}>
              <option value="">指定なし / Contextの観測</option>
              {attempts.map((attempt) => (
                <option key={attempt.id} value={attempt.id}>
                  {attempt.id} · {attempt.model ?? 'モデル未記録'} · {exactTime(attempt.startedAt)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="観測した時刻（任意）" hint="記録した時刻とは別に保存します。">
            <input
              type="datetime-local"
              value={observedAt}
              onChange={(e) => setObservedAt(e.target.value)}
            />
          </Field>
        </div>
        <Field label="観測の種類">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="friction">Friction · 進めにくさ</option>
            <option value="missing-support">Missing support · 情報不足</option>
            <option value="defect">Defect · 不具合</option>
            <option value="success">Success · 有効だったこと</option>
            <option value="improvement">Improvement · 改善の種</option>
          </select>
        </Field>
        <Field label="観測したこと">
          <textarea
            required
            rows={5}
            value={observation}
            onChange={(e) => setObservation(e.target.value)}
            placeholder="実行中に起きたことを、具体的に記録してください。"
          />
        </Field>
        <Field label="考えられる原因（任意）">
          <textarea rows={2} value={cause} onChange={(e) => setCause(e.target.value)} />
        </Field>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            キャンセル
          </button>
          <button className="button primary" disabled={busy || !snapshot}>
            Journalを保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function Journals({
  data,
  mutate,
  onAdd,
  initialReviewId = '',
}: {
  data: Overview;
  mutate: Mutate;
  onAdd: () => void;
  initialReviewId?: string;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewId, setReviewId] = useState(initialReviewId);
  const [request, setRequest] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const journals = data.journals.filter((j) => !filter || j.context.workflow === filter);
  return (
    <>
      <div className="toolbar">
        <div className="button-row">
          <select
            aria-label="Journal Workflow絞り込み"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">すべてのWorkflow</option>
            {[...new Set(data.journals.map((j) => j.context.workflow).filter(Boolean))].map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <span className="muted small-text">{data.journals.length} observations</span>
        </div>
        <div className="button-row">
          <button className="button" onClick={onAdd} disabled={!data.snapshots.length}>
            <Plus size={15} />
            Journalを記録
          </button>
          <button
            className="button primary"
            disabled={!selected.length}
            onClick={() => setRequest(true)}
          >
            <ScanLine size={15} />
            選択した{selected.length || ''}件をReview
          </button>
        </div>
      </div>
      <div className="journals-layout">
        <section className="panel">
          {journals.length ? (
            journals.map((j) => (
              <JournalCard
                key={j.id}
                j={j}
                selected={selected.includes(j.id)}
                toggle={() =>
                  setSelected(
                    selected.includes(j.id)
                      ? selected.filter((id) => id !== j.id)
                      : [...selected, j.id],
                  )
                }
              />
            ))
          ) : (
            <Empty title="Journalはまだありません">
              実行後にJournalを記録すると、Workflowごとに知見を振り返れます。
            </Empty>
          )}
        </section>
        <aside>
          <div className="section-head compact">
            <h3>Journal reviews</h3>
            <Badge>{data.reviews.length}</Badge>
          </div>
          {data.reviews.length ? (
            data.reviews.map((r) => (
              <button key={r.id} className="review-card" onClick={() => setReviewId(r.id)}>
                <div className="button-row">
                  <ScanLine size={17} />
                  <strong>{r.id.slice(-12)}</strong>
                  <ExternalLink size={13} />
                </div>
                <p>{r.reason}</p>
                <div className="button-row">
                  <Badge
                    tone={r.status === 'pending' ? 'amber' : r.status === 'approved' ? 'green' : ''}
                  >
                    {statusLabel(r.status)}
                  </Badge>
                  <span className="small-text muted">{r.journalIds.length} journals</span>
                </div>
              </button>
            ))
          ) : (
            <div className="aside-note">
              <ScanLine size={22} />
              <h3>Reviewの開始と承認</h3>
              <p>
                Journalを選択してReviewを開始します。接続したAI
                Runtimeが提案し、内容を確認してから承認できます。
              </p>
            </div>
          )}
        </aside>
      </div>
      {error && <div className="error">{error}</div>}
      {request && (
        <Modal title="Journal Reviewを開始" onClose={() => setRequest(false)}>
          <p>選択した{selected.length}件のJournalとSnapshotをReview対象にします。</p>
          <p className="muted">
            開始後、MCP接続したAIにReview
            IDを渡してください。提案は承認するまでAssetに反映されません。
          </p>
          <div className="modal-actions">
            <button className="button" onClick={() => setRequest(false)}>
              キャンセル
            </button>
            <button
              className="button primary"
              onClick={async () => {
                try {
                  const r = await mutate('/reviews', {
                    journalIds: selected,
                    reason: '選択した観測からWorkflow / Assetの改善を検討する',
                  });
                  setRequest(false);
                  setSelected([]);
                  setReviewId(r.id);
                } catch (e) {
                  setError((e as Error).message);
                  setRequest(false);
                }
              }}
            >
              Reviewを開始
            </button>
          </div>
        </Modal>
      )}
      {reviewId && (
        <ReviewModal
          review={data.reviews.find((r) => r.id === reviewId)!}
          data={data}
          mutate={mutate}
          onClose={() => setReviewId('')}
        />
      )}
    </>
  );
}
function JournalCard({
  j,
  selected,
  toggle,
}: {
  j: Journal;
  selected: boolean;
  toggle: () => void;
}) {
  return (
    <article className="journal-card">
      <input
        type="checkbox"
        checked={selected}
        onChange={toggle}
        aria-label={`Journalを選択: ${j.observation.slice(0, 30)}`}
      />
      <div className="grow">
        <div className="section-head compact">
          <Badge tone={j.kind === 'success' ? 'green' : j.kind === 'defect' ? 'red' : 'amber'}>
            {j.kind}
          </Badge>
          <time className="small-text muted">{relativeDate(j.createdAt)}</time>
        </div>
        <p>{j.observation}</p>
        <p className="small-text muted">
          観測時刻: {j.observedAt ? exactTime(j.observedAt) : '未記録'} · 記録時刻:{' '}
          {exactTime(j.createdAt)} · 試行: {j.attemptId ?? '未記録'}
        </p>
        {j.possibleCause && <p className="muted small-text">原因の仮説: {j.possibleCause}</p>}
        <div className="scope-pills">
          {[j.context.workflow, j.context.stage, j.context.role, j.context.model]
            .filter(Boolean)
            .map((s, i) => (
              <span key={i}>{s}</span>
            ))}
          <span>r{j.workflowRevision ?? '—'}</span>
        </div>
      </div>
    </article>
  );
}
function ReviewModal({
  review,
  data,
  mutate,
  onClose,
}: {
  review: Review;
  data: Overview;
  mutate: Mutate;
  onClose: () => void;
}) {
  const [proposal, setProposal] = useState(
    '{\n  "reason": "観測と提案の対応、scopeを選んだ理由",\n  "proposedBy": "external-runtime",\n  "items": []\n}',
  );
  const [previewReady, setPreviewReady] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const action = async (route: string, body: unknown) => {
    setBusy(true);
    try {
      await mutate(route, body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Journal Review · ${review.id.slice(-12)}`} onClose={onClose} wide>
      <div className="section-head compact">
        <Badge tone={review.status === 'pending' ? 'amber' : 'blue'}>
          {statusLabel(review.status)}
        </Badge>
        <CopyButton
          text={`AACLの ${review.id} をaacl_review_getで読み、JournalとSnapshotを分析してaacl_review_submitのitemsで改善提案を提出してください。変更ごとにoperation、proposedScope、proposedRelations、reason、evidence（journalIds/snapshotIds/explanation）を指定してください。根拠はReview対象のIDに限定し、観測範囲と提案範囲を区別してください。`}
          label="AIへの依頼をコピー"
        />
      </div>
      <div className="callout">
        Observed scopeは実行時の事実、Proposed scopeは提案者の判断です。
      </div>
      <details>
        <summary>観測されたscope / 根拠Journal {review.journalIds.length}件</summary>
        <Json value={review.observedScopes} />
        {data.journals
          .filter((j) => review.journalIds.includes(j.id))
          .map((j) => (
            <p key={j.id}>{j.observation}</p>
          ))}
      </details>
      <p>{review.reason}</p>
      {review.status === 'awaiting-proposal' ? (
        <>
          <div className="aside-note">
            <h3>AI Runtimeからの提案を待っています</h3>
            <p>
              MCPのaacl_review_get /
              aacl_review_submitを利用できます。手動でJSON提案を貼り付けることもできます。
            </p>
            <CopyButton text={review.id} label="Review IDをコピー" />
          </div>
          <details className="form-section">
            <summary>JSON提案を取り込む</summary>
            <textarea
              className="mono"
              rows={12}
              value={proposal}
              onChange={(e) => setProposal(e.target.value)}
            />
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                try {
                  void action(`/reviews/${review.id}/proposal`, JSON.parse(proposal));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              提案を取り込む
            </button>
          </details>
        </>
      ) : (
        <>
          <div className="change-summary">
            {(review.items
              ? [...new Set(review.items.flatMap((i) => i.changeKinds))]
              : ['upsert', 'delete']
            ).map((kind) => (
              <Badge key={kind}>
                {changeLabel(kind)} ·{' '}
                {review.items
                  ? review.items.filter((i) => i.changeKinds.includes(kind)).length
                  : review.operations.filter((o) => o.op === kind).length}
              </Badge>
            ))}
            <span className="muted small-text">提案者: {review.proposedBy}</span>
          </div>
          {review.operations.length === 0 ? (
            <p className="muted">Asset変更なしの提案です。</p>
          ) : (
            review.operations.map((op, i) => (
              <div className="proposal-change" key={i}>
                <h3>
                  {op.op === 'upsert' ? op.asset.name : op.id}{' '}
                  {!review.items && (
                    <Badge>
                      {op.op === 'delete'
                        ? 'removed'
                        : op.expectedRevision > 0
                          ? 'updated / binding change'
                          : 'added'}
                    </Badge>
                  )}
                </h3>
                {review.items?.[i] && (
                  <ProposalDetails item={review.items[i]} journals={data.journals} />
                )}
                <details>
                  <summary>変更内容のデータ</summary>
                  <Json value={op} />
                </details>
              </div>
            ))
          )}
          {review.operations.length > 0 && (
            <ProposalPreview
              reviewId={review.id}
              revisionKey={JSON.stringify(review.operations)}
              onReady={setPreviewReady}
            />
          )}
          {review.status === 'pending' && (
            <div className="modal-actions">
              <button
                disabled={busy}
                className="button"
                onClick={() => action(`/reviews/${review.id}/decision`, { approve: false })}
              >
                <X size={15} />
                却下する
              </button>
              <button
                disabled={busy || (review.operations.length > 0 && !previewReady)}
                className="button primary"
                onClick={() => action(`/reviews/${review.id}/decision`, { approve: true })}
              >
                <Check size={15} />
                承認して反映
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}
export function History({
  data,
  mutate,
  initialChangeId = '',
}: {
  data: Overview;
  mutate: Mutate;
  initialChangeId?: string;
}) {
  const [selected, setSelected] = useState<ChangeSet | null>(
    data.changesets.find((c) => c.id === initialChangeId) ?? null,
  );
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="panel">
        {data.changesets.length ? (
          data.changesets.map((c) => (
            <button
              key={c.id}
              className="history-row"
              onClick={() => {
                setSelected(c);
                setConfirm(false);
              }}
            >
              <span className="history-icon">
                <GitCommitHorizontal size={21} />
              </span>
              <div className="grow">
                <strong>{c.summary}</strong>
                <p>
                  {c.actor} · {relativeDate(c.createdAt)} · {c.id}
                </p>
              </div>
              <Badge tone={c.origin === 'journal-review' ? 'purple' : ''}>{c.origin}</Badge>
              <span className="muted small-text">{c.changes.length} assets</span>
              <ExternalLink size={15} />
            </button>
          ))
        ) : (
          <Empty title="変更履歴はまだありません">
            Assetの作成・編集・承認済み提案をChange Setとして記録します。
          </Empty>
        )}
      </div>
      {selected && (
        <Modal
          title="Change Set / Provenance"
          onClose={() => {
            setSelected(null);
            setError('');
          }}
          wide
        >
          <div className="eyebrow">{selected.id}</div>
          <h3>{selected.summary}</h3>
          <div className="button-row wrap">
            <Badge>{selected.origin}</Badge>
            <span className="muted small-text">
              {selected.actor} · {relativeDate(selected.approvedAt)}
            </span>
            {selected.gitCommit && <code>Git {selected.gitCommit.slice(0, 10)}</code>}
          </div>
          {selected.gitError && <div className="callout">{selected.gitError}</div>}
          {selected.reviewId && <p>Source review: {selected.reviewId}</p>}
          {selected.sourceJournals.length > 0 && (
            <details>
              <summary>根拠と観測scope</summary>
              <Json
                value={{ journals: selected.sourceJournals, observed: selected.observedScopes }}
              />
            </details>
          )}
          {selected.changes.map((c) => (
            <div key={c.id} className="history-change">
              <div className="section-head compact">
                <h3>{c.id}</h3>
                <Badge tone={c.kind === 'added' ? 'green' : c.kind === 'removed' ? 'red' : 'blue'}>
                  {c.kind}
                </Badge>
              </div>
              {selected.proposalItems?.find((i) => i.id === c.proposalItemId) && (
                <ProposalDetails
                  item={selected.proposalItems.find((i) => i.id === c.proposalItemId)!}
                  journals={data.journals}
                />
              )}
              <ChangeDiff change={c} />
            </div>
          ))}
          {confirm ? (
            <div className="callout">
              <p>
                このChange Setの{selected.changes.length}
                件を変更前に戻し、新しい復元履歴を作ります。後続変更があるAssetは復元を拒否します。
              </p>
              <div className="button-row">
                <button className="button" onClick={() => setConfirm(false)}>
                  キャンセル
                </button>
                <button
                  className="button danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await mutate('/rollback', { changeSetId: selected.id });
                      setSelected(null);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  復元を実行
                </button>
              </div>
            </div>
          ) : (
            <button className="button" onClick={() => setConfirm(true)}>
              <RotateCcw size={14} />
              このChange Setを元に戻す
            </button>
          )}
          {error && <div className="error">{error}</div>}
        </Modal>
      )}
    </>
  );
}
function ChangeDiff({ change }: { change: ChangeSet['changes'][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        差分を見る · r{change.before?.revision ?? '—'} → r{change.after?.revision ?? '—'}
      </summary>
      {open && (
        <RevisionDiff
          assetId={change.id}
          from={change.before?.revision ?? 0}
          to={change.after?.revision ?? 0}
        />
      )}
    </details>
  );
}
export function Diagnostics({ data }: { data: Overview }) {
  return (
    <>
      <div className="stats-grid">
        <div className="stat-card">
          <span>記録されたSnapshot</span>
          <strong>{data.snapshots.length}</strong>
          <small>Contextの保存数。実作業の試行数ではありません。</small>
        </div>
        <div className="stat-card">
          <span>平均Context量</span>
          <strong>
            {data.snapshots.length
              ? Math.round(
                  data.snapshots.reduce((s, x) => s + x.estimatedTokens, 0) / data.snapshots.length,
                ).toLocaleString()
              : '—'}
            <em>tokens</em>
          </strong>
          <small>文字種に基づく推定</small>
        </div>
        <div className="stat-card">
          <span>改善の観測</span>
          <strong>{data.journals.length}</strong>
          <small>Journalに記録された一次観測</small>
        </div>
        <div className="stat-card">
          <span>診断項目</span>
          <strong>{data.diagnostics.length}</strong>
          <small>情報・警告・エラー</small>
        </div>
      </div>
      <section className="panel">
        <div className="panel-head">
          <h3>Asset diagnostics</h3>
          <span className="small-text muted">検出と計測 · 自動変更なし</span>
        </div>
        {data.diagnostics.length ? (
          data.diagnostics.map((d) => (
            <div className="diagnostic-row" key={d.id}>
              <Badge
                tone={d.severity === 'error' ? 'red' : d.severity === 'warning' ? 'amber' : 'blue'}
              >
                {d.severity}
              </Badge>
              <div>
                <strong>{d.assetId ?? 'History'}</strong>
                <p>{d.message}</p>
              </div>
            </div>
          ))
        ) : (
          <Empty title="検出された問題はありません">
            Assetの依存関係・本文の重複・サイズ・接続設定を確認します。
          </Empty>
        )}
      </section>
      <WorkflowComparison data={data} />
      <AssetCosts data={data} />
      <div className="callout">
        AIが報告した試行は{data.runs.reduce((sum, run) => sum + (run.attempts?.length ?? 0), 0)}
        件です。
        以下のContext集計には、準備・中止・未完了の実行も含まれます。モデル、関連Assetの改訂、Projectの設定、作業規模の違いは実行の詳細で確認してください。Context量だけでは品質の改善を判定できません。
      </div>
      <section className="panel margin-top">
        <div className="panel-head">
          <h3>Workflow / revision別の観測</h3>
          <Badge>{data.metrics.length} groups</Badge>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {[
                  'Workflow',
                  'Rev.',
                  'Stage / Role',
                  'Snapshots',
                  'Avg. tokens',
                  'Defects',
                  'Missing',
                  'Retry / Return',
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.metrics.map((m, i) => (
                <tr key={i}>
                  <td>{m.workflow}</td>
                  <td>{m.revision ?? '—'}</td>
                  <td>
                    {m.stage}
                    <small>{m.role}</small>
                  </td>
                  <td>{m.snapshots}</td>
                  <td>{m.averageTokens}</td>
                  <td>{m.defects}</td>
                  <td>{m.missingSupport}</td>
                  <td>
                    {m.retries} / {m.returns}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.metrics.length && (
            <p className="table-empty">実行すると、同じWorkflow revisionの観測を比較できます。</p>
          )}
        </div>
      </section>
    </>
  );
}
