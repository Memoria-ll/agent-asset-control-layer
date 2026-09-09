import { useEffect, useState } from 'react';
import type { Core } from '../server/core.ts';
import { api, type Overview } from './api.ts';
import { Badge, Field } from './ui.tsx';

type Comparison = ReturnType<Core['workflowMetrics']>;
export function WorkflowComparison({ data }: { data: Overview }) {
  const [workflow, setWorkflow] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState<Comparison | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setResult(null);
    setError('');
    if (from && to && from > to) {
      setError('期間の開始は終了以前にしてください。');
      return;
    }
    const query = new URLSearchParams();
    if (workflow) query.set('workflowId', workflow);
    if (from) query.set('from', new Date(`${from}T00:00:00`).toISOString());
    if (to) query.set('to', new Date(`${to}T23:59:59.999`).toISOString());
    api<Comparison>(`/metrics/workflows?${query}`)
      .then((value) => {
        if (active) setResult(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [workflow, from, to, data.runs, data.journals]);
  const names = new Map(data.assets.map((a) => [a.id, a.name]));
  return (
    <section className="panel margin-top" aria-label="Workflowの比較条件と実試行">
      <div className="panel-head">
        <h3>Workflowの比較条件と実試行</h3>
        <Badge>作業開始の報告に基づく集計</Badge>
      </div>
      <div className="panel-body">
        <div className="form-grid">
          <Field label="比較するWorkflow">
            <select value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
              <option value="">すべて</option>
              {[
                ...new Map(
                  data.runs
                    .filter((r) => r.workflow)
                    .map((r) => [r.workflow!.id, r.workflow!.name]),
                ).entries(),
              ].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="実行開始日の範囲・開始">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="実行開始日の範囲・終了">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!result && !error && <p role="status">比較データを取得中…</p>}
        {result && (
          <>
            <p className="callout">
              対象: {result.population.runs}件の実行（完了 {result.population.completed}件、中止{' '}
              {result.population.cancelled}件、進行中 {result.population.active}
              件）。開始日で選択しています。{!from && !to && '期間は全期間です。'}
              同じ実行が異なる条件の行に現れるため、行の実行数は単純合計できません。
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {[
                      'Workflow / 版',
                      '比較条件',
                      '実行数',
                      '準備Context保存',
                      'AIの試行',
                      '結果 / 失敗',
                      '人間の判断待ち',
                      '欠陥 / 差し戻し',
                      '試行ごとの推定Context量',
                    ].map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.groups.map((group, index) => (
                    <tr key={index}>
                      <td>
                        {names.get(group.workflowId ?? '') ?? group.workflowId ?? '相談・準備'}
                        <small>r{group.revision ?? '—'}</small>
                      </td>
                      <td>
                        <details>
                          <summary>
                            {data.projects.find((p) => p.id === group.project)?.name ??
                              group.project ??
                              'Global'}{' '}
                            · 実際:{' '}
                            {data.config.models.find((m) => m.id === group.model)?.name ??
                              group.model ??
                              '未報告'}
                          </summary>
                          <p>要求モデル: {group.requestedModel ?? '指定なし · Runtime標準'}</p>
                          <p>
                            Runtime: {group.runtime ?? '未記録'} · 設定版:{' '}
                            {group.settingsVersion ?? '未記録'}
                          </p>
                          <ul>
                            {group.assetRevisions.map((asset) => (
                              <li key={asset}>{asset}</li>
                            ))}
                          </ul>
                        </details>
                      </td>
                      <td>
                        {group.runs}件
                        <small>
                          完了 {group.completed} / 中止 {group.cancelled}
                        </small>
                      </td>
                      <td>{group.preparations}件</td>
                      <td>{group.attempts}件</td>
                      <td>
                        {group.results} / {group.failedAttempts}
                      </td>
                      <td>{group.waitingUser}件</td>
                      <td>
                        {group.defects} / {group.returns}
                      </td>
                      <td>
                        {group.averageAttemptContextTokens === null
                          ? '開始報告なし'
                          : `${group.averageAttemptContextTokens.toLocaleString()} tokens`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!result.groups.length && <p className="muted">条件に一致する記録はありません。</p>}
            <p className="muted small-text">{result.interpretation}</p>
          </>
        )}
      </div>
    </section>
  );
}
