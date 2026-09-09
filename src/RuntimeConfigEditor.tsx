import { useState } from 'react';
import { Plus, Save, Trash2, Cpu, Users, Check, RefreshCw } from 'lucide-react';
import { configSchema, modelIdSchema, type Config } from '../server/domain.ts';
import type { Overview } from './api.ts';
import { Badge, Field, Modal, Empty } from './ui.tsx';
import { ModelDiscovery } from './ModelDiscovery.tsx';
import { modelSelectionConflict } from './ModelPolicy.tsx';

export function RuntimeConfigEditor({
  data,
  onSave,
}: {
  data: Overview;
  onSave: (config: Config) => Promise<unknown>;
}) {
  const [config, setConfig] = useState<Config>(() => structuredClone(data.config));
  const [savedConfig, setSavedConfig] = useState(JSON.stringify(data.config));
  const [tab, setTab] = useState<'models' | 'bindings'>('models');
  const [modelEditor, setModelEditor] = useState<{
    index: number;
    value: Config['models'][number];
  } | null>(null);
  const [bindingEditor, setBindingEditor] = useState<{
    index: number;
    value: Config['bindings'][number];
  } | null>(null);
  const [advanced, setAdvanced] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const dirty = JSON.stringify(config) !== savedConfig;
  const change = (next: Config) => {
    setConfig(next);
    setSaved(false);
    setError('');
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await onSave(config);
      setSavedConfig(JSON.stringify(config));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel runtime-editor">
      <div className="panel-head">
        <h3>モデルと役割の割り当て</h3>
        <button
          type="button"
          className="button small"
          onClick={() => {
            setAdvanced(JSON.stringify(config, null, 2));
            setError('');
          }}
        >
          詳細設定
        </button>
      </div>
      <div className="tabs" aria-label="Runtime設定の表示">
        <button
          type="button"
          className={tab === 'models' ? 'active' : ''}
          onClick={() => setTab('models')}
        >
          <Cpu size={15} />
          モデル <span>{config.models.length}</span>
        </button>
        <button
          type="button"
          className={tab === 'bindings' ? 'active' : ''}
          onClick={() => setTab('bindings')}
        >
          <Users size={15} />
          Roleへの割り当て <span>{config.bindings.length}</span>
        </button>
      </div>
      <div className="panel-body">
        {tab === 'models' ? (
          <>
            <div className="section-head compact">
              <p className="muted">
                モデル登録は任意です。指定しない場合はRuntimeの標準設定で起動します。
              </p>
              <div className="button-row wrap">
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() => setDiscovering(true)}
                >
                  <RefreshCw size={15} />
                  モデルを自動認識
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    setModelEditor({
                      index: -1,
                      value: { id: '', name: '', provider: config.providers[0]?.id ?? '' },
                    })
                  }
                >
                  <Plus size={15} />
                  モデルを追加
                </button>
              </div>
            </div>
            {config.models.length ? (
              <div className="config-list">
                {config.models.map((model, i) => (
                  <div className="config-item" key={model.id}>
                    <span className="asset-icon rule">
                      <Cpu size={19} />
                    </span>
                    <div className="grow">
                      <strong>{model.name}</strong>
                      <small>
                        {model.id} ·{' '}
                        {config.providers.find((p) => p.id === model.provider)?.name ??
                          model.provider}
                      </small>
                    </div>
                    <Badge>
                      {config.bindings.filter((b) => b.model === model.id).length} roles
                    </Badge>
                    <button
                      type="button"
                      className="button small"
                      disabled={busy}
                      onClick={() => setModelEditor({ index: i, value: { ...model } })}
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`${model.name}を削除`}
                      disabled={busy || config.bindings.some((b) => b.model === model.id)}
                      title={
                        config.bindings.some((b) => b.model === model.id)
                          ? 'Roleの割り当てを外すと削除できます'
                          : 'モデルを削除'
                      }
                      onClick={() =>
                        change({
                          ...config,
                          models: config.models.filter((_, index) => index !== i),
                        })
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="モデル未登録でも実行できます">
                RoleにRuntimeを割り当てれば、モデル引数なしで起動できます。特定のモデルを指定するときに登録してください。
              </Empty>
            )}
          </>
        ) : (
          <>
            <div className="section-head compact">
              <p className="muted">
                RoleとWorkflowにRuntimeを割り当てます。モデルの指定は任意です。
              </p>
              <button
                type="button"
                className="button"
                disabled={
                  busy || !config.runtimes.length || !data.assets.some((a) => a.type === 'role')
                }
                onClick={() => setBindingEditor({ index: -1, value: { role: '', runtime: '' } })}
              >
                <Plus size={15} />
                割り当てを追加
              </button>
            </div>
            {config.bindings.length ? (
              <div className="config-list">
                {config.bindings.map((b, i) => (
                  <div className="config-item" key={`${b.role}:${b.workflow ?? '*'}:${i}`}>
                    <span className="asset-icon role">
                      <Users size={19} />
                    </span>
                    <div className="grow">
                      <strong>{data.assets.find((a) => a.id === b.role)?.name ?? b.role}</strong>
                      <small>
                        {b.workflow
                          ? (data.assets.find((a) => a.id === b.workflow)?.name ?? b.workflow)
                          : 'すべてのWorkflow'}{' '}
                        · {config.runtimes.find((r) => r.id === b.runtime)?.name ?? b.runtime}
                      </small>
                    </div>
                    <span className="config-assigned-model">
                      {config.models.find((m) => m.id === b.model)?.name ??
                        b.model ??
                        'Runtimeの標準モデル'}
                      {modelSelectionConflict(config, b.model, b.runtime) && (
                        <span className="error small-text">
                          {modelSelectionConflict(config, b.model, b.runtime)}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="button small"
                      disabled={busy}
                      onClick={() => setBindingEditor({ index: i, value: { ...b } })}
                    >
                      変更
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      disabled={busy}
                      aria-label={`${b.role}の割り当てを削除`}
                      onClick={() =>
                        change({
                          ...config,
                          bindings: config.bindings.filter((_, index) => index !== i),
                        })
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="Roleへの割り当てはまだありません">
                RoleとRuntimeを選んで、実行時の既定を設定します。モデルを登録する必要はありません。
              </Empty>
            )}
          </>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="config-save-bar">
        <span aria-live="polite">
          {dirty ? (
            '未保存の変更があります'
          ) : saved ? (
            <>
              <Check size={14} />
              保存しました
            </>
          ) : (
            '変更は保存すると反映されます'
          )}
        </span>
        <div className="button-row">
          {dirty && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setConfig(JSON.parse(savedConfig));
                setError('');
              }}
            >
              変更を戻す
            </button>
          )}
          <button type="button" className="button primary" disabled={busy || !dirty} onClick={save}>
            <Save size={15} />
            {busy ? '保存中…' : '設定を保存'}
          </button>
        </div>
      </div>
      {modelEditor && (
        <ModelForm
          entry={modelEditor}
          config={config}
          onClose={() => setModelEditor(null)}
          onApply={(model) => {
            const previous = config.models[modelEditor.index];
            const models =
              modelEditor.index < 0
                ? [...config.models, model]
                : config.models.map((m, i) => (i === modelEditor.index ? model : m));
            const bindings =
              previous && previous.id !== model.id
                ? config.bindings.map((b) =>
                    b.model === previous.id ? { ...b, model: model.id } : b,
                  )
                : config.bindings;
            change({ ...config, models, bindings });
            setModelEditor(null);
          }}
        />
      )}
      {discovering && (
        <ModelDiscovery
          config={config}
          onClose={() => setDiscovering(false)}
          onApply={(next) => {
            change(next);
            setDiscovering(false);
            setTab('models');
          }}
        />
      )}
      {bindingEditor && (
        <BindingForm
          entry={bindingEditor}
          config={config}
          data={data}
          onClose={() => setBindingEditor(null)}
          onApply={(binding) => {
            change({
              ...config,
              bindings:
                bindingEditor.index < 0
                  ? [...config.bindings, binding]
                  : config.bindings.map((b, i) => (i === bindingEditor.index ? binding : b)),
            });
            setBindingEditor(null);
          }}
        />
      )}
      {advanced !== null && (
        <Modal
          title="Provider / Account / Runtimeの詳細設定"
          wide
          onClose={() => {
            setAdvanced(null);
            setError('');
          }}
        >
          <Field label="Runtime設定（JSON）">
            <textarea
              className="mono"
              rows={20}
              value={advanced}
              onChange={(e) => setAdvanced(e.target.value)}
            />
          </Field>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-actions">
            <button className="button" onClick={() => setAdvanced(null)}>
              キャンセル
            </button>
            <button
              className="button primary"
              onClick={() => {
                try {
                  change(configSchema.parse(JSON.parse(advanced)));
                  setAdvanced(null);
                } catch (e) {
                  setError(e instanceof Error ? e.message : '設定を確認してください');
                }
              }}
            >
              編集内容を適用
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function ModelForm({
  entry,
  config,
  onClose,
  onApply,
}: {
  entry: { index: number; value: Config['models'][number] };
  config: Config;
  onClose: () => void;
  onApply: (model: Config['models'][number]) => void;
}) {
  const [model, setModel] = useState(entry.value);
  const [error, setError] = useState('');
  const assigned = entry.index >= 0 && config.bindings.some((b) => b.model === entry.value.id);
  return (
    <Modal title={entry.index < 0 ? 'モデルを追加' : 'モデルを編集'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const next = {
            ...model,
            id: model.id.trim(),
            name: model.name.trim() || model.id.trim(),
          };
          if (!modelIdSchema.safeParse(next.id).success) {
            setError('Model IDは250文字以内で、空白や制御文字を含めずに指定してください。');
            return;
          }
          if (config.models.some((m, i) => i !== entry.index && m.id === next.id)) {
            setError('このモデルIDはすでに登録されています');
            return;
          }
          onApply(next);
        }}
      >
        <Field label="モデルID">
          <input
            autoFocus
            required
            maxLength={250}
            value={model.id}
            onChange={(e) => setModel({ ...model, id: e.target.value })}
            placeholder="Runtimeで使用するモデルID"
          />
        </Field>
        <Field label="表示名（任意）">
          <input
            value={model.name}
            onChange={(e) => setModel({ ...model, name: e.target.value })}
            placeholder="未入力ならモデルIDを表示"
          />
        </Field>
        <Field label="Provider">
          <select
            required
            disabled={assigned}
            value={model.provider}
            onChange={(e) => setModel({ ...model, provider: e.target.value, account: undefined })}
          >
            <option value="" disabled>
              選択してください
            </option>
            {config.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {config.accounts.some((a) => a.provider === model.provider) && (
          <Field label="Account">
            <select
              value={model.account ?? ''}
              onChange={(e) => setModel({ ...model, account: e.target.value || undefined })}
            >
              <option value="">指定なし</option>
              {config.accounts
                .filter((a) => a.provider === model.provider)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            キャンセル
          </button>
          <button className="button primary">{entry.index < 0 ? '追加する' : '変更する'}</button>
        </div>
      </form>
    </Modal>
  );
}

function BindingForm({
  entry,
  config,
  data,
  onClose,
  onApply,
}: {
  entry: { index: number; value: Config['bindings'][number] };
  config: Config;
  data: Overview;
  onClose: () => void;
  onApply: (binding: Config['bindings'][number]) => void;
}) {
  const [binding, setBinding] = useState(entry.value);
  const [error, setError] = useState('');
  const provider = config.models.find((m) => m.id === binding.model)?.provider;
  const runtimes = config.runtimes.filter((r) => !provider || r.provider === provider);
  const conflict = modelSelectionConflict(config, binding.model, binding.runtime);
  return (
    <Modal title="RoleにRuntime・モデルを割り当てる" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (conflict) return;
          if (
            config.bindings.some(
              (b, i) =>
                i !== entry.index && b.role === binding.role && b.workflow === binding.workflow,
            )
          ) {
            setError(
              'このRole / Workflowの割り当ては登録済みです。既存の割り当てを変更してください。',
            );
            return;
          }
          onApply(binding);
        }}
      >
        <Field label="Role">
          <select
            required
            value={binding.role}
            onChange={(e) => setBinding({ ...binding, role: e.target.value })}
          >
            <option value="" disabled>
              役割を選択
            </option>
            {data.assets
              .filter((a) => a.type === 'role')
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="適用するWorkflow">
          <select
            value={binding.workflow ?? ''}
            onChange={(e) => setBinding({ ...binding, workflow: e.target.value || undefined })}
          >
            <option value="">すべてのWorkflow</option>
            {data.assets
              .filter((a) => a.type === 'workflow')
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Model">
          <select
            value={binding.model ?? ''}
            onChange={(e) => {
              if (!e.target.value) {
                const next = { ...binding };
                delete next.model;
                setBinding(next);
                return;
              }
              const model = config.models.find((m) => m.id === e.target.value)!;
              const choices = config.runtimes.filter((r) => r.provider === model.provider);
              setBinding({
                ...binding,
                model: model.id,
                runtime: choices.some((r) => r.id === binding.runtime)
                  ? binding.runtime
                  : choices.length === 1
                    ? choices[0].id
                    : '',
              });
            }}
          >
            <option value="">指定なし · Runtimeの標準モデル</option>
            {config.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Runtime">
          <select
            required
            value={binding.runtime}
            onChange={(e) => setBinding({ ...binding, runtime: e.target.value })}
          >
            <option value="" disabled>
              Runtimeを選択
            </option>
            {runtimes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="muted small-text">
          指定なしの場合はモデル引数を付けずに起動します。実際のモデルはRuntimeの開始報告で確認します。
        </p>
        {conflict && (
          <p className="error" role="alert">
            {conflict}
          </p>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            キャンセル
          </button>
          <button className="button primary" disabled={!!conflict}>
            割り当てる
          </button>
        </div>
      </form>
    </Modal>
  );
}
