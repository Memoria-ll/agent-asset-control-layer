import { useState } from 'react';
import { Plus, FolderGit2, Plug, Download, ArrowUpRight } from 'lucide-react';
import type { Overview } from './api.ts';
import { RuntimeConfigEditor } from './RuntimeConfigEditor.tsx';
import { ProjectOverlayEditor } from './ProjectOverlayEditor.tsx';
import { SettingsHistory } from './SettingsHistory.tsx';
import { Badge, CopyButton, Empty, Field, Modal } from './ui.tsx';

type Mutate = (route: string, body: unknown, method?: string) => Promise<any>;
export function Settings({ data, mutate }: { data: Overview; mutate: Mutate }) {
  const endpoint = `${location.origin}/mcp`;
  return (
    <>
      <RuntimeConfigEditor data={data} onSave={(config) => mutate('/config', config, 'PUT')} />
      <SettingsHistory data={data} mutate={mutate} />
      <section className="panel margin-top">
        <div className="panel-head">
          <h3>
            <Plug size={17} />
            MCPで接続
          </h3>
          <Badge tone="green">Streamable HTTP</Badge>
        </div>
        <div className="panel-body">
          <p className="muted">
            Claude・CodexなどのMCPクライアントから、同じCoreのWorkflowとContextを利用できます。
          </p>
          <div className="endpoint">
            <span className="status-dot active" />
            <code>{endpoint}</code>
            <CopyButton text={endpoint} />
          </div>
          <div className="form-grid">
            <div>
              <h4>Codex · config.toml</h4>
              <pre className="code">{`[mcp_servers.aacl]\nurl = "${endpoint}"`}</pre>
              <CopyButton text={`[mcp_servers.aacl]\nurl = "${endpoint}"`} />
            </div>
            <div>
              <h4>Claude Code</h4>
              <pre className="code">{`claude mcp add --transport http aacl ${endpoint}`}</pre>
              <CopyButton text={`claude mcp add --transport http aacl ${endpoint}`} />
            </div>
          </div>
          <details className="form-section">
            <summary>stdio bridgeを使う</summary>
            <p>Coreを起動したまま、プロジェクトの絶対パスを指定します。</p>
            <pre className="code">
              {JSON.stringify(
                {
                  mcpServers: {
                    aacl: {
                      command: 'node',
                      args: [
                        '--import',
                        '/absolute/path/to/aacl/node_modules/tsx/dist/loader.mjs',
                        '/absolute/path/to/aacl/server/stdio.ts',
                      ],
                      env: { AACL_URL: endpoint },
                    },
                  },
                },
                null,
                2,
              )}
            </pre>
          </details>
          <p className="small-text muted">
            Coreは状態管理とContext提供を担当します。Modelと外部MCPツールの呼び出しは接続先Runtimeが担当します。
          </p>
          <section className="form-section" aria-label="会話から操作するための接続案内">
            <h3>会話から確認・実行・改善する</h3>
            <p>
              接続したAIに依頼すると、同じ資産と実行をMCPから操作できます。承認が必要な変更は、具体的な提案を会話で確認して判断できます。
            </p>
            <dl className="evidence-values">
              <div>
                <dt>現在の実行とContextを確認</dt>
                <dd>
                  <code>aacl_run_get</code> と <code>aacl_context_handoff_preview</code>{' '}
                  は閲覧用です。Snapshotや実行versionを増やしません。
                </dd>
              </div>
              <div>
                <dt>作業を実行</dt>
                <dd>
                  <code>aacl_context_handoff</code>{' '}
                  でContextを受け取り、実際の作業開始・結果・失敗を <code>aacl_runtime_event</code>{' '}
                  で報告します。
                </dd>
              </div>
              <div>
                <dt>新しい資産や紐づけを提案</dt>
                <dd>
                  <code>aacl_asset_propose</code> で変更案を用意し、ユーザーの判断を{' '}
                  <code>aacl_proposal_decision</code> で記録します。架空のJournalは不要です。
                </dd>
              </div>
              <div>
                <dt>実行の観測から改善</dt>
                <dd>
                  <code>aacl_review_get</code> と <code>aacl_review_submit</code>{' '}
                  で根拠と提案を確認し、<code>aacl_review_decision</code>{' '}
                  でユーザーの判断を記録します。
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </section>
    </>
  );
}
export function Projects({ data, mutate }: { data: Overview; mutate: Mutate }) {
  const [adding, setAdding] = useState(false);
  const [root, setRoot] = useState('');
  const [name, setName] = useState('');
  const [edit, setEdit] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="toolbar">
        <p className="muted">Projectの資産は、そのProjectの.aaclディレクトリに保存します。</p>
        <button
          className="button primary"
          onClick={() => {
            setAdding(true);
            setError('');
          }}
        >
          <Plus size={15} />
          Projectを登録
        </button>
      </div>
      <div className="project-grid">
        {data.projects.map((p) => (
          <section className="panel" key={p.id}>
            <div className="panel-body">
              <div className="section-head compact">
                <div className="asset-icon knowledge">
                  <FolderGit2 size={23} />
                </div>
                <Badge tone="green">Initialized</Badge>
              </div>
              <h2>{p.name}</h2>
              <p className="path-text">{p.root}</p>
              <code className="small-text">{p.id}</code>
              <div className="project-stats">
                <span>
                  <strong>{data.assets.filter((a) => a.projectId === p.id).length}</strong> assets
                </span>
                <span>
                  <strong>
                    {p.disabled.length +
                      Object.keys(p.overrides).length +
                      Object.keys(p.bindings).length}
                  </strong>{' '}
                  overlays
                </span>
              </div>
              <button
                className="button"
                onClick={() => {
                  setEdit(p.id);
                  setError('');
                }}
              >
                Overlayを編集
                <ArrowUpRight size={14} />
              </button>
            </div>
          </section>
        ))}
      </div>
      {!data.projects.length && (
        <Empty
          title="Project固有の知識を登録する"
          action={
            <button className="button" onClick={() => setAdding(true)}>
              <FolderGit2 size={15} />
              Projectを登録
            </button>
          }
        >
          Global Assetを共有しながら、Projectごとの追加・無効化・置き換え・bindingを指定できます。
        </Empty>
      )}
      {adding && (
        <Modal title="Projectを登録" onClose={() => setAdding(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await mutate('/projects', { root, name });
                setAdding(false);
                setRoot('');
                setName('');
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Project名">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My project"
              />
            </Field>
            <Field label="Project root" hint="Coreが動作しているOSでの既存ディレクトリの絶対パス。">
              <input
                required
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                placeholder="/home/owner/dev/my-project"
              />
            </Field>
            <div className="callout">
              指定したフォルダに.aacl/project.jsonとassets.jsonを作成し、安定したProject
              IDを割り当てます。
            </div>
            {error && <div className="error">{error}</div>}
            <div className="modal-actions">
              <button type="button" className="button" onClick={() => setAdding(false)}>
                キャンセル
              </button>
              <button disabled={busy} className="button primary">
                登録する
              </button>
            </div>
          </form>
        </Modal>
      )}
      {edit && (
        <ProjectOverlayEditor
          project={data.projects.find((p) => p.id === edit)!}
          data={data}
          onClose={() => setEdit('')}
          onSave={(overlay) => mutate(`/projects/${edit}/overlay`, overlay, 'PUT')}
        />
      )}
    </>
  );
}
export function ImportModal({
  data,
  mutate,
  onClose,
}: {
  data: Overview;
  mutate: Mutate;
  onClose: () => void;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState('skill');
  const [content, setContent] = useState('');
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Native Markdownを取り込む" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await mutate('/import', {
              id,
              name,
              type,
              content,
              ...(projectId ? { projectId } : {}),
            });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Markdownファイル">
          <input
            type="file"
            accept=".md,.txt"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) {
                setContent(await file.text());
                setName((current) => current || file.name.replace(/\.md$/, ''));
              }
            }}
          />
        </Field>
        <div className="form-grid">
          <Field label="ID">
            <input required value={id} onChange={(e) => setId(e.target.value)} />
          </Field>
          <Field label="名前">
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="種別">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="skill">Skill</option>
              <option value="rule">Rule</option>
              <option value="knowledge">Knowledge</option>
            </select>
          </Field>
          <Field label="保存先">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Global</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="本文 / SKILL.md">
          <textarea
            required
            rows={10}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </Field>
        <p className="muted small-text">
          名前は画面の入力値を使います。先頭メタデータからdescriptionを取り込み、nameは使いません。scopeやbindingは本文から推測しません。
        </p>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            キャンセル
          </button>
          <button disabled={busy} className="button primary">
            <Download size={15} />
            取り込む
          </button>
        </div>
      </form>
    </Modal>
  );
}
