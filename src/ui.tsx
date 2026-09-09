import {
  useEffect,
  useRef,
  useId,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { X, Copy, Check, ArrowUpRight, Inbox } from 'lucide-react';
import { useState } from 'react';

export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function statusLabel(value: string) {
  return (
    (
      {
        active: '実行中',
        completed: '完了',
        cancelled: '中止',
        'awaiting-proposal': '提案待ち',
        pending: '承認待ち',
        approved: '承認済み',
        rejected: '却下',
        included: '適用',
        excluded: '対象外',
        overridden: '置き換え',
        disabled: '無効',
        unavailable: '利用不可',
        conflict: '競合',
      } as Record<string, string>
    )[value] ?? value
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Inbox size={26} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    const fn = () => {
      if (!d.open) onClose();
    };
    d.addEventListener('close', fn);
    return () => {
      d.removeEventListener('close', fn);
      d.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'modal wide' : 'modal'}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="閉じる" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string; 'aria-describedby'?: string }>, {
        id,
        'aria-describedby': hint ? `${id}-hint` : undefined,
      })
    : children;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function CopyButton({ text, label = 'コピー' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <button
      className="button small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setError(false);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          setError(true);
        }
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {error ? '選択してコピーしてください' : copied ? 'コピー済み' : label}
    </button>
  );
}
export function DownloadButton({ filename, content }: { filename: string; content: string }) {
  return (
    <button className="button small" onClick={() => download(filename, content)}>
      <ArrowUpRight size={14} />
      ダウンロード
    </button>
  );
}
export function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Json({ value }: { value: unknown }) {
  return <pre className="code">{JSON.stringify(value, null, 2)}</pre>;
}
export function relativeDate(iso: string) {
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
