import { useState } from 'react';
import type { Overview } from './api.ts';
import { Badge, Field } from './ui.tsx';

export function AssetCosts({ data }: { data: Overview }) {
  const [workflow, setWorkflow] = useState('');
  const [revision, setRevision] = useState('');
  const [stage, setStage] = useState('');
  const [role, setRole] = useState('');
  const source = data.assetMetrics;
  const scoped = source.filter((m) => !workflow || m.workflow === workflow);
  const rows = scoped.filter(
    (m) =>
      (!revision || String(m.workflowRevision) === revision) &&
      (!stage || m.stage === stage) &&
      (!role || m.role === role),
  );
  return (
    <section className="panel margin-top" aria-label="Asset別Context Cost">
      <div className="panel-head">
        <h3>Asset別Context Cost</h3>
        <Badge>{rows.reduce((n, m) => n + m.estimatedTokens, 0).toLocaleString()} tokens</Badge>
      </div>
      <div className="asset-cost-filters">
        <Field label="CostのWorkflow">
          <select
            value={workflow}
            onChange={(e) => {
              setWorkflow(e.target.value);
              setRevision('');
              setStage('');
              setRole('');
            }}
          >
            <option value="">すべて</option>
            {[...new Set(source.map((m) => m.workflow))].sort().map((w) => (
              <option key={w}>{w}</option>
            ))}
          </select>
        </Field>
        <Field label="Workflow revision">
          <select value={revision} onChange={(e) => setRevision(e.target.value)}>
            <option value="">すべて</option>
            {[...new Set(scoped.map((m) => m.workflowRevision).filter((r) => r !== null))]
              .sort((a, b) => a - b)
              .map((r) => (
                <option key={r} value={r}>
                  r{r}
                </option>
              ))}
          </select>
        </Field>
        <Field label="CostのStage">
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">すべて</option>
            {[...new Set(scoped.map((m) => m.stage))].sort().map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="CostのRole">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">すべて</option>
            {[...new Set(scoped.map((m) => m.role))].sort().map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
      </div>
      <p className="muted small-text panel-body">
        Snapshotに含まれたContextの推定量です。Skillの説明の提示、本文取得、使用の報告を別々に数えます。説明の提示は本文の読み込みや使用を意味しません。
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {[
                'Asset / revision',
                'Workflow / revision',
                'Stage / Role',
                'Context保存数',
                '説明の提示',
                '本文取得',
                '使用の報告',
                '累計tokens',
                '平均tokens',
              ].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => (
              <tr key={i}>
                <td>
                  {m.name}
                  <small>
                    {m.assetId} · r{m.assetRevision}
                  </small>
                </td>
                <td>
                  {m.workflow}
                  <small>{m.workflowRevision === null ? '—' : `r${m.workflowRevision}`}</small>
                </td>
                <td>
                  {m.stage}
                  <small>{m.role}</small>
                </td>
                <td>{m.snapshots}</td>
                <td>{m.type === 'skill' ? (m.candidatePresentations ?? 0) : '—'}</td>
                <td>{m.type === 'skill' ? (m.retrieved ?? 0) : '—'}</td>
                <td>{m.type === 'skill' ? (m.reportedUses ?? 0) : '—'}</td>
                <td>{m.estimatedTokens.toLocaleString()}</td>
                <td>{m.averageTokens.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="table-empty">該当するSnapshotはありません。</p>}
      </div>
    </section>
  );
}
