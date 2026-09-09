import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import {
  Workflow,
  Layers,
  Play,
  BookOpen,
  GitBranch,
  Activity,
  FolderGit2,
  Plug,
  Search,
  Plus,
  ChevronRight,
  ArrowUpRight,
  ArrowRight,
  LayoutGrid,
  List,
  ShieldCheck,
  CircleHelp,
  FileCode2,
  Pencil,
  Trash2,
  RefreshCw,
  Terminal,
  Sparkles,
  RotateCcw,
} from 'lucide-react';
import type { Asset, AssetInput, Context } from '../server/domain.ts';
import { assetTypes } from '../server/domain.ts';
import { api, fetchState, type Overview } from './api.ts';
import { Badge, Empty, Modal, Json, relativeDate } from './ui.tsx';
import { AssetEditor } from './AssetEditor.tsx';
import { ContractDetails } from './AssetContracts.tsx';
import { AssetHistory } from './AssetHistory.tsx';
import { AssetMetadata, AssetFiles, RelationsExplorer } from './AssetRelations.tsx';
import { WorkflowActivity } from './WorkflowActivity.tsx';
import { runName, isPrepared, runStatusLabel } from './RunEvidence.tsx';
import { changeSummary } from './changeSummary.ts';
import { stageAssignment } from './ModelPolicy.tsx';
import { Launcher, Runs, WorkflowFlow } from './RunViews.tsx';
import { ContextView } from './ContextView.tsx';
import { Diagnostics, History, JournalModal, Journals } from './Operations.tsx';
import { ImportModal, Projects, Settings } from './Settings.tsx';

const nav: { id: string; label: string; icon: ComponentType<{ size?: number }>; group?: string }[] =
  [
    { id: 'workflows', label: 'Workflows', icon: Workflow, group: 'WORKSPACE' },
    { id: 'runs', label: 'Executions', icon: Play },
    { id: 'assets', label: 'Assets', icon: Layers },
    { id: 'context', label: 'Context Preview', icon: FileCode2 },
    { id: 'journals', label: 'Journal & Reviews', icon: BookOpen, group: 'OBSERVE & IMPROVE' },
    { id: 'history', label: 'Change History', icon: GitBranch },
    { id: 'diagnostics', label: 'Diagnostics', icon: Activity },
    { id: 'projects', label: 'Projects', icon: FolderGit2, group: 'MANAGE' },
    { id: 'settings', label: 'Runtime & MCP', icon: Plug },
  ];
const descriptions: Record<string, string> = {
  workflows: 'Workflowの作成・編集・実行。',
  runs: 'Workflowの進行と、実行時に渡されたContextを確認する。',
  assets: 'Role・Skill・Ruleなどの登録と編集。',
  context: 'AIに渡るContextを、実行前に確認する。',
  journals: '実行の観測記録と、改善提案の確認・承認。',
  history: '変更内容・理由・根拠の確認と復元。',
  diagnostics: 'Contextの量と実行の品質を、同じWorkflowで比較する。',
  projects: 'Projectの登録と、固有のAsset・適用条件の設定。',
  settings: '使うRuntime・Modelと、その割り当てを管理する。',
};
export function App() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(location.hash.slice(1) || 'workflows');
  const [query, setQuery] = useState('');
  const [launch, setLaunch] = useState<{ workflowId?: string } | null>(null);
  const [edit, setEdit] = useState<{ asset?: Asset; type?: AssetInput['type'] } | null>(null);
  const [detail, setDetail] = useState<Asset | null>(null);
  const [journal, setJournal] = useState<{ snapshotId?: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [context, setContext] = useState<Context>({});
  const [toast, setToast] = useState('');
  const [help, setHelp] = useState(false);
  const [selectedRun, setSelectedRun] = useState('');
  const [selectedReview, setSelectedReview] = useState('');
  const [selectedChange, setSelectedChange] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const reloadSequence = useRef(0);
  const reload = useCallback(async () => {
    const sequence = ++reloadSequence.current;
    const d = await fetchState();
    if (sequence === reloadSequence.current) {
      setData(d);
      setError('');
    }
  }, []);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      const element = e.target as HTMLElement;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (
        e.key === '/' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !element.closest('input,textarea,select,[contenteditable=true]')
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload().catch((e) => setError(e.message));
    }, 10000);
    return () => clearInterval(timer);
  }, [reload]);
  useEffect(() => {
    const fn = () => setPage(location.hash.slice(1) || 'workflows');
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  const go = (id: string) => {
    location.hash = id;
    setPage(id);
    setQuery('');
  };
  const mutate = async (route: string, body: unknown, method?: string) => {
    const result = await api(route, body, method);
    await reload();
    setToast('保存しました');
    setTimeout(() => setToast(''), 2500);
    return result;
  };
  const preview = (ctx: Context) => {
    setContext(ctx);
    go('context');
  };
  const activeNav = nav.find((n) => n.id === page) ?? nav[0];
  if (!data)
    return (
      <div className="loading-screen">
        <div className="brand-symbol">
          <Layers size={28} />
        </div>
        <h2>AACL</h2>
        <p>{error || 'Coreに接続しています…'}</p>
        {error && (
          <button className="button" onClick={() => reload().catch((e) => setError(e.message))}>
            再接続
          </button>
        )}
      </div>
    );
  return (
    <div className="app">
      <aside className="sidebar">
        <button className="brand" onClick={() => go('workflows')}>
          <span className="brand-symbol">
            <Layers size={21} />
          </span>
          <span>
            AACL<small>Agent Asset Control Layer</small>
          </span>
        </button>
        <div className="workspace-switch">
          <div className="workspace-avatar">P</div>
          <div>
            <strong>Personal workspace</strong>
            <span>ローカル環境</span>
          </div>
          <Badge>LOCAL</Badge>
        </div>
        <nav>
          {nav.map((n) => (
            <div key={n.id}>
              {n.group && <div className="nav-group">{n.group}</div>}
              <button
                className={`nav-item ${page === n.id ? 'active' : ''}`}
                aria-label={n.label}
                aria-current={page === n.id ? 'page' : undefined}
                title={n.label}
                onClick={() => go(n.id)}
              >
                <n.icon size={18} />
                <span>{n.label}</span>
                {n.id === 'runs' && data.runs.filter((r) => r.status === 'active').length > 0 && (
                  <span className="nav-count">
                    {data.runs.filter((r) => r.status === 'active').length}
                  </span>
                )}
                {n.id === 'journals' &&
                  data.reviews.filter((r) => r.status === 'pending').length > 0 && (
                    <span className="nav-count amber">
                      {data.reviews.filter((r) => r.status === 'pending').length}
                    </span>
                  )}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="core-status">
            <span className={`status-dot ${error ? 'cancelled' : 'active'}`} />
            <div>
              <strong>{error ? 'Core disconnected' : 'Core is running'}</strong>
              <span>{location.host}</span>
            </div>
            <Terminal size={15} />
          </div>
          <button className="help-button" onClick={() => setHelp(true)}>
            <CircleHelp size={17} />
            はじめてのAACL
            <ArrowUpRight size={14} />
          </button>
          <div className="sidebar-version">
            <span>Personal edition</span>
            <span>v0.1.0</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{activeNav.label}</strong>
          </div>
          <div className="topbar-actions">
            <label className="global-search">
              <Search size={15} />
              <input
                ref={searchRef}
                aria-label="Assetを検索"
                placeholder="Assetを検索…"
                value={query}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setQuery('');
                    searchRef.current?.blur();
                  }
                }}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (page !== 'assets') {
                    location.hash = 'assets';
                    setPage('assets');
                  }
                }}
              />
              <kbd>/</kbd>
              {query && (
                <button
                  type="button"
                  className="search-clear"
                  aria-label="検索をクリア"
                  onClick={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                >
                  ×
                </button>
              )}
            </label>
            <span className="user-avatar">P</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <h1>{activeNav.label}</h1>
              <p>{descriptions[page]}</p>
            </div>
            <div className="button-row">
              {page === 'workflows' && (
                <button className="button" onClick={() => setEdit({ type: 'workflow' })}>
                  <Plus size={16} />
                  Workflowを作成
                </button>
              )}
              {['workflows', 'runs'].includes(page) && (
                <button className="button primary" onClick={() => setLaunch({})}>
                  <Play size={15} />
                  新しい実行
                </button>
              )}
              {page === 'assets' && (
                <>
                  <button className="button" onClick={() => setImporting(true)}>
                    アセットインポート
                  </button>
                  <button className="button primary" onClick={() => setEdit({})}>
                    <Plus size={15} />
                    Assetを作成
                  </button>
                </>
              )}
            </div>
          </div>
          {error && (
            <div className="error connection-error" role="alert">
              Coreとの接続に問題があります: {error}
              <button
                className="button small"
                onClick={() => reload().catch((e) => setError(e.message))}
              >
                <RefreshCw size={13} />
                再接続
              </button>
            </div>
          )}
          {page === 'workflows' && (
            <Workflows
              data={data}
              onLaunch={(id) => setLaunch({ workflowId: id })}
              onEdit={(asset) => setEdit({ asset })}
              onPreview={preview}
              install={() => mutate('/starter', {})}
              onCreate={() => setEdit({ type: 'workflow' })}
              onOpenRun={(id) => {
                setSelectedRun(id);
                go('runs');
              }}
              onReviews={() => go('journals')}
              onOpenReview={(id) => {
                setSelectedReview(id);
                go('journals');
              }}
              onOpenChange={(id) => {
                setSelectedChange(id);
                go('history');
              }}
            />
          )}
          {page === 'assets' && (
            <Assets data={data} query={query} onDetail={setDetail} mutate={mutate} />
          )}
          {page === 'runs' && (
            <Runs
              key={selectedRun}
              initialRunId={selectedRun}
              data={data}
              mutate={mutate}
              onLaunch={() => setLaunch({})}
              onJournal={(snapshotId) => setJournal({ snapshotId })}
            />
          )}
          {page === 'context' && (
            <ContextView key={JSON.stringify(context)} data={data} initial={context} />
          )}
          {page === 'journals' && (
            <Journals
              key={selectedReview}
              initialReviewId={selectedReview}
              data={data}
              mutate={mutate}
              onAdd={() => setJournal({})}
            />
          )}
          {page === 'history' && (
            <History
              key={selectedChange}
              initialChangeId={selectedChange}
              data={data}
              mutate={mutate}
            />
          )}
          {page === 'diagnostics' && <Diagnostics data={data} />}
          {page === 'projects' && <Projects data={data} mutate={mutate} />}
          {page === 'settings' && <Settings data={data} mutate={mutate} />}
        </main>
      </div>
      {launch && (
        <Launcher
          data={data}
          workflowId={launch.workflowId}
          onClose={() => setLaunch(null)}
          onLaunch={async (body) => {
            const run = await mutate('/runs', body);
            setSelectedRun(run.id);
            go('runs');
            return run;
          }}
        />
      )}
      {edit && (
        <AssetEditor
          data={data}
          asset={edit.asset}
          type={edit.type}
          onClose={() => setEdit(null)}
          onSave={(body) => mutate('/assets/change', body)}
        />
      )}
      {detail && (
        <AssetDetail
          key={detail.id}
          asset={data.assets.find((a) => a.id === detail.id) ?? detail}
          data={data}
          onSelect={setDetail}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setEdit({ asset: data.assets.find((a) => a.id === detail.id) ?? detail });
            setDetail(null);
          }}
          mutate={mutate}
        />
      )}
      {journal && (
        <JournalModal
          data={data}
          snapshotId={journal.snapshotId}
          onClose={() => setJournal(null)}
          mutate={mutate}
        />
      )}
      {importing && <ImportModal data={data} mutate={mutate} onClose={() => setImporting(false)} />}
      {toast && (
        <div className="toast" role="status">
          <ShieldCheck size={17} />
          {toast}
        </div>
      )}
      {help && (
        <Modal title="AACLを使い始める" onClose={() => setHelp(false)}>
          <ol className="help-steps">
            <li>
              <strong>WorkflowとAssetを用意する</strong>
              <p>スターターを追加するか、自分のRole・Skill・Rule・Workflowを作成します。</p>
            </li>
            <li>
              <strong>Contextを確認して起動する</strong>
              <p>Context Previewで適用理由を確認し、Workflowと今回の指示を指定します。</p>
            </li>
            <li>
              <strong>Runtimeと接続する</strong>
              <p>
                Runtime & MCPの接続先を登録します。AIはMCPからHandoffを受け取り、実作業を行います。
              </p>
            </li>
            <li>
              <strong>観測して、改善する</strong>
              <p>JournalからReviewを開始し、AIの提案を確認・承認します。</p>
            </li>
          </ol>
          <div className="callout">
            Workflowの接続図からStageを選び、担当Role・遷移先・完了条件を編集できます。
          </div>
        </Modal>
      )}
    </div>
  );
}
function Workflows({
  data,
  onLaunch,
  onEdit,
  onPreview,
  install,
  onCreate,
  onOpenRun,
  onReviews,
  onOpenReview,
  onOpenChange,
}: {
  data: Overview;
  onLaunch: (id: string) => void;
  onEdit: (a: Asset) => void;
  onPreview: (ctx: Context) => void;
  install: () => Promise<unknown>;
  onCreate: () => void;
  onOpenRun: (id: string) => void;
  onReviews: () => void;
  onOpenReview: (id: string) => void;
  onOpenChange: (id: string) => void;
}) {
  const workflows = data.assets.filter((a) => a.type === 'workflow');
  const [selectedId, setSelectedId] = useState('');
  const selected = workflows.find((a) => a.id === selectedId) ?? workflows[0];
  const [stageId, setStageId] = useState('');
  const stage =
    selected?.workflow?.stages.find((s) => s.id === stageId) ?? selected?.workflow?.stages[0];
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const activeRuns = data.runs.filter((r) => r.status === 'active');
  const runningRuns = activeRuns.filter((r) => r.executionStatus === 'running');
  const preparedRuns = data.runs.filter(isPrepared);
  const pendingReviews = data.reviews.filter((r) => r.status === 'pending');
  const starter = async () => {
    setBusy(true);
    try {
      await install();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {workflows.length > 0 && (
        <div className="workspace-overview">
          <div>
            <Workflow size={18} />
            <strong>{workflows.length}</strong>
            <span>Workflows</span>
          </div>
          <div>
            <Layers size={18} />
            <strong>{data.assets.length}</strong>
            <span>Assets</span>
          </div>
          <div>
            <span className={`status-dot ${runningRuns.length ? 'active' : ''}`} />
            <strong>{runningRuns.length}</strong>
            <span>実行中</span>
          </div>
          <div>
            <strong>{preparedRuns.length}</strong>
            <span>AIへ依頼待ち</span>
          </div>
          <button type="button" onClick={onReviews}>
            <BookOpen size={18} />
            <strong>{pendingReviews.length}</strong>
            <span>承認待ち</span>
            <ChevronRight size={14} />
          </button>
        </div>
      )}
      {activeRuns[0] && (
        <button type="button" className="resume-run" onClick={() => onOpenRun(activeRuns[0].id)}>
          <span className="resume-icon">
            <Play size={19} />
          </span>
          <div className="grow">
            <span>{runStatusLabel(activeRuns[0])}</span>
            <strong>{activeRuns[0].title}</strong>
            <small>
              {runName(activeRuns[0], data)} ·{' '}
              {activeRuns[0].workflow?.workflow?.stages.find((s) => s.id === activeRuns[0].stage)
                ?.name ?? '質問・調査・検討'}
            </small>
          </div>
          <span className="resume-action">
            続きを開く
            <ArrowRight size={16} />
          </span>
        </button>
      )}
      <div className="section-head">
        <div className="button-row">
          <h2>My workflows</h2>
          <Badge>{workflows.length}</Badge>
        </div>
        <span className="small-text muted">明示的に選択して開始</span>
      </div>
      {error && <div className="error">{error}</div>}
      {!workflows.length ? (
        <div className="workflow-empty">
          <div className="starter-card">
            <div className="asset-icon workflow">
              <Sparkles size={23} />
            </div>
            <div>
              <Badge>QUICK START</Badge>
              <h3>Issue developmentから始める</h3>
              <p>
                6つのStage、共通Role、Ruleと単独レビューSkillを追加。
                <br />
                追加後は、自分の開発方針に合わせて編集できます。
              </p>
              <button disabled={busy} className="button primary" onClick={starter}>
                {busy ? '追加中…' : 'スターターを追加'}
                <ArrowRight size={15} />
              </button>
            </div>
          </div>
          <button className="create-workflow-card" onClick={onCreate}>
            <Plus size={26} />
            <strong>自分のWorkflowを作成</strong>
            <span>RoleとStageから進め方を定義</span>
          </button>
        </div>
      ) : (
        <>
          <div className="workflow-cards">
            {workflows.map((w) => (
              <article
                key={w.id}
                className={`workflow-card ${selected?.id === w.id ? 'selected' : ''}`}
              >
                <button
                  className="workflow-card-main"
                  onClick={() => {
                    setSelectedId(w.id);
                    setStageId('');
                  }}
                >
                  <div className="section-head compact">
                    <div className="asset-icon workflow">
                      <Workflow size={22} />
                    </div>
                    <Badge tone={w.enabled ? 'green' : ''}>{w.enabled ? '有効' : '無効'}</Badge>
                  </div>
                  <h3>{w.name}</h3>
                  <p>{w.description || 'ユーザー定義の開発Workflow'}</p>
                  <div className="workflow-card-meta">
                    <span>{w.workflow?.stages.length} stages</span>
                    <span>r{w.revision}</span>
                    <span>{w.projectId ? 'Project' : 'Global'}</span>
                  </div>
                </button>
                <div className="workflow-card-footer">
                  <code>/{w.id}</code>
                  <button
                    aria-label={`${w.name}を起動`}
                    className="button small primary workflow-launch"
                    disabled={!w.enabled && !w.mandatory}
                    onClick={() => onLaunch(w.id)}
                  >
                    <Play size={14} fill="currentColor" />
                    起動する
                  </button>
                </div>
              </article>
            ))}
            <button className="create-workflow-card compact-card" onClick={onCreate}>
              <Plus size={23} />
              <strong>新しいWorkflow</strong>
              <span>Stage・Role・遷移を設定</span>
            </button>
          </div>
          {selected && (
            <section className="panel workflow-definition">
              <div className="panel-head">
                <div className="button-row">
                  <h3>{selected.name}</h3>
                  <Badge>r{selected.revision}</Badge>
                </div>
                <div className="button-row">
                  <button className="button small" onClick={() => onEdit(selected)}>
                    <Pencil size={13} />
                    定義を編集
                  </button>
                  <button
                    className="button small"
                    onClick={() =>
                      onPreview({
                        workflow: selected.id,
                        stage: stage?.id,
                        project: selected.projectId,
                      })
                    }
                  >
                    Contextを確認
                    <ArrowUpRight size={13} />
                  </button>
                </div>
              </div>
              <WorkflowFlow workflow={selected} current={stage?.id} onSelect={setStageId} />
              <div className="stage-detail">
                <div>
                  <span className="eyebrow">SELECTED STAGE</span>
                  <h3>{stage?.name}</h3>
                  <p>{stage?.completionCriteria.join(' / ') || '完了条件は未設定'}</p>
                </div>
                <div>
                  <span className="eyebrow">ROLE / MODEL</span>
                  <strong>{stage?.role}</strong>
                  <span>
                    {stageAssignment(data.config, selected.id, stage).model ??
                      'Runtimeの標準モデル'}
                  </span>
                  <span>
                    {stageAssignment(data.config, selected.id, stage).runtime ?? 'Runtime未指定'}
                  </span>
                  {stage?.modelConstraint?.model && (
                    <span>必須モデル: {stage.modelConstraint.model}</span>
                  )}
                  {stage?.modelConstraint?.differentFromStage && (
                    <span>
                      {selected.workflow?.stages.find(
                        (s) => s.id === stage.modelConstraint?.differentFromStage,
                      )?.name ?? stage.modelConstraint.differentFromStage}
                      とは別の実モデルが必要
                    </span>
                  )}
                </div>
                <div>
                  <span className="eyebrow">TRANSITIONS</span>
                  {stage && (stage.canComplete ?? stage.transitions.length === 0) && (
                    <Badge tone="green">完了可能</Badge>
                  )}
                  {stage?.transitions.length ? (
                    stage.transitions.map((t) => (
                      <span key={`${t.to}:${t.kind}`}>
                        <Badge>{t.kind}</Badge> {t.to}
                      </span>
                    ))
                  ) : (
                    <span>遷移先なし</span>
                  )}
                </div>
              </div>
              <WorkflowActivity
                key={selected.id}
                workflow={selected}
                data={data}
                onRun={onOpenRun}
                onReview={onOpenReview}
                onChange={onOpenChange}
              />
            </section>
          )}
        </>
      )}
      <div className="bottom-cards">
        <button className="guidance-card" onClick={() => onPreview({})}>
          <div className="asset-icon rule">
            <FileCode2 size={20} />
          </div>
          <div>
            <h3>実行前に、Contextを確認</h3>
            <p>どのAssetが、なぜ適用されるか。</p>
          </div>
          <ArrowUpRight size={17} />
        </button>
        <div className="guidance-card advisory-note">
          <div className="asset-icon knowledge">
            <ShieldCheck size={20} />
          </div>
          <div>
            <h3>Workflowを選ばないときはAdvisory</h3>
            <p>質問や検討から、実装へ自動で進みません。</p>
          </div>
        </div>
      </div>
    </>
  );
}
function Assets({
  data,
  query,
  onDetail,
  mutate,
}: {
  data: Overview;
  query: string;
  onDetail: (asset: Asset) => void;
  mutate: (route: string, body: unknown) => Promise<unknown>;
}) {
  const [type, setType] = useState('all');
  const [view, setView] = useState('list');
  const list = data.assets.filter(
    (a) =>
      (type === 'all' || a.type === type) &&
      `${a.id} ${a.name} ${a.description} ${a.content}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="toolbar">
        <div className="filter-pills">
          <button className={type === 'all' ? 'active' : ''} onClick={() => setType('all')}>
            すべて <span>{data.assets.length}</span>
          </button>
          {assetTypes
            .filter((t) => data.assets.some((a) => a.type === t))
            .map((t) => (
              <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>
                {t} <span>{data.assets.filter((a) => a.type === t).length}</span>
              </button>
            ))}
        </div>
        <div className="view-switch">
          <button
            aria-label="リスト表示"
            className={view === 'list' ? 'active' : ''}
            onClick={() => setView('list')}
          >
            <List size={17} />
          </button>
          <button
            aria-label="関係表示"
            className={view === 'relations' ? 'active' : ''}
            onClick={() => setView('relations')}
          >
            <GitBranch size={17} />
          </button>
          <button
            aria-label="カード表示"
            className={view === 'grid' ? 'active' : ''}
            onClick={() => setView('grid')}
          >
            <LayoutGrid size={17} />
          </button>
        </div>
      </div>
      {view === 'relations' ? (
        <RelationsExplorer data={data} onSelect={onDetail} mutate={mutate} />
      ) : list.length ? (
        view === 'list' ? (
          <div className="panel table-scroll">
            <table className="asset-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Type</th>
                  <th>Scope</th>
                  <th>Revision</th>
                  <th>更新</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <button className="asset-name-button" onClick={() => onDetail(a)}>
                        <span className={`asset-icon ${a.type}`}>
                          <FileCode2 size={17} />
                        </span>
                        <span>
                          <strong>{a.name}</strong>
                          <small>{a.id}</small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <Badge>{a.type}</Badge>
                    </td>
                    <td>
                      <div className="scope-pills">
                        {Object.entries(a.scope).length ? (
                          Object.entries(a.scope).map(([k, v]) => (
                            <span key={k} title={v?.join(', ')}>
                              {k}: {v?.join(', ')}
                            </span>
                          ))
                        ) : (
                          <span>global</span>
                        )}
                      </div>
                    </td>
                    <td className="mono">r{a.revision}</td>
                    <td className="muted small-text">{relativeDate(a.updatedAt)}</td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={`${a.name}の詳細`}
                        onClick={() => onDetail(a)}
                      >
                        <ArrowUpRight size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="asset-grid">
            {list.map((a) => (
              <button className="panel asset-tile" key={a.id} onClick={() => onDetail(a)}>
                <div className="section-head compact">
                  <span className={`asset-icon ${a.type}`}>
                    <FileCode2 size={20} />
                  </span>
                  <Badge>{a.type}</Badge>
                </div>
                <h3>{a.name}</h3>
                <p>{a.description || a.content.slice(0, 90)}</p>
                <div className="small-text muted">
                  {a.id} · r{a.revision}
                </div>
              </button>
            ))}
          </div>
        )
      ) : (
        <Empty title={query ? '一致するAssetがありません' : 'Assetはまだありません'}>
          上の「Assetを作成」から知識や方針を登録するか、Workflowsでスターターを追加できます。
        </Empty>
      )}
    </>
  );
}
function AssetDetail({
  asset,
  data,
  onClose,
  onEdit,
  mutate,
  onSelect,
}: {
  asset: Asset;
  data: Overview;
  onClose: () => void;
  onEdit: () => void;
  onSelect: (asset: Asset) => void;
  mutate: (route: string, body: unknown) => Promise<any>;
}) {
  const [tab, setTab] = useState('content');
  const [deleting, setDeleting] = useState(false);
  const [restore, setRestore] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const history = data.changesets.filter((c) => c.changes.some((x) => x.id === asset.id));
  return (
    <Modal title={asset.name} onClose={onClose} wide>
      <div className="section-head compact">
        <div className="button-row">
          <Badge tone="blue">{asset.type}</Badge>
          <code>
            {asset.id}@{asset.revision}
          </code>
        </div>
        <button className="button" onClick={onEdit}>
          <Pencil size={14} />
          編集する
        </button>
      </div>
      <p className="muted">{asset.description}</p>
      <div className="tabs">
        <button className={tab === 'content' ? 'active' : ''} onClick={() => setTab('content')}>
          本文
        </button>
        <button className={tab === 'metadata' ? 'active' : ''} onClick={() => setTab('metadata')}>
          Scope / Relations
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          変更履歴 <span>{history.length}</span>
        </button>
      </div>
      {tab === 'content' && (
        <>
          <ContractDetails asset={asset} />
          <pre className="context-content">{asset.content || '本文はありません。'}</pre>
          {asset.workflow && <WorkflowFlow workflow={asset} />}
          {asset.capability && <Json value={asset.capability} />}
          {(asset.files || asset.sources) && <AssetFiles asset={asset} />}
        </>
      )}
      {tab === 'metadata' && <AssetMetadata asset={asset} data={data} onSelect={onSelect} />}
      {tab === 'history' && (
        <AssetHistory key={`${asset.id}:${asset.revision}`} assetId={asset.id} />
      )}
      {tab === 'history' &&
        history.map((c) => {
          const change = c.changes.find((x) => x.id === asset.id)!;
          return (
            <div key={c.id} className="asset-history-entry">
              <Badge>{c.origin}</Badge>
              <strong>{changeSummary(c)}</strong>
              {changeSummary(c) !== c.summary && (
                <details>
                  <summary>導入ID・依頼原文・変更理由</summary>
                  <pre className="context-content">{c.summary}</pre>
                </details>
              )}
              <p className="muted small-text">
                {relativeDate(c.createdAt)} · {c.actor} · {c.id}
              </p>
              <details>
                <summary>変更前 / 変更後を見る</summary>
                <div className="diff-grid">
                  <Json value={change.before} />
                  <Json value={change.after} />
                </div>
              </details>
              {change.after && change.after.revision !== asset.revision && (
                <button className="button small" onClick={() => setRestore(change.after!.revision)}>
                  <RotateCcw size={13} />r{change.after.revision}へ復元
                </button>
              )}
            </div>
          );
        })}
      {restore !== null && (
        <div className="callout">
          <p>
            {asset.id}のr{restore}を、新しいrevisionとして復元します。
          </p>
          <div className="button-row">
            <button className="button" onClick={() => setRestore(null)}>
              キャンセル
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await mutate('/rollback', {
                    assetId: asset.id,
                    revision: restore,
                    expectedRevision: asset.revision,
                  });
                  setRestore(null);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              復元する
            </button>
          </div>
        </div>
      )}
      {deleting ? (
        <div className="callout">
          <p>
            {asset.name}
            を削除します。履歴は保持されます。他のAssetから必要とされる場合、削除できません。
          </p>
          <div className="button-row">
            <button className="button" onClick={() => setDeleting(false)}>
              キャンセル
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await mutate('/assets/change', {
                    operations: [{ op: 'delete', id: asset.id, expectedRevision: asset.revision }],
                    summary: `削除: ${asset.name}`,
                  });
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              削除を確定
            </button>
          </div>
        </div>
      ) : (
        <div className="modal-actions left">
          <button className="button text-button" onClick={() => setDeleting(true)}>
            <Trash2 size={14} />
            Assetを削除
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}
