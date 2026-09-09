import type { ChangeSet } from '../server/domain.ts';

// Keep persisted recovery markers intact; only shorten their presentation.
export function changeSummary(change: Pick<ChangeSet, 'summary' | 'changes'>) {
  const match = /^onboarding:([a-zA-Z0-9._-]+):(import|verify|organize):[a-f0-9]{64}(?:\n|$)/.exec(
    change.summary,
  );
  if (!match) return change.summary;
  return {
    import: `既存指示${change.changes.length}件を取り込み`,
    verify: '接続を確認',
    organize: `既存指示を分類（変更した資産${change.changes.length}件）`,
  }[match[2]]!;
}
