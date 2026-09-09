import { useRef, useState } from 'react';
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
                <dt>必要なSkillを読む</dt>
                <dd>
                  <code>aacl_skill_get</code>{' '}
                  で候補のID・revision・snapshotIdを指定して本文を取得します。説明だけの候補、本文の取得、使用の報告は別に記録されます。
                </dd>
              </div>
              <div>
                <dt>作業を実行</dt>
                <dd>
                  <code>aacl_context_handoff</code>{' '}
                  でContextを受け取り、実際の作業開始・結果・失敗を <code>aacl_runtime_event</code>{' '}
                  で報告します。モデル未指定ならRuntimeの標準設定で起動し、開始報告に実際のモデル・Runtimeを添えます。不明な値は推測しません。
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
function markdownName(content: string, fallback: string) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const value = frontmatter?.match(/^name:[ \t]*([^\r\n]*)$/m)?.[1].trim();
  if (!value) return fallback;
  const doubleQuoted = value.match(/^"([^"\\]*)"(?:[ \t]+#.*)?$/);
  if (doubleQuoted) return doubleQuoted[1].trim() || fallback;
  const singleQuoted = value.match(/^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/);
  if (singleQuoted) return singleQuoted[1].replace(/''/g, "'").trim() || fallback;
  // Only suggest simple scalar names; leave complex YAML to the user.
  if (/^["'\[\]{},&*!|>#%@`]/.test(value)) return fallback;
  return value.replace(/[ \t]+#.*$/, '').trim() || fallback;
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
  const [reading, setReading] = useState(false);
  const nameEdited = useRef(false);
  const fileSelection = useRef(0);
  const filenameSuggestion = useRef('');
  const onboardingRequest = `既存のAI向け設定・SkillをAACLへ移行してください。対象フォルダ: [移行する絶対パスに置換]。通常のREADMEやプロジェクト資料は元の場所に残してください。
1. AACLのMCP（AIがツールを使う接続方式） ${location.origin}/mcp に接続したAIから、aacl_onboarding_discoverで対象を調べ、返された移行IDを記録してください。
2. 対象ファイルを確認し、aacl_onboarding_importでバックアップを作成して無効状態で取り込んでください。元のパス・ハッシュと補助ファイルも確認してください。
3. 接続先のAIからaacl_asset_getで取り込んだ全資産を読み、この移行依頼をuserRequestに指定してaacl_onboarding_verifyで実際のMCP書き込みを検証してください。
4. 検証後にaacl_onboarding_organizeで種別・適用条件・資産間の関係を分類・整理してください。不明な資産は無効または未接続のままにしてください。
5. 追加の接続設定が必要なAI環境がある場合だけ、aacl_onboarding_planで設定を確認し、aacl_onboarding_connectで設定してください。既に接続済みなら設定を繰り返す必要はありません。
6. バックアップ・分類・接続の検証結果と切り替え対象を示してください。元ファイルの自動読み込みを止める切り替えは、その対象について私の依頼を確認してからaacl_onboarding_cutoverで行ってください。通常のREADMEは切り替え対象から外してください。
7. 移行IDと復元手順を報告してください。復元を依頼した場合はaacl_onboarding_restoreにそのIDをidとして渡し、バックアップから戻してください。`;
  return (
    <Modal title="単一Markdownを登録" onClose={onClose}>
      <p>
        1つのMarkdownを新しい資産として登録します。登録直後から有効になります。Skillは必要時に本文を取得する候補になります。
      </p>
      <p className="muted small-text">
        元のパス・ハッシュ・補助ファイルは保存しません。元ファイルは変更しません。既存環境のバックアップや移行には、下の「AIに移行・初期設定を依頼」を使ってください。
      </p>
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
              if (!file) return;
              const selection = ++fileSelection.current;
              setReading(true);
              setError('');
              try {
                const text = await file.text();
                if (selection !== fileSelection.current) return;
                filenameSuggestion.current = file.name.replace(/\.(md|txt)$/i, '');
                setContent(text);
                if (!nameEdited.current) {
                  setName(markdownName(text, filenameSuggestion.current));
                }
              } catch {
                if (selection === fileSelection.current)
                  setError(
                    'ファイルを読み込めませんでした。もう一度選択するか、本文を貼り付けてください。',
                  );
              } finally {
                if (selection === fileSelection.current) setReading(false);
              }
            }}
          />
        </Field>
        <div className="form-grid">
          <Field label="ID" hint="既存の資産と重複しないIDを入力してください。">
            <input required value={id} onChange={(e) => setId(e.target.value)} />
          </Field>
          <Field label="名前">
            <input
              required
              value={name}
              onChange={(e) => {
                nameEdited.current = true;
                setName(e.target.value);
              }}
            />
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
            onChange={(e) => {
              ++fileSelection.current;
              setReading(false);
              setContent(e.target.value);
              if (!nameEdited.current) {
                setName(markdownName(e.target.value, filenameSuggestion.current));
              }
            }}
          />
        </Field>
        <p className="muted small-text">
          名前は先頭メタデータのname（単純な引用符付き・引用符なしの値）を候補にし、なければファイル名を使います。本文の貼り付けでも候補を更新します。名前を手入力した後は、ファイルを選び直しても上書きしません。保存には画面の名前を使います。
        </p>
        <p className="muted small-text">
          先頭メタデータのdescriptionを説明として保存し、先頭メタデータを除いた内容を本文として保存します。適用条件（scope）や割り当て（binding）は本文から推測しません。
        </p>
        {reading && <p role="status">ファイルを読み込み中です。</p>}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            キャンセル
          </button>
          <button disabled={busy || reading} className="button primary">
            <Download size={15} />
            取り込む
          </button>
        </div>
      </form>
      <section className="form-section" aria-label="AIに移行・初期設定を依頼">
        <h3>AIに移行・初期設定を依頼</h3>
        <p className="muted small-text">
          既存のAI環境を移行する場合の依頼文です。対象フォルダを書き換えて、AACLにMCPで接続したAIに渡してください。移行ではバックアップを保存し、接続確認後に元の自動読み込みを切り替えます。
        </p>
        <CopyButton text={onboardingRequest} label="移行の依頼をコピー" />
        <details>
          <summary>移行の依頼文を確認</summary>
          <pre className="context-content">{onboardingRequest}</pre>
        </details>
      </section>
    </Modal>
  );
}
