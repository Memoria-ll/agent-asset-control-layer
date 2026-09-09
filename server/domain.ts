import { z } from 'zod';

export const idSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/,
    'IDは英数字・ドット・ハイフン・アンダースコアで指定してください',
  );
// Model identifiers are opaque Runtime values, not file or Asset identifiers.
export const modelIdSchema = z
  .string()
  .min(1)
  .max(250)
  .regex(/^[^\s\x00-\x1f\x7f]+$/, 'Model IDに空白や制御文字は使えません');
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
    expectedOutput: z.array(z.string().trim().min(1)).optional(),
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
const contractList = z.array(z.string().trim().min(1)).max(100).default([]);
export const skillSchema = z
  .object({
    executionMode: z.enum(['standalone', 'workflow', 'both']).default('both'),
    role: idSchema.optional(),
    taskType: idSchema.optional(),
    expectedOutput: contractList,
    completionCriteria: contractList,
    executionPermission: z.enum(['read-only', 'workflow-development']).default('read-only'),
  })
  .strict();
export const roleSchema = z
  .object({
    responsibilities: contractList,
    expectedOutput: contractList,
  })
  .strict();
export const taskTypeSchema = z
  .object({
    objective: z.string().trim().default(''),
    qualityCriteria: contractList,
    constraints: contractList,
  })
  .strict();
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
    skill: skillSchema.optional(),
    role: roleSchema.optional(),
    taskType: taskTypeSchema.optional(),
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
    for (const [key, type] of [
      ['skill', 'skill'],
      ['role', 'role'],
      ['taskType', 'task-type'],
    ] as const)
      if (a[key] && a.type !== type)
        ctx.addIssue({ code: 'custom', path: [key], message: `${key}は${type} Asset専用です` });
    if (
      a.skill?.executionMode === 'standalone' &&
      a.skill.executionPermission === 'workflow-development'
    )
      ctx.addIssue({
        code: 'custom',
        path: ['skill'],
        message: '開発権限が必要なSkillはWorkflow内で実行してください',
      });
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
      z
        .object({
          id: idSchema,
          name: z.string().min(1),
          provider: idSchema,
          endpoint: z.string().url().optional(),
        })
        .strict(),
    ),
    models: z.array(
      z
        .object({
          id: modelIdSchema,
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
          model: modelIdSchema,
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
  project?: Pick<Project, 'id' | 'name' | 'root'> | null;
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
  skill?: Asset;
  createdAt: string;
  updatedAt: string;
  snapshotIds: string[];
  lastHandoff?: { at: string; delivery: 'runtime-pull' | 'host-inject'; snapshotId: string };
  runtimeHandoffAt?: string;
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
export const proposalItemSchema = z
  .object({
    operation: operationSchema,
    proposedScope: scopeSchema.nullable(),
    proposedRelations: z
      .object({ dependencies: z.array(idSchema), conflicts: z.array(idSchema) })
      .strict()
      .nullable(),
    reason: z.string().trim().min(1).max(20000),
    evidence: z
      .object({
        journalIds: z.array(z.string().min(1)).min(1),
        snapshotIds: z.array(z.string().min(1)).default([]),
        explanation: z.string().trim().min(1).max(20000),
      })
      .strict(),
  })
  .strict();
export const reviewSubmissionShape = {
  reason: z.string().trim().min(1),
  proposedBy: z.string().min(1),
  operations: z.array(operationSchema).max(100).optional(),
  items: z.array(proposalItemSchema).max(100).optional(),
};
export type ProposalItem = z.infer<typeof proposalItemSchema> & {
  id: string;
  observedScopes: Context[];
  evidenceMode: 'per-item' | 'legacy-review';
  changeKinds: string[];
};
export type ChangeSet = {
  id: string;
  createdAt: string;
  origin: string;
  summary: string;
  actor: string;
  changes: {
    id: string;
    before: Asset | null;
    after: Asset | null;
    kind: string;
    proposalItemId?: string;
    kinds?: string[];
  }[];
  reviewId?: string;
  sourceJournals: string[];
  sourceSnapshots?: string[];
  proposalItems?: ProposalItem[];
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
  items?: ProposalItem[];
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
