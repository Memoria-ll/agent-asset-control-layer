import { useEffect, useState } from 'react';
import type { Core } from '../server/core.ts';
import { api } from './api.ts';
import { Field, Badge } from './ui.tsx';
import './contracts.css';

type Diff = ReturnType<Core['assetDiff']>;
type History = ReturnType<Core['assetHistory']>;
const display = (value: unknown) =>
  value === null ? '—' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export function RevisionDiff({ assetId, from, to }: { assetId: string; from: number; to: number }) {
  const [result, setResult] = useState<Diff | null>(null);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(1000);
  useEffect(() => {
    let active = true;
    setResult(null);
    setError('');
    setLimit(1000);
    api<Diff>(`/assets/${encodeURIComponent(assetId)}/diff?from=${from}&to=${to}`)
      .then((r) => {
        if (active) setResult(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [assetId, from, to]);
  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!result)
    return (
      <p className="muted" role="status">
        差分を読み込み中…
      </p>
    );
  const added = result.content.lines.filter((l) => l.kind === 'added').length;
  const removed = result.content.lines.filter((l) => l.kind === 'removed').length;
  const visible = new Set<number>();
  result.content.lines.forEach((line, index) => {
    if (line.kind !== 'equal')
      for (
        let i = Math.max(0, index - 3);
        i <= Math.min(result.content.lines.length - 1, index + 3);
        i++
      )
        visible.add(i);
  });
  const indices = [...visible].sort((a, b) => a - b);
  return (
    <div className="revision-diff" aria-label="Revision差分">
      <div className="button-row wrap">
        <Badge tone="green">+{added}行</Badge>
        <Badge tone="red">−{removed}行</Badge>
        <Badge>設定 {result.fields.length}項目</Badge>
      </div>
      {result.fields.length > 0 && (
        <div className="table-scroll">
          <table className="field-diff">
            <thead>
              <tr>
                <th>項目</th>
                <th>変更前</th>
                <th>変更後</th>
              </tr>
            </thead>
            <tbody>
              {result.fields.map((f) => (
                <tr key={f.path}>
                  <th>{f.path}</th>
                  <td>
                    <pre>{display(f.before)}</pre>
                  </td>
                  <td>
                    <pre>{display(f.after)}</pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {added > 0 || removed > 0 ? (
        <>
          {result.content.coarse && (
            <p className="muted small-text">
              変更範囲が大きいため、変更前後のブロックで表示しています。
            </p>
          )}
          <div className="line-diff" tabIndex={0} aria-label="本文の行差分">
            {indices.slice(0, limit).map((i, n) => {
              const l = result.content.lines[i];
              return (
                <div key={i}>
                  {i > (indices[n - 1] ?? -1) + 1 && (
                    <div className="diff-gap">… 変更のない行を省略 …</div>
                  )}
                  <div className={`diff-line ${l.kind}`}>
                    <span className="line-number">{l.beforeLine ?? ''}</span>
                    <span className="line-number">{l.afterLine ?? ''}</span>
                    <span aria-hidden="true">
                      {l.kind === 'added' ? '+' : l.kind === 'removed' ? '−' : ' '}
                    </span>
                    <code>
                      {l.text.replace(/\r?\n$/, '')}
                      {!l.text.endsWith('\n') && <small className="no-newline"> ⏎なし</small>}
                    </code>
                  </div>
                </div>
              );
            })}
          </div>
          {indices.length > limit && (
            <button className="button small" onClick={() => setLimit(limit + 1000)}>
              続きを表示 · 残り{indices.length - limit}行
            </button>
          )}
        </>
      ) : (
        <p className="muted small-text">本文の変更はありません。</p>
      )}
    </div>
  );
}
export function AssetHistory({ assetId }: { assetId: string }) {
  const [history, setHistory] = useState<History | null>(null);
  const [from, setFrom] = useState(0),
    [to, setTo] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setHistory(null);
    setError('');
    api<History>(`/assets/${encodeURIComponent(assetId)}/history`)
      .then((h) => {
        if (!active) return;
        setFrom(
          h.currentRevision === 0 ? h.revisions[0].revision : (h.revisions[1]?.revision ?? 0),
        );
        setTo(h.currentRevision);
        setHistory(h);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [assetId]);
  return (
    <section className="asset-comparison">
      <h3>Revisionを比較</h3>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {history && (
        <>
          <div className="form-grid">
            {[
              { label: '比較元', value: from, set: setFrom },
              { label: '比較先', value: to, set: setTo },
            ].map((field) => (
              <Field key={field.label} label={field.label}>
                <select value={field.value} onChange={(e) => field.set(Number(e.target.value))}>
                  <option value={0}>存在しない状態</option>
                  {history.revisions.map((a) => (
                    <option key={a.revision} value={a.revision}>
                      r{a.revision} · {new Date(a.updatedAt).toLocaleString('ja-JP')}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          {from || to ? (
            <RevisionDiff assetId={assetId} from={from} to={to} />
          ) : (
            <p className="muted">比較するrevisionを選択してください。</p>
          )}
        </>
      )}
    </section>
  );
}
