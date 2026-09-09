import { z } from 'zod';
import type { State } from './domain.ts';

export function compareWorkflows(state: State, input: unknown = {}) {
  const req = z
    .object({
      workflowId: z.string().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    })
    .strict()
    .refine((r) => !r.from || !r.to || r.from <= r.to, '期間の開始・終了が逆です')
    .parse(input);
  const within = (at: string) => (!req.from || at >= req.from) && (!req.to || at <= req.to);
  const runs = state.runs.filter(
    (r) => (!req.workflowId || r.workflow?.id === req.workflowId) && within(r.createdAt),
  );
  const groups = new Map<
    string,
    {
      workflowId: string | null;
      revision: number | null;
      project: string | null;
      model: string | null;
      requestedModel: string | null;
      runtime: string | null;
      settingsVersion: number | null;
      assetRevisions: string[];
      runIds: Set<string>;
      snapshotIds: Set<string>;
      attempts: number;
      preparations: number;
      results: number;
      failedAttempts: number;
      waitingUser: number;
      contextTokens: number;
      journals: number;
      defects: number;
    }
  >();
  for (const run of runs) {
    for (const snapshot of state.snapshots.filter((s) => s.runId === run.id)) {
      const c = snapshot.resolution.context;
      const conditions = {
        workflowId: snapshot.workflowId,
        revision: snapshot.workflowRevision,
        project: c.project ?? null,
        model: snapshot.modelSelection
          ? (snapshot.modelSelection.actualModel ?? null)
          : (c.model ?? null),
        requestedModel: snapshot.modelSelection
          ? (snapshot.modelSelection.requestedModel ?? null)
          : (c.model ?? null),
        runtime: c.runtime ?? null,
        settingsVersion: snapshot.settings?.version ?? null,
        assetRevisions: [
          ...new Set([
            ...snapshot.resolution.assets.map((a) => `${a.id}@${a.revision}`),
            ...(snapshot.resolution.skillCandidates ?? []).map((a) => `${a.id}@${a.revision}`),
            ...(run.skillReads ?? [])
              .filter(
                (read) =>
                  read.snapshotId === snapshot.id ||
                  (read.usedAt && read.snapshotId === snapshot.preparedFrom),
              )
              .map((read) => `${read.assetId}@${read.revision}`),
          ]),
        ].sort(),
      };
      const key = JSON.stringify(conditions);
      const g = groups.get(key) ?? {
        ...conditions,
        runIds: new Set<string>(),
        snapshotIds: new Set<string>(),
        attempts: 0,
        preparations: 0,
        results: 0,
        failedAttempts: 0,
        waitingUser: 0,
        contextTokens: 0,
        journals: 0,
        defects: 0,
      };
      g.runIds.add(run.id);
      g.snapshotIds.add(snapshot.id);
      if (snapshot.origin !== 'runtime-report') g.preparations++;
      const attempts = (run.attempts ?? []).filter((a) => a.snapshotId === snapshot.id);
      g.attempts += attempts.length;
      g.results += attempts.filter((a) => a.status === 'result').length;
      g.failedAttempts += attempts.filter((a) => a.status === 'failed').length;
      g.waitingUser += run.events.filter(
        (e) => e.snapshotId === snapshot.id && e.kind === 'runtime-waiting-user',
      ).length;
      g.contextTokens += attempts.length * snapshot.resolution.estimatedTokens;
      const journals = state.journals.filter((j) => j.snapshotId === snapshot.id);
      g.journals += journals.length;
      g.defects += journals.filter((j) => j.kind === 'defect').length;
      groups.set(key, g);
    }
  }
  return {
    period: { from: req.from ?? null, to: req.to ?? null, basis: 'Run.createdAt' },
    population: {
      runs: runs.length,
      completed: runs.filter((r) => r.status === 'completed').length,
      cancelled: runs.filter((r) => r.status === 'cancelled').length,
      active: runs.filter((r) => r.status === 'active').length,
    },
    groups: [...groups.values()].map(({ runIds, snapshotIds, ...g }) => ({
      ...g,
      runs: runIds.size,
      completed: runs.filter((r) => runIds.has(r.id) && r.status === 'completed').length,
      cancelled: runs.filter((r) => runIds.has(r.id) && r.status === 'cancelled').length,
      returns: runs
        .filter((r) => runIds.has(r.id))
        .flatMap((r) => r.events)
        .filter((e) => e.kind === 'return' && !!e.snapshotId && snapshotIds.has(e.snapshotId))
        .length,
      averageAttemptContextTokens: g.attempts ? Math.round(g.contextTokens / g.attempts) : null,
    })),
    interpretation:
      '開始時刻で選んだ実行を、Workflow改訂・Project・モデル・Runtime・設定版・資産改訂で分けています。準備回数は実試行数ではありません。Context量は開始報告のある試行に配った推定値で、モデルの実測消費量ではありません。品質は報告された結果・欠陥・差し戻しから確認してください。作業規模の同等性と因果的な改善効果は自動判定しません。',
  };
}
