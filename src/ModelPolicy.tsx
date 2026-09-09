import type { AssetInput, Config, Context, Resolution } from '../server/domain.ts';

type Stage = NonNullable<AssetInput['workflow']>['stages'][number];

export function stageAssignment(
  config: Config,
  workflow?: string,
  stage?: Stage,
  context: Context = {},
) {
  const role = stage?.role ?? context.role;
  const binding =
    config.bindings.find((b) => b.role === role && b.workflow === workflow) ??
    config.bindings.find((b) => b.role === role && !b.workflow);
  return {
    model: context.model ?? stage?.model ?? stage?.modelConstraint?.model ?? binding?.model,
    runtime: context.runtime ?? stage?.runtime ?? binding?.runtime,
  };
}

export function modelSelectionConflict(config: Config, model?: string, runtime?: string) {
  if (!model || !runtime) return '';
  const selectedRuntime = config.runtimes.find((r) => r.id === runtime);
  if (selectedRuntime?.supportsModelSelection === false)
    return `${selectedRuntime.name}はモデルの明示指定に対応していません。モデル指定を外すか、対応するRuntimeを選んでください。`;
  const selectedModel = config.models.find((m) => m.id === model);
  if (selectedRuntime && selectedModel && selectedRuntime.provider !== selectedModel.provider)
    return 'モデルとRuntimeのProviderが一致していません。割り当てを確認してください。';
  return '';
}

export function ModelPolicy({
  requestedModel,
  actualModel,
  runtime,
  policy,
}: {
  requestedModel?: string | null;
  actualModel?: string | null;
  runtime?: string | null;
  policy?: 'runtime-default' | 'explicit';
}) {
  return (
    <div className="model-policy" aria-label="モデルの指定と実行報告">
      <dl className="model-facts">
        <div>
          <dt>要求したモデル</dt>
          <dd>
            {requestedModel ??
              (policy === 'explicit' ? '明示指定・ID未記録' : '指定なし · Runtimeの標準設定')}
          </dd>
        </div>
        <div>
          <dt>実際のモデル（報告）</dt>
          <dd>{actualModel ?? '不明 · Runtimeから未報告'}</dd>
        </div>
        {runtime && (
          <div>
            <dt>Runtime</dt>
            <dd>{runtime}</dd>
          </div>
        )}
      </dl>
      {!requestedModel && policy !== 'explicit' && (
        <p className="muted small-text">
          モデル引数を付けずに起動します。親のモデルや要求値から、実際のモデルを推測しません。
        </p>
      )}
    </div>
  );
}

export function UnevaluatedConditions({ items }: { items?: Resolution['unevaluated'] }) {
  if (!items?.length) return null;
  return (
    <div className="callout" aria-label="未評価の適用条件">
      <strong>実行環境の報告を待っている条件</strong>
      <p className="small-text">未報告のモデルに依存する資産は、適用済みとは扱いません。</p>
      <ul>
        {items.map((item, i) => (
          <li key={i}>
            {item.assetId} · {item.dimension}: {item.expected.join(', ')}
          </li>
        ))}
      </ul>
    </div>
  );
}
