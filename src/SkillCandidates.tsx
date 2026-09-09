import { useState } from 'react';
import type { Core } from '../server/core.ts';
import type { Run, SkillCandidate } from '../server/domain.ts';
import { api } from './api.ts';
import { Badge, CopyButton } from './ui.tsx';

type SkillBody = ReturnType<Core['skillGet']>;

export function SkillCandidates({
  candidates = [],
  reads = [],
  attemptId,
}: {
  candidates?: SkillCandidate[];
  reads?: Run['skillReads'];
  attemptId?: string;
}) {
  if (!candidates.length) return null;
  return (
    <section className="panel skill-candidates" aria-label="Skill候補">
      <div className="panel-head">
        <h3>Skill候補</h3>
        <Badge>{candidates.length}件</Badge>
      </div>
      <div className="panel-body">
        <p className="muted small-text">
          まず説明だけを渡します。必要なSkillの本文と参照先は、同じ担当者が個別に取得します。本文の取得と、作業に使用したという報告は別に記録されます。
        </p>
        <div className="skill-candidate-list">
          {candidates.map((candidate) => (
            <CandidateCard
              key={`${candidate.id}:${candidate.revision}:${candidate.retrieval.arguments.snapshotId ?? ''}`}
              candidate={candidate}
              reads={reads.filter(
                (r) =>
                  r.assetId === candidate.id &&
                  r.revision === candidate.revision &&
                  r.snapshotId === candidate.retrieval.arguments.snapshotId,
              )}
              attemptId={attemptId}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function CandidateCard({
  candidate,
  reads,
  attemptId,
}: {
  candidate: SkillCandidate;
  reads: NonNullable<Run['skillReads']>;
  attemptId?: string;
}) {
  const [body, setBody] = useState<SkillBody | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const used = reads.some((r) => r.usedAt);
  const retrieved = !!body || reads.length > 0;
  return (
    <article className="skill-candidate" aria-label={candidate.name}>
      <div className="section-head compact">
        <div>
          <h4>{candidate.name}</h4>
          <span className="muted small-text">
            {candidate.id} · r{candidate.revision}
          </span>
        </div>
        <Badge tone={used ? 'green' : ''}>
          {used
            ? '使用の報告あり'
            : retrieved
              ? '本文を取得済み'
              : candidate.loading === 'body'
                ? 'Contextに本文を含む'
                : '説明のみ・本文未取得'}
        </Badge>
      </div>
      <p>{candidate.description || '説明は未登録です。'}</p>
      <details>
        <summary>候補になった理由・取得先</summary>
        <ul>
          {candidate.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
        <p className="small-text">
          取得ツール: <code>{candidate.retrieval.tool}</code> · {candidate.id}@{candidate.revision}
        </p>
        {candidate.retrieval.arguments.snapshotId && (
          <p className="small-text muted">
            固定したContext: {candidate.retrieval.arguments.snapshotId}
          </p>
        )}
      </details>
      {reads.length > 0 && (
        <details>
          <summary>取得・使用の記録</summary>
          <ul>
            {reads.map((read, i) => (
              <li key={i}>
                本文取得:{' '}
                <time dateTime={read.retrievedAt}>
                  {new Date(read.retrievedAt).toLocaleString()}
                </time>
                {read.usedAt ? (
                  <>
                    {' '}
                    · 使用報告:{' '}
                    <time dateTime={read.usedAt}>{new Date(read.usedAt).toLocaleString()}</time>
                  </>
                ) : (
                  ' · 使用報告なし'
                )}
                {read.attemptId && ` · 試行: ${read.attemptId}`}
                {read.reason && <p>{read.reason}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="button-row">
        <button
          type="button"
          className="button small"
          disabled={busy}
          onClick={async () => {
            if (body) {
              setOpen(!open);
              return;
            }
            setBusy(true);
            setError('');
            try {
              setBody(
                await api<SkillBody>('/skills/get', {
                  ...candidate.retrieval.arguments,
                  usage: 'inspect',
                  ...(candidate.retrieval.arguments.snapshotId && attemptId ? { attemptId } : {}),
                }),
              );
              setOpen(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy
            ? '本文を取得中…'
            : body
              ? open
                ? '本文を閉じる'
                : '取得した本文を表示'
              : 'この版の本文を取得'}
        </button>
      </div>
      <p className="small-text muted">
        {candidate.retrieval.arguments.snapshotId
          ? '取得すると閲覧の記録を残します。使用の報告や実行の開始は行いません。'
          : '本文を確認できます。実行に紐づく使用の記録は残しません。'}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {open && body && (
        <div className="skill-body" aria-label="取得したSkill本文">
          <div className="section-head compact">
            <strong>取得した本文 · r{body.asset.revision}</strong>
            <CopyButton text={body.asset.content} label="Skill本文をコピー" />
          </div>
          <pre className="context-content">{body.asset.content || '本文は空です。'}</pre>
          <details>
            <summary>補助ファイル・参照先（説明のみ）</summary>
            <p className="small-text muted">補助ファイルと参照先の本文は、まだ取得していません。</p>
            {body.files.length ? (
              <ul>
                {body.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code> · r{file.revision} · <code>{file.retrievalTool}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">補助ファイルなし</p>
            )}
            {body.references.length ? (
              <ul>
                {body.references.map((reference) => (
                  <li key={reference.id}>
                    <strong>{reference.name}</strong> · {reference.id}@{reference.revision}
                    <p>{reference.description}</p>
                    <code>{reference.retrieval.tool}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">参照先なし</p>
            )}
          </details>
          <p className="muted small-text">{body.guidance}</p>
        </div>
      )}
    </article>
  );
}
