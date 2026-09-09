import { useId, useState } from 'react';
import { X, Plus } from 'lucide-react';

export type Choice = { id: string; label: string };
export function TokenPicker({
  id,
  value,
  onChange,
  choices = [],
  placeholder = '値を入力してEnter',
  'aria-describedby': describedBy,
}: {
  id?: string;
  value: string[];
  onChange: (value: string[]) => void;
  choices?: Choice[];
  placeholder?: string;
  'aria-describedby'?: string;
}) {
  const listId = useId();
  const [draft, setDraft] = useState('');
  const commit = (text = draft, extra: string[] = []) => {
    const additions = text
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    onChange([...new Set([...value, ...additions, ...extra])]);
    setDraft('');
  };
  return (
    <div className="token-picker">
      <div className="token-input">
        {value.map((item) => (
          <span className="input-token" key={item} title={item}>
            {choices.find((c) => c.id === item)?.label ?? item}
            <button
              type="button"
              aria-label={`${item}を除く`}
              onClick={() => onChange(value.filter((v) => v !== item))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          id={id}
          list={listId}
          value={draft}
          placeholder={value.length ? 'さらに追加…' : placeholder}
          aria-describedby={describedBy}
          onChange={(e) => {
            const next = e.target.value;
            if (next.endsWith(',')) commit(next);
            else setDraft(next);
          }}
          onBlur={() => {
            if (draft.trim()) commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              commit();
            }
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (/[,\n]/.test(text)) {
              e.preventDefault();
              commit(draft + text);
            }
          }}
        />
        {draft.trim() && (
          <button
            type="button"
            className="icon-button"
            aria-label="入力した値を追加"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commit()}
          >
            <Plus size={15} />
          </button>
        )}
      </div>
      <datalist id={listId}>
        {choices
          .filter((c) => !value.includes(c.id))
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
      </datalist>
      {choices.length > 0 && (
        <details className="token-choices">
          <summary>
            候補から選ぶ <span>{choices.length}</span>
          </summary>
          <div className="choice-list">
            {choices.map((c) => (
              <label key={c.id} title={c.id} className={value.includes(c.id) ? 'checked' : ''}>
                <input
                  type="checkbox"
                  checked={value.includes(c.id)}
                  onChange={(e) => {
                    if (e.target.checked) commit(draft, [c.id]);
                    else onChange(value.filter((v) => v !== c.id));
                  }}
                />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
