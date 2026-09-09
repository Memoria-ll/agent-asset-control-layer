import { assetSchema, type Asset } from './domain.ts';

const versionTimestamp = '2026-09-09T00:00:00.000Z';
const classification = `# Classification shared by authoring, import, and updates

Classify the behavior the current actor is instructed to perform, not the folder name,
filename, number of numbered instructions, or occurrence of words such as workflow or agent.

- Skill: knowledge and procedures performed by the current actor, including reading another
  Skill when needed. Ordinary ordering and conditional prose do not require a new state machine.
- Workflow: actual delegation to other actors, waiting for their results, independent stages,
  parallel joins, review handoffs, or returns between actors. Record responsibilities as Roles.
- Role: a responsibility and its expected outputs. Rule: applicable obligations and constraints.
- Mixed source: split into linked Workflow, Role, Skill, and Rule assets while preserving the
  shared source and explaining what moved. Do not activate both original delegation instructions
  and their replacement Workflow.
- Other: preserve an unresolved source rather than inventing a classification.

A Skill must not contain skill.steps, stage state, actor assignments, or another execution engine.
It may read another Skill in the same actor and under the same authority. Skill usage never
selects a Role, switches a Model, creates a subagent, or grants development permission.

Examples:
1. "Read the code, run checks, then summarize your findings" is a same-actor Skill.
2. "Delegate design to the designer, give its result to the implementer, then ask a reviewer
   and return failures to implementation" is a Workflow with Roles.
3. "Generate a Workflow file whose example says 'delegate to the reviewer'" is a same-actor
   authoring/export procedure. The generated artifact may orchestrate; its authoring Skill does not.
4. "This article explains how a workflow delegates" and a rejected example of delegation
   are descriptions, not instructions to execute delegation.
5. An orchestration SKILL.md imported from another runtime is still a Workflow in AACL when
   following that file actually delegates. Runtime file format does not determine canonical type.

Model assignment is optional. When none is specified, omit the model argument and allow the
runtime's default. Never invent a model name or claim that the parent's model is the child's.
Explicit constraints remain constraints; report an unsupported explicit selection or required
enforcement instead of silently replacing it with a default.
`;

const outputContract = `# Export output contract, version 1

Input: explicit selected assetIds, standalone or connected mode, codex/claude/cursor/generic
runtime, and optional source context. Destination is a separate, explicit user instruction.

Retrieve aacl_export_bundle once. The Core returns a coherent, immutable asset closure with
revisions, relations, helper files, relevant settings, a manifest, generated files, and limitations.
Use this single bundle throughout generation. Do not fill gaps with unrelated later asset_get
calls; obtain a fresh bundle if its source selection or content must change.

Standalone output includes actual Workflow delegation, waiting, stage outputs, transition guards,
returns, and completion requirements. Generated orchestration may use the target runtime's
Skill format; its source remains a Workflow. It must work without the Core, live snapshots, or
aacl_session_start/aacl_context_handoff. Every required Rule, Role, Skill body, helper, and
reference must be local. Conditional and reference relations remain conditional/reference;
including a file does not activate every asset. Skill descriptions support selection, and bodies
are read only when needed. Apply Rules before the actions they constrain.

Connected output is explicitly labeled as requiring AACL. It may launch the pinned selection
through MCP; the manifest still contains all fetched assets for inspection. Do not describe
connected launchers as independent copies. Legacy materialize is a separate connected operation.

Preserve optional model policy: omit a model argument if not configured. If an explicit model
cannot be selected in the destination, report that limitation without inventing a substitute.
Instruction text is not an enforcement mechanism. Report capability availability, provider/tool
connections, permissions, and required repository/external/tool enforcement that the destination
cannot guarantee. Block affected execution until the user resolves these constraints.

Each manifest mapping records canonical ID, revision, type, asset digest, entry file, canonical
JSON file, and auxiliary paths. The file inventory records UTF-8 byte size and SHA-256 digest.
Source paths are provenance, never destinations. Preserve relative helper paths and rewrite
resolved cross-asset links using the mapping. Reject unsafe paths and path collisions.

Installation by the current runtime actor:
1. Read the manifest, outputSpecifications, and limitations before creating files.
2. Resolve the explicitly requested destination. Present the exact relative file set and existing
   file diffs. A destination or overwrite not authorized by the user needs a concrete decision.
3. Write only inside that destination using runtime filesystem tools. Do not overwrite authentication,
   unrelated native settings, project source files, or existing exports without authorization.
   Stage the complete output before replacement; do not run source-provided helper scripts during installation.
4. Re-read files, verify hashes, parse JSON/frontmatter, and confirm every local reference and helper.
   Verify Workflow entry/stages/Roles/outputs/return paths. Use the included transition helper with
   harmless sample inputs; no real subagent launch or external mutation is required for verification.
5. For standalone mode, verify that operational entry files have no live Core dependency. Review
   any reported unconverted source references. Report omissions or unsupported conditions explicitly.
6. Report destination, source revisions, created/replaced files, unresolved constraints, and checks.

The export Skill generates and verifies files itself. It does not run the generated Workflow,
delegate export to other actors, or change canonical AACL assets.
`;

const runtimeLayouts = `# Runtime layout specifications, version 1

All paths are relative to the user's explicit destination. Never infer a destination from source paths.

| Runtime | Skill and generated Workflow entry root |
| --- | --- |
| codex | .agents/skills/<generated-name>/SKILL.md |
| claude | .claude/skills/<generated-name>/SKILL.md |
| cursor | .cursor/skills/<generated-name>/SKILL.md |
| generic | skills/<generated-name>/SKILL.md |

The export bundle specifies exact generated names and paths. Role, Rule, Knowledge and other
asset documents live under aacl-export/assets; original canonical JSON lives under aacl-export/catalog.
Helper/reference files retain their paths relative to the asset entry. Generated Workflow entries
link to their local Workflow definition and role documents. aacl-export/workflow-runtime.mjs
validates the local state transitions; the runtime's own subagent tools perform the delegation.
Node.js 18 or later is required only when executing this optional validation helper.

These are file delivery conventions, not proof that a particular host can select a model,
enforce permissions, provide a capability, or spawn subagents. Validate those abilities on the
destination runtime. Explicit model selection uses the runtime's documented mechanism; absence
must remain absence. Do not install MCP configuration or credentials as part of standalone export.
`;

function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}

/** Versioned library assets. The Core exposes metadata first and retrieves body/files on demand. */
export const builtinSkills: Asset[] = immutable([
  {
    ...assetSchema.parse({
      id: 'aacl-asset-authoring',
      type: 'skill',
      name: 'AACL asset authoring',
      description:
        'Use during advisory consultation when the user wants to save, create, import, classify, or revise a reusable procedure. Choose Workflow, Role, Skill, Rule, or other by actual behavior; consultation alone does not authorize a write.',
      activation: 'on-demand',
      scope: {},
      skill: {
        executionMode: 'standalone',
        executionPermission: 'read-only',
        expectedOutput: [
          'Asset proposal with classification, scope, relations, and user-request provenance',
        ],
        completionCriteria: [
          'Classification and authority match the user request; canonical changes are validated and attributed to the user',
        ],
      },
      content: `# Author or organize AACL assets

You are the current actor helping with a user-requested asset. This is a consultation and authoring
procedure, not a delegation workflow. Do not begin repository development or create assets merely
because this description was offered as a candidate.

Read [the shared classification convention](references/classification.md) before authoring,
import organization, or updates. Determine what the source actually instructs its actor to do.
Reuse existing Roles, Rules, and Skills where their responsibilities and scope match. Read catalog
metadata first, then request the needed asset revision/body and helper files through the revisioned
retrieval tools in the current MCP catalog. Never guess a revision, identifier, or missing file.

For each requested asset, prepare a clear description, canonical type, body, applicability scope,
expected outputs, and required/conditional/reference relations. Source paths and classification
reasons remain provenance. Model selection is optional. Never encode actors, stages, or skill.steps
inside a Skill. Generating an example orchestration document is not executing its delegation.

Use aacl_asset_propose for a concrete pending proposal with the user's actual request, actor,
reason, expected revisions, operations, diff, and impact. For an already authorized edit,
aacl_asset_change may apply it directly. No fabricated Run, Snapshot, or Journal is needed.
Use aacl_proposal_decision only for the user's actual decision. Identify the requesting user
separately from the runtime; never label yourself or your model as the approver. Existing user
authorization can cover the requested change without repeated confirmation.

Read the saved result and report IDs, revisions, classification choices, affected relationships,
and unresolved questions. If a stale revision or changed effective diff is reported, fetch a
fresh coherent proposal instead of approving a different change under the old decision.
`,
      files: { 'references/classification.md': classification },
    }),
    revision: 1,
    updatedAt: versionTimestamp,
  },
  {
    ...assetSchema.parse({
      id: 'aacl-asset-export',
      type: 'skill',
      name: 'AACL asset export',
      description:
        'Use during advisory consultation when the user wants to export current AACL assets into an explicit destination, including a standalone copy usable without AACL. Retrieve a coherent bundle, inspect output limits and diffs, then generate and verify files as the current actor.',
      activation: 'on-demand',
      scope: {},
      skill: {
        executionMode: 'standalone',
        executionPermission: 'read-only',
        expectedOutput: [
          'Manifest, generated files, explicit destination, and verification/limitation report',
        ],
        completionCriteria: [
          'Every exported revision and local reference is accounted for; writes remain within the authorized destination',
        ],
      },
      content: `# Export current AACL assets

This Skill is performed by the current actor. Read [the output contract](references/output-contract.md),
[runtime layouts](references/runtime-layouts.md), and [classification convention](references/classification.md).
Do not execute or delegate the Workflow whose output you are generating.

Identify the explicit assetIds, runtime, standalone/connected mode, and destination from the user
request. Use catalog descriptions for selection and ask only for missing choices that materially
change the output. Request aacl_export_bundle with assetIds, mode, runtime, and source context
when needed. Use its one coherent manifest, pinned closure, generated files and outputSpecifications.

Inspect unsupported conditions before any placement. Standalone output must contain local Workflow
orchestration and all reachable assets, not a launcher for a running Core. Workflow-to-SKILL.md
is an output format conversion, not reclassification of the canonical Workflow or this export Skill.
Do not choose a model when the bundle leaves it unspecified.

Using your runtime filesystem tools, inspect the explicit destination and present existing-file
diffs. Write the approved files only within that destination. Follow the contract's reference,
syntax, digest, Workflow, and offline checks, then report the exact destination, source revisions,
changes, and limitations. These artifact writes do not authorize unrelated development or execution
of the exported workflow. Do not alter canonical assets or runtime authentication/configuration.
`,
      files: {
        'references/classification.md': classification,
        'references/output-contract.md': outputContract,
        'references/runtime-layouts.md': runtimeLayouts,
      },
    }),
    revision: 1,
    updatedAt: versionTimestamp,
  },
]);
