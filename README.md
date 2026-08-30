# Agent Asset Control Layer

A local-first control layer for managing, resolving, and evolving AI development assets.

> **Status:** early-stage. There is nothing to install yet — the MVP is being built in the open.
> See [Installation](#installation) for what will land and when.

## The problem

If you work with AI coding agents seriously, you accumulate assets: skills, rules, roles,
workflows, routing policies, guardrails, templates, checklists, project knowledge. Three things
then go wrong at the same time.

**They fragment.** The same rule exists in `~/.claude` on Windows, again under WSL, again in
another runtime's config format, and the copies drift.

**They load wholesale.** Every session pays for every asset, whether or not the current project,
task, role, or model has any use for it — and you cannot tell which ones actually applied.

**They never improve.** You notice friction mid-task, and the observation dies with the session.

## The idea

Keep the assets in one place, and make loading them a **decision** rather than a dump.

Agent Asset Control Layer holds your AI development assets as the source of truth, then resolves
**what a given runtime, role, model, project, and task should know and be allowed to do** — and
tells you why each asset was included or excluded. Runtimes consume the resolved result through
stable interfaces instead of reading your config directories directly.

It does not replace Claude Code, Codex, your IDE, MCP, or an agent runtime. It decides what they
should be given.

### Principles

- **One source of truth.** Assets live in human-readable files you can read, diff, and edit by hand.
- **Resolve, don't dump.** Only the context the current situation calls for.
- **Explainable.** Every inclusion and exclusion has a reason you can inspect.
- **Local-first, private-first.** A single-user localhost service is the primary target, not a
  degraded mode of something hosted.
- **Runtime-neutral.** The canonical representation is not any one vendor's format.
- **Human-approved evolution.** Diagnostics propose; they do not rewrite your assets behind your back.

## What it does

### Manage assets

One canonical model covering skills, rules, roles, workflows, task types, routing and model
policies, guardrail definitions, templates and checklists, project knowledge, and capability /
MCP-tool bindings. A **Skill** is the common callable format runtimes see; internally a skill can
be a workflow launcher, a standalone task, a procedure, advisory material, or system/meta.

### Resolve context

Assets are evaluated against the dimensions that actually vary — project, workflow, task type,
role, provider, runtime, model, directory — through scope matching, mandatory policy evaluation,
disable/override handling, priority and specificity, dependency validation, and conflict handling.
The result is materialized for the target runtime, with an explanation attached.

### Run workflows without a monolithic orchestrator

A workflow defines its stages, roles, transition constraints, and completion states. The
orchestrator is a **role**, not a required mega-skill: it owns assignment, transition, retry,
reject, fallback, and return decisions, while the Core owns the workflow definition and state and
returns the information those decisions need. Actual model and tool execution stays in the agent
runtime.

### Record what happened

Execution context snapshots let a past run be inspected and reconstructed, instead of being
reconstructed from memory.

### Close the loop

```text
Assets
  -> Context Resolution
  -> Execution
  -> Execution Snapshot
  -> Journal
  -> Diagnostics
  -> Journal Review
  -> Improvement Proposal
  -> Human Approval
  -> Versioned Asset Update
```

Diagnostics detect and correlate signals. They do not autonomously rewrite important assets.

### Reach it from where you work

```text
                Agent Asset Control Layer
                       Core Service
                           |
          +----------------+----------------+
          |                |                |
     Core UI          MCP interface      Core API
                                           |
                                  Runtime / IDE clients
```

The Core runs on localhost and is reached the same way from Windows and WSL, so the same assets
stop needing to be synchronized between environments. A VS Code extension acts as the workbench;
an MCP-facing interface exposes resolution to agent runtimes.

## Installation

Not available yet. This section will carry the real steps once the MVP lands.

Planned shape:

- The **VS Code extension** as the everyday entry point.
- The **Core service** running locally alongside it, with a desktop shell for asset management,
  preview, and history.
- Building from source in the meantime, once there is something to build.

Remote and team deployment are later phases and will never be required for local use:

```text
Phase 1: single-user localhost Core
Phase 2: single-user remote Core / multi-PC
Phase 3: multi-user team Core
```

## Built with

- Core domain and service: TypeScript / Node.js
- Desktop Core UI shell: Tauri 2 with a TypeScript frontend
- Asset source of truth: human-readable filesystem files
- Revision backend: a Git-compatible history abstraction
- Optional index / runtime storage: SQLite where it helps
- Interfaces: a local API and an MCP-facing interface

Rust may be introduced later for stable system-boundary components — high-reliability guardrail
execution, process supervision, file watching, credential/keychain integration, and
performance-sensitive paths.

## Roadmap

The MVP is not a resolver demo. It is a single-user, localhost version usable for day-to-day AI
development. It is being built in three passes:

1. Canonical assets, resolver, preview, and Claude/Codex materialization
2. Workflow state, orchestration bridge contracts, runtime integration, and snapshots
3. History, journal, diagnostics, context-cost metrics, and the learning loop

Team sharing, multi-user access control, remote hosting, and additional providers are post-MVP.

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
