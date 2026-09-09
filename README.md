# Agent Asset Control Layer

**English** | [日本語](README.ja.md)

**AACL is a local app for saving AI development methods, reusing them, and improving them from execution records.**

Import existing instructions or ask the AI to create a method. Next time, select the saved Workflow and give it this task's target.

```text
/issue-development #123 Fix the login failure
```

This example assumes you have registered `issue-development`. AACL manages the method and its state. The connected AI runtime performs code changes and reviews.

```mermaid
flowchart LR
    User["User<br/>Select method and target"] --> AI["Connected AI"]
    AI <-->|"Get instructions / report results"| Core["AACL<br/>Assets, stages, history"]
    AI --> Work["Runtime<br/>Start agents, develop, review"]
    Work -->|"Results"| AI
    User <-->|"Inspect / edit"| UI["Browser UI"]
    UI <--> Core
```

**Available now:** local Core, browser UI, MCP, CLI, asset onboarding, and standalone file export. The Core service stores data and validates operations. MCP is the protocol through which AI clients call those operations; the CLI provides terminal commands.

## Get started

Use Node.js 24 or newer. Run these commands from the repository root:

```sh
npm ci
npm run build
npm start
```

| Interface      | Setup                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------ |
| Browser UI     | Open `http://localhost:4780`.                                                              |
| MCP over HTTP  | Connect your AI client to `http://localhost:4780/mcp`.                                     |
| MCP over stdio | Keep the Core running. Set this repository as the working directory and run `npm --silent run mcp`. |

The stdio process bridges to the running Core. The `--silent` option keeps npm banners out of the MCP protocol stream. Once connected, ask the AI to register your project and import and organize existing development instructions. If you have no assets, ask it to create a Workflow or add the editable starter through the UI. Model registration is optional.

| Environment variable | Purpose and default                                                  |
| -------------------- | -------------------------------------------------------------------- |
| `AACL_DATA_DIR`      | Core storage directory; defaults to `.aacl-data` in this repository. |
| `PORT`               | Core port; defaults to `4780`.                                       |
| `AACL_URL`           | Stdio bridge destination; defaults to `http://127.0.0.1:4780/mcp`.   |
| `AACL_API_URL`       | CLI destination; defaults to `http://127.0.0.1:4780`.                |

The Core listens on `127.0.0.1`. If you change its port, update the AI and CLI connection settings too.

## Save methods as assets

An **Asset** is reusable instruction or knowledge. Assets have IDs, revisions, applicability conditions, and relationships.

| Type        | What it stores                                                                 |
| ----------- | ------------------------------------------------------------------------------ |
| Workflow    | Stages, assigned Roles, delegation, outputs, returns, and completion criteria. |
| Role        | A responsibility and its expected outputs.                                     |
| Skill       | Procedures, knowledge, and supporting files used by the current actor.         |
| Rule        | Instructions that apply when their conditions match.                           |
| Task Type   | Work objectives, quality criteria, and constraints.                            |
| Capability  | External tool connection and permission information.                           |
| Other types | Project knowledge, policies, templates, and unclassified assets.               |

A Workflow assigns responsibility. Each actor uses the Skills it needs. This example separates implementation from review:

```mermaid
flowchart TD
    Implement["Implementation stage<br/>Role: Implementer"] --> Review["Review stage<br/>Role: Reviewer"]
    Review -->|"Pass"| Done["Complete"]
    Review -->|"Return"| Implement
    Implement -. "Read when needed" .-> Coding["Skill: Implementation procedure"]
    Review -. "Read when needed" .-> Checking["Skill: Review procedure"]
    Rules["Rule: Shared constraints"] -. "Apply to both actors" .-> Implement
    Rules -. "Apply to both actors" .-> Review
```

A Skill does not choose actors or models. It can describe ordered steps performed by the same actor. Delegation and stage control belong in a Workflow. Legacy `skill.steps` remain readable but are not executed; new writes are rejected.

Repository changes require explicit launch of a Workflow that permits development. Conversations without a Workflow and standalone Skills stay in advisory or preparation mode. Editing AACL assets is a separate management operation authorized by the user's request.

The UI lets you edit stages, responsibilities, outputs, and return paths. Screenshots show the current Japanese UI with example data.

![Workflow editor showing stages, assigned Roles, and a return path](docs/images/readme-workflow.png)

## Import existing instructions

Single Markdown registration and migration of an existing environment have separate entry points within the import dialog. The UI labels below are in Japanese.

| Goal | UI entry point | What is saved or changed |
| --- | --- | --- |
| Register one file as an asset | Assets → インポート → 単一Markdownを登録 | Saves the body and description as an enabled asset. It does not retain the original path, hash, or supporting files, and leaves the source file unchanged. |
| Migrate a folder of existing instructions | In the same dialog, AIに移行・初期設定を依頼 → 移行の依頼をコピー | A connected AI uses MCP to back up, import with provenance, verify, classify, and switch off the original automatic loading. The onboarding ID supports resuming and restoring the operation. |

For one file, select it or paste its contents, enter an ID and name, choose its type and destination, and click 取り込む. The name is suggested from the frontmatter `name`, falling back to the filename. A manually entered name survives subsequent file selections. A Skill is registered as an enabled candidate whose body is retrieved when needed.

For migration, replace the target folder in the copied request and send it to an AI connected to AACL. The AI retrieves every imported asset and verifies a real MCP write before classification, while the source files remain in place. Additional connection setup, if needed, happens before cutover.

Directory discovery targets instruction files such as `AGENTS.md` and `AGENTS.override.md`, Skills, and instruction folders. Ordinary README and design documents are not candidates. To reuse a README as a separate asset, select its file path explicitly. README files within a selected Skill are included as supporting files. In both cases, cutover leaves the original README in place, and restore preserves subsequent edits to it.

```mermaid
flowchart TD
    Backup["Discover and back up"] --> Import["Import with provenance<br/>Initially disabled"]
    Import --> Organize["Verify reads and writes<br/>AI classifies and organizes"]
    Organize --> Check{"Classification settled?"}
    Check -->|"Yes"| Cutover["Verify unchanged sources<br/>Disable original loading"]
    Check -->|"No"| Hold["Keep disabled"]
    Cutover -. "Restore" .-> Restore["Restore source files<br/>and prior organization"]
```

A file is not classified as a Skill just because it lives in a `skills` directory. The AI reads its actual behavior and can split one source into Workflow, Role, and Skill assets. AACL records output IDs, classification reasons, unconverted parts, and provenance.

Resume interrupted work with its onboarding ID. Cutover and restore verify file contents and asset revisions; later edits are not overwritten. Credentials, connection settings, histories, and caches are not imported as asset bodies.

Connection setup is available for Codex, Claude, and Cursor. Unsupported formats and plugin-managed assets remain in place with an explanation. See the [operating guide](docs/mcp-operations.md) (Japanese) for the full procedure.

## Update supporting files

The 補助ファイルと出所 section in asset detail and edit views is read-only. Expand a file to read or copy it. Editing the body or description preserves saved supporting files.

To change a checklist or another supporting file, click 補助ファイル更新の依頼をコピー. Fill in the target path and requested changes, then send the request to an AI connected to AACL. The AI retrieves the latest asset and saves the change while retaining other supporting files. A revision conflict requires checking the latest content before continuing. Unsaved body edits in the UI are not included in the request; save any edits you need before sending it.

## Deliver only the instructions needed

**Context is the information delivered to an actor.** The Core resolves it from the Project, Workflow, stage, Role, task type, Runtime, model, directory, and other conditions. A Runtime is the environment that starts AI agents and runs tools.

Initial Context includes applicable Rule bodies and Skill descriptions. The AI selects and retrieves Skill bodies and supporting files when needed.

```mermaid
flowchart TD
    Conditions["Current conditions<br/>Project, stage, Role, runtime"] --> Resolve["Core resolves applicability"]
    Resolve --> Rules["Applicable Rule bodies"]
    Resolve --> Catalog["Skill descriptions<br/>IDs, revisions, retrieval"]
    Rules --> AI["Assigned AI"]
    Catalog --> AI
    AI -->|"Select a Skill"| Body["Read its pinned revision"]
    Body -->|"Follow needed references"| Files["Read individual files<br/>and referenced assets"]
    Resolve -. "Omit bodies" .-> Other["Excluded assets<br/>Return reasons only"]
```

Different condition dimensions combine with AND. For example, an asset scoped to `Role = reviewer` and `Model = model-a` applies only when both match. Projects can also disable assets, replace them, or override their conditions.

When several relationships select the same Skill, the candidate appears once and retains its selection reasons. Candidate presentation, body retrieval, and reported use are separate records. Retrieval alone does not count as use.

The execution UI shows the current stage's Context and Skill candidates.

![Context preview showing model policy, instructions, and Skill candidates](docs/images/readme-run-context.png)

## Leave model selection optional

Role and model are separate settings. When a model is specified, precedence is the explicit run selection, then the stage setting, then the Role binding.

```mermaid
flowchart TD
    Order["Look for a model selection<br/>Run, then stage, then Role"] --> Selected{"Selection present?"}
    Selected -->|"Yes"| Explicit["Request the specified model"]
    Selected -->|"No"| Default["Omit the model argument<br/>Use the runtime default"]
    Explicit --> Report["Report the actual model separately<br/>Leave unknown values unset"]
    Default --> Report
```

An omitted model does not mean “use the parent AI's model.” If a Runtime cannot honor an explicit selection, AACL reports a conflict rather than ignoring the selection.

Requested and reported actual models are stored separately. Runtimes may report unregistered models, but applying model-specific assets requires a matching model configuration. A Workflow that requires a particular model or a different model for review cannot advance or complete without confirming that constraint through execution reports.

## Prepare a Workflow execution in the UI

1. Launch the selected Workflow from Workflows, fill in 今回の指示 and any required conditions, and click 実行を開始.
2. The execution displays 準備済み／AIへ依頼待ち (prepared; waiting for a request to the AI). Under 次の操作：AIへ依頼する, click AIへの依頼をコピー and send it to an AI connected to AACL.
3. The execution view updates when the AI reports an actual start or result.

実行を開始 creates prepared state in the Core; it does not automatically launch an AI. The Workflows 実行中 count includes only executions with a reported running status. Preparations are counted separately under AIへ依頼待ち. In Executions, the 未完了（準備・待機を含む） filter includes preparations and work waiting for a decision.

## Use a Workflow from an AI client

Read `aacl_bootstrap` or `aacl://bootstrap` after connecting. Obtain exact arguments from the connected server's MCP tool definitions.

For a minimal example with `issue-development` already registered, pass these arguments to `aacl_session_preflight`. If it returns `ready: true`, pass the same arguments to `aacl_session_start` to create the preparation.

```json
{
  "workflowId": "issue-development",
  "instruction": "#123 Fix the login failure"
}
```

Use the start response's `id` as `runId` in `aacl_run_get` or `aacl_context_handoff_preview` to inspect the state and the actor's instructions. To proceed with development, follow the handoff and execution-reporting sequence below.

A session start request creates a prepared execution. The Runtime performs the actual work. This is the basic call sequence for one stage:

```mermaid
sequenceDiagram
    participant AI as Connected AI / Runtime
    participant Core as AACL Core
    AI->>Core: aacl_session_preflight: check every stage
    AI->>Core: aacl_session_start: Workflow and task instructions
    Core-->>AI: Run ID and current version
    AI->>Core: aacl_context_handoff: get the actor's Context
    Core-->>AI: Launch policy, Rule bodies, Skill candidates
    AI->>AI: Start the assigned agent
    AI->>Core: aacl_runtime_event: started, actual model if known
    Core-->>AI: Attempt Snapshot and Context for the actual model
    AI->>Core: aacl_skill_get: retrieve a needed body
    AI->>AI: Perform and verify the work
    AI->>Core: aacl_runtime_event: result / failed
    AI->>Core: aacl_workflow_transition: outputs and evidence
```

A **Snapshot** pins asset revisions, settings, and Context. A start report preserves the preparation record and creates another Snapshot reflecting the actual model.

Rules for AI clients:

1. Do not invent executions or Journals to create or organize assets. Record `userRequest`, the change reason, and the actual requesting user.
2. Before development, request a handoff with `action: "development"` and check `developmentAllowed`.
3. Call `aacl_skill_get` with the returned `id`, `revision`, and `snapshotId`. Use `usage: "inspect"` for reading and `usage: "use"` to report use. Retrieve supporting files with `aacl_asset_file_get` at the same revision.
4. Use the latest `expectedVersion` for updates. Where request replay is supported, reuse the same payload and `requestId`. A start report's `attemptId` identifies the real attempt.
5. Inspect state with `aacl_run_get` and `aacl_context_handoff_preview`. These reads do not increment the run version or create Snapshots.
6. Transitions must follow defined stages and supply outputs and completion evidence. Collect fresh evidence after a return. To restart with the latest Workflow, use `aacl_run_restart` to create a separate execution.

## Improve from records

A **Journal** records problems and results observed in a real attempt. At the user's request, the AI reviews these records and proposes a change.

```mermaid
flowchart TD
    Work["Actual work"] --> Journal["Journal<br/>Record problems and results"]
    Journal --> Review["User-requested AI review"]
    Review --> Proposal["Concrete proposal<br/>Diff and evidence"]
    Proposal --> Decision{"User decision"}
    Decision -->|"Approve"| Revision["Save a new revision"]
    Decision -->|"Reject"| Keep["Record decision<br/>without changing assets"]
    Revision --> Next["Use in the next execution"]
    Next --> Work
```

Use `aacl_asset_propose` or `aacl_asset_change` for initial authoring and direct change requests, and `aacl_proposal_decision` for approval decisions. Reviews based on execution records start with `aacl_review_start`. The built-in `aacl-asset-authoring` Skill supports authoring and classification during consultation.

Assets, model bindings, and Project settings retain before/after values and change reasons and can be restored. Past Snapshots remain unchanged. Comparison views distinguish preparations from attempts, requested from actual models, and asset and setting revisions.

Change History presents onboarding changes with headings such as 既存指示を分類 (classify existing instructions) and 接続を確認 (verify the connection). Open a change and expand 導入ID・依頼原文・変更理由 to inspect the original identifiers, hashes, and full request. Reverting an asset change and restoring source files and connection settings through an onboarding ID are separate operations. To restore the entire onboarding operation, give its ID to the AI and request restoration.

## Export files

The built-in `aacl-asset-export` Skill and `aacl_export_bundle` retrieve selected assets and their required references together. Assets, relationships, and settings come from one point in time, so export does not mix revisions.

```mermaid
flowchart LR
    Assets["Selected assets<br/>and required references"] --> Bundle["One consistent bundle<br/>Revisions, settings, hashes, paths"]
    Bundle --> Standalone["standalone<br/>Local stages, Roles, Skills, files"]
    Bundle --> Connected["connected<br/>Launch instructions using MCP"]
    Standalone --> Offline["Use after AACL stops"]
    Connected --> Online["Connect to a running AACL"]
```

| Mode         | Requirements                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `standalone` | Includes Workflow delegation, return instructions, and referenced files. The exported result does not need the Core. |
| `connected`  | Requires MCP. Configure the connection in the destination environment.                                               |

Output formats are `codex`, `claude`, `cursor`, and `generic`. Source connection endpoints are omitted in both modes. Check `limitations`; if `ready: false`, resolve the blocking conditions before use. Export alone does not guarantee model selection support or permission enforcement.

To request standalone output from the UI:

1. In Context Preview, select a Workflow or entries under 追加する利用候補.
2. Under Core不要の単独出力をAIに依頼, choose the output format and click 単独出力の依頼をコピー.
3. Send the request and destination to the AI. It checks output limitations and differences from existing files, saves the complete set including supporting files, and verifies hashes and references.

Retrieving the export requires the Core and an MCP connection. The saved standalone output can be used after the Core stops. Copying the request does not save files. The Codex and Claude buttons under Coreに接続して使うファイルを生成 generate connected files that also require the Core and MCP when used.

For example, save this as `export-input.json`, replacing the asset ID with a registered one:

```json
{
  "assetIds": ["issue-development"],
  "mode": "standalone",
  "runtime": "codex"
}
```

Keep the Core running and export to a directory that does not yet exist:

```sh
npm run cli -- export-bundle export-input.json ./exported-assets
```

`aacl_materialize` and CLI `export` also generate connected output that requires MCP. Use `export-bundle` as shown above to save a complete set of files for use without the Core.

## Implementation and verification

The Core uses TypeScript, Node.js, and Express. The UI uses React and Vite. Canonical data is stored as JSON: shared assets and state in the Core's storage directory, and Project assets in each project's `.aacl` directory.

```sh
npm run dev                      # Development server
npm run check                    # Type check, build, server tests
npx playwright install chromium  # First-time setup
npm run test:ui                  # Browser tests
```

Browser tests use port 4781 and temporary data. After the September 9, 2026 usability fixes, all 144 server tests and all 35 browser test cases were verified. Coverage includes README retention and restoration, MCP over npm stdio, name suggestions, prepared execution displays, standalone-export requests, and change history.

The current app supports local, single-user operation. A VS Code extension, dedicated desktop shell, multi-user management, and remote operation are not implemented. The Core validates operations that pass through it. The Runtime handles model invocation, external tools, and OS-level restrictions. Execution reports and estimated Context size alone do not establish an improvement in development quality.

Further documentation is currently in Japanese:

| Topic                                              | Document                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Onboarding, daily operation, restore, and export   | [Operating guide](docs/mcp-operations.md)                                          |
| Type contracts, proposals, and revision comparison | [Core contracts](docs/core-contracts.md)                                           |
| Current requirements                               | [Requirements v15](agent-asset-control-layer-requirements.md)                      |
| Implementation and verification scope              | [September 9 implementation report](docs/improvement-implementation-2026-09-09.md) |
| Skill, Workflow, model, and export design          | [Design notes](docs/skill-workflow-model-and-export-design.md)                     |

Licensed under the [Apache License 2.0](LICENSE).
