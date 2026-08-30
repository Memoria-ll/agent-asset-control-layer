# Agent Asset Control Layer

A local-first control layer for managing, resolving, and evolving AI development assets.

> **Status:** early-stage. There is nothing to install yet — the MVP is being built in the open.
> See [Installation](#installation) for what will land and when.

## The problem

As AI-assisted development becomes part of everyday engineering, teams and individuals accumulate
reusable assets: skills, rules, roles, workflows, routing policies, guardrails, templates,
checklists, project knowledge, and tool bindings. Over time, three problems tend to appear.

**They fragment.** Assets become scattered across projects, machines, runtimes, and
provider-specific configuration formats. Equivalent instructions are duplicated, then gradually
drift apart.

**They load without enough context.** Assets are often applied as static configuration rather than
resolved for the current project, task, role, runtime, or model. This increases context cost and
makes it difficult to understand what actually influenced an execution.

**They rarely evolve systematically.** Useful observations from real executions are easy to lose,
and there is usually no structured path from execution evidence to reviewed, versioned asset
improvements.

## The idea

Keep AI development assets in a canonical source of truth, and make their application a
**resolution decision** rather than a configuration dump.

Agent Asset Control Layer resolves **what a given runtime, role, model, project, and task should
know and be allowed to do**, and explains why each asset was included, excluded, overridden, or
unavailable. Runtimes and development tools consume the resolved result through stable interfaces
instead of each owning a separate copy of the same knowledge and policy.

It does not replace an AI coding runtime, model provider, IDE, MCP implementation, or agent
framework. It provides the control layer that manages and resolves the assets those systems use.

### Principles

- **One source of truth.** Assets live in human-readable files that can be inspected, diffed, and edited directly.
- **Resolve, don't dump.** Apply the context and policy required by the current execution conditions.
- **Explainable.** Every inclusion, exclusion, override, and conflict should have an inspectable reason.
- **Local-first, private-first.** Local single-user operation is a first-class deployment model, not a degraded hosted mode.
- **Runtime-neutral.** The canonical representation is independent of any single provider or runtime format.
- **Human-approved evolution.** Diagnostics and reviews can propose changes, but important assets are not silently rewritten.

## What it does

### Manage assets

One canonical model covering skills, rules, roles, workflows, task types, routing and model
policies, guardrail definitions, templates and checklists, project knowledge, and capability /
MCP-tool bindings. A **Skill** is the common callable form exposed to runtimes; internally a skill
can be a workflow launcher, a standalone task, a procedure, advisory material, or system/meta.

### Resolve context

Assets are evaluated against the dimensions that vary between executions — project, workflow,
task type, role, provider, runtime, model, and directory — through scope matching, mandatory
policy evaluation, disable/override handling, priority and specificity, dependency validation,
and conflict handling. The result is materialized for the target runtime with resolution reasons
attached.

### Run workflows without a monolithic orchestrator

A workflow defines its stages, roles, transition constraints, and completion states. The
orchestrator is a **role**, not a required mega-skill: it owns assignment, transition, retry,
reject, fallback, and return decisions, while the Core owns the workflow definition and state and
returns the information those decisions need. Actual model and tool execution remains the
responsibility of the agent runtime.

### Record what happened

Execution context snapshots record which assets, revisions, scopes, runtime metadata, and
resolution decisions were active for an execution. This makes past context inspectable and
reconstructable without treating full model execution as reproducible.

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

Diagnostics detect, measure, correlate, and flag candidates. They do not autonomously rewrite
important assets.

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

The Core is designed to provide a consistent asset and resolution layer across development
environments. Local clients can share the same source of truth without maintaining independent
copies of runtime-specific configuration. A VS Code extension acts as a workbench, while an
MCP-facing interface exposes resolution capabilities to compatible agent runtimes.

## Installation

Not available yet. This section will carry the real steps once the MVP lands.

Planned shape:

- The **VS Code extension** as an everyday development entry point.
- The **Core service** running locally, with a desktop shell for asset management, preview, and history.
- Building from source in the meantime, once there is something to build.

Remote and team deployment are later phases and will not be required for local use:

```text
Phase 1: single-user local Core
Phase 2: single-user remote Core / multi-device use
Phase 3: multi-user team Core
```

## Built with

- Core domain and service: TypeScript / Node.js
- Desktop Core UI shell: Tauri 2 with a TypeScript frontend
- Asset source of truth: human-readable filesystem files
- Revision backend: a Git-compatible history abstraction
- Optional index / runtime storage: SQLite where it helps
- Interfaces: local service API and an MCP-facing interface

Rust may be introduced later for stable system-boundary components — high-reliability guardrail
execution, process supervision, file watching, credential/keychain integration, and
performance-sensitive paths.

## Roadmap

The MVP is intended to be a usable single-user local development system rather than a resolver
demo. It is being built in three passes:

1. Canonical assets, resolver, preview, and initial runtime materialization
2. Workflow state, orchestration bridge contracts, runtime integration, and snapshots
3. History, journal, diagnostics, context-cost metrics, and the learning loop

Initial runtime adapters target Claude Code and Codex. Team sharing, multi-user access control,
remote hosting, and additional providers/runtimes are post-MVP.

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
