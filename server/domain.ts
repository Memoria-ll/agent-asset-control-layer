import { z } from 'zod';

export const idSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/,
    'IDは英数字・ドット・ハイフン・アンダースコアで指定してください',
  );
export const dimensions = [
  'project',
  'team',
  'workflow',
  'stage',
  'taskType',
  'role',
  'provider',
  'runtime',
  'model',
  'directory',
] as const;
export const scopeSchema = z
  .object(
    Object.fromEntries(
      dimensions.map((k) => [k, z.array(z.string().min(1)).min(1).optional()]),
    ) as Record<(typeof dimensions)[number], z.ZodOptional<z.ZodArray<z.ZodString>>>,
  )
  .strict();
export type Scope = z.infer<typeof scopeSchema>;
export const contextSchema = z
  .object(
    Object.fromEntries(dimensions.map((k) => [k, z.string().min(1).optional()])) as Record<
      (typeof dimensions)[number],
      z.ZodOptional<z.ZodString>
    >,
  )
  .strict();
export type Context = z.infer<typeof contextSchema>;
export const stageSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    role: idSchema,
    taskType: idSchema.optional(),
    requiredAssets: z.array(idSchema).default([]),
    requiredCapabilities: z.array(idSchema).default([]),
    completionCriteria: z.array(z.string().min(1)).default([]),
    transitions: z
      .array(
        z
          .object({
            to: idSchema,
            kind: z.enum(['advance', 'return', 'retry', 'reject']).default('advance'),
            requiredArtifacts: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export const workflowSchema = z
  .object({
    developmentCapable: z.boolean(),
    entryStage: idSchema,
    entryRole: idSchema,
    stages: z.array(stageSchema).min(1),
    completionCriteria: z.array(z.string().min(1)).default([]),
  })
  .strict();
export const assetTypes = [
  'workflow',
  'skill',
  'rule',
  'role',
  'task-type',
  'knowledge',
  'policy',
  'capability',
  'template',
] as const;
export const assetSchema = z
  .object({
    id: idSchema,
    type: z.enum(assetTypes),
    name: z.string().min(1).max(200),
    description: z.string().default(''),
    content: z.string().max(200000).default(''),
    scope: scopeSchema.default({}),
    projectId: idSchema.optional(),
    priority: z.number().int().min(-1000).max(1000).default(0),
    mandatory: z.boolean().default(false),
    enabled: z.boolean().default(true),
    dependencies: z.array(idSchema).default([]),
    conflicts: z.array(idSchema).default([]),
    compatibility: z
      .enum(['portable', 'claude-only', 'codex-only', 'adaptable', 'unsupported'])
      .default('portable'),
    activation: z.enum(['auto', 'on-demand']).default('auto'),
    workflow: workflowSchema.optional(),
    capability: z
      .object({
        provider: z.string().min(1),
        tools: z.array(z.string().min(1)),
        connected: z.boolean().default(false),
        allowed: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.type === 'workflow' && !a.workflow)
      ctx.addIssue({ code: 'custom', message: 'Workflow定義が必要です' });
    if (a.type !== 'workflow' && a.workflow)
      ctx.addIssue({ code: 'custom', message: 'workflowはWorkflow Asset専用です' });
    if (a.type === 'capability' && !a.capability)
      ctx.addIssue({ code: 'custom', message: 'Capability定義が必要です' });
    if (a.type !== 'capability' && a.capability)
      ctx.addIssue({ code: 'custom', message: 'capabilityはCapability Asset専用です' });
    const w = a.workflow;
    if (w) {
      const ids = new Set(w.stages.map((s) => s.id));
      if (ids.size !== w.stages.length || !ids.has(w.entryStage))
        ctx.addIssue({ code: 'custom', message: 'Stage IDの重複、またはentryStageが不正です' });
      if (w.stages.find((s) => s.id === w.entryStage)?.role !== w.entryRole)
        ctx.addIssue({ code: 'custom', message: 'entryRoleとentryStageのRoleが一致しません' });
      if (!w.stages.some((s) => s.transitions.length === 0))
        ctx.addIssue({ code: 'custom', message: '完了Stageが必要です' });
      for (const s of w.stages) {
        const edges = new Set<string>();
        for (const t of s.transitions) {
          const key = `${t.to}:${t.kind}`;
          if (!ids.has(t.to) || edges.has(key))
            ctx.addIssue({ code: 'custom', message: `不正な遷移: ${s.id} → ${t.to}` });
          edges.add(key);
        }
      }
      const reached = new Set<string>();
      const visit = (id: string) => {
        if (reached.has(id)) return;
        reached.add(id);
        w.stages.find((s) => s.id === id)?.transitions.forEach((t) => visit(t.to));
      };
      visit(w.entryStage);
      if (reached.size !== ids.size)
        ctx.addIssue({ code: 'custom', message: '到達できないStageがあります' });
    }
  });
export type AssetInput = z.infer<typeof assetSchema>;
export type Asset = AssetInput & { revision: number; updatedAt: string };
export type ResolutionStatus =
  'included' | 'excluded' | 'overridden' | 'disabled' | 'unavailable' | 'conflict';
export type ResolutionEntry = {
  asset: Asset;
  status: ResolutionStatus;
  reasons: string[];
  estimatedTokens: number;
};
export type Resolution = {
  context: Context;
  entries: ResolutionEntry[];
  assets: Asset[];
  content: string;
  estimatedTokens: number;
  valid: boolean;
  errors: string[];
};
export type Project = {
  id: string;
  name: string;
  root: string;
  disabled: string[];
  overrides: Record<string, string>;
  bindings: Record<string, Scope>;
};
export const configSchema = z
  .object({
    providers: z.array(z.object({ id: idSchema, name: z.string().min(1) }).strict()),
    accounts: z.array(
      z.object({ id: idSchema, provider: idSchema, name: z.string().min(1) }).strict(),
    ),
    runtimes: z.array(
      z.object({ id: idSchema, name: z.string().min(1), provider: idSchema }).strict(),
    ),
    models: z.array(
      z
        .object({
          id: idSchema,
          name: z.string().min(1),
          provider: idSchema,
          account: idSchema.optional(),
        })
        .strict(),
    ),
    bindings: z.array(
      z
        .object({
          role: idSchema,
          workflow: idSchema.optional(),
          model: idSchema,
          runtime: idSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type Snapshot = {
  id: string;
  runId: string;
  createdAt: string;
  mode: 'advisory' | 'workflow';
  workflowId: string | null;
  workflowRevision: number | null;
  stage: string | null;
  task: string;
  resolution: Resolution;
  artifacts: Record<string, string>;
};
export type Run = {
  id: string;
  title: string;
  instruction: string;
  mode: 'advisory' | 'workflow';
  status: 'active' | 'completed' | 'cancelled';
  version: number;
  workflow: Asset | null;
  stage: string | null;
  context: Context;
  runtimeSelection?: Pick<Context, 'model' | 'runtime' | 'provider'>;
  skillId?: string;
  createdAt: string;
  updatedAt: string;
  snapshotIds: string[];
  events: { at: string; from: string | null; to: string | null; kind: string; note: string }[];
  artifacts: Record<string, string>;
  criteria: Record<string, string>;
};
export type Journal = {
  id: string;
  snapshotId: string;
  runId: string;
  kind: 'friction' | 'missing-support' | 'defect' | 'success' | 'improvement';
  observation: string;
  possibleCause: string;
  confidence: number;
  createdAt: string;
  context: Context;
  workflowRevision: number | null;
};
export type Operation =
  | { op: 'upsert'; asset: AssetInput; expectedRevision: number }
  | { op: 'delete'; id: string; expectedRevision: number };
export const operationSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('upsert'),
      asset: assetSchema,
      expectedRevision: z.number().int().min(0),
    })
    .strict(),
  z
    .object({ op: z.literal('delete'), id: idSchema, expectedRevision: z.number().int().min(1) })
    .strict(),
]);
export type ChangeSet = {
  id: string;
  createdAt: string;
  origin: string;
  summary: string;
  actor: string;
  changes: { id: string; before: Asset | null; after: Asset | null; kind: string }[];
  reviewId?: string;
  sourceJournals: string[];
  observedScopes: Context[];
  approvedAt: string;
  gitCommit?: string;
  gitError?: string;
  rollbackOf?: string;
};
export type Review = {
  id: string;
  createdAt: string;
  journalIds: string[];
  snapshotIds: string[];
  status: 'awaiting-proposal' | 'pending' | 'approved' | 'rejected';
  reason: string;
  operations: Operation[];
  observedScopes: Context[];
  proposedBy?: string;
  changeSetId?: string;
};
export type State = {
  schemaVersion: 1;
  projects: Project[];
  config: Config;
  runs: Run[];
  snapshots: Snapshot[];
  journals: Journal[];
  changesets: ChangeSet[];
  reviews: Review[];
};
export const defaultConfig: Config = {
  providers: [
    { id: 'openai', name: 'OpenAI' },
    { id: 'anthropic', name: 'Anthropic' },
  ],
  accounts: [],
  runtimes: [
    { id: 'codex', name: 'Codex', provider: 'openai' },
    { id: 'claude', name: 'Claude Code', provider: 'anthropic' },
  ],
  models: [],
  bindings: [],
};
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function requireValue<T>(value: T | undefined | null, message: string): T {
  if (value == null) throw new DomainError('NOT_FOUND', message, 404);
  return value;
}
export function inputOf(asset: Asset): AssetInput {
  const { revision, updatedAt, ...input } = asset;
  return structuredClone(input);
}
