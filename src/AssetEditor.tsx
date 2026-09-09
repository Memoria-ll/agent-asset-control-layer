import { useState } from 'react';
import type { Asset, AssetInput } from '../server/domain.ts';
import { assetTypes, dimensions, inputOf } from '../server/domain.ts';
import type { Overview } from './api.ts';
import { Field, Modal } from './ui.tsx';
import { TokenPicker, type Choice } from './TokenPicker.tsx';
import { WorkflowEditor } from './WorkflowEditor.tsx';
import { AssetContractEditor, defaultContract, contractKey } from './AssetContracts.tsx';
import { RelationEditor, AssetFiles, ScopeDetails } from './AssetRelations.tsx';

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
          ...defaultContract(type),
        },
  );
  const role = data.assets.find((a) => a.type === 'role')?.id ?? 'orchestrator';
  const [definition, setDefinition] = useState<NonNullable<AssetInput['workflow']>>(
    structuredClone(
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
  const [addingRole, setAddingRole] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (key: string, value: unknown) => setForm((f: any) => ({ ...f, [key]: value }));
  const choicesFor = (dimension: string): Choice[] => {
    const items = (items: { id: string; name: string }[]) =>
      items.map((a) => ({ id: a.id, label: a.name }));
    if (dimension === 'project') return items(data.projects);
    if (dimension === 'provider') return items(data.config.providers);
    if (dimension === 'runtime') return items(data.config.runtimes);
    if (dimension === 'model') return items(data.config.models);
    if (dimension === 'stage') {
      const workflows = data.assets.filter(
        (a) => a.workflow && (!form.scope.workflow?.length || form.scope.workflow.includes(a.id)),
      );
      return [
        ...new Map(
          workflows.flatMap((w) =>
            w.workflow!.stages.map((s) => [s.id, { id: s.id, label: s.name }] as const),
          ),
        ).values(),
      ];
    }
    return items(
      data.assets.filter((a) => a.type === (dimension === 'taskType' ? 'task-type' : dimension)),
    );
  };
  const editor = (
    <Modal title={asset ? `Assetを編集 · ${asset.id}` : '新しいAsset'} onClose={onClose} wide>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const next = {
              ...form,
              ...(form.type === 'workflow' ? { workflow: definition } : {}),
              ...(form.type === 'capability' ? { capability: JSON.parse(capability) } : {}),
            };
            if (form.type !== 'workflow') delete next.workflow;
            if (form.type !== 'capability') delete next.capability;
            for (const key of ['skill', 'role', 'taskType'])
              if (key !== contractKey(form.type)) delete next[key];
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
              disabled={!!asset && asset.type !== 'other'}
              onChange={(e) =>
                setForm({ ...form, type: e.target.value, ...defaultContract(e.target.value) })
              }
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
        {form.type === 'workflow' && (
          <WorkflowEditor
            value={definition}
            assets={data.assets}
            onChange={setDefinition}
            onCreateRole={() => setAddingRole(true)}
          />
        )}
        <AssetContractEditor value={form} assets={data.assets} onChange={set} />
        <RelationEditor
          value={form}
          assets={data.assets}
          onChange={(relations) => set('relations', relations)}
        />
        {(form.files || form.sources) && <AssetFiles asset={form} />}
        <details className="form-section" open={form.type !== 'workflow'}>
          <summary>説明・本文</summary>
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
        </details>
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
            異なる条件はAND、同じ条件の複数値はORです。候補から選ぶか、Enterで追加できます。
          </p>
          <div className="form-grid">
            {dimensions
              .filter((d) => form.type !== 'skill' || !['role', 'model'].includes(d))
              .map((d) => (
                <Field key={d} label={d}>
                  <TokenPicker
                    value={form.scope[d] ?? []}
                    choices={choicesFor(d)}
                    onChange={(values) => {
                      const scope = { ...form.scope };
                      if (values.length) scope[d] = values;
                      else delete scope[d];
                      set('scope', scope);
                    }}
                    placeholder="指定なし · 全体に適用"
                  />
                </Field>
              ))}
          </div>
          {form.type === 'skill' && (
            <>
              <p className="muted small-text">
                Role・Modelとの紐づけは上位の関係画面から設定します。保存済みの適用条件は保持され、既に選ばれたRole・Modelに対する制約として働きます。
              </p>
              <ScopeDetails scope={{ role: form.scope.role, model: form.scope.model }} />
            </>
          )}
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
              <TokenPicker
                value={form.dependencies}
                choices={data.assets
                  .filter(
                    (a) =>
                      a.id !== form.id &&
                      !['role', 'workflow'].includes(a.type) &&
                      (form.type !== 'skill' || a.type !== 'task-type'),
                  )
                  .map((a) => ({ id: a.id, label: a.name }))}
                onChange={(values) => set('dependencies', values)}
              />
            </Field>
            <Field label="Conflicts">
              <TokenPicker
                value={form.conflicts}
                choices={data.assets
                  .filter((a) => a.id !== form.id)
                  .map((a) => ({ id: a.id, label: a.name }))}
                onChange={(values) => set('conflicts', values)}
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
  return (
    <>
      {editor}
      {addingRole && (
        <AssetEditor
          type="role"
          data={data}
          onClose={() => setAddingRole(false)}
          onSave={async (body) => {
            if (
              (body as { operations: { asset: AssetInput }[] }).operations[0].asset.type !== 'role'
            )
              throw new Error(
                'この画面では担当Roleを追加してください。種別をroleに戻してください。',
              );
            const result = await onSave(body);
            const id = (body as { operations: { asset: AssetInput }[] }).operations[0].asset.id;
            setDefinition((current) => ({
              ...current,
              entryRole: data.assets.some((a) => a.type === 'role' && a.id === current.entryRole)
                ? current.entryRole
                : id,
              stages: current.stages.map((s) =>
                data.assets.some((a) => a.type === 'role' && a.id === s.role)
                  ? s
                  : { ...s, role: id },
              ),
            }));
            return result;
          }}
        />
      )}
    </>
  );
}
