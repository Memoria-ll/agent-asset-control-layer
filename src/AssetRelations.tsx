import { useState } from 'react';
import type { Asset, AssetInput, Scope } from '../server/domain.ts';
import { dimensions, inputOf } from '../server/domain.ts';
import type { Overview } from './api.ts';
import { Badge, CopyButton, Field } from './ui.tsx';
import { TokenPicker } from './TokenPicker.tsx';

type Relation = NonNullable<AssetInput['relations']>[number];
const kinds = { required: '必須利用', conditional: '条件付き利用', reference: '資料参照' };
const lowerAsset = (asset: Asset) =>
  ['skill', 'rule', 'knowledge', 'policy', 'template', 'capability', 'other'].includes(asset.type);
export function ScopeDetails({ scope }: { scope?: Scope }) {
  return (
    <div className="scope-pills">
      {Object.entries(scope ?? {})
        .filter(([, values]) => values?.length)
        .map(([key, values]) => (
          <span key={key}>
            {key}: {values?.join(', ')}
          </span>
        ))}
    </div>
  );
}
export function RelationEditor({
  value,
  assets,
  onChange,
}: {
  value: AssetInput;
  assets: Asset[];
  onChange: (relations: Relation[]) => void;
}) {
  const relations = value.relations ?? [];
  const targets = assets.filter(
    (asset) =>
      asset.id !== value.id &&
      (value.type === 'skill' ? asset.type === 'skill' : lowerAsset(asset)),
  );
  const update = (index: number, patch: Partial<Relation>) =>
    onChange(relations.map((relation, i) => (i === index ? { ...relation, ...patch } : relation)));
  return (
    <section className="form-section" aria-label="資産の関係を編集">
      <div className="section-head compact">
        <h3>利用する資産との関係</h3>
        <Badge>{relations.length}件</Badge>
      </div>
      <p className="muted small-text">
        担当とモデルは上位のWorkflow・Roleで決まります。ここでは、その条件の下で利用・参照する資産を設定します。資料参照は手順の自動実行を意味しません。
      </p>
      {relations.map((relation, index) => (
        <fieldset className="relation-editor" key={index}>
          <legend>
            関係 {index + 1} · {relation.origin === 'extracted' ? '本文から抽出' : '手動設定'}
          </legend>
          <div className="form-grid">
            <Field label={`関係 ${index + 1}の対象`}>
              <select
                required
                value={relation.target}
                onChange={(e) => update(index, { target: e.target.value })}
              >
                <option value="">資産を選択</option>
                {!targets.some((a) => a.id === relation.target) && relation.target && (
                  <option value={relation.target}>{relation.target}（既存の参照）</option>
                )}
                {targets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name} · {asset.type}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`関係 ${index + 1}の意味`}>
              <select
                value={relation.kind}
                onChange={(e) => update(index, { kind: e.target.value as Relation['kind'] })}
              >
                {Object.entries(kinds).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field
            label={`関係 ${index + 1}の条件`}
            hint="条件付き利用では、利用する場面を具体的に記録してください。"
          >
            <input
              required={
                relation.kind === 'conditional' && !Object.keys(relation.scope ?? {}).length
              }
              value={relation.condition ?? ''}
              onChange={(e) => update(index, { condition: e.target.value || undefined })}
              placeholder="公開APIを変更するとき"
            />
          </Field>
          <Field label={`関係 ${index + 1}の理由`}>
            <textarea
              required
              rows={2}
              value={relation.reason}
              onChange={(e) => update(index, { reason: e.target.value })}
            />
          </Field>
          <details>
            <summary>適用条件と出所</summary>
            <div className="form-grid">
              {dimensions
                .filter((d) => value.type !== 'skill' || !['role', 'model'].includes(d))
                .map((dimension) => (
                  <Field key={dimension} label={`関係 ${index + 1} · ${dimension}`}>
                    <TokenPicker
                      value={relation.scope?.[dimension] ?? []}
                      onChange={(values) => {
                        const scope = { ...relation.scope };
                        if (values.length) scope[dimension] = values;
                        else delete scope[dimension];
                        update(index, { scope: Object.keys(scope).length ? scope : undefined });
                      }}
                    />
                  </Field>
                ))}
            </div>
            {value.type === 'skill' && (
              <ScopeDetails scope={{ role: relation.scope?.role, model: relation.scope?.model }} />
            )}
            <Field label={`関係 ${index + 1}の出所`}>
              <select
                value={relation.origin}
                onChange={(e) => update(index, { origin: e.target.value as Relation['origin'] })}
              >
                <option value="manual">手動設定</option>
                <option value="extracted">本文から抽出</option>
              </select>
            </Field>
            {relation.source ? (
              <>
                <p className="path-text">
                  {relation.source.path}:{relation.source.line}
                </p>
                <pre className="context-content">{relation.source.text}</pre>
                <p className="muted small-text">
                  本文が変わらない編集では抽出元を保持します。本文を変更するとCoreが抽出関係を再評価します。手動設定の関係は保持されます。
                </p>
              </>
            ) : (
              <p className="muted small-text">抽出元の位置は未記録です。</p>
            )}
          </details>
          <button
            type="button"
            className="button small"
            onClick={() => onChange(relations.filter((_, i) => i !== index))}
          >
            関係 {index + 1}を削除
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="button small"
        onClick={() =>
          onChange([...relations, { target: '', kind: 'required', origin: 'manual', reason: '' }])
        }
      >
        関係を追加
      </button>
    </section>
  );
}
export function AssetFiles({ asset }: { asset: Pick<AssetInput, 'files' | 'sources'> }) {
  return (
    <section className="form-section" aria-label="補助ファイルと出所">
      <h3>補助ファイルと出所</h3>
      <p className="muted small-text">
        本文とは別に取り込んだファイルと元の場所です。Assetの編集時も保持されます。
      </p>
      {Object.entries(asset.files ?? {}).map(([path, content]) => (
        <details key={path} className="source-file">
          <summary>
            {path} <span className="muted">{content.length.toLocaleString()}文字</span>
          </summary>
          <CopyButton text={content} label={`${path}をコピー`} />
          <pre className="context-content">{content}</pre>
        </details>
      ))}
      {asset.sources?.map((source, index) => (
        <article className="evidence-record" key={index}>
          <strong>{source.host}</strong>
          <p className="path-text">{source.path}</p>
          <p className="small-text path-text">内容のハッシュ: {source.hash}</p>
        </article>
      ))}
      {!Object.keys(asset.files ?? {}).length && !asset.sources?.length && (
        <p className="muted">補助ファイル・出所は未登録です。</p>
      )}
    </section>
  );
}
function RelationCard({
  relation,
  data,
  onSelect,
}: {
  relation: Relation;
  data: Overview;
  onSelect: (asset: Asset) => void;
}) {
  const target = data.assets.find((asset) => asset.id === relation.target);
  return (
    <article className="relation-card">
      <div className="section-head compact">
        {target ? (
          <button className="button text-button" onClick={() => onSelect(target)}>
            {target.name}{' '}
            <span className="muted small-text">
              {target.type} · {target.id}
            </span>
          </button>
        ) : (
          <strong>{relation.target}（参照先が見つかりません）</strong>
        )}
        <Badge
          tone={
            relation.kind === 'required' ? 'blue' : relation.kind === 'conditional' ? 'amber' : ''
          }
        >
          {kinds[relation.kind]}
        </Badge>
      </div>
      <p>{relation.reason}</p>
      {relation.condition && (
        <p>
          <strong>利用条件:</strong> {relation.condition}
        </p>
      )}
      <ScopeDetails scope={relation.scope} />
      <small className="muted">{relation.origin === 'manual' ? '手動設定' : '本文から抽出'}</small>
      {relation.source && (
        <details>
          <summary>
            根拠: {relation.source.path}:{relation.source.line}
          </summary>
          <pre className="context-content">{relation.source.text}</pre>
        </details>
      )}
    </article>
  );
}
export function AssetMetadata({
  asset,
  data,
  onSelect,
}: {
  asset: Asset;
  data: Overview;
  onSelect: (asset: Asset) => void;
}) {
  const incoming = data.assets.filter(
    (source) =>
      source.relations?.some((r) => r.target === asset.id) ||
      source.dependencies.includes(asset.id) ||
      source.workflow?.stages.some(
        (s) => s.role === asset.id || s.requiredAssets.includes(asset.id),
      ),
  );
  return (
    <>
      <h3>適用条件</h3>
      <ScopeDetails scope={asset.scope} />
      {!Object.keys(asset.scope).length && <p className="muted">追加の条件なし</p>}
      <div className="evidence-meta">
        <Badge>{asset.enabled ? '有効' : '無効'}</Badge>
        <Badge>{asset.mandatory ? '必須適用' : '任意適用'}</Badge>
        <span>優先度: {asset.priority}</span>
        <span>{asset.compatibility}</span>
        <span>{asset.activation}</span>
      </div>
      <h3>利用・参照する資産</h3>
      {asset.relations?.map((relation, index) => (
        <RelationCard key={index} relation={relation} data={data} onSelect={onSelect} />
      ))}
      {!asset.relations?.length && <p className="muted">意味を指定した関係はありません。</p>}
      {(['dependencies', 'conflicts'] as const).map(
        (key) =>
          asset[key].length > 0 && (
            <section key={key}>
              <h4>{key === 'dependencies' ? '既存の依存関係' : '競合する資産'}</h4>
              <div className="button-row wrap">
                {asset[key].map((id) => {
                  const target = data.assets.find((a) => a.id === id);
                  return (
                    <button
                      className="button small"
                      key={id}
                      disabled={!target}
                      onClick={() => target && onSelect(target)}
                    >
                      {target?.name ?? id}
                    </button>
                  );
                })}
              </div>
            </section>
          ),
      )}
      <h3>この資産を利用する上位・参照元</h3>
      <p className="muted small-text">
        逆引きの表示です。この資産の利用によってRoleやModelが選ばれることはありません。
      </p>
      <div className="button-row wrap">
        {incoming.map((source) => (
          <button key={source.id} className="button" onClick={() => onSelect(source)}>
            {source.name} · {source.type}
          </button>
        ))}
      </div>
      {!incoming.length && <p className="muted">資産からの参照は未登録です。</p>}
      <AssetFiles asset={asset} />
    </>
  );
}
export function RelationsExplorer({
  data,
  onSelect,
  mutate,
}: {
  data: Overview;
  onSelect: (asset: Asset) => void;
  mutate: (route: string, body: unknown) => Promise<unknown>;
}) {
  const [root, setRoot] = useState('');
  const [targetId, setTargetId] = useState('');
  const [modelAction, setModelAction] = useState<'add' | 'remove'>('add');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const assets = data.assets.filter((a) => ['workflow', 'role'].includes(a.type));
  const selected = assets.find((a) => `asset:${a.id}` === root) ?? (!root ? assets[0] : undefined);
  const model = data.config.models.find((m) => `model:${m.id}` === root);
  const modelAssets = (id: string) =>
    data.assets.filter((a) => lowerAsset(a) && a.scope.model?.includes(id));
  const assetButton = (asset: Asset) => (
    <button className="button" key={asset.id} onClick={() => onSelect(asset)}>
      {asset.name} <Badge>{asset.type}</Badge>
    </button>
  );
  const roleView = (role: Asset, workflow?: string) => {
    const bindings = data.config.bindings.filter(
      (binding) =>
        binding.role === role.id &&
        (!workflow ||
          binding.workflow === workflow ||
          (!binding.workflow &&
            !data.config.bindings.some((b) => b.role === role.id && b.workflow === workflow))),
    );
    return (
      <section className="relation-branch" key={role.id}>
        <div className="section-head compact">
          <h3>{role.name}</h3>
          {assetButton(role)}
        </div>
        <p className="muted small-text">Roleが利用するモデルと資産</p>
        {bindings.map((binding, index) => (
          <div className="model-branch" key={index}>
            {binding.model ? (
              <button
                className="button"
                onClick={() => {
                  setRoot(`model:${binding.model}`);
                  setTargetId('');
                }}
              >
                {data.config.models.find((m) => m.id === binding.model)?.name ?? binding.model}
              </button>
            ) : (
              <strong>Runtimeの標準モデル</strong>
            )}
            <span className="muted small-text">
              {binding.runtime} · {binding.workflow ? 'Workflow固有の割り当て' : '共通の割り当て'}
            </span>
            {binding.model && (
              <div className="button-row wrap">{modelAssets(binding.model).map(assetButton)}</div>
            )}
          </div>
        ))}
        {!bindings.length && (
          <p className="muted">Runtimeの割り当ては未登録です。モデル指定は任意です。</p>
        )}
        {role.relations?.map((relation, index) => (
          <RelationCard key={index} relation={relation} data={data} onSelect={onSelect} />
        ))}
        <div className="button-row wrap">
          {role.dependencies
            .map((id) => data.assets.find((a) => a.id === id))
            .filter((a): a is Asset => !!a)
            .map(assetButton)}
        </div>
      </section>
    );
  };
  return (
    <section className="panel relations-explorer" aria-label="資産の関係図">
      <div className="panel-head">
        <h2>資産の関係</h2>
        <Badge>上位から展開</Badge>
      </div>
      <div className="panel-body">
        <p className="muted">
          Workflowで工程と担当を選び、RoleでRuntimeと利用資産を指定します。モデルの指定は任意です。モデルに紐づく資産には、対象Assetのmodel適用条件を使います。同じIDは共有された同一資産です。
        </p>
        <Field label="関係を確認するWorkflow・Role・Model">
          <select
            value={root || (selected ? `asset:${selected.id}` : '')}
            onChange={(e) => {
              setRoot(e.target.value);
              setTargetId('');
              setError('');
            }}
          >
            <option value="">選択してください</option>
            {(['workflow', 'role'] as const).map((type) => (
              <optgroup key={type} label={type}>
                {assets
                  .filter((a) => a.type === type)
                  .map((a) => (
                    <option key={a.id} value={`asset:${a.id}`}>
                      {a.name}
                    </option>
                  ))}
              </optgroup>
            ))}
            <optgroup label="Model">
              {data.config.models.map((m) => (
                <option key={m.id} value={`model:${m.id}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
        {selected?.workflow && (
          <>
            <div className="relation-root">{assetButton(selected)}</div>
            {selected.workflow.stages.map((stage) => {
              const role = data.assets.find((a) => a.id === stage.role);
              return (
                <div className="relation-stage" key={stage.id}>
                  <h3>{stage.name}</h3>
                  {role ? roleView(role, selected.id) : <p>{stage.role}（未登録）</p>}
                  <div className="button-row wrap">
                    {stage.requiredAssets
                      .map((id) => data.assets.find((a) => a.id === id))
                      .filter((a): a is Asset => !!a)
                      .map(assetButton)}
                  </div>
                </div>
              );
            })}
          </>
        )}
        {selected?.type === 'role' && roleView(selected)}
        {model && (
          <section className="relation-branch">
            <h3>{model.name}が使う資産</h3>
            <p className="muted small-text">RoleやProjectなどの追加条件は各資産で確認できます。</p>
            {modelAssets(model.id).map((asset) => (
              <article className="relation-card" key={asset.id}>
                {assetButton(asset)}
                <ScopeDetails scope={asset.scope} />
                <button
                  className="button small"
                  disabled={busy}
                  onClick={() => {
                    setTargetId(asset.id);
                    setModelAction('remove');
                    setReason('');
                  }}
                >
                  このModelとの紐づけを編集
                </button>
              </article>
            ))}
            {!modelAssets(model.id).length && <p className="muted">紐づいた資産はありません。</p>}
            <form
              className="form-section"
              onSubmit={async (e) => {
                e.preventDefault();
                const asset = data.assets.find((a) => a.id === targetId);
                if (!asset) return;
                setBusy(true);
                setError('');
                try {
                  const input = inputOf(asset);
                  const models =
                    modelAction === 'add'
                      ? [...new Set([...(input.scope.model ?? []), model.id])]
                      : (input.scope.model ?? []).filter((id) => id !== model.id);
                  if (models.length) input.scope.model = models;
                  else delete input.scope.model;
                  await mutate('/assets/change', {
                    operations: [{ op: 'upsert', asset: input, expectedRevision: asset.revision }],
                    summary: reason,
                  });
                  setTargetId('');
                  setReason('');
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field label="Modelに紐づける資産">
                <select required value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                  <option value="">選択してください</option>
                  {data.assets
                    .filter((a) => lowerAsset(a))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {a.type}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Modelとの紐づけの変更">
                <select
                  value={modelAction}
                  onChange={(e) => setModelAction(e.target.value as 'add' | 'remove')}
                >
                  <option value="add">このModelを適用条件に追加</option>
                  <option value="remove">このModelを適用条件から解除</option>
                </select>
              </Field>
              <p className="muted small-text">
                {modelAction === 'add'
                  ? '対象資産のmodel適用条件に追加します。未設定だった資産は、このモデルに適用範囲が限定されます。'
                  : (data.assets.find((a) => a.id === targetId)?.scope.model?.length ?? 0) <= 1
                    ? '最後のmodel条件を解除すると、モデルによる制限がなくなります。他の適用条件を満たすすべてのModelが対象になります。'
                    : 'このModelを適用条件から解除し、残りのModelへの紐づけを保持します。'}
              </p>
              <Field label="Modelとの紐づけの理由">
                <input required value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <button className="button primary" disabled={busy || !targetId}>
                Modelとの紐づけを保存
              </button>
            </form>
          </section>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
