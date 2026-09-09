import { useState } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown, RotateCcw } from 'lucide-react';
import { assetSchema, type Asset, type AssetInput } from '../server/domain.ts';
import { Badge, Field } from './ui.tsx';
import { TokenPicker } from './TokenPicker.tsx';

type Definition = NonNullable<AssetInput['workflow']>;
type Stage = Definition['stages'][number];
const kinds = { advance: '次へ', return: '差し戻し', retry: '再試行', reject: '却下' };

export function TextList({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="text-list">
      <legend>{label}</legend>
      {value.map((text, index) => (
        <div className="text-list-row" key={index}>
          <input
            required
            aria-label={`${label} ${index + 1}`}
            value={text}
            onChange={(e) => onChange(value.map((v, i) => (i === index ? e.target.value : v)))}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`${label} ${index + 1}を削除`}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button type="button" className="button small" onClick={() => onChange([...value, ''])}>
        <Plus size={14} />
        {label}を追加
      </button>
    </fieldset>
  );
}

export function WorkflowEditor({
  value,
  assets,
  onChange: onValueChange,
}: {
  value: Definition;
  assets: Asset[];
  onChange: (value: Definition) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [undo, setUndo] = useState<Definition | null>(null);
  const onChange = (next: Definition) => {
    setUndo(null);
    onValueChange(next);
  };
  const stage = value.stages[selected] ?? value.stages[0];
  const index = value.stages.indexOf(stage);
  const roles = assets.filter((a) => a.type === 'role');
  const changeStage = (next: Stage) =>
    onChange({
      ...value,
      entryStage: value.entryStage === stage.id ? next.id : value.entryStage,
      entryRole: value.entryStage === stage.id ? next.role : value.entryRole,
      stages: value.stages.map((s, i) => ({
        ...(i === index ? next : s),
        transitions: (i === index ? next : s).transitions.map((t) => ({
          ...t,
          to: t.to === stage.id ? next.id : t.to,
        })),
      })),
    });
  const validation = assetSchema.safeParse({
    id: 'workflow-preview',
    type: 'workflow',
    name: 'Preview',
    workflow: value,
  });
  const issues = validation.success
    ? []
    : [...new Set(validation.error.issues.map((i) => i.message))];
  const width = Math.max(600, value.stages.length * 190 + 30);
  return (
    <section className="workflow-editor" aria-label="Workflow編集">
      <div className="section-head compact">
        <h3>Stageと遷移</h3>
        <div className="button-row">
          {undo && (
            <button
              type="button"
              className="button small"
              onClick={() => {
                onChange(undo);
                setUndo(null);
                setSelected(0);
              }}
            >
              <RotateCcw size={14} />
              削除を取り消す
            </button>
          )}
          <button
            type="button"
            className="button small"
            disabled={!roles.length}
            onClick={() => {
              let number = value.stages.length + 1;
              while (value.stages.some((s) => s.id === `stage-${number}`)) number++;
              const next: Stage = {
                id: `stage-${number}`,
                name: `Stage ${number}`,
                role: stage?.role ?? roles[0].id,
                requiredAssets: [],
                requiredCapabilities: [],
                completionCriteria: [],
                transitions: [],
              };
              onChange({
                ...value,
                stages: [
                  ...value.stages.map((s, i) =>
                    i === index
                      ? {
                          ...s,
                          transitions: [
                            ...s.transitions,
                            { to: next.id, kind: 'advance' as const, requiredArtifacts: [] },
                          ],
                        }
                      : s,
                  ),
                  next,
                ],
              });
              setSelected(value.stages.length);
            }}
          >
            <Plus size={14} />
            次のStageを追加
          </button>
        </div>
      </div>
      <p className="small-text muted">
        Stageを選んで編集 · 実線は「次へ」、点線は差し戻し・再試行・却下
      </p>
      {!roles.length && <p className="error">先にRole Assetを登録してください。</p>}
      <div className="workflow-canvas" aria-label="Stage接続図">
        <div style={{ width, height: 174, position: 'relative' }}>
          <svg width={width} height="174" aria-hidden="true" className="workflow-edges">
            <defs>
              <marker
                id="wf-arrow"
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3"
                orient="auto"
              >
                <path d="M0,0 L0,6 L6,3 z" fill="context-stroke" />
              </marker>
            </defs>
            {value.stages.flatMap((s, i) =>
              s.transitions.map((t, ti) => {
                const dest = value.stages.findIndex((d) => d.id === t.to);
                if (dest < 0) return null;
                const x = i * 190 + 100,
                  to = dest * 190 + 100;
                const y = dest > i ? 34 : 139 + (ti % 2) * 12;
                const d =
                  dest === i
                    ? `M ${x + 34} 113 C ${x + 100} 164, ${x - 100} 164, ${x - 34} 113`
                    : `M ${x} ${dest > i ? 48 : 113} C ${x} ${y}, ${to} ${y}, ${to} ${dest > i ? 48 : 113}`;
                return (
                  <path
                    key={`${i}:${ti}`}
                    d={d}
                    fill="none"
                    stroke={t.kind === 'advance' ? '#617adb' : '#a58aab'}
                    strokeWidth="1.7"
                    strokeDasharray={t.kind === 'advance' ? undefined : '4 3'}
                    markerEnd="url(#wf-arrow)"
                  />
                );
              }),
            )}
          </svg>
          {value.stages.map((s, i) => (
            <button
              type="button"
              key={i}
              className={`workflow-node ${index === i ? 'selected' : ''}`}
              style={{ left: i * 190 + 18, top: 48 }}
              aria-label={`Stage ${i + 1}: ${s.name}`}
              aria-pressed={index === i}
              onClick={() => setSelected(i)}
            >
              <small>
                {value.entryStage === s.id ? '開始' : String(i + 1).padStart(2, '0')}
                {!s.transitions.length ? ' · 完了' : ''}
              </small>
              <strong>{s.name || '名前未入力'}</strong>
              <span>{roles.find((r) => r.id === s.role)?.name ?? s.role}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="workflow-options form-grid">
        <Field label="開始Stage">
          <select
            value={value.entryStage}
            onChange={(e) => {
              const first = value.stages.find((s) => s.id === e.target.value)!;
              onChange({ ...value, entryStage: first.id, entryRole: first.role });
            }}
          >
            {value.stages.map((s, i) => (
              <option key={i} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="check-field">
          <input
            type="checkbox"
            checked={value.developmentCapable}
            onChange={(e) => onChange({ ...value, developmentCapable: e.target.checked })}
          />
          開発操作を許可
        </label>
      </div>
      {stage && (
        <div className="stage-editor" key={index}>
          <div className="section-head compact">
            <h4>
              Stage {index + 1} · {stage.name}
            </h4>
            <div className="button-row">
              {([-1, 1] as const).map((direction) => (
                <button
                  key={direction}
                  type="button"
                  className="icon-button"
                  aria-label={direction < 0 ? '前に並べる' : '後ろに並べる'}
                  disabled={index + direction < 0 || index + direction >= value.stages.length}
                  onClick={() => {
                    const next = [...value.stages];
                    [next[index], next[index + direction]] = [next[index + direction], next[index]];
                    onChange({ ...value, stages: next });
                    setSelected(index + direction);
                  }}
                >
                  {direction < 0 ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
                </button>
              ))}
              <button
                type="button"
                className="button small danger"
                disabled={value.stages.length === 1}
                onClick={() => {
                  setUndo(structuredClone(value));
                  const stages = value.stages
                    .filter((_, i) => i !== index)
                    .map((s) => ({
                      ...s,
                      transitions: s.transitions.filter((t) => t.to !== stage.id),
                    }));
                  const first = stages.find((s) => s.id === value.entryStage) ?? stages[0];
                  onValueChange({ ...value, stages, entryStage: first.id, entryRole: first.role });
                  setSelected(Math.max(0, index - 1));
                }}
              >
                <Trash2 size={14} />
                Stageを削除
              </button>
            </div>
          </div>
          <div className="form-grid">
            <Field label="Stage名">
              <input
                required
                value={stage.name}
                onChange={(e) => changeStage({ ...stage, name: e.target.value })}
              />
            </Field>
            <StageId
              key={stage.id}
              stage={stage}
              stages={value.stages}
              onChange={(id) => changeStage({ ...stage, id })}
            />
            <Field label="担当Role">
              <select
                required
                value={stage.role}
                onChange={(e) => changeStage({ ...stage, role: e.target.value })}
              >
                <option value="" disabled>
                  Roleを選択
                </option>
                {roles.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Task Type">
              <select
                value={stage.taskType ?? ''}
                onChange={(e) => changeStage({ ...stage, taskType: e.target.value || undefined })}
              >
                <option value="">指定なし</option>
                {assets
                  .filter((a) => a.type === 'task-type')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <TextList
            label="Stage完了条件"
            value={stage.completionCriteria}
            onChange={(completionCriteria) => changeStage({ ...stage, completionCriteria })}
          />
          <div className="section-head compact">
            <h4>遷移先</h4>
            <button
              type="button"
              className="button small"
              onClick={() =>
                changeStage({
                  ...stage,
                  transitions: [
                    ...stage.transitions,
                    {
                      to: value.stages[index + 1]?.id ?? stage.id,
                      kind: value.stages[index + 1] ? 'advance' : 'retry',
                      requiredArtifacts: [],
                    },
                  ],
                })
              }
            >
              <Plus size={14} />
              遷移を追加
            </button>
          </div>
          {!stage.transitions.length && (
            <p className="muted small-text">このStageでWorkflowを完了します。</p>
          )}
          {stage.transitions.map((t, i) => (
            <div className="transition-editor" key={i}>
              <div className="form-grid">
                <Field label={`遷移 ${i + 1}の種類`}>
                  <select
                    value={t.kind}
                    onChange={(e) =>
                      changeStage({
                        ...stage,
                        transitions: stage.transitions.map((v, j) =>
                          j === i ? { ...v, kind: e.target.value as typeof t.kind } : v,
                        ),
                      })
                    }
                  >
                    {Object.entries(kinds).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`遷移 ${i + 1}の接続先`}>
                  <select
                    value={t.to}
                    onChange={(e) =>
                      changeStage({
                        ...stage,
                        transitions: stage.transitions.map((v, j) =>
                          j === i ? { ...v, to: e.target.value } : v,
                        ),
                      })
                    }
                  >
                    {value.stages.map((s, j) => (
                      <option key={j} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label={`遷移 ${i + 1}の必要成果物`}>
                <TokenPicker
                  value={t.requiredArtifacts}
                  placeholder="成果物名を入力してEnter"
                  onChange={(requiredArtifacts) =>
                    changeStage({
                      ...stage,
                      transitions: stage.transitions.map((v, j) =>
                        j === i ? { ...v, requiredArtifacts } : v,
                      ),
                    })
                  }
                />
              </Field>
              <button
                type="button"
                className="button small"
                onClick={() =>
                  changeStage({
                    ...stage,
                    transitions: stage.transitions.filter((_, j) => j !== i),
                  })
                }
              >
                遷移 {i + 1}を削除
              </button>
            </div>
          ))}
          <details className="form-section">
            <summary>必須Asset・Capability</summary>
            <div className="form-grid">
              <Field label="必須Asset">
                <TokenPicker
                  value={stage.requiredAssets}
                  choices={assets
                    .filter((a) => a.type !== 'workflow')
                    .map((a) => ({ id: a.id, label: a.name }))}
                  onChange={(requiredAssets) => changeStage({ ...stage, requiredAssets })}
                />
              </Field>
              <Field label="必須Capability">
                <TokenPicker
                  value={stage.requiredCapabilities}
                  choices={assets
                    .filter((a) => a.type === 'capability')
                    .map((a) => ({ id: a.id, label: a.name }))}
                  onChange={(requiredCapabilities) =>
                    changeStage({ ...stage, requiredCapabilities })
                  }
                />
              </Field>
            </div>
          </details>
        </div>
      )}
      <TextList
        label="Workflow完了条件"
        value={value.completionCriteria}
        onChange={(completionCriteria) => onChange({ ...value, completionCriteria })}
      />
      <div className="workflow-validation" aria-live="polite">
        {issues.length ? (
          <div className="error">
            {issues.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        ) : (
          <Badge tone="green">接続を確認済み</Badge>
        )}
      </div>
    </section>
  );
}

function StageId({
  stage,
  stages,
  onChange,
}: {
  stage: Stage;
  stages: Stage[];
  onChange: (id: string) => void;
}) {
  const [draft, setDraft] = useState(stage.id);
  return (
    <Field label="Stage ID">
      <input
        required
        pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.setCustomValidity(
            stages.some((s) => s !== stage && s.id === e.target.value)
              ? 'Stage IDが重複しています'
              : '',
          );
        }}
        onBlur={(e) => {
          if (e.target.validity.valid) onChange(draft);
        }}
      />
    </Field>
  );
}
