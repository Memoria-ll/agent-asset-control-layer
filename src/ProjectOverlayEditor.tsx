import { useState } from 'react';
import { dimensions, type Project, type Scope } from '../server/domain.ts';
import type { Overview } from './api.ts';
import { Field, Modal } from './ui.tsx';
import { TokenPicker, type Choice } from './TokenPicker.tsx';

export function ProjectOverlayEditor({
  project,
  data,
  onClose,
  onSave,
}: {
  project: Project;
  data: Overview;
  onClose: () => void;
  onSave: (overlay: Pick<Project, 'disabled' | 'overrides' | 'bindings'>) => Promise<unknown>;
}) {
  const [disabled, setDisabled] = useState(project.disabled);
  const [overrides, setOverrides] = useState(project.overrides);
  const [bindings, setBindings] = useState(project.bindings);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [binding, setBinding] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const assets = data.assets.filter((a) => !a.projectId || a.projectId === project.id);
  const choices = assets.map((a) => ({ id: a.id, label: a.name }));
  const options = (selected: string, exclude: string[] = []) => (
    <>
      <option value="">Assetを選択</option>
      {selected && !assets.some((a) => a.id === selected) && (
        <option value={selected}>{selected}（現在の候補外）</option>
      )}
      {assets
        .filter((a) => !exclude.includes(a.id))
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {a.id}
          </option>
        ))}
    </>
  );
  const scopeChoices = (dimension: string, scope: Scope): Choice[] => {
    const list = (items: { id: string; name: string }[]) =>
      items.map((a) => ({ id: a.id, label: a.name }));
    if (dimension === 'project') return list(data.projects);
    if (dimension === 'provider') return list(data.config.providers);
    if (dimension === 'runtime') return list(data.config.runtimes);
    if (dimension === 'model') return list(data.config.models);
    if (dimension === 'stage')
      return [
        ...new Map(
          assets
            .filter((a) => a.workflow && (!scope.workflow?.length || scope.workflow.includes(a.id)))
            .flatMap((a) =>
              a.workflow!.stages.map((s) => [s.id, { id: s.id, label: s.name }] as const),
            ),
        ).values(),
      ];
    return list(
      assets.filter((a) => a.type === (dimension === 'taskType' ? 'task-type' : dimension)),
    );
  };
  return (
    <Modal title={`Project overlay · ${project.name}`} onClose={onClose} wide>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            if (source || target || binding)
              throw new Error(
                '選択中の置き換え・適用条件を追加するか、選択を解除してから保存してください。',
              );
            await onSave({ disabled, overrides, bindings });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted">
          このプロジェクトで使うAssetを名前から選びます。必須の方針は無効化や置き換えより優先されます。
        </p>
        <Field label="このProjectで無効にするAsset">
          <TokenPicker
            value={disabled}
            choices={choices}
            onChange={setDisabled}
            placeholder="候補から選択"
          />
        </Field>
        <h3>Assetの置き換え</h3>
        {Object.entries(overrides).map(([id, replacement]) => (
          <div className="form-grid" key={id}>
            <Field label={`置き換え先 · ${data.assets.find((a) => a.id === id)?.name ?? id}`}>
              <select
                value={replacement}
                onChange={(e) => setOverrides({ ...overrides, [id]: e.target.value })}
              >
                {options(replacement, [id])}
              </select>
            </Field>
            <button
              type="button"
              className="button small"
              onClick={() =>
                setOverrides(
                  Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== id)),
                )
              }
            >
              置き換えを解除 · {data.assets.find((a) => a.id === id)?.name ?? id}
            </button>
          </div>
        ))}
        <div className="form-grid">
          <Field label="置き換え元">
            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setTarget('');
              }}
            >
              {options(source, Object.keys(overrides))}
            </select>
          </Field>
          <Field label="置き換え先">
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {options(target, [source])}
            </select>
          </Field>
        </div>
        <button
          type="button"
          className="button small"
          disabled={!source || !target}
          onClick={() => {
            setOverrides({ ...overrides, [source]: target });
            setSource('');
            setTarget('');
          }}
        >
          置き換えを追加
        </button>
        <h3>適用条件の変更</h3>
        <p className="muted small-text">
          ここで指定した条件は、このProjectで元の適用条件を置き換えます。空の条件は制限なしです。
        </p>
        {Object.entries(bindings).map(([id, scope]) => (
          <section className="form-section" key={id}>
            <h4>{data.assets.find((a) => a.id === id)?.name ?? id}</h4>
            <div className="form-grid">
              {dimensions.map((dimension) => (
                <Field key={dimension} label={`${id} · ${dimension}`}>
                  <TokenPicker
                    value={scope[dimension] ?? []}
                    choices={scopeChoices(dimension, scope)}
                    onChange={(values) => {
                      const next = { ...scope };
                      if (values.length) next[dimension] = values;
                      else delete next[dimension];
                      setBindings({ ...bindings, [id]: next });
                    }}
                    placeholder="指定なし"
                  />
                </Field>
              ))}
            </div>
            <button
              type="button"
              className="button small"
              onClick={() =>
                setBindings(
                  Object.fromEntries(Object.entries(bindings).filter(([key]) => key !== id)),
                )
              }
            >
              元の適用条件に戻す · {data.assets.find((a) => a.id === id)?.name ?? id}
            </button>
          </section>
        ))}
        <Field label="適用条件を変更するAsset">
          <select value={binding} onChange={(e) => setBinding(e.target.value)}>
            {options(binding, Object.keys(bindings))}
          </select>
        </Field>
        <button
          type="button"
          className="button small"
          disabled={!binding}
          onClick={() => {
            setBindings({
              ...bindings,
              [binding]: structuredClone(data.assets.find((a) => a.id === binding)?.scope ?? {}),
            });
            setBinding('');
          }}
        >
          適用条件を追加
        </button>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            キャンセル
          </button>
          <button className="button primary" disabled={busy}>
            Overlayを保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
