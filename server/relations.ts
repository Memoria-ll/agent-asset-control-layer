import path from 'node:path';
import { type Asset, type AssetRelation, DomainError } from './domain.ts';

// Extraction happens at edit/import time. The resolver never interprets prose.
// Only an unambiguous ID/path in an explicit use/reference instruction is linked.
export function extractRelations(asset: Asset, catalog: Asset[]): AssetRelation[] {
  if (asset.type !== 'skill') return [];
  const result: AssetRelation[] = [];
  for (const [index, text] of asset.content.split(/\r?\n/).entries()) {
    if (/使わない|使用しない|利用しない|禁止|do not|don't|never|must not/i.test(text)) continue;
    const reference = /参照|参考|reference|refer to|see\b/i.test(text);
    const use = /使[いうっ]|使用|利用|実施|実行|\buse\b|\brun\b|\bexecute\b|\brequire\b/i.test(
      text,
    );
    if (!reference && !use) continue;
    const tokens = [
      ...[...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
      ...[...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]),
    ];
    for (const token of new Set(tokens)) {
      const clean = token.replace(/^aacl:\/\/assets\//, '').replace(/#.*$/, '');
      const matches = catalog.filter((candidate) => {
        if (candidate.type !== 'skill' || candidate.id === asset.id) return false;
        if (candidate.id === clean) return true;
        return (candidate.sources ?? []).some((target) =>
          (asset.sources ?? []).some((source) => {
            if (source.host !== target.host) return false;
            const api = /^[A-Za-z]:|^\\\\/.test(source.path) ? path.win32 : path.posix;
            return api.resolve(api.dirname(source.path), clean) === api.normalize(target.path);
          }),
        );
      });
      if (matches.length !== 1) continue;
      const conditional = /場合|とき|時は|なら|\bif\b|\bwhen\b|\bunless\b/i.test(text);
      const kind = conditional
        ? 'conditional'
        : reference && !/必ず|must|required/i.test(text)
          ? 'reference'
          : 'required';
      result.push({
        target: matches[0].id,
        kind,
        origin: 'extracted',
        ...(conditional ? { condition: text.trim() } : {}),
        source: { path: asset.sources?.[0]?.path ?? 'SKILL.md', line: index + 1, text },
        reason: '明示されたID・パスと利用指示から抽出しました',
      });
    }
  }
  return result;
}

export function validateRelations(assets: Asset[]) {
  const catalog = new Map(assets.map((a) => [a.id, a]));
  const lowerTypes = new Set([
    'skill',
    'rule',
    'knowledge',
    'policy',
    'template',
    'capability',
    'other',
  ]);
  for (const a of assets) {
    for (const r of a.relations ?? []) {
      const target = catalog.get(r.target);
      if (
        !target ||
        !lowerTypes.has(target.type) ||
        (a.type === 'skill' && target.type !== 'skill')
      )
        throw new DomainError(
          'RELATION_DIRECTION',
          `関係は下位資産へ指定してください。Skillからは別のSkillのみ選べます: ${a.id} → ${r.target}`,
          409,
        );
    }
    for (const targetId of a.dependencies) {
      const target = catalog.get(targetId);
      if (a.type === 'skill' && target && ['role', 'workflow', 'task-type'].includes(target.type))
        throw new DomainError(
          'RELATION_DIRECTION',
          `Skillの依存から上位の担当・工程を選択できません: ${a.id} → ${targetId}`,
          409,
        );
    }
  }
  // Required execution cycles cannot be satisfied; mutual documentation links are valid.
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id))
      throw new DomainError('RELATION_CYCLE', `必須利用の循環を検出しました: ${id}`, 409);
    if (visited.has(id)) return;
    visiting.add(id);
    const asset = catalog.get(id);
    for (const dependency of asset?.dependencies ?? []) visit(dependency);
    for (const r of asset?.relations ?? []) if (r.kind === 'required') visit(r.target);
    visiting.delete(id);
    visited.add(id);
  }
  assets.forEach((a) => visit(a.id));
}
