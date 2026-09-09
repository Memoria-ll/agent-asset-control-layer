import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DomainError,
  type Asset,
  type ProposalItem,
  type Review,
  type State,
  reviewSubmissionShape,
} from './domain.ts';
import { changeKinds } from './history.ts';

export const reviewSubmissionSchema = z
  .object(reviewSubmissionShape)
  .strict()
  .refine(
    (r) => (r.items !== undefined) !== (r.operations !== undefined),
    'itemsまたはoperationsの片方を指定してください',
  );
export function prepareProposal(state: State, assets: Asset[], review: Review, input: unknown) {
  const req = reviewSubmissionSchema.parse(input);
  const explicit = req.items !== undefined;
  const items: ProposalItem[] = (
    req.items ??
    req.operations!.map((operation) => ({
      operation,
      proposedScope:
        operation.op === 'upsert'
          ? {
              ...operation.asset.scope,
              ...(operation.asset.projectId ? { project: [operation.asset.projectId] } : {}),
            }
          : null,
      proposedRelations:
        operation.op === 'upsert'
          ? { dependencies: operation.asset.dependencies, conflicts: operation.asset.conflicts }
          : null,
      reason: req.reason,
      evidence: {
        journalIds: review.journalIds,
        snapshotIds: review.snapshotIds,
        explanation: req.reason,
      },
    }))
  ).map((item) => {
    const fail = (message: string): never => {
      throw new DomainError('PROPOSAL_EVIDENCE', message);
    };
    const journalIds = [...new Set(item.evidence.journalIds)];
    const journals = journalIds.map((id) => {
      const journal = state.journals.find((j) => j.id === id);
      return journal && review.journalIds.includes(id)
        ? journal
        : fail(`Review対象外のJournalです: ${id}`);
    });
    const snapshotIds = [
      ...new Set([...journals.map((j) => j.snapshotId), ...item.evidence.snapshotIds]),
    ];
    const snapshots = snapshotIds.map((id) => {
      const snapshot = state.snapshots.find((s) => s.id === id);
      return snapshot && review.snapshotIds.includes(id)
        ? snapshot
        : fail(`Review対象外のSnapshotです: ${id}`);
    });
    const op = item.operation;
    const target = op.op === 'upsert' ? structuredClone(op.asset) : null;
    if (target?.projectId) target.scope.project = [target.projectId];
    const relations = target
      ? { dependencies: target.dependencies, conflicts: target.conflicts }
      : null;
    if (!isDeepStrictEqual(item.proposedScope, target?.scope ?? null))
      fail(
        `proposedScopeが変更内容と一致しません。期待値: ${JSON.stringify(target?.scope ?? null)}。入力値: ${JSON.stringify(item.proposedScope)}。${target?.projectId ? '保存先のprojectIdに合わせてproposedScope.projectを指定してください。' : ''}`,
      );
    if (!isDeepStrictEqual(item.proposedRelations, relations))
      fail(
        `proposedRelationsが変更内容と一致しません。期待値: ${JSON.stringify(relations)}。入力値: ${JSON.stringify(item.proposedRelations)}`,
      );
    const id = op.op === 'upsert' ? op.asset.id : op.id;
    const observedScopes = [
      ...new Map(
        snapshots.map((s) => [JSON.stringify(s.resolution.context), s.resolution.context]),
      ).values(),
    ];
    return {
      ...item,
      id: `item-${randomUUID().slice(0, 12)}`,
      observedScopes,
      evidence: { ...item.evidence, journalIds, snapshotIds },
      evidenceMode: explicit ? 'per-item' : 'legacy-review',
      changeKinds: changeKinds(
        assets.find((a) => a.id === id) ?? null,
        target ? { ...target, revision: 0, updatedAt: '' } : null,
      ),
    };
  });
  return {
    reason: req.reason,
    proposedBy: req.proposedBy,
    operations: items.map((i) => i.operation),
    items,
  };
}
