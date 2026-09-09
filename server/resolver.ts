import path from 'node:path';
import {
  type Asset,
  type Context,
  type Project,
  type Resolution,
  type ResolutionEntry,
  type Scope,
  dimensions,
} from './domain.ts';

const precedence: Record<string, number> = {
  team: 20,
  project: 30,
  workflow: 40,
  stage: 45,
  taskType: 50,
  role: 60,
  provider: 70,
  runtime: 80,
  model: 90,
  directory: 100,
};
export function scopeMatches(scope: Scope, ctx: Context): boolean {
  return dimensions.every(
    (key) =>
      !scope[key] ||
      (!!ctx[key] &&
        scope[key]!.some((value) => {
          if (key !== 'directory') return value === ctx[key];
          const normalize = (s: string) =>
            path.posix.normalize(s.replaceAll('\\', '/')).replace(/\/$/, '') || '/';
          const target = normalize(ctx[key]!);
          const root = normalize(value);
          return target === root || target.startsWith(root === '/' ? '/' : root + '/');
        })),
  );
}
export const tokenEstimate = (s: string) =>
  Math.ceil([...s].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 1 : 0.25), 0));
function score(a: Asset): number[] {
  return [
    a.mandatory ? 1 : 0,
    a.priority,
    Object.keys(a.scope).length,
    Math.max(10, ...Object.keys(a.scope).map((k) => precedence[k] ?? 10)),
  ];
}
function compare(a: Asset, b: Asset) {
  const aa = score(a),
    bb = score(b);
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return bb[i] - aa[i];
  return 0;
}
export function resolveContext(
  assets: Asset[],
  context: Context,
  options: { project?: Project; requested?: string[] } = {},
): Resolution {
  // Apply explicit project bindings before candidate activation and dependency discovery.
  assets = assets.map((asset) => {
    const binding =
      options.project && Object.hasOwn(options.project.bindings, asset.id)
        ? options.project.bindings[asset.id]
        : undefined;
    return { ...asset, scope: { ...asset.scope, ...(binding ?? {}) } };
  });
  const requested = new Set(options.requested ?? []);
  // Dependencies are activated explicitly; scopes and compatibility still apply to them.
  const expand = (id: string) => {
    const a = assets.find((x) => x.id === id);
    for (const dep of a?.dependencies ?? [])
      if (!requested.has(dep)) {
        requested.add(dep);
        expand(dep);
      }
  };
  for (const a of assets)
    if (
      requested.has(a.id) ||
      (a.activation === 'auto' &&
        !['workflow', 'role', 'task-type', 'skill', 'template', 'capability'].includes(a.type) &&
        scopeMatches(a.scope, context))
    ) {
      requested.add(a.id);
      expand(a.id);
    }
  if (context.workflow) requested.add(context.workflow);
  if (context.role) requested.add(context.role);
  if (context.taskType) requested.add(context.taskType);
  for (const id of [...requested]) expand(id);
  const entries: ResolutionEntry[] = assets
    .map((original) => {
      const binding =
        options.project && Object.hasOwn(options.project.bindings, original.id)
          ? options.project.bindings[original.id]
          : undefined;
      const a = { ...original, scope: { ...original.scope, ...(binding ?? {}) } };
      let status: ResolutionEntry['status'] = 'included';
      const reasons: string[] = [];
      const mark = (s: ResolutionEntry['status'], reason: string) => {
        status = s;
        reasons.push(reason);
      };
      if (a.projectId && a.projectId !== context.project) mark('excluded', '他のProjectのAsset');
      else if (!scopeMatches(a.scope, context))
        mark('excluded', '複合scopeのAND条件に一致しません');
      else if (!requested.has(a.id))
        mark('excluded', 'オンデマンドAssetは明示選択時に読み込みます');
      else if (
        a.compatibility === 'unsupported' ||
        (a.compatibility === 'claude-only' && context.runtime !== 'claude') ||
        (a.compatibility === 'codex-only' && context.runtime !== 'codex')
      )
        mark('unavailable', 'Runtimeとの互換性がありません');
      else if (a.capability && (!a.capability.connected || !a.capability.allowed))
        mark(
          'unavailable',
          a.capability.connected
            ? 'Capabilityの使用が許可されていません'
            : 'Capabilityが未接続です',
        );
      else if ((!a.enabled || options.project?.disabled.includes(a.id)) && !a.mandatory)
        mark('disabled', 'ユーザー設定で無効化されています');
      else {
        reasons.push(
          Object.keys(a.scope).length
            ? `scope一致: ${Object.entries(a.scope)
                .map(([k, v]) => `${k}=${v!.join('|')}`)
                .join(' AND ')}`
            : 'Global scope',
        );
        if (a.mandatory) reasons.push('mandatory: disable / overrideより優先');
        if (binding) reasons.push('Project bindingを適用');
        if (requested.has(a.id)) reasons.push('明示選択・scope一致、または必要な依存Asset');
      }
      return { asset: a, status, reasons, estimatedTokens: tokenEstimate(a.content) };
    })
    .sort((a, b) => compare(a.asset, b.asset) || a.asset.id.localeCompare(b.asset.id, 'en'));
  const get = (id: string) => entries.find((e) => e.asset.id === id);
  const overrides: { from: ResolutionEntry; to: ResolutionEntry }[] = [];
  for (const [id, replacement] of Object.entries(options.project?.overrides ?? {})) {
    const from = get(id),
      to = get(replacement);
    if (from?.status !== 'included') continue;
    if (from.asset.mandatory) {
      from.reasons.push('mandatoryのためoverrideを無視');
      continue;
    }
    if (!to || to.status !== 'included' || from.asset.type !== to.asset.type) {
      from.status = 'unavailable';
      from.reasons.push('override先が利用不可、またはAsset Typeが異なります');
    } else {
      from.status = 'overridden';
      from.reasons.push(`Project override: ${replacement}`);
      overrides.push({ from, to });
    }
  }
  const included = entries.filter((e) => e.status === 'included');
  for (let i = 0; i < included.length; i++)
    for (let j = i + 1; j < included.length; j++) {
      const a = included[i],
        b = included[j];
      if (a.status === 'overridden' || b.status === 'overridden') continue;
      if (!a.asset.conflicts.includes(b.asset.id) && !b.asset.conflicts.includes(a.asset.id))
        continue;
      const cmp = compare(a.asset, b.asset);
      if (cmp === 0 || (a.asset.mandatory && b.asset.mandatory)) {
        a.status = b.status = 'conflict';
        a.reasons.push(`排他的競合: ${b.asset.id}。明示的な解決が必要です`);
        b.reasons.push(`排他的競合: ${a.asset.id}。明示的な解決が必要です`);
      } else {
        const loser = cmp < 0 ? b : a;
        loser.status = 'overridden';
        loser.reasons.push(
          `明示priority / specificity / precedence: ${(cmp < 0 ? a : b).asset.id}が優先`,
        );
      }
    }
  const cycleMembers = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, stack: string[]) => {
    if (stack.includes(id)) {
      stack.slice(stack.indexOf(id)).forEach((x) => cycleMembers.add(x));
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    get(id)?.asset.dependencies.forEach((d) => visit(d, [...stack, id]));
  };
  included.forEach((e) => visit(e.asset.id, []));
  for (const id of cycleMembers) {
    const e = get(id);
    if (e?.status === 'included') {
      e.status = 'unavailable';
      e.reasons.push('循環依存を検出');
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const { from, to } of overrides)
      if (from.status === 'overridden' && to.status !== 'included') {
        from.status = 'unavailable';
        from.reasons.push('override先の解決に失敗しました');
        changed = true;
      }
    for (const e of entries.filter((e) => e.status === 'included')) {
      const missing = e.asset.dependencies.filter((d) => get(d)?.status !== 'included');
      if (missing.length) {
        e.status = 'unavailable';
        e.reasons.push(`必要な依存Assetが利用不可: ${missing.join(', ')}`);
        changed = true;
      }
    }
  }
  const final: Asset[] = [];
  const emitted = new Set<string>();
  const emit = (a: Asset) => {
    if (emitted.has(a.id)) return;
    emitted.add(a.id);
    a.dependencies.forEach((d) => {
      const e = get(d);
      if (e?.status === 'included') emit(e.asset);
    });
    final.push(a);
  };
  entries.filter((e) => e.status === 'included').forEach((e) => emit(e.asset));
  const errors = entries
    .filter((e) => ['conflict', 'unavailable'].includes(e.status))
    .map((e) => `${e.asset.id}: ${e.reasons.at(-1)}`);
  for (const id of options.requested ?? [])
    if (get(id)?.status !== 'included') errors.push(`Required Assetが解決されません: ${id}`);
  const content = final
    .filter((a) => a.content)
    .map((a) => `## ${a.name} [${a.id}@${a.revision}]\n\n${a.content}`)
    .join('\n\n');
  return {
    context,
    entries,
    assets: final,
    content,
    estimatedTokens: tokenEstimate(content),
    valid: errors.length === 0,
    errors,
  };
}
