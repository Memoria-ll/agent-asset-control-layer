import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  CircleSlash,
  Download,
  RefreshCw,
  FileCode2,
  ArrowRight,
} from 'lucide-react';
import type { Context, Resolution } from '../server/domain.ts';
import type { Overview } from './api.ts';
import { api } from './api.ts';
import { Badge, CopyButton, DownloadButton, Empty, Field, Modal, statusLabel } from './ui.tsx';

export function ContextView({ data, initial = {} }: { data: Overview; initial?: Context }) {
  const [context, setContext] = useState<Context>(initial);
  const [requested, setRequested] = useState<string[]>([]);
  const [result, setResult] = useState<Resolution | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('included');
  const [bundle, setBundle] = useState<{ files: { path: string; content: string }[] } | null>(null);
  const [fileIndex, setFileIndex] = useState(0);
  const workflow = data.assets.find((a) => a.id === context.workflow);
  const stage = workflow?.workflow?.stages.find(
    (s) => s.id === (context.stage ?? workflow.workflow?.entryStage),
  );
  const change = (key: keyof Context, value: string) => {
    const next = { ...context, [key]: value || undefined };
    if (key === 'workflow') {
      delete next.stage;
      delete next.role;
      delete next.taskType;
    }
    if (key === 'stage') {
      delete next.role;
      delete next.taskType;
    }
    if (key === 'runtime') {
      delete next.model;
      delete next.provider;
    }
    setContext(next);
  };
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api<Resolution>('/resolve', { context, requested })
        .then((r) => {
          if (active) {
            setResult(r);
            setError('');
          }
        })
        .catch((e) => {
          if (active) {
            setError(e.message);
            setResult(null);
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [JSON.stringify(context), JSON.stringify(requested), data.assets]);
  return (
    <>
      <div className="context-layout">
        <aside className="panel context-controls">
          <div className="panel-head">
            <h3>解決する条件</h3>
            <button
              type="button"
              className="icon-button"
              aria-label="条件をリセット"
              title="条件をリセット"
              onClick={() => {
                setContext({});
                setRequested([]);
              }}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="panel-body">
            <Field label="Workflow">
              <select
                value={context.workflow ?? ''}
                onChange={(e) => change('workflow', e.target.value)}
              >
                <option value="">Advisory / 指定なし</option>
                {data.assets
                  .filter((a) => a.type === 'workflow')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · r{a.revision}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Stage">
              <select
                disabled={!workflow}
                value={context.stage ?? ''}
                onChange={(e) => change('stage', e.target.value)}
              >
                <option value="">Entry stage</option>
                {workflow?.workflow?.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Role">
              <select
                disabled={!!workflow}
                value={context.role ?? stage?.role ?? workflow?.workflow?.entryRole ?? ''}
                onChange={(e) => change('role', e.target.value)}
              >
                <option value="">指定なし</option>
                {data.assets
                  .filter((a) => a.type === 'role')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Task type">
              <select
                disabled={!!workflow}
                value={context.taskType ?? stage?.taskType ?? ''}
                onChange={(e) => change('taskType', e.target.value)}
              >
                <option value="">Workflowに従う / 指定なし</option>
                {data.assets
                  .filter((a) => a.type === 'task-type')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Runtime">
              <select
                value={context.runtime ?? ''}
                onChange={(e) => change('runtime', e.target.value)}
              >
                <option value="">Bindingに従う</option>
                {data.config.runtimes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model">
              <select value={context.model ?? ''} onChange={(e) => change('model', e.target.value)}>
                <option value="">Bindingに従う</option>
                {data.config.models
                  .filter(
                    (m) =>
                      !context.runtime ||
                      data.config.runtimes.find((r) => r.id === context.runtime)?.provider ===
                        m.provider,
                  )
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Project">
              <select
                value={context.project ?? ''}
                onChange={(e) => change('project', e.target.value)}
              >
                <option value="">Global</option>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Directory">
              <input
                value={context.directory ?? ''}
                onChange={(e) => change('directory', e.target.value)}
                placeholder="src/components"
              />
            </Field>
            <fieldset className="context-skills">
              <legend>
                追加で読み込むSkill <Badge>{requested.length}</Badge>
              </legend>
              <div className="choice-list">
                {data.assets
                  .filter((a) => a.activation === 'on-demand' || a.type === 'skill')
                  .map((a) => (
                    <label key={a.id} className={requested.includes(a.id) ? 'checked' : ''}>
                      <input
                        type="checkbox"
                        checked={requested.includes(a.id)}
                        onChange={(e) =>
                          setRequested(
                            e.target.checked
                              ? [...requested, a.id]
                              : requested.filter((id) => id !== a.id),
                          )
                        }
                      />
                      <span>{a.name}</span>
                    </label>
                  ))}
              </div>
            </fieldset>
          </div>
        </aside>
        <div className="context-result">
          <div className="context-summary">
            <div>
              <span className="eyebrow">RESOLVED CONTEXT</span>
              <h2>適用されるContext</h2>
              <p>明示した条件から、適用するAssetとその理由を確認できます。</p>
            </div>
            <div className="context-total">
              <strong>{result?.estimatedTokens.toLocaleString() ?? '—'}</strong>
              <span>estimated tokens</span>
            </div>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {loading && (
            <div className="muted small-text loading-line">
              <RefreshCw size={13} />
              解決中…
            </div>
          )}
          {result && (
            <>
              <div className="context-meta">
                <Badge tone={result.valid ? 'green' : 'red'}>
                  {result.valid ? <CheckCircle2 size={12} /> : <CircleSlash size={12} />}
                  {result.valid ? '解決済み' : '解決に問題があります'}
                </Badge>
                {Object.entries(result.context)
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <span key={k}>
                      {k}: <strong>{v}</strong>
                    </span>
                  ))}
              </div>
              {result.errors.length > 0 && (
                <div className="error">
                  {result.errors.map((e, i) => (
                    <div key={i}>{e}</div>
                  ))}
                </div>
              )}
              <section className="panel">
                <div className="tabs">
                  <button
                    className={tab === 'included' ? 'active' : ''}
                    onClick={() => setTab('included')}
                  >
                    適用されるAsset <span>{result.assets.length}</span>
                  </button>
                  <button
                    className={tab === 'excluded' ? 'active' : ''}
                    onClick={() => setTab('excluded')}
                  >
                    除外・競合{' '}
                    <span>{result.entries.filter((e) => e.status !== 'included').length}</span>
                  </button>
                  <button
                    className={tab === 'content' ? 'active' : ''}
                    onClick={() => setTab('content')}
                  >
                    最終Context
                  </button>
                </div>
                {tab === 'content' ? (
                  <div className="panel-body">
                    <CopyButton text={result.content} />
                    <pre className="context-content">
                      {result.content || '読み込まれる本文はありません。'}
                    </pre>
                  </div>
                ) : (
                  <div className="resolution-list">
                    {result.entries
                      .filter((e) =>
                        tab === 'included' ? e.status === 'included' : e.status !== 'included',
                      )
                      .map((e) => (
                        <details key={e.asset.id} className="resolution-entry">
                          <summary>
                            <div className={`asset-icon ${e.asset.type}`}>
                              <FileCode2 size={18} />
                            </div>
                            <div className="grow">
                              <strong>{e.asset.name}</strong>
                              <span className="muted small-text">
                                {e.asset.type} · {e.asset.id}@{e.asset.revision}
                              </span>
                            </div>
                            <Badge
                              tone={
                                e.status === 'included'
                                  ? 'green'
                                  : e.status === 'conflict'
                                    ? 'red'
                                    : ''
                              }
                            >
                              {statusLabel(e.status)}
                            </Badge>
                            <span className="token-count">~{e.estimatedTokens} t</span>
                          </summary>
                          <div className="resolution-reasons">
                            {e.reasons.map((r, i) => (
                              <p key={i}>
                                <ArrowRight size={13} />
                                {r}
                              </p>
                            ))}
                            {e.asset.content && (
                              <pre className="context-content">{e.asset.content}</pre>
                            )}
                          </div>
                        </details>
                      ))}
                    {result.entries.filter((e) =>
                      tab === 'included' ? e.status === 'included' : e.status !== 'included',
                    ).length === 0 && (
                      <Empty title="該当するAssetはありません">
                        条件を変更するか、Assetを登録してください。
                      </Empty>
                    )}
                  </div>
                )}
              </section>
              <div className="export-bar">
                <div>
                  <strong>Runtimeに渡すファイルを生成</strong>
                  <p>Canonical Assetから、選択したRuntime向けの表現を作成します。</p>
                </div>
                <div className="button-row">
                  {(['codex', 'claude'] as const).map((runtime) => (
                    <button
                      key={runtime}
                      className="button"
                      disabled={!result.valid || loading}
                      onClick={async () => {
                        try {
                          setBundle(
                            await api('/materialize', {
                              runtime,
                              context,
                              requested,
                              endpoint: `${location.origin}/mcp`,
                            }),
                          );
                          setFileIndex(0);
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      <Download size={14} />
                      {runtime === 'codex' ? 'Codex' : 'Claude'}
                    </button>
                  ))}
                </div>
              </div>
              <p className="small-text muted">
                Token数は文字種に基づく推定値です。Previewは実行を開始しません。
              </p>
            </>
          )}
        </div>
      </div>
      {bundle && (
        <Modal title="生成されたRuntimeファイル" onClose={() => setBundle(null)} wide>
          <div className="button-row wrap">
            {bundle.files.map((f, i) => (
              <button
                className={`button small ${fileIndex === i ? 'selected-button' : ''}`}
                key={f.path}
                onClick={() => setFileIndex(i)}
              >
                {f.path}
              </button>
            ))}
          </div>
          <div className="section-head compact">
            <code>{bundle.files[fileIndex].path}</code>
            <DownloadButton
              filename={bundle.files[fileIndex].path.split('/').at(-1)!}
              content={bundle.files[fileIndex].content}
            />
          </div>
          <pre className="code">{bundle.files[fileIndex].content}</pre>
          <DownloadButton
            filename="aacl-runtime-bundle.json"
            content={JSON.stringify(bundle, null, 2)}
          />
        </Modal>
      )}
    </>
  );
}
