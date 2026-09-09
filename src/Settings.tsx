import { useState } from 'react';
import { Plus, FolderGit2, Plug, Save, Download, ArrowUpRight } from 'lucide-react';
import type { Overview } from './api.ts';
import { Badge, CopyButton, Empty, Field, Json, Modal } from './ui.tsx';

type Mutate = (route: string, body: unknown, method?: string) => Promise<any>;
export function Settings({ data, mutate }: { data: Overview; mutate: Mutate }) {
  const [config, setConfig] = useState(JSON.stringify(data.config, null, 2));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const endpoint = `${location.origin}/mcp`;
  return (
    <>
      <section className="panel">
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
        </div>
      </section>
      <section className="panel margin-top">
        <div className="panel-head">
          <h3>Provider / Account / Model / Role binding</h3>
          <Badge>ユーザー定義</Badge>
        </div>
        <div className="panel-body">
          <p className="muted">
            モデルIDと利用方針を明示登録してください。Accountは識別用で、APIキーは保存しません。
          </p>
          <details>
            <summary>設定例を見る</summary>
            <Json
              value={{
                providers: [{ id: 'openai', name: 'OpenAI' }],
                accounts: [{ id: 'personal', provider: 'openai', name: 'Personal' }],
                runtimes: [{ id: 'codex', name: 'Codex', provider: 'openai' }],
                models: [
                  {
                    id: 'your-model-id',
                    name: '利用するモデル',
                    provider: 'openai',
                    account: 'personal',
                  },
                ],
                bindings: [
                  {
                    role: 'implementer',
                    workflow: 'issue-development',
                    model: 'your-model-id',
                    runtime: 'codex',
                  },
                ],
              }}
            />
          </details>
          <Field label="Runtime設定（JSON）">
            <textarea
              className="mono"
              rows={19}
              value={config}
              onChange={(e) => {
                setConfig(e.target.value);
                setSaved(false);
              }}
            />
          </Field>
          {error && <div className="error">{error}</div>}
          <div className="button-row">
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await mutate('/config', JSON.parse(config), 'PUT');
                  setSaved(true);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Save size={15} />
              設定を保存
            </button>
            {saved && <Badge tone="green">保存しました</Badge>}
          </div>
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
  const [overlay, setOverlay] = useState('');
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
                  setOverlay(
                    JSON.stringify(
                      { disabled: p.disabled, overrides: p.overrides, bindings: p.bindings },
                      null,
                      2,
                    ),
                  );
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
        <Modal title="Project overlay" onClose={() => setEdit('')}>
          <p className="muted">
            disabledはAsset ID配列、overridesは置換元ID→置換先ID、bindingsはAsset ID→scopeです。
          </p>
          <textarea
            className="mono"
            rows={16}
            value={overlay}
            onChange={(e) => setOverlay(e.target.value)}
          />
          {error && <div className="error">{error}</div>}
          <div className="modal-actions">
            <button className="button" onClick={() => setEdit('')}>
              キャンセル
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await mutate(`/projects/${edit}/overlay`, JSON.parse(overlay), 'PUT');
                  setEdit('');
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Overlayを保存
            </button>
          </div>
        </Modal>
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
                setName(file.name.replace(/\.md$/, ''));
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
          単純なname / description frontmatterを取り込みます。scopeやbindingは本文から推測しません。
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
