import type { Asset, AssetInput } from '../server/domain.ts';
import { skillSchema, roleSchema, taskTypeSchema } from '../server/domain.ts';
import { Field, Badge } from './ui.tsx';
import { TextList } from './WorkflowEditor.tsx';

export const contractKey = (type: string) =>
  type === 'skill' ? 'skill' : type === 'role' ? 'role' : type === 'task-type' ? 'taskType' : null;
export function defaultContract(type: string): Partial<AssetInput> {
  if (type === 'skill') return { skill: skillSchema.parse({}) };
  if (type === 'role') return { role: roleSchema.parse({}) };
  if (type === 'task-type') return { taskType: taskTypeSchema.parse({}) };
  return {};
}
const modes = { both: '単独・Workflow内', standalone: '単独のみ', workflow: 'Workflow内のみ' };
const permissions = {
  'read-only': '参照・分析',
  'workflow-development': '開発Workflowの権限が必要',
};
export function AssetContractEditor({
  value,
  assets,
  onChange,
}: {
  value: AssetInput;
  assets: Asset[];
  onChange: (key: string, value: unknown) => void;
}) {
  const key = contractKey(value.type);
  if (!key) return null;
  const contract = value[key];
  const change = (field: string, next: unknown) => onChange(key, { ...contract, [field]: next });
  const list = (field: string, label: string, values: string[]) => (
    <TextList label={label} value={values} onChange={(v) => change(field, v)} />
  );
  return (
    <section className="contract-editor form-section" aria-label="Asset固有設定">
      <div className="section-head compact">
        <h3>
          {value.type === 'skill'
            ? 'Skillの実行条件'
            : value.type === 'role'
              ? 'Roleの責務'
              : 'Task Typeの実行基準'}
        </h3>
      </div>
      {!contract ? (
        <div className="button-row wrap">
          <span className="muted small-text">追加の条件は未設定です。</span>
          <button
            type="button"
            className="button small"
            onClick={() => onChange(key, defaultContract(value.type)[key])}
          >
            条件を設定
          </button>
        </div>
      ) : (
        <>
          {value.skill && value.type === 'skill' && (
            <>
              <div className="form-grid">
                <Field label="実行モード">
                  <select
                    value={value.skill.executionMode}
                    onChange={(e) => change('executionMode', e.target.value)}
                  >
                    {Object.entries(modes).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="実行権限"
                  hint="開発操作にはDevelopment-capable Workflowの明示起動が必要です。"
                >
                  <select
                    value={value.skill.executionPermission}
                    onChange={(e) => change('executionPermission', e.target.value)}
                  >
                    {Object.entries(permissions).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </Field>
                {(['role', 'taskType'] as const).map((dimension) => (
                  <Field
                    key={dimension}
                    label={dimension === 'role' ? '担当Role' : '作業のTask Type'}
                  >
                    <select
                      value={value.skill![dimension] ?? ''}
                      onChange={(e) => change(dimension, e.target.value || undefined)}
                    >
                      <option value="">指定なし</option>
                      {assets
                        .filter((a) => a.type === (dimension === 'role' ? 'role' : 'task-type'))
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                ))}
              </div>
              {list('expectedOutput', '期待する成果物', value.skill.expectedOutput)}
              {list('completionCriteria', 'Skillの完了条件', value.skill.completionCriteria)}
            </>
          )}
          {value.role && value.type === 'role' && (
            <>
              {list('responsibilities', '責務', value.role.responsibilities)}
              {list('expectedOutput', '期待する成果物', value.role.expectedOutput)}
            </>
          )}
          {value.taskType && value.type === 'task-type' && (
            <>
              <Field label="作業の目的">
                <textarea
                  rows={2}
                  value={value.taskType.objective}
                  onChange={(e) => change('objective', e.target.value)}
                />
              </Field>
              {list('qualityCriteria', '品質基準', value.taskType.qualityCriteria)}
              {list('constraints', '制約', value.taskType.constraints)}
            </>
          )}
        </>
      )}
    </section>
  );
}
export function ContractDetails({ asset }: { asset: Asset }) {
  const list = (label: string, values: string[]) =>
    values.length > 0 && (
      <div>
        <strong>{label}</strong>
        <ul>
          {values.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      </div>
    );
  if (!asset.skill && !asset.role && !asset.taskType) return null;
  return (
    <section className="contract-details">
      <h3>実行条件・責務</h3>
      {asset.skill && (
        <>
          <div className="button-row wrap">
            <Badge>{modes[asset.skill.executionMode]}</Badge>
            <Badge>{permissions[asset.skill.executionPermission]}</Badge>
            {asset.skill.role && <span>Role: {asset.skill.role}</span>}
            {asset.skill.taskType && <span>Task Type: {asset.skill.taskType}</span>}
          </div>
          {list('期待する成果物', asset.skill.expectedOutput)}
          {list('完了条件', asset.skill.completionCriteria)}
        </>
      )}
      {asset.role && (
        <>
          {list('責務', asset.role.responsibilities)}
          {list('期待する成果物', asset.role.expectedOutput)}
        </>
      )}
      {asset.taskType && (
        <>
          <p>{asset.taskType.objective}</p>
          {list('品質基準', asset.taskType.qualityCriteria)}
          {list('制約', asset.taskType.constraints)}
        </>
      )}
    </section>
  );
}
