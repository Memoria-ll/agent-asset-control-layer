import type { Run, Snapshot } from '../server/domain.ts';
import type { Overview } from './api.ts';
import { Badge, CopyButton } from './ui.tsx';

export const executionLabels = {
  prepared: '準備済み',
  'delivery-pending': 'AIへの送信待ち',
  running: 'AIが作業開始を報告',
  'result-received': '結果を受信',
  failed: '実行失敗',
  'waiting-user': '人間の判断待ち',
};
export function runName(run: Run, data?: Overview) {
  return (
    run.workflow?.name ??
    run.skill?.name ??
    data?.assets.find((a) => a.id === run.skillId)?.name ??
    run.skillId ??
    '相談・準備'
  );
}
export function executionLabel(run: Run) {
  return run.executionStatus
    ? executionLabels[run.executionStatus]
    : run.runtimeHandoffAt
      ? '引き継ぎ取得済み・作業開始は未確認'
      : '準備済み';
}
export function exactTime(at: string) {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? at
    : `${date.toLocaleString('ja-JP', { hour12: false })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
}
export function snapshotLabel(snapshot: Overview['snapshots'][number], data: Overview) {
  const run = data.runs.find((r) => r.id === snapshot.runId);
  const attempt = run?.attempts?.find((a) => a.snapshotId === snapshot.id);
  const stage = run?.workflow?.workflow?.stages.find((s) => s.id === snapshot.stage);
  return `${run?.title ?? snapshot.task ?? snapshot.runId} · ${stage?.name ?? snapshot.stage ?? '相談・準備'} · ${attempt ? `試行 ${attempt.id}` : '試行未記録'} · ${snapshot.context.model ?? 'モデル未記録'} · ${exactTime(snapshot.createdAt)} · ${snapshot.id}`;
}
export function EvidenceValues({
  values,
  label,
}: {
  values?: Record<string, string>;
  label: string;
}) {
  if (!values || !Object.keys(values).length) return null;
  return (
    <dl className="evidence-values" aria-label={label}>
      {Object.entries(values).map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>
            <pre className="evidence-text">{value}</pre>
          </dd>
        </div>
      ))}
    </dl>
  );
}
export const eventLabels: Record<string, string> = {
  advance: '次の工程へ',
  return: '差し戻し',
  retry: '再試行',
  reject: '却下',
  complete: '完了',
  cancel: '中止',
  'runtime-started': 'AIが作業開始を報告',
  'runtime-resumed': 'AIが作業を再開',
  'runtime-result': '結果を受信',
  'runtime-failed': '実行失敗',
  'waiting-user': '人間の判断待ち',
  'runtime-waiting-user': '人間の判断待ち',
  handoff: '引き継ぎを記録',
};
export function RunEvidence({ run }: { run: Run }) {
  const records = run.events.filter(
    (event) =>
      Object.keys(event.criteria ?? {}).length || Object.keys(event.artifacts ?? {}).length,
  );
  return (
    <section className="panel" aria-label="保存された完了根拠">
      <div className="panel-head">
        <h3>保存された完了根拠</h3>
        <Badge>{records.length}件の判断記録</Badge>
      </div>
      <div className="panel-body">
        <p className="muted small-text">
          記録時点の条件と成果物です。差し戻し前の根拠は、修正後の合格を示しません。根拠の本文に記録されていない検証方法は未確認です。
          ここにあるのは記録者から報告された根拠です。AACLがテストや成果物を自動検証したことを示すものではありません。
        </p>
        {records.map((event, i) => (
          <article className="evidence-record" key={i}>
            <div className="section-head compact">
              <h4>
                {eventLabels[event.kind] ?? event.kind} ·{' '}
                {run.workflow?.workflow?.stages.find((s) => s.id === event.from)?.name ??
                  event.from ??
                  runName(run)}
              </h4>
              <Badge>{event.kind === 'complete' ? '完了時の記録' : '過去の判断'}</Badge>
            </div>
            <div className="evidence-meta">
              <span>記録者: {event.actor ?? '未記録'}</span>
              <span>試行: {event.attemptId ?? '未記録'}</span>
              <time dateTime={event.at}>{exactTime(event.at)}</time>
              {event.observedAt && <span>観測時刻: {exactTime(event.observedAt)}</span>}
              {event.snapshotId && <span>Context: {event.snapshotId}</span>}
            </div>
            {event.note && <p>{event.note}</p>}
            <EvidenceValues values={event.criteria} label="条件と根拠" />
            <details>
              <summary>この判断で記録した成果物</summary>
              <EvidenceValues values={event.artifacts} label="判断時の成果物" />
              {!Object.keys(event.artifacts ?? {}).length && (
                <p className="muted">成果物は未記録です。</p>
              )}
            </details>
          </article>
        ))}
        {!records.length &&
          (Object.keys(run.criteria).length ? (
            <>
              <p className="callout">
                旧形式で保存された根拠です。記録した工程・試行・記録者は特定できません。
              </p>
              <EvidenceValues values={run.criteria} label="旧形式の条件と根拠" />
            </>
          ) : (
            <p className="muted">保存された根拠はありません。</p>
          ))}
      </div>
    </section>
  );
}
export function RunAttempts({ run }: { run: Run }) {
  return (
    <section className="panel" aria-label="AIの試行">
      <div className="panel-head">
        <h3>AIの試行</h3>
        <Badge>{run.attempts?.length ?? 0}件</Badge>
      </div>
      <div className="panel-body">
        <p className="muted small-text">
          Runtimeが報告した試行を表示します。Contextの保存・閲覧回数とは別の記録です。
        </p>
        {run.attempts?.length ? (
          run.attempts.map((attempt) => (
            <article key={attempt.id} className="evidence-record">
              <strong>
                {run.workflow?.workflow?.stages.find((s) => s.id === attempt.stage)?.name ??
                  attempt.stage ??
                  runName(run)}
              </strong>
              <Badge>
                {
                  {
                    running: '作業中',
                    result: '結果受信',
                    failed: '失敗',
                    'waiting-user': '人間の判断待ち',
                  }[attempt.status]
                }
              </Badge>
              <p className="evidence-meta">
                <span>試行: {attempt.id}</span>
                <span>
                  {attempt.model ?? 'モデル未記録'} · {attempt.runtime ?? 'Runtime未記録'}
                </span>
              </p>
              <p className="small-text">
                開始: {exactTime(attempt.startedAt)}
                {attempt.finishedAt && ` · 終了: ${exactTime(attempt.finishedAt)}`}
              </p>
              <p>{attempt.note}</p>
            </article>
          ))
        ) : (
          <p className="muted">作業開始を報告した試行はありません。</p>
        )}
      </div>
    </section>
  );
}
export function SavedContext({ snapshot }: { snapshot: Snapshot }) {
  return (
    <>
      <p className="small-text muted">
        {snapshot.id} · {exactTime(snapshot.createdAt)}
      </p>
      <p>
        {snapshot.project?.name} {snapshot.project?.root}
      </p>
      <div className="evidence-meta">
        {Object.entries(snapshot.resolution.context)
          .filter(([, value]) => value)
          .map(([dimension, value]) => (
            <span key={dimension}>
              {dimension}: {value}
            </span>
          ))}
      </div>
      <h3>今回の指示</h3>
      {snapshot.settings && (
        <details>
          <summary>保存時の設定 · v{snapshot.settings.version}</summary>
          <p>
            Project: {snapshot.settings.project?.name ?? 'Global'} ·{' '}
            {snapshot.settings.project?.root}
          </p>
          <p>無効にした資産: {snapshot.settings.project?.disabled.join(', ') || 'なし'}</p>
          <ul>
            {Object.entries(snapshot.settings.project?.overrides ?? {}).map(([before, after]) => (
              <li key={before}>
                置き換え: {before} → {after}
              </li>
            ))}
          </ul>
          <ul>
            {snapshot.settings.config.bindings.map((binding, index) => (
              <li key={index}>
                {binding.role} · {binding.model} · {binding.runtime} · {binding.workflow ?? '共通'}
              </li>
            ))}
          </ul>
        </details>
      )}
      <pre className="context-content">{snapshot.task}</pre>
      <h3>渡したContext</h3>
      <CopyButton text={snapshot.resolution.content} label="Contextをコピー" />
      <pre className="context-content">{snapshot.resolution.content}</pre>
      <details>
        <summary>適用したAssetと理由</summary>
        {snapshot.resolution.entries.map((entry) => (
          <article className="evidence-record" key={entry.asset.id}>
            <strong>
              {entry.asset.name} · r{entry.asset.revision}
            </strong>
            <Badge>{entry.status}</Badge>
            {entry.reasons.map((reason, i) => (
              <p key={i}>{reason}</p>
            ))}
          </article>
        ))}
      </details>
      <details>
        <summary>保存時の成果物</summary>
        <EvidenceValues values={snapshot.artifacts} label="保存時の成果物" />
      </details>
    </>
  );
}
