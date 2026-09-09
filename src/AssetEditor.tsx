import { useState } from 'react';
import type { Asset, AssetInput } from '../server/domain.ts';
import { assetTypes, dimensions, inputOf } from '../server/domain.ts';
import type { Overview } from './api.ts';
import { Field, Modal } from './ui.tsx';

export function AssetEditor({
  asset,
  type = 'rule',
  data,
  onClose,
  onSave,
}: {
  asset?: Asset;
  type?: AssetInput['type'];
  data: Overview;
  onClose: () => void;
  onSave: (body: unknown) => Promise<unknown>;
}) {
  const [form, setForm] = useState<any>(
    asset
      ? inputOf(asset)
      : {
          id: '',
          type,
          name: '',
          description: '',
          content: '',
          scope: {},
          priority: 0,
          enabled: true,
          mandatory: false,
          activation: type === 'skill' ? 'on-demand' : 'auto',
          compatibility: 'portable',
          dependencies: [],
          conflicts: [],
        },
  );
  const role = data.assets.find((a) => a.type === 'role')?.id ?? 'orchestrator';
  const [definition, setDefinition] = useState(
    JSON.stringify(
      asset?.workflow ?? {
        developmentCapable: true,
        entryRole: role,
        entryStage: 'work',
        completionCriteria: ['成果物が確認されている'],
        stages: [
          {
            id: 'work',
            name: '作業',
            role,
            requiredAssets: [],
            requiredCapabilities: [],
            completionCriteria: ['検証が完了している'],
            transitions: [],
          },
        ],
      },
      null,
      2,
    ),
  );
  const [capability, setCapability] = useState(
    JSON.stringify(
      asset?.capability ?? { provider: 'my-mcp', tools: [], connected: false, allowed: false },
      null,
      2,
    ),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key: string, value: unknown) => setForm((f: any) => ({ ...f, [key]: value }));
  const csv = (text: string) =>
    text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return (
    <Modal title={asset ? `Assetを編集 · ${asset.id}` : '新しいAsset'} onClose={onClose} wide>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const next = {
              ...form,
              ...(form.type === 'workflow' ? { workflow: JSON.parse(definition) } : {}),
              ...(form.type === 'capability' ? { capability: JSON.parse(capability) } : {}),
            };
            if (form.type !== 'workflow') delete next.workflow;
            if (form.type !== 'capability') delete next.capability;
            await onSave({
              operations: [{ op: 'upsert', asset: next, expectedRevision: asset?.revision ?? 0 }],
              summary: `${asset ? '編集' : '作成'}: ${form.name}`,
            });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <Field label="名前">
            <input
              required
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="実装時の変更方針"
            />
          </Field>
          <Field label="ID">
            <input
              required
              disabled={!!asset}
              pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}"
              value={form.id}
              onChange={(e) => set('id', e.target.value)}
              placeholder="implementation-policy"
            />
          </Field>
          <Field label="種別">
            <select
              value={form.type}
              disabled={!!asset}
              onChange={(e) => set('type', e.target.value)}
            >
              {assetTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="保存先">
            <select
              value={form.projectId ?? ''}
              onChange={(e) => set('projectId', e.target.value || undefined)}
            >
              <option value="">Global / Personal</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="説明">
          <input
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="このAssetの用途を短く説明"
          />
        </Field>
        <Field label="本文（Markdown）">
          <textarea
            rows={7}
            value={form.content}
            onChange={(e) => set('content', e.target.value)}
            placeholder="AIに渡す手順・責務・知識を記述してください。"
          />
        </Field>
        {form.type === 'workflow' && (
          <Field
            label="Workflow定義（JSON）"
            hint="Stage・Role・遷移・完了条件を定義します。Roleは先に登録してください。"
          >
            <textarea
              className="mono"
              rows={15}
              value={definition}
              onChange={(e) => setDefinition(e.target.value)}
            />
          </Field>
        )}
        {form.type === 'capability' && (
          <Field
            label="Capability定義（JSON）"
            hint="connectedは接続状態の明示申告、allowedは利用許可です。外部ツールの実呼び出しはRuntimeが担当します。"
          >
            <textarea
              className="mono"
              rows={8}
              value={capability}
              onChange={(e) => setCapability(e.target.value)}
            />
          </Field>
        )}
        <details className="form-section" open={!!asset}>
          <summary>適用条件 · Scope</summary>
          <p className="muted small-text">
            異なる条件はAND、カンマで区切った同じ条件の値はORです。空欄は制限なし。
          </p>
          <div className="form-grid">
            {dimensions.map((d) => (
              <Field key={d} label={d}>
                <input
                  value={(form.scope[d] ?? []).join(', ')}
                  onChange={(e) => {
                    const values = csv(e.target.value);
                    const scope = { ...form.scope };
                    if (values.length) scope[d] = values;
                    else delete scope[d];
                    set('scope', scope);
                  }}
                  placeholder={d === 'role' ? 'implementer, reviewer' : '制限なし'}
                />
              </Field>
            ))}
          </div>
        </details>
        <details className="form-section">
          <summary>優先度・依存関係・互換性</summary>
          <div className="form-grid">
            <Field label="Priority">
              <input
                type="number"
                min={-1000}
                max={1000}
                value={form.priority}
                onChange={(e) => set('priority', Number(e.target.value))}
              />
            </Field>
            <Field label="Activation">
              <select value={form.activation} onChange={(e) => set('activation', e.target.value)}>
                <option value="auto">auto</option>
                <option value="on-demand">on-demand</option>
              </select>
            </Field>
            <Field label="Dependencies">
              <input
                value={form.dependencies.join(', ')}
                onChange={(e) => set('dependencies', csv(e.target.value))}
              />
            </Field>
            <Field label="Conflicts">
              <input
                value={form.conflicts.join(', ')}
                onChange={(e) => set('conflicts', csv(e.target.value))}
              />
            </Field>
            <Field label="Compatibility">
              <select
                value={form.compatibility}
                onChange={(e) => set('compatibility', e.target.value)}
              >
                {['portable', 'claude-only', 'codex-only', 'adaptable', 'unsupported'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
            <div className="check-group">
              <label>
                <input
                  type="checkbox"
                  checked={form.mandatory}
                  onChange={(e) => set('mandatory', e.target.checked)}
                />
                mandatory
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => set('enabled', e.target.checked)}
                />
                有効
              </label>
            </div>
          </div>
        </details>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            キャンセル
          </button>
          <button disabled={busy} className="button primary">
            {busy ? '保存中…' : 'Assetを保存'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
