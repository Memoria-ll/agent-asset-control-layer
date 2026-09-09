import { useEffect, useState } from 'react';
import type { SettingHistoryEntry } from '../server/management.ts';
import type { Config } from '../server/domain.ts';
import { api, type Overview } from './api.ts';
import { Badge, Field, Modal } from './ui.tsx';
import { exactTime } from './RunEvidence.tsx';

type HistoryPage = {
  items: SettingHistoryEntry[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
};
const labels: Record<string, string> = {
  providers: 'Provider',
  accounts: 'Account',
  runtimes: 'Runtime',
  models: 'Model',
  bindings: '割り当て・適用条件',
  disabled: '無効にする資産',
  overrides: '置き換える資産',
  pathMappings: 'パスの対応',
  name: '名前',
  id: 'ID',
  role: 'Role',
  workflow: 'Workflow',
  model: 'Model',
  runtime: 'Runtime',
  provider: 'Provider',
  account: 'Account',
  endpoint: '接続先',
  enforcement: '強制できる制約',
  repository: 'リポジトリ操作',
  external: '外部操作',
  tools: 'ツール操作',
  from: '変換元',
  to: '変換先',
};
function SettingFacts({ value }: { value: unknown }) {
  if (value == null) return <span className="muted">未設定</span>;
  if (Array.isArray(value))
    return value.length ? (
      <div>
        {value.map((item, index) => (
          <div className="setting-item" key={index}>
            <SettingFacts value={item} />
          </div>
        ))}
      </div>
    ) : (
      <span className="muted">なし</span>
    );
  if (typeof value === 'object')
    return (
      <dl className="setting-facts">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>{labels[key] ?? key}</dt>
            <dd>
              {typeof item === 'object' && item !== null ? (
                <details>
                  <summary>{Array.isArray(item) ? `${item.length}件` : '設定を見る'}</summary>
                  <SettingFacts value={item} />
                </details>
              ) : (
                <SettingFacts value={item} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  return <span>{typeof value === 'boolean' ? (value ? '有効' : '無効') : String(value)}</span>;
}
function savedValue(entry: SettingHistoryEntry, side: 'before' | 'after') {
  const value = entry[side];
  if (entry.kind !== 'overlay' || !value || typeof value !== 'object') return value;
  const { disabled, overrides, bindings, pathMappings } = value as Record<string, unknown>;
  return { disabled, overrides, bindings, pathMappings: pathMappings ?? [] };
}
export function SettingsHistory({
  data,
  mutate,
}: {
  data: Overview;
  mutate: (route: string, body: unknown) => Promise<unknown>;
}) {
  const [history, setHistory] = useState<HistoryPage | null>(null);
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<{
    entry: SettingHistoryEntry;
    expectedVersion: number;
    current: unknown;
  } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setHistory(null);
    setError('');
    const params = new URLSearchParams({ offset: String(offset), limit: '10' });
    if (kind) params.set('kind', kind);
    if (query.trim()) params.set('query', query.trim());
    const timer = setTimeout(() => {
      api<HistoryPage>(`/settings/history?${params}`)
        .then((result) => {
          if (active) setHistory(result);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [offset, kind, query, revision, data.config, data.projects]);
  return (
    <section className="panel margin-top" aria-label="設定の変更履歴">
      <div className="panel-head">
        <h3>設定の変更履歴</h3>
        <Badge>{history?.total ?? '—'}件</Badge>
      </div>
      <div className="panel-body">
        <p className="muted">
          モデルの割り当てやProjectの例外設定を、変更理由・記録者・設定版とともに確認できます。復元も新しい変更として記録され、過去の実行のContextは保持されます。
        </p>
        <div className="form-grid">
          <Field label="設定履歴の種類">
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">すべて</option>
              <option value="config">Runtime・Model・割り当て</option>
              <option value="overlay">Projectの例外設定</option>
            </select>
          </Field>
          <Field label="設定履歴を検索">
            <input
              type="search"
              value={query}
              placeholder="変更理由・記録者"
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
            />
          </Field>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!history && !error && <p role="status">設定履歴を取得中…</p>}
        {history?.items.map((entry) => (
          <article key={entry.id} className="evidence-record">
            <div className="section-head compact">
              <h4>
                {entry.kind === 'config'
                  ? 'Runtime・Model・割り当て'
                  : `Projectの例外設定 · ${data.projects.find((p) => p.id === entry.targetId)?.name ?? entry.targetId}`}
              </h4>
              <Badge>設定版 {entry.version}</Badge>
            </div>
            <p>{entry.reason}</p>
            <p className="small-text muted">
              {entry.actor} · {exactTime(entry.createdAt)} · {entry.id}
            </p>
            {entry.userRequest && <p className="small-text">ユーザーの依頼: {entry.userRequest}</p>}
            {entry.restoreOf && <p className="small-text">復元元の変更: {entry.restoreOf}</p>}
            <details className="form-section">
              <summary>変更前と変更後を比較</summary>
              <div className="diff-grid">
                <section>
                  <h4>変更前</h4>
                  <SettingFacts value={savedValue(entry, 'before')} />
                </section>
                <section>
                  <h4>変更後</h4>
                  <SettingFacts value={savedValue(entry, 'after')} />
                </section>
              </div>
            </details>
            <button
              className="button small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                setReason('');
                try {
                  const current = await api<{ config: Config; settingsVersion: number }>('/config');
                  const currentValue =
                    entry.kind === 'config'
                      ? current.config
                      : (await api<Overview>('/state')).projects.find(
                          (p) => p.id === entry.targetId,
                        );
                  setSelected({
                    entry,
                    expectedVersion: current.settingsVersion,
                    current: currentValue,
                  });
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              変更前に戻す内容を確認
            </button>
          </article>
        ))}
        {history && !history.items.length && (
          <p className="muted">条件に一致する設定履歴はありません。</p>
        )}
        {history && (
          <div className="button-row wrap">
            <button
              className="button small"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 10))}
            >
              前の10件
            </button>
            <span className="small-text muted">
              {history.total ? history.offset + 1 : 0}–{history.offset + history.items.length} /{' '}
              {history.total}件
            </span>
            <button
              className="button small"
              disabled={history.nextOffset === null}
              onClick={() => setOffset(history.nextOffset!)}
            >
              次の10件
            </button>
          </div>
        )}
      </div>
      {selected && (
        <Modal title="設定の復元内容を確認" wide onClose={() => setSelected(null)}>
          <p className="callout">
            {selected.entry.kind === 'config'
              ? 'Runtime・Model・割り当ての設定全体'
              : 'このProjectの例外設定全体'}
            を、この変更の前に記録された値へ戻します。以後の変更も置き換わります。現在の設定版は
            {selected.expectedVersion}です。
          </p>
          <p>
            {selected.entry.reason} · {selected.entry.actor} · {exactTime(selected.entry.createdAt)}
          </p>
          <div className="diff-grid">
            <section>
              <h3>現在の設定</h3>
              <SettingFacts
                value={
                  selected.entry.kind === 'config'
                    ? selected.current
                    : savedValue({ ...selected.entry, before: selected.current }, 'before')
                }
              />
            </section>
            <section>
              <h3>復元する値</h3>
              <SettingFacts value={savedValue(selected.entry, 'before')} />
            </section>
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                await mutate('/settings/restore', {
                  id: selected.entry.id,
                  side: 'before',
                  expectedVersion: selected.expectedVersion,
                  reason,
                });
                setSelected(null);
                setOffset(0);
                setRevision((value) => value + 1);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="設定を復元する理由">
              <textarea
                required
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            {error && (
              <p className="error" role="alert">
                {error} 閉じて最新の設定を確認してください。
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="button" onClick={() => setSelected(null)}>
                キャンセル
              </button>
              <button className="button primary" disabled={busy}>
                変更前の設定を復元
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
