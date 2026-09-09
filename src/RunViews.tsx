import { useState } from 'react';
import {
  Play,
  ArrowRight,
  Check,
  RotateCcw,
  X,
  FileText,
  Terminal,
  ChevronRight,
} from 'lucide-react';
import type { Asset, Snapshot } from '../server/domain.ts';
import type { Core } from '../server/core.ts';
import { api, type Overview } from './api.ts';
import { Badge, Empty, Field, Modal, relativeDate, CopyButton, statusLabel } from './ui.tsx';
import {
  ModelPolicy,
  stageAssignment,
  modelSelectionConflict,
  UnevaluatedConditions,
} from './ModelPolicy.tsx';
import { SkillCandidates } from './SkillCandidates.tsx';
import {
  executionLabels,
  eventLabels,
  executionLabel,
  runName,
  exactTime,
  snapshotLabel,
  RunEvidence,
  RunAttempts,
  SavedContext,
  EvidenceValues,
} from './RunEvidence.tsx';

export function WorkflowFlow({
  workflow,
  current,
  onSelect,
}: {
  workflow: Asset;
  current?: string | null;
  onSelect?: (id: string) => void;
}) {
  const stages = workflow.workflow?.stages ?? [];
  const Node = onSelect ? 'button' : 'div';
  return (
    <div className="workflow-flow">
      {stages.map((s, i) => (
        <div key={s.id} className="flow-segment">
          <Node
            className={`flow-node ${current === s.id ? 'selected' : ''}`}
            onClick={onSelect ? () => onSelect(s.id) : undefined}
            aria-current={current === s.id ? 'step' : undefined}
            title={`${s.name}: ${s.role}`}
          >
            <span className="stage-number">{String(i + 1).padStart(2, '0')}</span>
            <strong>{s.name}</strong>
            <span className="mono">{s.role}</span>
            {(s.canComplete ?? s.transitions.length === 0) && (
              <span className="small-text">完了可能</span>
            )}
          </Node>
          <div className="flow-transitions">
            {s.transitions.map((edge) => (
              <span key={`${edge.kind}:${edge.to}`}>
                {
                  { advance: '次へ', return: '差し戻し', retry: '再試行', reject: '却下' }[
                    edge.kind
                  ]
                }{' '}
                → {stages.find((next) => next.id === edge.to)?.name ?? edge.to}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
export function Launcher({
  data,
  workflowId,
  onClose,
  onLaunch,
}: {
  data: Overview;
  workflowId?: string;
  onClose: () => void;
  onLaunch: (body: unknown) => Promise<unknown>;
}) {
  const [selected, setSelected] = useState(workflowId ?? '');
  const [instruction, setInstruction] = useState('');
  const [project, setProject] = useState(
    data.assets.find((a) => a.id === workflowId)?.projectId ?? '',
  );
  const [runtime, setRuntime] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selectedWorkflow = data.assets.find((a) => a.id === selected && a.type === 'workflow');
  const entryStage = selectedWorkflow?.workflow?.stages.find(
    (s) => s.id === selectedWorkflow.workflow?.entryStage,
  );
  const assignment = stageAssignment(data.config, selectedWorkflow?.id, entryStage, {
    model: model || undefined,
    runtime: runtime || undefined,
  });
  const conflict = modelSelectionConflict(data.config, assignment.model, assignment.runtime);
  return (
    <Modal title="新しい実行" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (conflict) return;
          setBusy(true);
          setError('');
          try {
            const target = data.assets.find((a) => a.id === selected);
            await onLaunch({
              ...(target
                ? target.type === 'workflow'
                  ? { workflowId: selected }
                  : { skillId: selected }
                : {}),
              instruction,
              context: {
                ...(project ? { project } : {}),
                ...(runtime ? { runtime } : {}),
                ...(model ? { model } : {}),
              },
            });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Workflow / Skill">
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              const owner = data.assets.find((a) => a.id === e.target.value)?.projectId;
              if (owner) setProject(owner);
            }}
          >
            <option value="">Advisory / Preparation</option>
            <optgroup label="Workflows">
              {data.assets
                .filter((a) => a.type === 'workflow')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · r{a.revision}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Standalone Skills">
              {data.assets
                .filter((a) => a.type === 'skill')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </optgroup>
          </select>
        </Field>
        <div className="callout">
          {!selected
            ? '質問・調査・検討のセッションを開始します。開発Stageへの自動移行はありません。'
            : 'Coreで実行状態と初期Contextを作成します。AIの実作業は接続したRuntimeが担当します。'}
        </div>
        <Field label="今回の指示">
          <textarea
            autoFocus
            rows={4}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="#123 · 今回の対象や追加の制約"
          />
        </Field>
        <Field label="Project">
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">Global / 未登録workspace</option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Runtime">
            <select
              value={runtime}
              onChange={(e) => {
                setRuntime(e.target.value);
                setModel('');
              }}
            >
              <option value="">Stage / Roleの設定に従う</option>
              {data.config.runtimes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Stage / Roleの設定、なければRuntime標準</option>
              {data.config.models
                .filter(
                  (m) =>
                    !runtime ||
                    data.config.runtimes.find((r) => r.id === runtime)?.provider === m.provider,
                )
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <p className="muted small-text">
          モデル登録は任意です。明示指定がなければモデル引数を付けずに起動し、実際のモデルはRuntimeの報告で確認します。
        </p>
        <p className="small-text">
          今回のモデル指定: {assignment.model ?? '指定なし · Runtimeの標準設定'}
        </p>
        {conflict && (
          <div className="error" role="alert">
            {conflict}
          </div>
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
          <button className="button primary" disabled={busy || !!conflict}>
            <Play size={15} />
            {busy ? '起動中…' : '実行を開始'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function Runs({
  data,
  mutate,
  onLaunch,
  onJournal,
  initialRunId = '',
}: {
  data: Overview;
  mutate: (route: string, body: unknown) => Promise<any>;
  onLaunch: () => void;
  onJournal: (snapshot: string) => void;
  initialRunId?: string;
}) {
  const [selected, setSelected] = useState(initialRunId);
  const [filters, setFilters] = useState({
    query: '',
    project: '',
    workflow: '',
    skill: '',
    status: '',
  });
  const filteredRuns = data.runs.filter(
    (r) =>
      (!filters.project || r.context.project === filters.project) &&
      (!filters.workflow || r.workflow?.id === filters.workflow) &&
      (!filters.skill || r.skillId === filters.skill) &&
      (!filters.status || r.status === filters.status || r.executionStatus === filters.status) &&
      `${r.title} ${r.instruction} ${r.id} ${runName(r, data)} ${data.projects.find((p) => p.id === r.context.project)?.name ?? ''}`
        .toLowerCase()
        .includes(filters.query.toLowerCase().trim()),
  );
  const run = filteredRuns.find((r) => r.id === selected) ?? filteredRuns[0];
  const [transition, setTransition] = useState<{ to?: string; kind: string } | null>(null);
  const [handoff, setHandoff] = useState<ReturnType<Core['handoff']> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const stage = run?.workflow?.workflow?.stages.find((s) => s.id === run.stage);
  const project = data.projects.find((p) => p.id === run?.context.project);
  const latestWorkflow = data.assets.find(
    (asset) => asset.id === run?.workflow?.id && asset.revision !== run?.workflow?.revision,
  );
  if (!data.runs.length)
    return (
      <Empty
        title="実行はまだありません"
        action={
          <button className="button primary" onClick={onLaunch}>
            <Play size={15} />
            新しい実行
          </button>
        }
      >
        WorkflowまたはAdvisoryセッションを開始すると、進行状況を確認できます。
      </Empty>
    );
  return (
    <>
      <section className="run-filters panel" aria-label="実行の絞り込み">
        <Field label="実行を検索">
          <input
            type="search"
            placeholder="実行名・指示・ID"
            value={filters.query}
            onChange={(e) => setFilters({ ...filters, query: e.target.value })}
          />
        </Field>
        {(['project', 'workflow', 'skill'] as const).map((dimension) => (
          <Field
            key={dimension}
            label={`${dimension === 'project' ? 'Project' : dimension === 'workflow' ? 'Workflow' : 'Skill'}で絞り込み`}
          >
            <select
              value={filters[dimension]}
              onChange={(e) => setFilters({ ...filters, [dimension]: e.target.value })}
            >
              <option value="">すべて</option>
              {[
                ...new Map(
                  data.runs.flatMap((r) => {
                    const id =
                      dimension === 'project'
                        ? r.context.project
                        : dimension === 'workflow'
                          ? r.workflow?.id
                          : r.skillId;
                    const name =
                      dimension === 'project'
                        ? data.projects.find((p) => p.id === id)?.name
                        : dimension === 'workflow'
                          ? r.workflow?.name
                          : (r.skill?.name ?? data.assets.find((a) => a.id === id)?.name);
                    return id ? [[id, name ?? id] as const] : [];
                  }),
                ).entries(),
              ].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
        ))}
        <Field label="状態で絞り込み">
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          >
            <option value="">すべての状態</option>
            <optgroup label="実行の状態">
              {['active', 'completed', 'cancelled'].map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </optgroup>
            <optgroup label="AIの作業状況">
              {Object.entries(executionLabels).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
        <button
          className="button"
          onClick={() =>
            setFilters({ query: '', project: '', workflow: '', skill: '', status: '' })
          }
        >
          絞り込みをクリア
        </button>
        <span className="muted small-text" role="status">
          {filteredRuns.length} / {data.runs.length}件の実行
        </span>
      </section>
      <div className="split-view">
        <div className="run-list">
          {filteredRuns.map((r) => (
            <button
              key={r.id}
              className={`run-item ${r.id === run?.id ? 'active' : ''}`}
              onClick={() => {
                setSelected(r.id);
                setTransition(null);
                setError('');
              }}
            >
              <span className={`status-dot ${r.status}`} />
              <div>
                <strong>{r.title}</strong>
                <span>
                  {runName(r, data)} ·{' '}
                  {data.projects.find((p) => p.id === r.context.project)?.name ??
                    r.context.project ??
                    'Global'}
                </span>
                <span>
                  {statusLabel(r.status)} · {executionLabel(r)}
                </span>
                <span>
                  {r.workflow?.workflow?.stages.find((s) => s.id === r.stage)?.name ??
                    r.stage ??
                    '相談・準備'}{' '}
                  · 更新 {relativeDate(r.updatedAt)}
                </span>
              </div>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
        {run ? (
          <div className="run-detail">
            <div className="section-head">
              <div>
                <div className="eyebrow">
                  {runName(run, data)} {run.workflow && `· REVISION ${run.workflow.revision}`}
                </div>
                <h2>{run.title}</h2>
              </div>
              <Badge
                tone={run.status === 'active' ? 'blue' : run.status === 'completed' ? 'green' : ''}
              >
                {statusLabel(run.status)}
              </Badge>
            </div>
            <div className="button-row wrap">
              <Badge tone={run.executionStatus === 'failed' ? 'red' : 'blue'}>
                {executionLabel(run)}
              </Badge>
              <span className="muted small-text">更新: {exactTime(run.updatedAt)}</span>
            </div>
            {project && (
              <p className="path-text">
                Project: {project.name} · {project.root}
              </p>
            )}
            {run.restartedFrom && (
              <div className="callout">
                r{run.restartedFrom.workflowRevision}の実行から再開しました。
                {run.restartedFrom.reason}
                <button
                  className="button small"
                  onClick={() => {
                    setFilters({ query: '', project: '', workflow: '', skill: '', status: '' });
                    setSelected(run.restartedFrom!.runId);
                  }}
                >
                  元の実行を開く
                </button>
              </div>
            )}
            {latestWorkflow && (
              <div className="callout">
                この実行はr{run.workflow?.revision}に固定されています。現在の定義はr
                {latestWorkflow.revision}です。
                <button className="button small" onClick={() => setRestarting(true)}>
                  新版で再開する内容を確認
                </button>
              </div>
            )}
            {run.instruction && <pre className="context-content">{run.instruction}</pre>}
            {run.status === 'active' && (
              <div className="callout">
                表示とコピーは実行状態を変更しません。接続したAIへの依頼後、Runtimeの開始・結果報告が作業状況に反映されます。
              </div>
            )}
            {run.workflow ? (
              <WorkflowFlow workflow={run.workflow} current={run.stage} />
            ) : (
              <div className="callout">
                Advisory Mode · Workflowを明示起動するまで、開発Stageには進みません。
              </div>
            )}
            <div className="detail-grid">
              <section className="panel">
                <div className="panel-head">
                  <h3>現在のStage</h3>
                  <Badge>{run.version} updates</Badge>
                </div>
                <div className="panel-body">
                  <h2>{stage?.name ?? runName(run, data)}</h2>
                  <p className="muted">{stage?.role ?? run.skillId ?? '質問・調査・検討'}</p>
                  {(() => {
                    const saved = data.snapshots.find((s) => s.id === run.snapshotIds.at(-1));
                    return (
                      <ModelPolicy
                        requestedModel={
                          saved?.modelSelection?.requestedModel ??
                          (saved?.modelSelection ? undefined : run.context.model)
                        }
                        actualModel={saved?.modelSelection?.actualModel}
                        runtime={saved?.modelSelection?.actualRuntime ?? run.context.runtime}
                        policy={saved?.modelSelection?.policy}
                      />
                    );
                  })()}
                  <ul className="criteria-list">
                    {run.requirements.completionCriteria.map((c) => (
                      <li key={c}>
                        <span aria-hidden="true">○</span>
                        {c}
                      </li>
                    ))}
                  </ul>
                  {run.status === 'active' && (
                    <div className="button-row wrap">
                      {stage?.transitions.map((t) => (
                        <button
                          key={`${t.to}:${t.kind}`}
                          className={`button ${t.kind === 'advance' ? 'primary' : ''}`}
                          onClick={() => setTransition(t)}
                          title={run.workflow?.workflow?.stages.find((s) => s.id === t.to)?.name}
                        >
                          {t.kind === 'advance' ? (
                            <ArrowRight size={14} />
                          ) : (
                            <RotateCcw size={14} />
                          )}
                          {t.kind === 'advance'
                            ? '次のStageへ'
                            : t.kind === 'retry'
                              ? '再実行'
                              : t.kind === 'reject'
                                ? '却下して戻す'
                                : '差し戻す'}
                          {t.kind !== 'retry' && (
                            <span className="transition-target">
                              {run.workflow?.workflow?.stages.find((s) => s.id === t.to)?.name}
                            </span>
                          )}
                        </button>
                      ))}
                      {(!stage || (stage.canComplete ?? stage.transitions.length === 0)) && (
                        <button
                          className="button primary"
                          onClick={() => setTransition({ kind: 'complete' })}
                        >
                          <Check size={14} />
                          実行を完了
                        </button>
                      )}
                      <button
                        className="button text-button"
                        onClick={() => setTransition({ kind: 'cancel' })}
                      >
                        <X size={14} />
                        中止
                      </button>
                    </div>
                  )}
                </div>
              </section>
              <section className="panel">
                <div className="panel-head">
                  <h3>引き継ぎ情報を確認</h3>
                  <Terminal size={16} />
                </div>
                <div className="panel-body">
                  <p className="muted">
                    現在のStageのContextを閲覧できます。プレビューはSnapshotを作成せず、versionも更新しません。
                  </p>
                  <code className="inline-code">{run.id}</code>
                  {run.status === 'active' && (
                    <CopyButton
                      label="AIへの依頼をコピー"
                      text={`AACLの実行 ${run.id} を引き継いでください。${project ? `\nProject: ${project.name} (${project.id})\n作業フォルダー（${project.host ?? 'Coreが動くOS'}上のパス）: ${project.root}\n` : '\n作業フォルダーは未登録です。作業対象を確認してください。\n'}今回の指示: ${run.instruction}\naacl_run_getとaacl_context_handoff_previewで現在のStage・Contextを閲覧してください。作業を実行するときにaacl_context_handoffでContextを受け取ってください。${run.workflow?.workflow?.developmentCapable ? '開発操作の前にaction=developmentで権限を確認してください。' : 'Advisory Modeの範囲で進めてください。'}実際の作業開始・結果・失敗はaacl_runtime_eventで報告し、最新のversionを次の更新のexpectedVersionに指定してください。定義された成果物・完了条件の根拠を記録し、観測は対応する試行とSnapshotにJournalとして残してください。`}
                    />
                  )}
                  <div className="button-row wrap">
                    <button
                      disabled={run.status !== 'active' || previewing}
                      className="button"
                      onClick={async () => {
                        try {
                          setPreviewing(true);
                          setError('');
                          setHandoff(await api(`/runs/${encodeURIComponent(run.id)}/handoff`));
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setPreviewing(false);
                        }
                      }}
                    >
                      <Terminal size={14} />
                      {previewing ? '確認中…' : 'Handoffをプレビュー'}
                    </button>
                    <button
                      disabled={!run.snapshotIds.length}
                      className="button"
                      onClick={() => onJournal(run.snapshotIds.at(-1)!)}
                    >
                      <FileText size={14} />
                      Journalを記録
                    </button>
                  </div>
                </div>
              </section>
            </div>
            {error && <div className="error">{error}</div>}
            <RunEvidence run={run} />
            <RunAttempts run={run} />
            {(() => {
              const saved = data.snapshots.find((s) => s.id === run.snapshotIds.at(-1));
              return (
                <SkillCandidates
                  key={saved?.id ?? run.id}
                  candidates={saved?.skillCandidates}
                  reads={run.skillReads}
                  attemptId={run.attempts?.find((a) => a.snapshotId === saved?.id)?.id}
                />
              );
            })()}
            <section className="panel">
              <div className="panel-head">
                <h3>記録した成果物</h3>
              </div>
              <div className="panel-body">
                {Object.entries(run.artifacts).length ? (
                  Object.entries(run.artifacts).map(([name, value]) => (
                    <div key={name}>
                      <h4>{name}</h4>
                      <pre className="context-content">{value}</pre>
                      <CopyButton text={value} label="成果物をコピー" />
                    </div>
                  ))
                ) : (
                  <p className="muted">成果物はまだ記録されていません。</p>
                )}
              </div>
            </section>
            <section className="panel">
              <div className="panel-head">
                <h3>過去のContext</h3>
              </div>
              <div className="panel-body button-row wrap">
                {run.snapshotIds.map((id, i) => {
                  const saved = data.snapshots.find((s) => s.id === id);
                  return (
                    <button
                      key={id}
                      className="button"
                      onClick={async () => {
                        try {
                          setSnapshot(await api<Snapshot>(`/snapshots/${encodeURIComponent(id)}`));
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Snapshot {i + 1} · {saved ? snapshotLabel(saved, data) : id}
                    </button>
                  );
                })}
              </div>
            </section>
            <section className="panel">
              <div className="panel-head">
                <h3>実行履歴</h3>
                <span className="muted small-text">
                  Context保存 {run.snapshotIds.length}件 · AIの試行 {run.attempts?.length ?? 0}件
                </span>
              </div>
              <div className="timeline">
                <div className="timeline-row">
                  <span className="timeline-point" />
                  <div>
                    <strong>セッションを開始</strong>
                    <p>
                      {relativeDate(run.createdAt)} · {run.mode}
                    </p>
                  </div>
                </div>
                {run.events.map((e, i) => (
                  <div key={i} className="timeline-row">
                    <span className="timeline-point" />
                    <div>
                      <strong>
                        {eventLabels[e.kind] ?? e.kind} ·{' '}
                        {run.workflow?.workflow?.stages.find((s) => s.id === e.from)?.name ??
                          e.from ??
                          '相談・準備'}{' '}
                        →{' '}
                        {run.workflow?.workflow?.stages.find((s) => s.id === e.to)?.name ??
                          e.to ??
                          '—'}
                      </strong>
                      <p>{e.note}</p>
                      <p className="small-text muted">
                        {exactTime(e.at)} · 記録者: {e.actor ?? '未記録'}
                        {e.attemptId && ` · 試行: ${e.attemptId}`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        ) : (
          <Empty title="条件に一致する実行はありません">
            検索条件を変更するか、絞り込みをクリアしてください。
          </Empty>
        )}
      </div>
      {transition && run && (
        <TransitionModal
          run={run}
          edge={transition}
          onClose={() => setTransition(null)}
          onSave={(body) => mutate(`/runs/${run.id}/transition`, body)}
        />
      )}
      {restarting && run && latestWorkflow && (
        <RestartModal
          run={run}
          latest={latestWorkflow}
          onClose={() => setRestarting(false)}
          onRestart={async (body) => {
            const next = await mutate(`/runs/${run.id}/restart`, body);
            setSelected(next.id);
            setFilters({ query: '', project: '', workflow: '', skill: '', status: '' });
          }}
        />
      )}
      {snapshot && (
        <Modal title="保存されたContext" wide onClose={() => setSnapshot(null)}>
          <SavedContext
            key={snapshot.id}
            snapshot={snapshot}
            run={data.runs.find((r) => r.id === snapshot.runId)}
          />
        </Modal>
      )}
      {handoff && (
        <Modal title="Handoffプレビュー（閲覧のみ）" wide onClose={() => setHandoff(null)}>
          <p className="callout">閲覧用の情報です。AIへの送信や作業開始は行っていません。</p>
          <p>
            {handoff.project?.name} · {handoff.project?.root}
          </p>
          <p className="small-text muted">
            {handoff.runId} · version {handoff.version} · {handoff.stage ?? '相談・準備'}
          </p>
          <p>
            <Badge>
              {handoff.launch?.kind === 'subagent'
                ? '担当の子エージェントを起動'
                : '現在の担当者で実行'}
            </Badge>{' '}
            ·{' '}
            {handoff.launch?.modelPolicy === 'explicit' ? 'モデルを明示指定' : 'Runtimeの標準設定'}
          </p>
          <ModelPolicy
            requestedModel={handoff.requestedModel}
            actualModel={handoff.actualModel}
            runtime={handoff.runtime?.name}
            policy={handoff.launch?.modelPolicy}
          />
          <UnevaluatedConditions items={handoff.unevaluated} />
          <h3>今回の指示</h3>
          <pre className="context-content">{handoff.task}</pre>
          <h3>Context</h3>
          <CopyButton text={handoff.context} label="Contextをコピー" />
          <pre className="context-content">{handoff.context}</pre>
          <SkillCandidates
            key={handoff.snapshotId}
            candidates={handoff.skillCandidates}
            reads={data.runs.find((r) => r.id === handoff.runId)?.skillReads}
            attemptId={
              data.runs
                .find((r) => r.id === handoff.runId)
                ?.attempts?.find((a) => a.snapshotId === handoff.snapshotId)?.id
            }
          />
          <h3>完了条件</h3>
          <ul>
            {handoff.completionCriteria.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <h3>必要な成果物</h3>
          <ul>
            {handoff.expectedOutput.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <details>
            <summary>適用したAssetの版</summary>
            <ul>
              {handoff.assets.map((a) => (
                <li key={a.id}>
                  {a.id} · r{a.revision} · {a.type}
                </li>
              ))}
            </ul>
          </details>
          <EvidenceValues values={handoff.artifacts} label="記録済み成果物" />
        </Modal>
      )}
    </>
  );
}
function TransitionModal({
  run: currentRun,
  edge,
  onClose,
  onSave,
}: {
  run: Overview['runs'][number];
  edge: { to?: string; kind: string };
  onClose: () => void;
  onSave: (body: unknown) => Promise<unknown>;
}) {
  const [run] = useState(currentRun);
  const stage = run.workflow?.workflow?.stages.find((s) => s.id === run.stage);
  const transition = stage?.transitions.find((t) => t.to === edge.to && t.kind === edge.kind);
  const criteria = ['advance', 'complete'].includes(edge.kind)
    ? run.requirements.completionCriteria
    : [];
  const requiredArtifacts = [
    ...new Set([
      ...(transition?.requiredArtifacts ?? []),
      ...(['advance', 'complete'].includes(edge.kind) ? run.requirements.expectedOutput : []),
    ]),
  ];
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [artifacts, setArtifacts] = useState<Record<string, string>>(run.artifacts);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={
        edge.kind === 'cancel'
          ? '実行を中止'
          : edge.kind === 'complete'
            ? '完了条件を確認'
            : `Stageの遷移 · ${edge.kind}`
      }
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave({
              to: edge.to,
              kind: edge.kind,
              expectedVersion: run.version,
              criteria: evidence,
              artifacts,
              note,
            });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted">
          {stage?.name ?? 'Advisory'}
          {edge.to && ` → ${run.workflow?.workflow?.stages.find((s) => s.id === edge.to)?.name}`}
        </p>
        {criteria.map((c) => (
          <Field key={c} label={c} hint="条件を満たした根拠を記載してください。">
            <input
              required
              value={evidence[c] ?? ''}
              onChange={(e) => setEvidence({ ...evidence, [c]: e.target.value })}
              placeholder="確認結果・テスト結果・参照先"
            />
          </Field>
        ))}
        {requiredArtifacts.map((a) => (
          <Field key={a} label={`成果物 · ${a}`}>
            <input
              required
              value={artifacts[a] ?? ''}
              onChange={(e) => setArtifacts({ ...artifacts, [a]: e.target.value })}
              placeholder="ファイルパス、URL、または結果"
            />
          </Field>
        ))}
        <Field label="記録 / 理由">
          <textarea
            rows={3}
            required={['retry', 'return', 'reject'].includes(edge.kind)}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            キャンセル
          </button>
          <button
            disabled={busy}
            className={`button ${edge.kind === 'cancel' ? 'danger' : 'primary'}`}
          >
            確定する
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RestartModal({
  run: currentRun,
  latest,
  onClose,
  onRestart,
}: {
  run: Overview['runs'][number];
  latest: Asset;
  onClose: () => void;
  onRestart: (body: unknown) => Promise<unknown>;
}) {
  const [run] = useState(currentRun);
  const [reuse, setReuse] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="新版のWorkflowで再開" wide onClose={onClose}>
      <p className="callout">
        r{run.workflow?.revision}の実行を保持し、r{latest.revision}
        の開始工程から新しい実行を作ります。完了根拠は引き継がず、再確認が必要です。
      </p>
      {run.workflow && (
        <details>
          <summary>現在の実行の定義 · r{run.workflow.revision}</summary>
          <WorkflowFlow workflow={run.workflow} />
        </details>
      )}
      <h3>新版の工程 · r{latest.revision}</h3>
      <WorkflowFlow workflow={latest} />
      <p>
        開始工程:{' '}
        {latest.workflow?.stages.find((stage) => stage.id === latest.workflow?.entryStage)?.name}
      </p>
      <h4>新版の完了条件</h4>
      <ul>
        {latest.workflow?.completionCriteria.map((criterion) => (
          <li key={criterion}>{criterion}</li>
        ))}
      </ul>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await onRestart({ expectedVersion: run.version, reuseArtifacts: reuse, reason });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="relation-editor">
          <legend>再利用する成果物（任意）</legend>
          {Object.entries(run.artifacts).map(([name, value]) => (
            <label className="check-field" key={name}>
              <input
                type="checkbox"
                checked={reuse.includes(name)}
                onChange={(e) =>
                  setReuse(
                    e.target.checked ? [...reuse, name] : reuse.filter((key) => key !== name),
                  )
                }
              />
              <span>
                {name}: {value}
              </span>
            </label>
          ))}
          {!Object.keys(run.artifacts).length && (
            <p className="muted">記録された成果物はありません。</p>
          )}
        </fieldset>
        <Field label="新版で再開する理由">
          <textarea required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            キャンセル
          </button>
          <button className="button primary" disabled={busy}>
            新しい実行を作成して再開
          </button>
        </div>
      </form>
    </Modal>
  );
}
