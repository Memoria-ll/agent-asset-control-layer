import { isDeepStrictEqual } from 'node:util';
import { type Asset, type State, inputOf, requireValue } from './domain.ts';

export function changeKinds(before: Asset | null, after: Asset | null): string[] {
  if (!before) return ['added'];
  if (!after) return ['removed'];
  const kinds: string[] = [];
  const {
    scope: bs,
    dependencies: bd,
    conflicts: bc,
    relations: br,
    projectId: bp,
    ...b
  } = inputOf(before);
  const {
    scope: as,
    dependencies: ad,
    conflicts: ac,
    relations: ar,
    projectId: ap,
    ...a
  } = inputOf(after);
  if (!isDeepStrictEqual([bs, bp], [as, ap])) kinds.push('scope-changed');
  if (!isDeepStrictEqual([bd, bc, br], [ad, ac, ar])) kinds.push('relation-changed');
  if (!isDeepStrictEqual(b, a)) kinds.push('updated');
  return kinds.length ? kinds : ['no-change'];
}
export function assetHistory(state: State, assets: Asset[], id: string) {
  const versions = new Map<number, Asset>();
  const changesets = state.changesets.filter((c) => c.changes.some((x) => x.id === id));
  for (const cs of [...changesets].reverse())
    for (const change of cs.changes.filter((x) => x.id === id))
      for (const a of [change.before, change.after]) if (a) versions.set(a.revision, a);
  const current = assets.find((a) => a.id === id);
  if (current) versions.set(current.revision, current);
  requireValue(versions.size || undefined, 'Assetの履歴が見つかりません');
  return {
    id,
    currentRevision: current?.revision ?? 0,
    revisions: [...versions.values()].sort((a, b) => b.revision - a.revision),
    changesets,
  };
}
export type DiffLine = {
  kind: 'equal' | 'added' | 'removed';
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
};
export function lineDiff(before: string, after: string) {
  // Split without discarding newline terminators, so a missing final newline is a real change.
  const split = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = split(before),
    b = split(after);
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const lines: DiffLine[] = [];
  let ai = 0,
    bi = 0;
  const emit = (kind: DiffLine['kind']) => {
    const text = kind === 'added' ? b[bi] : a[ai];
    lines.push({
      kind,
      text,
      beforeLine: kind === 'added' ? null : ++ai,
      afterLine: kind === 'removed' ? null : ++bi,
    });
  };
  while (ai < prefix) emit('equal');
  const n = a.length - prefix - suffix,
    m = b.length - prefix - suffix;
  const coarse = (n + 1) * (m + 1) > 1_000_000;
  if (coarse) {
    while (ai < a.length - suffix) emit('removed');
    while (bi < b.length - suffix) emit('added');
  } else {
    const dp = new Uint32Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[at(i, j)] =
          a[prefix + i] === b[prefix + j]
            ? dp[at(i + 1, j + 1)] + 1
            : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    while (ai < a.length - suffix || bi < b.length - suffix) {
      const i = ai - prefix,
        j = bi - prefix;
      if (i < n && j < m && a[ai] === b[bi]) emit('equal');
      else if (i < n && (j === m || dp[at(i + 1, j)] >= dp[at(i, j + 1)])) emit('removed');
      else emit('added');
    }
  }
  while (ai < a.length) emit('equal');
  return { lines, coarse };
}
export function assetDiff(before: Asset | null, after: Asset | null) {
  const fields: { path: string; before: unknown; after: unknown }[] = [];
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const walk = (a: unknown, b: unknown, path: string) => {
    if (isDeepStrictEqual(a, b)) return;
    if (object(a) && object(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
        walk(a[key], b[key], path ? `${path}.${key}` : key);
    } else fields.push({ path, before: a ?? null, after: b ?? null });
  };
  const metadata = (a: Asset | null) => {
    if (!a) return {};
    const { content, ...rest } = inputOf(a);
    return rest;
  };
  walk(metadata(before), metadata(after), '');
  return {
    assetId: (before ?? after)!.id,
    fromRevision: before?.revision ?? 0,
    toRevision: after?.revision ?? 0,
    fields,
    content: lineDiff(before?.content ?? '', after?.content ?? ''),
  };
}
