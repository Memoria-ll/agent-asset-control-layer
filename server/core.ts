import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.ts';
import { resolveContext } from './resolver.ts';
import { starterAssets } from './starter.ts';
import { pinnedSkill, runRequirements } from './contracts.ts';
import { assetHistory, assetDiff, changeKinds } from './history.ts';
import { prepareProposal } from './proposals.ts';
import {
  assetSchema,
  configSchema,
  contextSchema,
  scopeSchema,
  idSchema,
  operationSchema,
  inputOf,
  requireValue,
  DomainError,
  type Asset,
  type State,
  type Run,
  type Snapshot,
  type Context,
  type Resolution,
  type Operation,
  type ChangeSet,
  type Review,
} from './domain.ts';

const uid = (prefix: string) => `${prefix}-${randomUUID().slice(0, 12)}`;
const now = () => new Date().toISOString();
function guard(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new DomainError(code, message, 409);
}
function validateReferences(assets: Asset[]) {
  const get = (id: string, type?: string) => {
    const a = assets.find((a) => a.id === id);
    guard(
      a && (!type || a.type === type),
      'REFERENCE',
      `参照先が存在しない、または種別が不正です: ${id}${type ? ` (${type})` : ''}`,
    );
  };
  for (const a of assets) {
    a.dependencies.forEach((id) => get(id));
    if (a.skill?.role) get(a.skill.role, 'role');
    if (a.skill?.taskType) get(a.skill.taskType, 'task-type');
    for (const s of a.workflow?.stages ?? []) {
      get(s.role, 'role');
      if (s.taskType) get(s.taskType, 'task-type');
      s.requiredAssets.forEach((id) => get(id));
      s.requiredCapabilities.forEach((id) => get(id, 'capability'));
    }
  }
}
export class Core {
  constructor(readonly store: Store) {}
  state() {
    return this.store.load();
  }
  overview() {
    const { state, assets } = this.state();
    return {
      assets,
      projects: state.projects,
      config: state.config,
      runs: state.runs.map((run) => ({
        ...run,
        skill: pinnedSkill(run, state.snapshots),
        requirements: runRequirements(run, state.snapshots),
      })),
      journals: state.journals,
      reviews: state.reviews,
      changesets: state.changesets,
      snapshots: state.snapshots.map(({ resolution, ...s }) => ({
        ...s,
        context: resolution.context,
        estimatedTokens: resolution.estimatedTokens,
        assetCount: resolution.assets.length,
      })),
      diagnostics: this.diagnostics(),
      metrics: this.metrics(),
      assetMetrics: this.assetMetrics(),
    };
  }
  private finishHistory(change: ChangeSet) {
    Object.assign(change, this.store.gitRecord(change));
    this.store.transaction((state) => {
      Object.assign(
        requireValue(
          state.changesets.find((c) => c.id === change.id),
          'Change Setが見つかりません',
        ),
        change,
      );
    });
    return change;
  }
  private apply(
    state: State,
    assets: Asset[],
    ops: Operation[],
    meta: { origin: string; summary: string; actor: string; review?: Review; rollbackOf?: string },
  ): ChangeSet {
    guard(ops.length > 0 && ops.length <= 100, 'OPERATIONS', '変更は1〜100件で指定してください');
    const ids = ops.map((op) => (op.op === 'upsert' ? op.asset.id : op.id));
    guard(
      new Set(ids).size === ids.length,
      'DUPLICATE_OPERATION',
      '同じAssetを複数回変更できません',
    );
    const change: ChangeSet = {
      id: uid('cs'),
      createdAt: now(),
      origin: meta.origin,
      summary: meta.summary,
      actor: meta.actor,
      changes: [],
      sourceJournals: meta.review?.journalIds ?? [],
      sourceSnapshots: meta.review?.snapshotIds ?? [],
      proposalItems: meta.review?.items ? structuredClone(meta.review.items) : undefined,
      observedScopes: meta.review?.observedScopes ?? [],
      approvedAt: now(),
      reviewId: meta.review?.id,
      rollbackOf: meta.rollbackOf,
    };
    for (const op of ops) {
      const id = op.op === 'upsert' ? op.asset.id : op.id;
      const index = assets.findIndex((a) => a.id === id);
      const before = index < 0 ? null : assets[index];
      guard(
        (before?.revision ?? 0) === op.expectedRevision,
        'REVISION_CONFLICT',
        `${id}は変更されています。最新内容を読み直してください`,
      );
      let after: Asset | null = null;
      if (op.op === 'upsert') {
        const parsed = assetSchema.parse(op.asset);
        if (parsed.projectId) {
          requireValue(
            state.projects.find((p) => p.id === parsed.projectId),
            'Projectが未登録です',
          );
          parsed.scope.project = [parsed.projectId];
        }
        const last = Math.max(
          0,
          ...state.changesets.flatMap((c) =>
            c.changes
              .filter((x) => x.id === id)
              .map((x) => x.after?.revision ?? x.before?.revision ?? 0),
          ),
          before?.revision ?? 0,
        );
        after = { ...parsed, revision: last + 1, updatedAt: now() };
        if (index < 0) assets.push(after);
        else assets[index] = after;
      } else {
        guard(before, 'NOT_FOUND', '削除対象が存在しません');
        assets.splice(index, 1);
      }
      let kind = before ? (after ? 'updated' : 'removed') : 'added';
      if (
        before &&
        after &&
        (JSON.stringify(before.scope) !== JSON.stringify(after.scope) ||
          JSON.stringify(before.dependencies) !== JSON.stringify(after.dependencies) ||
          JSON.stringify(before.conflicts) !== JSON.stringify(after.conflicts))
      )
        kind = 'binding-changed';
      const item = meta.review?.items?.find(
        (i) => (i.operation.op === 'upsert' ? i.operation.asset.id : i.operation.id) === id,
      );
      change.changes.push({
        id,
        before,
        after,
        kind,
        kinds: changeKinds(before, after),
        proposalItemId: item?.id,
      });
    }
    validateReferences(assets);
    state.changesets.unshift(change);
    return change;
  }
  changeAssets(input: unknown) {
    const req = z
      .object({
        operations: z.array(operationSchema),
        summary: z.string().min(1),
        origin: z.enum(['human-edit', 'native-import']).default('human-edit'),
      })
      .strict()
      .parse(input);
    const change = this.store.transaction((s, a) =>
      this.apply(s, a, req.operations, {
        origin: req.origin,
        summary: req.summary,
        actor: 'local-user',
      }),
    );
    return this.finishHistory(change);
  }
  installStarter() {
    const { assets } = this.state();
    const operations = starterAssets()
      .filter((a) => !assets.some((x) => x.id === a.id))
      .map((asset) => ({ op: 'upsert' as const, asset, expectedRevision: 0 }));
    if (!operations.length) return { installed: 0 };
    return {
      installed: operations.length,
      changeSet: this.changeAssets({ operations, summary: 'ユーザー操作でスターターを追加' }),
    };
  }
  initProject(input: unknown) {
    const req = z
      .object({ root: z.string().min(1), name: z.string().min(1) })
      .strict()
      .parse(input);
    const root = fs.realpathSync(path.resolve(req.root));
    guard(
      fs.statSync(root).isDirectory(),
      'PROJECT_PATH',
      'Project rootにはディレクトリを指定してください',
    );
    return this.store.transaction((state, assets) => {
      const existing = state.projects.find((p) => p.root === root);
      if (existing) return existing;
      const marker = path.join(root, '.aacl', 'project.json');
      let id = uid('project');
      if (fs.existsSync(marker)) {
        id = idSchema.parse(JSON.parse(fs.readFileSync(marker, 'utf8')).id);
        guard(
          !state.projects.some((p) => p.id === id),
          'PROJECT_ID',
          '同じProject IDが別のパスに登録されています',
        );
        const file = path.join(root, '.aacl', 'assets.json');
        const existingAssets: Asset[] = fs.existsSync(file)
          ? JSON.parse(fs.readFileSync(file, 'utf8'))
          : [];
        for (const a of existingAssets) {
          assetSchema.parse(inputOf(a));
          guard(
            a.projectId === id &&
              Number.isInteger(a.revision) &&
              a.revision > 0 &&
              !assets.some((x) => x.id === a.id),
            'PROJECT_IMPORT',
            'Project AssetのID・所属・revisionを確認してください',
          );
          assets.push(a);
        }
      } else
        guard(
          !fs.existsSync(path.join(root, '.aacl', 'assets.json')),
          'PROJECT_EXISTS',
          '既存の.aacl/assets.jsonを上書きできません。Project markerを確認してください',
        );
      const project = { id, name: req.name, root, disabled: [], overrides: {}, bindings: {} };
      state.projects.push(project);
      validateReferences(assets);
      return project;
    });
  }
  updateOverlay(id: string, input: unknown) {
    const req = z
      .object({
        disabled: z.array(idSchema),
        overrides: z.record(idSchema, idSchema),
        bindings: z.record(idSchema, scopeSchema),
      })
      .strict()
      .parse(input);
    return this.store.transaction((state, assets) => {
      const p = requireValue(
        state.projects.find((p) => p.id === id),
        'Projectが見つかりません',
      );
      for (const ref of [
        ...req.disabled,
        ...Object.keys(req.overrides),
        ...Object.values(req.overrides),
        ...Object.keys(req.bindings),
      ])
        requireValue(
          assets.find((a) => a.id === ref),
          `Assetが存在しません: ${ref}`,
        );
      Object.assign(p, req);
      return p;
    });
  }
  updateConfig(input: unknown) {
    const config = configSchema.parse(input);
    const { assets } = this.state();
    for (const list of [config.providers, config.accounts, config.models, config.runtimes])
      guard(new Set(list.map((x) => x.id)).size === list.length, 'CONFIG', 'IDが重複しています');
    for (const x of [...config.accounts, ...config.models, ...config.runtimes])
      requireValue(
        config.providers.find((p) => p.id === x.provider),
        `Providerが存在しません: ${x.provider}`,
      );
    for (const m of config.models)
      if (m.account)
        guard(
          config.accounts.some((a) => a.id === m.account && a.provider === m.provider),
          'CONFIG',
          'ModelとAccountのProviderが一致しません',
        );
    const bindings = new Set<string>();
    for (const b of config.bindings) {
      const key = `${b.workflow ?? '*'}:${b.role}`;
      guard(!bindings.has(key), 'CONFIG', 'Role / Workflow bindingが重複しています');
      bindings.add(key);
      requireValue(
        assets.find((a) => a.id === b.role && a.type === 'role'),
        `Roleが存在しません: ${b.role}`,
      );
      if (b.workflow)
        requireValue(
          assets.find((a) => a.id === b.workflow && a.type === 'workflow'),
          'Workflowが存在しません',
        );
      const m = requireValue(
        config.models.find((m) => m.id === b.model),
        'Modelが存在しません',
      );
      const r = requireValue(
        config.runtimes.find((r) => r.id === b.runtime),
        'Runtimeが存在しません',
      );
      guard(m.provider === r.provider, 'CONFIG', 'ModelとRuntimeのProviderが一致しません');
    }
    return this.store.transaction((state) => {
      state.config = config;
      return config;
    });
  }
  private boundContext(state: State, context: Context): Context {
    const ctx = { ...context };
    const binding =
      state.config.bindings.find((b) => b.role === ctx.role && b.workflow === ctx.workflow) ??
      state.config.bindings.find((b) => b.role === ctx.role && !b.workflow);
    if (binding && !ctx.model && !ctx.runtime) {
      ctx.model = binding.model;
      ctx.runtime = binding.runtime;
    }
    const model = ctx.model
      ? requireValue(
          state.config.models.find((m) => m.id === ctx.model),
          'Modelが未登録です',
        )
      : undefined;
    const runtime = ctx.runtime
      ? requireValue(
          state.config.runtimes.find((r) => r.id === ctx.runtime),
          'Runtimeが未登録です',
        )
      : undefined;
    if (model && runtime)
      guard(
        model.provider === runtime.provider,
        'PROVIDER',
        'ModelとRuntimeのProviderが一致しません',
      );
    const provider = model?.provider ?? runtime?.provider;
    if (ctx.provider && provider)
      guard(ctx.provider === provider, 'PROVIDER', '指定ProviderがModel / Runtimeと一致しません');
    if (provider) ctx.provider = provider;
    if (ctx.project)
      requireValue(
        state.projects.find((p) => p.id === ctx.project),
        'Projectが未登録です',
      );
    return ctx;
  }
  private resolution(
    state: State,
    assets: Asset[],
    context: Context,
    requested: string[] = [],
    pinned?: Asset | null,
  ): Resolution {
    let ctx = { ...context };
    let catalog = assets;
    if (ctx.workflow) {
      const workflow =
        pinned ??
        requireValue(
          assets.find((a) => a.id === ctx.workflow && a.workflow),
          'Workflowが存在しません',
        );
      const definition = requireValue(workflow.workflow, 'Workflow定義がありません');
      const stage = requireValue(
        definition.stages.find((s) => s.id === (ctx.stage ?? definition.entryStage)),
        'Stageが存在しません',
      );
      if (ctx.role)
        guard(ctx.role === stage.role, 'STAGE_ROLE', 'Stageに定義されたRoleと一致しません');
      if (ctx.taskType)
        guard(ctx.taskType === stage.taskType, 'STAGE_TASK', 'StageのTask Typeと一致しません');
      ctx = {
        ...ctx,
        workflow: workflow.id,
        stage: stage.id,
        role: stage.role,
        taskType: stage.taskType,
      };
      requested = [
        ...requested,
        workflow.id,
        stage.role,
        ...stage.requiredAssets,
        ...stage.requiredCapabilities,
        ...(stage.taskType ? [stage.taskType] : []),
      ];
      catalog = [...assets.filter((a) => a.id !== workflow.id), workflow];
    } else {
      guard(!ctx.stage, 'WORKFLOW_REQUIRED', 'Stageの指定にはWorkflowが必要です');
      for (const skill of assets.filter((a) => requested.includes(a.id) && a.skill))
        for (const key of ['role', 'taskType'] as const) {
          const value = skill.skill![key];
          if (value) {
            guard(!ctx[key] || ctx[key] === value, 'SKILL_CONTEXT', `Skillの${key}が一致しません`);
            ctx[key] = value;
          }
        }
      if (ctx.role) requested.push(ctx.role);
      if (ctx.taskType) requested.push(ctx.taskType);
    }
    ctx = this.boundContext(state, ctx);
    return resolveContext(catalog, ctx, {
      project: state.projects.find((p) => p.id === ctx.project),
      requested,
    });
  }
  preview(input: unknown) {
    const req = z
      .object({ context: contextSchema.default({}), requested: z.array(idSchema).default([]) })
      .strict()
      .parse(input);
    const { state, assets } = this.state();
    return this.resolution(state, assets, req.context, req.requested);
  }
  private snapshot(state: State, assets: Asset[], run: Run, context?: Context): Snapshot {
    const base = context ?? run.context;
    const skill = pinnedSkill(run, state.snapshots);
    if (run.skillId) guard(skill, 'SKILL_REVISION', '起動時のSkill revisionが見つかりません');
    const resolution = this.resolution(
      state,
      skill ? [...assets.filter((a) => a.id !== skill.id), skill] : assets,
      { ...base, workflow: run.workflow?.id, stage: run.stage ?? undefined },
      run.skillId ? [run.skillId] : [],
      run.workflow,
    );
    guard(resolution.valid, 'CONTEXT_UNRESOLVED', resolution.errors.join('\n'));
    const snapshot: Snapshot = {
      id: uid('snapshot'),
      runId: run.id,
      createdAt: now(),
      mode: run.mode,
      workflowId: run.workflow?.id ?? null,
      workflowRevision: run.workflow?.revision ?? null,
      stage: run.stage,
      task: run.instruction,
      resolution,
      artifacts: structuredClone(run.artifacts),
    };
    state.snapshots.unshift(snapshot);
    run.snapshotIds.push(snapshot.id);
    run.context = resolution.context;
    return snapshot;
  }
  startRun(input: unknown) {
    const req = z
      .object({
        command: z.string().max(10000).default(''),
        workflowId: idSchema.optional(),
        skillId: idSchema.optional(),
        instruction: z.string().max(10000).default(''),
        context: contextSchema.default({}),
      })
      .strict()
      .parse(input);
    return this.store.transaction((state, assets) => {
      let workflowId = req.workflowId;
      let skillId = req.skillId;
      let instruction = req.instruction || req.command;
      const match = req.command.match(/^\/([\w.-]+)(?:\s+([\s\S]*))?$/);
      if (match) {
        const a = requireValue(
          assets.find((a) => a.id === match[1] && ['workflow', 'skill'].includes(a.type)),
          '指定したWorkflow / Skillが見つかりません',
        );
        guard(!workflowId && !skillId, 'LAUNCH', 'commandとIDを同時に指定できません');
        if (a.type === 'workflow') workflowId = a.id;
        else skillId = a.id;
        instruction = match[2] ?? '';
      }
      guard(!(workflowId && skillId), 'LAUNCH', 'WorkflowとStandalone Skillの同時起動はできません');
      guard(
        !req.context.workflow && !req.context.stage && !req.context.role && !req.context.taskType,
        'LAUNCH_CONTEXT',
        'Workflow / Stage / Roleは明示した起動対象から決まります',
      );
      const workflow = workflowId
        ? requireValue(
            assets.find((a) => a.id === workflowId && a.workflow),
            'Workflowが存在しません',
          )
        : null;
      const skill = skillId
        ? requireValue(
            assets.find((a) => a.id === skillId && a.type === 'skill'),
            'Skillが存在しません',
          )
        : undefined;
      const run: Run = {
        id: uid('run'),
        title: instruction || workflow?.name || skillId || 'Advisory session',
        instruction,
        mode: workflow ? 'workflow' : 'advisory',
        status: 'active',
        version: 1,
        workflow: structuredClone(workflow),
        stage: workflow?.workflow?.entryStage ?? null,
        context: req.context,
        runtimeSelection: {
          model: req.context.model,
          runtime: req.context.runtime,
          provider: req.context.provider,
        },
        skillId,
        skill: skill ? structuredClone(skill) : undefined,
        createdAt: now(),
        updatedAt: now(),
        snapshotIds: [],
        artifacts: {},
        criteria: {},
        events: [],
      };
      this.snapshot(state, assets, run);
      state.runs.unshift(run);
      return run;
    });
  }
  transition(runId: string, input: unknown) {
    const req = z
      .object({
        expectedVersion: z.number().int().min(1),
        to: idSchema.optional(),
        kind: z.enum(['advance', 'return', 'retry', 'reject', 'complete', 'cancel']),
        note: z.string().max(10000).default(''),
        artifacts: z.record(z.string().min(1), z.string().trim().min(1)).default({}),
        criteria: z.record(z.string().min(1), z.string().trim().min(1)).default({}),
      })
      .strict()
      .parse(input);
    return this.store.transaction((state, assets) => {
      const run = requireValue(
        state.runs.find((r) => r.id === runId),
        'Runが見つかりません',
      );
      guard(
        run.version === req.expectedVersion,
        'RUN_CONFLICT',
        'Runは更新されています。最新状態を読み直してください',
      );
      guard(run.status === 'active', 'RUN_FINISHED', '終了済みRunは変更できません');
      const from = run.stage;
      if (['advance', 'complete'].includes(req.kind)) {
        const needed = runRequirements(run, state.snapshots);
        Object.assign(run.artifacts, req.artifacts);
        guard(
          needed.completionCriteria.every((c) => !!req.criteria[c]?.trim()),
          'COMPLETION_CRITERIA',
          `完了条件の根拠を入力してください: ${needed.completionCriteria.filter((c) => !req.criteria[c]).join(', ')}`,
        );
        guard(
          needed.expectedOutput.every((a) => !!run.artifacts[a]?.trim()),
          'ARTIFACTS',
          `必要な成果物: ${needed.expectedOutput.filter((a) => !run.artifacts[a]).join(', ')}`,
        );
        for (const [key, value] of Object.entries(req.criteria))
          run.criteria[`${run.stage ?? 'skill'}:${key}`] = value;
      }
      if (req.kind === 'cancel') run.status = 'cancelled';
      else if (!run.workflow) {
        guard(
          req.kind === 'complete',
          'WORKFLOW_REQUIRED',
          'Advisory Modeでは開発Stageへ移行できません。Workflowを明示起動してください',
        );
        run.status = 'completed';
      } else {
        const def = run.workflow.workflow!;
        const stage = requireValue(
          def.stages.find((s) => s.id === run.stage),
          'Stageが見つかりません',
        );
        Object.assign(run.artifacts, req.artifacts);
        if (req.kind === 'complete') {
          guard(stage.transitions.length === 0, 'TRANSITION', '最終Stageでのみ完了できます');
          run.status = 'completed';
        } else {
          const edge = requireValue(
            stage.transitions.find((t) => t.to === req.to && t.kind === req.kind),
            '定義されていない遷移です',
          );
          if (['return', 'retry', 'reject'].includes(req.kind))
            guard(req.note.trim(), 'TRANSITION_REASON', '再実行・差し戻しの理由を入力してください');
          guard(
            edge.requiredArtifacts.every((a) => !!run.artifacts[a]?.trim()),
            'ARTIFACTS',
            `必要な成果物: ${edge.requiredArtifacts.filter((a) => !run.artifacts[a]).join(', ')}`,
          );
          run.stage = edge.to;
        }
      }
      run.version++;
      run.updatedAt = now();
      run.events.push({ at: now(), from, to: run.stage, kind: req.kind, note: req.note });
      if (run.status === 'active') {
        const { role, taskType, model, provider, runtime, ...context } = run.context;
        // A new stage applies its own user-defined binding. Explicit choices may be made in handoff.
        this.snapshot(state, assets, run, { ...context, ...(run.runtimeSelection ?? {}) });
      }
      return run;
    });
  }
  getSnapshot(id: string) {
    return requireValue(
      this.state().state.snapshots.find((s) => s.id === id),
      'Snapshotが見つかりません',
    );
  }
  handoff(runId: string, input: unknown) {
    const req = z
      .object({
        context: contextSchema.default({}),
        delivery: z.enum(['runtime-pull', 'host-inject']).default('runtime-pull'),
        action: z.enum(['advisory', 'development']).default('advisory'),
      })
      .strict()
      .parse(input);
    return this.store.transaction((state, assets) => {
      const run = requireValue(
        state.runs.find((r) => r.id === runId),
        'Runが見つかりません',
      );
      guard(run.status === 'active', 'RUN_FINISHED', '終了済みRunには委譲できません');
      if (req.action === 'development')
        guard(
          run.workflow?.workflow?.developmentCapable,
          'DEVELOPMENT_BOUNDARY',
          '開発にはDevelopment-capable Workflowの明示起動が必要です',
        );
      for (const key of ['workflow', 'stage', 'project', 'role', 'taskType'] as const)
        if (req.context[key])
          guard(
            req.context[key] === run.context[key],
            'HANDOFF_CONTEXT',
            `Handoffで${key}は変更できません`,
          );
      const context = { ...run.context, ...req.context };
      if (req.context.model || req.context.runtime) {
        context.provider = req.context.provider;
        if (!req.context.model) delete context.model;
        if (!req.context.runtime) delete context.runtime;
      }
      const snapshot = this.snapshot(state, assets, run, context);
      run.updatedAt = now();
      run.version++;
      const stage = run.workflow?.workflow?.stages.find((s) => s.id === run.stage);
      const skill = pinnedSkill(run, state.snapshots);
      return {
        runId,
        snapshotId: snapshot.id,
        task: run.instruction,
        workflowId: snapshot.workflowId,
        workflowRevision: snapshot.workflowRevision,
        stage: run.stage,
        role: snapshot.resolution.context.role ?? null,
        runtime:
          state.config.runtimes.find((r) => r.id === snapshot.resolution.context.runtime) ?? null,
        model: state.config.models.find((m) => m.id === snapshot.resolution.context.model) ?? null,
        mode: run.mode,
        developmentAllowed: !!run.workflow?.workflow?.developmentCapable,
        delivery: req.delivery,
        context: snapshot.resolution.content,
        assets: snapshot.resolution.assets.map((a) => ({
          id: a.id,
          revision: a.revision,
          type: a.type,
        })),
        artifacts: run.artifacts,
        ...runRequirements(run, state.snapshots),
        skill: skill
          ? {
              id: skill.id,
              revision: skill.revision,
              contract: skill.skill ?? null,
            }
          : null,
        possibleTransitions: stage?.transitions ?? [],
        estimatedTokens: snapshot.resolution.estimatedTokens,
      };
    });
  }
  addJournal(input: unknown) {
    const req = z
      .object({
        snapshotId: z.string().min(1),
        kind: z.enum(['friction', 'missing-support', 'defect', 'success', 'improvement']),
        observation: z.string().trim().min(1).max(20000),
        possibleCause: z.string().max(10000).default(''),
        confidence: z.number().min(0).max(1).default(0.8),
      })
      .strict()
      .parse(input);
    return this.store.transaction((state) => {
      const s = requireValue(
        state.snapshots.find((s) => s.id === req.snapshotId),
        'Snapshotが見つかりません',
      );
      const journal = {
        ...req,
        id: uid('journal'),
        runId: s.runId,
        createdAt: now(),
        context: s.resolution.context,
        workflowRevision: s.workflowRevision,
      };
      state.journals.unshift(journal);
      return journal;
    });
  }
  requestReview(input: unknown) {
    const req = z
      .object({ journalIds: z.array(z.string()).min(1), reason: z.string().min(1) })
      .strict()
      .parse(input);
    return this.store.transaction((state) => {
      const journals = [...new Set(req.journalIds)].map((id) =>
        requireValue(
          state.journals.find((j) => j.id === id),
          'Journalが見つかりません',
        ),
      );
      const review: Review = {
        id: uid('review'),
        createdAt: now(),
        journalIds: journals.map((j) => j.id),
        snapshotIds: [...new Set(journals.map((j) => j.snapshotId))],
        status: 'awaiting-proposal',
        reason: req.reason,
        operations: [],
        observedScopes: journals.map((j) => j.context),
      };
      state.reviews.unshift(review);
      return review;
    });
  }
  reviewBundle(id: string) {
    const { state, assets } = this.state();
    const review = requireValue(
      state.reviews.find((r) => r.id === id),
      'Reviewが見つかりません',
    );
    return {
      review,
      journals: state.journals.filter((j) => review.journalIds.includes(j.id)),
      snapshots: state.snapshots.filter((s) => review.snapshotIds.includes(s.id)),
      assets,
      diagnostics: this.diagnostics(),
      provenance: state.changesets,
      instructions:
        'JournalとSnapshotを解釈し、aacl_review_submitのitemsで提案してください。各itemにoperation、proposedScope、proposedRelations（dependencies/conflicts）、reason、evidence（journalIds/snapshotIds/explanation）が必要です。Scope/Relationは変更後Assetと一致させ、削除時はnullにします。観測scopeは根拠からCoreが導出します。根拠IDはこのReviewの対象に限定します。既存AssetはexpectedRevisionを指定します。変更不要ならitemsを空にします。承認はユーザーがUIで行います。',
    };
  }
  submitReview(id: string, input: unknown) {
    return this.store.transaction((state, assets) => {
      const review = requireValue(
        state.reviews.find((r) => r.id === id),
        'Reviewが見つかりません',
      );
      guard(
        review.status === 'awaiting-proposal',
        'REVIEW_STATE',
        'このReviewには提案を送信できません',
      );
      const req = prepareProposal(state, assets, review, input);
      // Validate the complete proposed result on a copy. Never mutate canonical assets here.
      if (req.operations.length)
        this.apply(structuredClone(state), structuredClone(assets), req.operations, {
          origin: 'journal-review',
          summary: req.reason,
          actor: req.proposedBy,
          review,
        });
      Object.assign(review, req, { status: 'pending' });
      return review;
    });
  }
  decideReview(id: string, approve: boolean) {
    const result = this.store.transaction((state, assets) => {
      const review = requireValue(
        state.reviews.find((r) => r.id === id),
        'Reviewが見つかりません',
      );
      guard(review.status === 'pending', 'REVIEW_STATE', '承認待ちのReviewではありません');
      if (!approve) {
        review.status = 'rejected';
        return { review };
      }
      const changeSet = review.operations.length
        ? this.apply(state, assets, review.operations, {
            origin: 'journal-review',
            summary: review.reason,
            actor: 'local-user',
            review,
          })
        : undefined;
      review.status = 'approved';
      review.changeSetId = changeSet?.id;
      return { review, changeSet };
    });
    if (result.changeSet) this.finishHistory(result.changeSet);
    return result;
  }
  rollback(input: unknown) {
    const req = z
      .object({
        changeSetId: z.string().optional(),
        assetId: idSchema.optional(),
        revision: z.number().int().positive().optional(),
        expectedRevision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .parse(input);
    const change = this.store.transaction((state, assets) => {
      let operations: Operation[] = [];
      let rollbackOf: string;
      if (req.changeSetId) {
        const cs = requireValue(
          state.changesets.find((c) => c.id === req.changeSetId),
          'Change Setが見つかりません',
        );
        rollbackOf = cs.id;
        operations = cs.changes.map((c) => {
          const current = assets.find((a) => a.id === c.id);
          guard(
            (current?.revision ?? 0) === (c.after?.revision ?? 0),
            'ROLLBACK_CONFLICT',
            `${c.id}には後続の変更があります。Asset単位の復元を使ってください`,
          );
          return c.before
            ? { op: 'upsert', asset: inputOf(c.before), expectedRevision: current?.revision ?? 0 }
            : { op: 'delete', id: c.id, expectedRevision: current!.revision };
        });
      } else {
        guard(
          req.assetId && req.revision && req.expectedRevision !== undefined,
          'ROLLBACK_INPUT',
          'Asset ID、復元revision、現在revisionが必要です',
        );
        const version = state.changesets
          .flatMap((c) => c.changes.flatMap((x) => [x.before, x.after]))
          .find((a) => a?.id === req.assetId && a?.revision === req.revision);
        guard(version, 'VERSION_NOT_FOUND', '指定revisionが見つかりません');
        rollbackOf = `${req.assetId}@${req.revision}`;
        operations = [
          { op: 'upsert', asset: inputOf(version), expectedRevision: req.expectedRevision },
        ];
      }
      return this.apply(state, assets, operations, {
        origin: 'rollback',
        actor: 'local-user',
        summary: `${rollbackOf}を復元`,
        rollbackOf,
      });
    });
    return this.finishHistory(change);
  }
  importNative(input: unknown) {
    const req = z
      .object({
        id: idSchema,
        name: z.string().min(1),
        type: z.enum(['skill', 'rule', 'knowledge']),
        content: z.string().min(1),
        projectId: idSchema.optional(),
      })
      .strict()
      .parse(input);
    let body = req.content;
    let name = req.name;
    let description = '';
    const frontmatter = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (frontmatter) {
      name =
        frontmatter[1]
          .match(/^name:\s*(.+)$/m)?.[1]
          ?.trim()
          .replace(/^["']|["']$/g, '') ?? name;
      description =
        frontmatter[1]
          .match(/^description:\s*(.+)$/m)?.[1]
          ?.trim()
          .replace(/^["']|["']$/g, '') ?? '';
      body = body.slice(frontmatter[0].length);
    }
    const asset = assetSchema.parse({
      ...req,
      name,
      description,
      content: body,
      activation: req.type === 'skill' ? 'on-demand' : 'auto',
    });
    return this.changeAssets({
      origin: 'native-import',
      summary: `Native Markdownを取り込み: ${name}`,
      operations: [{ op: 'upsert', asset, expectedRevision: 0 }],
    });
  }
  assetHistory(id: string) {
    idSchema.parse(id);
    const { state, assets } = this.state();
    return assetHistory(state, assets, id);
  }
  assetDiff(id: string, input: unknown) {
    const req = z
      .object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
      .strict()
      .parse(input);
    guard(req.from || req.to, 'DIFF_REVISION', '比較には少なくとも1つのrevisionが必要です');
    const history = this.assetHistory(id);
    const version = (revision: number) =>
      revision === 0
        ? null
        : requireValue(
            history.revisions.find((a) => a.revision === revision),
            `revision ${revision}が見つかりません`,
          );
    return assetDiff(version(req.from), version(req.to));
  }
  assetMetrics() {
    const { state } = this.state();
    type Group = {
      assetId: string;
      name: string;
      type: string;
      assetRevision: number;
      workflow: string;
      workflowRevision: number | null;
      stage: string;
      role: string;
      snapshots: number;
      estimatedTokens: number;
    };
    const groups = new Map<string, Group>();
    for (const s of state.snapshots)
      for (const a of s.resolution.assets) {
        const entry = s.resolution.entries.find(
          (e) => e.asset.id === a.id && e.asset.revision === a.revision,
        );
        if (!entry || entry.status !== 'included') continue;
        const key = JSON.stringify([
          a.id,
          a.revision,
          s.workflowId,
          s.workflowRevision,
          s.stage,
          s.resolution.context.role,
        ]);
        const group = groups.get(key) ?? {
          assetId: a.id,
          name: a.name,
          type: a.type,
          assetRevision: a.revision,
          workflow: s.workflowId ?? 'advisory',
          workflowRevision: s.workflowRevision,
          stage: s.stage ?? '—',
          role: s.resolution.context.role ?? '—',
          snapshots: 0,
          estimatedTokens: 0,
        };
        group.snapshots++;
        group.estimatedTokens += entry.estimatedTokens;
        groups.set(key, group);
      }
    return [...groups.values()]
      .map((g) => ({ ...g, averageTokens: Math.round(g.estimatedTokens / g.snapshots) }))
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.assetId.localeCompare(b.assetId));
  }
  diagnostics() {
    const { state, assets } = this.state();
    const diagnostics: { id: string; severity: string; assetId?: string; message: string }[] = [];
    for (const a of assets) {
      for (const dep of a.dependencies)
        if (!assets.some((x) => x.id === dep && x.enabled))
          diagnostics.push({
            id: `dep-${a.id}-${dep}`,
            severity: 'error',
            assetId: a.id,
            message: `依存Assetが未登録または無効です: ${dep}`,
          });
      if (a.content.length > 12000)
        diagnostics.push({
          id: `size-${a.id}`,
          severity: 'warning',
          assetId: a.id,
          message: '本文が12,000文字を超えています。分割・オンデマンド化を検討できます。',
        });
      if (a.capability && (!a.capability.connected || !a.capability.allowed))
        diagnostics.push({
          id: `cap-${a.id}`,
          severity: 'warning',
          assetId: a.id,
          message: 'Capabilityの接続と利用許可を確認してください。',
        });
      if (a.type === 'role' && !state.config.bindings.some((b) => b.role === a.id))
        diagnostics.push({
          id: `binding-${a.id}`,
          severity: 'info',
          assetId: a.id,
          message:
            'Role / Model bindingは未設定です。Runtimeから明示指定するか、接続設定で登録できます。',
        });
      const duplicate = assets.find(
        (x) =>
          x.id < a.id &&
          x.type === a.type &&
          x.content.trim() &&
          x.content.trim() === a.content.trim(),
      );
      if (duplicate)
        diagnostics.push({
          id: `dup-${a.id}`,
          severity: 'warning',
          assetId: a.id,
          message: `本文が同一です: ${duplicate.id}`,
        });
    }
    state.changesets
      .filter((c) => c.gitError)
      .forEach((c) =>
        diagnostics.push({ id: `git-${c.id}`, severity: 'warning', message: c.gitError! }),
      );
    return diagnostics;
  }
  metrics() {
    const { state } = this.state();
    const groups = new Map<
      string,
      {
        workflow: string;
        revision: number | null;
        stage: string;
        role: string;
        snapshots: number;
        estimatedTokens: number;
        journals: number;
        defects: number;
        missingSupport: number;
        retries: number;
        returns: number;
      }
    >();
    for (const s of state.snapshots) {
      const c = s.resolution.context;
      const key = JSON.stringify([s.workflowId, s.workflowRevision, s.stage, c.role]);
      const g = groups.get(key) ?? {
        workflow: s.workflowId ?? 'advisory',
        revision: s.workflowRevision,
        stage: s.stage ?? '—',
        role: c.role ?? '—',
        snapshots: 0,
        estimatedTokens: 0,
        journals: 0,
        defects: 0,
        missingSupport: 0,
        retries: 0,
        returns: 0,
      };
      g.snapshots++;
      g.estimatedTokens += s.resolution.estimatedTokens;
      const journals = state.journals.filter((j) => j.snapshotId === s.id);
      g.journals += journals.length;
      g.defects += journals.filter((j) => j.kind === 'defect').length;
      g.missingSupport += journals.filter((j) => j.kind === 'missing-support').length;
      groups.set(key, g);
    }
    for (const r of state.runs)
      for (const event of r.events) {
        const stage = r.workflow?.workflow?.stages.find((s) => s.id === event.from);
        const g = groups.get(
          JSON.stringify([
            r.workflow?.id ?? null,
            r.workflow?.revision ?? null,
            event.from,
            stage?.role,
          ]),
        );
        if (g && event.kind === 'retry') g.retries++;
        if (g && event.kind === 'return') g.returns++;
      }
    return [...groups.values()].map((g) => ({
      ...g,
      averageTokens: Math.round(g.estimatedTokens / g.snapshots),
    }));
  }
}
