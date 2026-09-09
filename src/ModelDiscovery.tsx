import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Config } from '../server/domain.ts';
import type { Discovery, DiscoveredSource } from '../server/discovery.ts';
import { api } from './api.ts';
import { Badge, Field, Modal } from './ui.tsx';

const labels = {
  connected: '接続済み',
  'login-required': 'ログインが必要',
  unavailable: '未接続',
  error: '取得できません',
};
export function ModelDiscovery({
  config,
  onClose,
  onApply,
}: {
  config: Config;
  onClose: () => void;
  onApply: (config: Config) => void;
}) {
  const [result, setResult] = useState<Discovery | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [endpoints, setEndpoints] = useState(() =>
    Object.fromEntries(
      ['ollama', 'lmstudio', 'llamacpp'].map((id, i) => [
        id,
        config.runtimes.find((r) => r.id === id)?.endpoint ??
          `http://127.0.0.1:${[11434, 1234, 8080][i]}`,
      ]),
    ),
  );
  const [request, setRequest] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      config.runtimes
        .filter((r) => ['ollama', 'lmstudio', 'llamacpp'].includes(r.id) && r.endpoint)
        .map((r) => [r.id, r.endpoint!]),
    ),
  );
  const sourceConflict = (s: DiscoveredSource) =>
    config.runtimes.some((r) => r.id === s.runtime.id && r.provider !== s.provider.id);
  const existing = (id: string) => config.models.find((m) => m.id === id);
  const key = (s: DiscoveredSource, id: string) => JSON.stringify([s.id, id]);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError('');
    setSelected([]);
    setResult(null);
    api<Discovery>('/models/discover', request)
      .then((data) => {
        if (active) {
          setResult(data);
          setEndpoints((current) => ({
            ...current,
            ...Object.fromEntries(
              data.sources
                .filter((s) => s.runtime.endpoint)
                .map((s) => [s.id, s.runtime.endpoint!]),
            ),
          }));
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [request]);
  const add = () => {
    const next = structuredClone(config);
    for (const source of result?.sources ?? []) {
      const picked = source.models.filter((m) => selected.includes(key(source, m.id)));
      if (!picked.length) continue;
      if (sourceConflict(source)) {
        setError(`${source.name}のRuntime IDが別Providerで使われています。`);
        return;
      }
      if (!next.providers.some((p) => p.id === source.provider.id))
        next.providers.push(source.provider);
      const runtime = next.runtimes.find((r) => r.id === source.runtime.id);
      if (!runtime) next.runtimes.push(source.runtime);
      else if (source.runtime.endpoint) runtime.endpoint = source.runtime.endpoint;
      for (const model of picked) {
        if (next.models.some((m) => m.id === model.id)) {
          setError(`${model.id}が複数の接続先で選択されています。一つを選んでください。`);
          return;
        }
        next.models.push({ ...model, provider: source.provider.id });
      }
    }
    onApply(next);
  };
  return (
    <Modal title="モデルの自動認識" onClose={onClose} wide>
      <div className="section-head compact">
        <p className="muted">Coreと同じ環境のログインと、起動中のローカルサーバーを確認します。</p>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => setRequest({ ...endpoints })}
        >
          <RefreshCw size={15} />
          {busy ? '認識中…' : '再取得'}
        </button>
      </div>
      <details className="form-section">
        <summary>ローカルサーバーのURL</summary>
        <div className="form-grid">
          {Object.entries(endpoints).map(([id, url]) => (
            <Field
              key={id}
              label={`${{ ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp' }[id]} URL`}
            >
              <input
                type="url"
                value={url}
                disabled={busy}
                onChange={(e) => setEndpoints({ ...endpoints, [id]: e.target.value })}
              />
            </Field>
          ))}
        </div>
        <p className="muted small-text">
          URLを変更したら「再取得」を押してください。WSLからWindowsへ接続する場合は、Windows側のIPと公開ポートを指定できます。
        </p>
      </details>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div aria-busy={busy} className="discovery-sources">
        {busy && (
          <p role="status" className="muted">
            モデル一覧を取得しています…
          </p>
        )}
        {!busy &&
          result?.sources.map((source) => (
            <section key={source.id} className="discovery-source">
              <div className="section-head compact">
                <h3>{source.name}</h3>
                <Badge
                  tone={
                    source.status === 'connected' ? 'green' : source.status === 'error' ? 'red' : ''
                  }
                >
                  {labels[source.status]}
                </Badge>
              </div>
              <p className="muted small-text">{source.message}</p>
              {sourceConflict(source) && (
                <p className="error">同じRuntime IDが別Providerで使われています。</p>
              )}
              {source.runtime.endpoint &&
                config.runtimes.some(
                  (r) => r.id === source.runtime.id && r.endpoint !== source.runtime.endpoint,
                ) && (
                  <p className="small-text">
                    追加時にRuntimeのURLを {source.runtime.endpoint} へ更新します。
                  </p>
                )}
              {source.models.length > 0 && (
                <>
                  <button
                    type="button"
                    className="button small"
                    disabled={sourceConflict(source)}
                    onClick={() => {
                      const candidates = source.models
                        .filter((m) => !existing(m.id))
                        .map((m) => key(source, m.id));
                      setSelected(
                        candidates.every((k) => selected.includes(k))
                          ? selected.filter((k) => !candidates.includes(k))
                          : [...new Set([...selected, ...candidates])],
                      );
                    }}
                  >
                    この接続先をまとめて選択・解除
                  </button>
                  <div className="discovery-models">
                    {source.models.map((model) => (
                      <label key={model.id}>
                        <input
                          type="checkbox"
                          checked={selected.includes(key(source, model.id))}
                          disabled={!!existing(model.id) || sourceConflict(source)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, key(source, model.id)]
                                : selected.filter((k) => k !== key(source, model.id)),
                            )
                          }
                        />
                        <span>
                          <strong>{model.name}</strong>
                          <code>{model.id}</code>
                        </span>
                        {existing(model.id) && (
                          <Badge>
                            {existing(model.id)?.provider === source.provider.id
                              ? '登録済み'
                              : 'IDが重複'}
                          </Badge>
                        )}
                      </label>
                    ))}
                  </div>
                </>
              )}
              {source.status === 'connected' && !source.models.length && (
                <p className="muted small-text">登録できるモデルはありません。</p>
              )}
            </section>
          ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          閉じる
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || !selected.length}
          onClick={add}
        >
          選択した{selected.length}件を追加
        </button>
      </div>
    </Modal>
  );
}
