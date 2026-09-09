import { z } from 'zod';
import { Core } from './core.ts';
import { assetBody } from './contracts.ts';
import { contextSchema, idSchema, DomainError } from './domain.ts';

export function bootstrap(endpoint = `http://localhost:${process.env.PORT ?? '4780'}/mcp`) {
  return `# AACL runtime bootstrap v2\n\nAACL is the canonical source for workflows and assets. MCP endpoint: ${endpoint}\n\nUse the connected MCP tool catalog for current argument schemas. Search and retrieve the required assets through MCP, including their bundle files and saved relations. Follow required and applicable conditional relations in the selected execution context. Reference relations do not authorize execution. Never infer roles, models, or development permission from a skill reference.\n\nStart a session using aacl_session_start. A user-selected /workflow plus additional instructions explicitly starts that workflow. Without a workflow, stay in Advisory / Preparation Mode; do not begin repository modification or PR creation. Discover workflows with aacl_workflow_list; never infer or invent a selection. Use aacl_run_get and aacl_context_handoff_preview to inspect a run and its context without creating handoffs, snapshots, or execution events.\n\nBefore execution or delegation, call aacl_context_handoff with the run ID and actual runtime/model. For repository modification request action=development; proceed only when developmentAllowed=true. Apply the returned context and completion criteria. A handoff delivers context; it is not evidence that a model or tool ran. The external runtime invokes models and tools. Call aacl_runtime_event with started, result, or failed only when the corresponding invocation occurs, using the real attemptId, current expectedVersion, outcome, and evidence. Report defined transitions with aacl_workflow_transition, providing evidence and artifacts. Attach first-hand observations to real snapshots with aacl_journal_append.\n\nManage assets, configuration, onboarding, and improvement through conversational MCP operations. Preserve the explicit userRequest and change reason. When approval is required, prepare a proposal, show its concrete changes, and call aacl_asset_propose and aacl_proposal_decision with the user's instruction as the authority. Do not fabricate user approval or journals. Do not require the user to open the UI for conversational approval. Existing journal reviews use aacl_review_get, aacl_review_submit, and aacl_review_decision; first-time organization and explicitly requested edits do not need invented execution observations.\n\nDuring onboarding, retrieve every imported asset using aacl_asset_get, then invoke onboarding verification through MCP to prove a real Core write. Apply the user's initial organization request as a batch. Inspect unresolved items before cutover. Never rename native runtime parent directories. For optional connection installation, call aacl_onboarding_connect with the userRequest; its private adapter merges only the AACL MCP entry and preserves other settings and credentials. Read the registered bootstrap path returned in operation status. Use the prepared connection plan, keep unsupported plugin-managed assets in place, and cut over only the verified imported paths. Do not edit generated files as canonical assets.\n`;
}

/** Preview only; onboardingConnect executes supported merges with private backups. */
export function onboardingConnectionPlan(input: unknown) {
  const req = z
    .object({
      runtime: z.enum(['claude', 'codex', 'cursor', 'other']),
      endpoint: z
        .string()
        .url()
        .default(`http://localhost:${process.env.PORT ?? '4780'}/mcp`),
    })
    .strict()
    .parse(input);
  const url = new URL(req.endpoint);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new DomainError(
      'UNSAFE_ENDPOINT',
      'Use an HTTP(S) endpoint without credentials, query parameters, or fragments',
    );
  const target =
    req.runtime === 'codex'
      ? '.codex/config.toml'
      : req.runtime === 'claude'
        ? '.mcp.json'
        : req.runtime === 'cursor'
          ? '.cursor/mcp.json'
          : undefined;
  const content =
    req.runtime === 'codex'
      ? `[mcp_servers.aacl]\nurl = ${JSON.stringify(req.endpoint)}\n`
      : JSON.stringify(
          {
            mcpServers: {
              aacl: { ...(req.runtime === 'claude' ? { type: 'http' } : {}), url: req.endpoint },
            },
          },
          null,
          2,
        ) + '\n';
  return {
    runtime: req.runtime,
    endpoint: req.endpoint,
    files: [
      { path: 'AACL-BOOTSTRAP.md', content: bootstrap(req.endpoint) },
      {
        path: req.runtime === 'codex' ? 'aacl-mcp.snippet.toml' : 'aacl-mcp.snippet.json',
        content,
      },
    ],
    connection: {
      supported: req.runtime !== 'other',
      target,
      action: 'merge-aacl-entry',
      automatic: req.runtime !== 'other',
      tool: 'aacl_onboarding_connect',
      requiresUserRequest: true,
    },
    usage:
      'Call aacl_onboarding_connect with the operation ID and explicit userRequest to install supported native connections. It preserves unrelated configuration, saves private backups, and registers the exact AACL-BOOTSTRAP.md path in operation status. Read that guide in the runtime after reconnecting. Generating this plan does not install or verify a connection. Unsupported TOML syntax and other runtimes require the supplied snippet and an explicitly configured MCP client.',
  };
}
export function materialize(core: Core, input: unknown) {
  const req = z
    .object({
      runtime: z.enum(['claude', 'codex', 'cursor', 'other']),
      context: contextSchema.default({}),
      requested: z.array(idSchema).default([]),
      endpoint: z
        .string()
        .url()
        .default(`http://localhost:${process.env.PORT ?? '4780'}/mcp`),
    })
    .strict()
    .parse(input);
  const result = core.preview({
    context: { ...req.context, runtime: req.runtime },
    requested: req.requested,
  });
  if (!result.valid) throw new DomainError('CONTEXT_UNRESOLVED', result.errors.join('\n'), 409);
  const skillRoot =
    req.runtime === 'claude'
      ? '.claude/skills'
      : req.runtime === 'cursor'
        ? '.cursor/skills'
        : '.agents/skills';
  const files: { path: string; content: string }[] = [
    { path: 'AACL-BOOTSTRAP.md', content: bootstrap(req.endpoint) },
    {
      path: 'AACL-CONTEXT.md',
      content: `<!-- Generated by AACL. Edit canonical assets in the Core. -->\n\n${result.content}\n`,
    },
  ];
  for (const a of result.assets) {
    if (a.type === 'skill') {
      files.push({
        path: `${skillRoot}/${a.id}/SKILL.md`,
        content:
          a.sources?.length && a.content.startsWith('---\n')
            ? a.content
            : a.sources?.length && a.content.startsWith('---\r\n')
              ? a.content
              : `---\nname: ${a.id}\ndescription: ${JSON.stringify(a.description || a.name)}\n---\n\n${assetBody(a)}\n`,
      });
      for (const [relative, content] of Object.entries(a.files ?? {})) {
        if (relative.toLowerCase() === 'skill.md')
          throw new DomainError(
            'BUNDLE_ENTRY_CONFLICT',
            'Skill bundle files must not replace the canonical SKILL.md entry',
          );
        files.push({ path: `${skillRoot}/${a.id}/${relative}`, content });
      }
    }
    if (a.type === 'workflow')
      files.push({
        path: `${skillRoot}/${a.id}/SKILL.md`,
        content: `---\nname: ${a.id}\ndescription: ${JSON.stringify(a.description || a.name)}\n---\n\nThis is a generated AACL workflow launcher (${a.id}@${a.revision}).\nCall aacl_session_start with workflowId=${a.id}, context=${JSON.stringify(result.context.project ? { project: result.context.project } : {})}, and the user's additional instruction. Then call aacl_context_handoff for the created run. Use the returned project.root as the working directory on the Core host and the returned version as expectedVersion for the next transition. Read AACL-BOOTSTRAP.md for the runtime contract.\n`,
      });
  }
  files.push({
    path: 'aacl-manifest.json',
    content:
      JSON.stringify(
        {
          version: 1,
          generated: true,
          runtime: req.runtime,
          context: result.context,
          assets: result.assets.map((a) => ({
            id: a.id,
            revision: a.revision,
            sources: a.sources ?? [],
          })),
          files: files.map((f) => f.path),
        },
        null,
        2,
      ) + '\n',
  });
  return {
    runtime: req.runtime,
    files,
    usage:
      'Save each file at its returned relative path beneath the target project root; create the parent directories after downloading. Ask the AI to read AACL-BOOTSTRAP.md and AACL-CONTEXT.md. The manifest records generated conditions and revisions. MCP can supply live context without these files; generated workflow launchers still require a running Core and MCP connection. Regenerate after changing canonical assets and review any existing file at the same path before replacing it.',
    estimatedTokens: result.estimatedTokens,
  };
}
