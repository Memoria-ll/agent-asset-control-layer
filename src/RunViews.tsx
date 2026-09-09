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
import { api, type Overview } from './api.ts';
import { Badge, Empty, Field, Json, Modal, relativeDate, CopyButton, statusLabel } from './ui.tsx';

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
          </Node>
          {i < stages.length - 1 && <ArrowRight className="flow-arrow" size={17} />}
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
  return (
    <Modal title="新しい実行" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
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
              <option value="">Role bindingに従う</option>
              {data.config.runtimes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Role binding / 指定なし</option>
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
  const run = data.runs.find((r) => r.id === selected) ?? data.runs[0];
  const [transition, setTransition] = useState<{ to?: string; kind: string } | null>(null);
  const [handoff, setHandoff] = useState<unknown>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const stage = run?.workflow?.workflow?.stages.find((s) => s.id === run.stage);
  const project = data.projects.find((p) => p.id === run?.context.project);
  if (!run)
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
      <div className="split-view">
        <div className="run-list">
          {data.runs.map((r) => (
            <button
              key={r.id}
              className={`run-item ${r.id === run.id ? 'active' : ''}`}
              onClick={() => setSelected(r.id)}
            >
              <span className={`status-dot ${r.status}`} />
              <div>
                <strong>{r.title}</strong>
                <span>
                  {r.workflow?.name ?? 'Advisory'} · {relativeDate(r.createdAt)}
                </span>
              </div>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
        <div className="run-detail">
          <div className="section-head">
            <div>
              <div className="eyebrow">
                {run.workflow?.id ?? 'ADVISORY / PREPARATION'}{' '}
                {run.workflow && `· REVISION ${run.workflow.revision}`}
              </div>
              <h2>{run.title}</h2>
            </div>
            <Badge
              tone={run.status === 'active' ? 'blue' : run.status === 'completed' ? 'green' : ''}
            >
              {run.status === 'active'
                ? run.runtimeHandoffAt
                  ? 'AIが引き継ぎを取得済み'
                  : 'AIへの依頼待ち'
                : statusLabel(run.status)}
            </Badge>
          </div>
          {project && (
            <p className="path-text">
              Project: {project.name} · {project.root}
            </p>
          )}
          {run.instruction && <pre className="context-content">{run.instruction}</pre>}
          {run.status === 'active' && (
            <div className="callout">
              {run.runtimeHandoffAt
                ? 'AIから引き継ぎ情報の取得がありました。実際の作業状況は、依頼先のAIで確認してください。'
                : '「AIへの依頼をコピー」で依頼文を取得し、AACLに接続したAIへ渡してください。'}
              {run.lastHandoff?.delivery === 'host-inject' &&
                ' 手動で引き継ぎ情報を取得済みです。手動で取得した内容は、必要に応じてAIへ渡してください。'}
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
                <h2>{stage?.name ?? 'Advisory / Preparation'}</h2>
                <p className="muted">
                  {stage?.role ?? run.skillId ?? '質問・調査・検討'}
                  {run.context.model ? ` · ${run.context.model}` : ''}
                </p>
                <ul className="criteria-list">
                  {run.requirements.completionCriteria.map((c) => (
                    <li key={c}>
                      <Check size={15} />
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
                        {t.kind === 'advance' ? <ArrowRight size={14} /> : <RotateCcw size={14} />}
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
                    {(!stage || stage.transitions.length === 0) && (
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
                <h3>Runtimeへ引き継ぐ</h3>
                <Terminal size={16} />
              </div>
              <div className="panel-body">
                <p className="muted">現在のStageとAssetを解決し、委譲用Contextを取得します。</p>
                <code className="inline-code">{run.id}</code>
                {run.status === 'active' && (
                  <CopyButton
                    label="AIへの依頼をコピー"
                    text={`AACLの実行 ${run.id} を引き継いでください。${project ? `\nProject: ${project.name} (${project.id})\n作業フォルダー（Coreが動くOS上のパス）: ${project.root}\n` : '\n作業フォルダーは未登録です。作業対象を確認してください。\n'}今回の指示: ${run.instruction}\naacl_run_listで現在のStageを確認し、aacl_context_handoffでContextを取得してください。${run.workflow?.workflow?.developmentCapable ? '開発操作の前にaction=developmentで権限を確認してください。' : 'Advisory Modeの範囲で進めてください。'}引き継ぎのversionを次の遷移のexpectedVersionに指定してください。定義された成果物・完了条件を確認して進行し、終了時にJournalを残してください。`}
                  />
                )}
                <div className="button-row wrap">
                  <button
                    disabled={run.status !== 'active'}
                    className="button"
                    onClick={async () => {
                      try {
                        setHandoff(
                          await mutate(`/runs/${run.id}/handoff`, {
                            delivery: 'host-inject',
                            action: run.workflow?.workflow?.developmentCapable
                              ? 'development'
                              : 'advisory',
                          }),
                        );
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    <Terminal size={14} />
                    Handoffを取得
                  </button>
                  <button className="button" onClick={() => onJournal(run.snapshotIds.at(-1)!)}>
                    <FileText size={14} />
                    Journalを記録
                  </button>
                </div>
              </div>
            </section>
          </div>
          {error && <div className="error">{error}</div>}
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
                    Snapshot {i + 1} · {saved?.stage ?? 'Advisory'}
                  </button>
                );
              })}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head">
              <h3>実行履歴</h3>
              <span className="muted small-text">Snapshot {run.snapshotIds.length}件</span>
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
                      {e.kind} · {e.from ?? 'advisory'} → {e.to ?? '—'}
                    </strong>
                    <p>{e.note || relativeDate(e.at)}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
      {transition && (
        <TransitionModal
          run={run}
          edge={transition}
          onClose={() => setTransition(null)}
          onSave={(body) => mutate(`/runs/${run.id}/transition`, body)}
        />
      )}
      {snapshot && (
        <Modal title="保存されたContext" wide onClose={() => setSnapshot(null)}>
          <p>
            {snapshot.id} · {snapshot.createdAt}
          </p>
          <p>
            {snapshot.project?.name} {snapshot.project?.root}
          </p>
          <h3>今回の指示</h3>
          <pre className="context-content">{snapshot.task}</pre>
          <h3>渡したContext</h3>
          <pre className="context-content">{snapshot.resolution.content}</pre>
          <details>
            <summary>適用理由・成果物を含む全データ</summary>
            <Json value={snapshot} />
          </details>
        </Modal>
      )}
      {handoff && (
        <Modal title="Runtime handoff" wide onClose={() => setHandoff(null)}>
          <CopyButton text={JSON.stringify(handoff, null, 2)} />
          <Json value={handoff} />
        </Modal>
      )}
    </>
  );
}
function TransitionModal({
  run,
  edge,
  onClose,
  onSave,
}: {
  run: Overview['runs'][number];
  edge: { to?: string; kind: string };
  onClose: () => void;
  onSave: (body: unknown) => Promise<unknown>;
}) {
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
