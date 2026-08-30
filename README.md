# Agent Asset Control Layer

A local-first control layer for managing, resolving, and evolving AI development assets.

> **Status:** early-stage / design-driven implementation.

Agent Asset Control Layer is the **Core** of a private-first AI development environment. It acts as the source of truth for reusable AI development assets such as skills, rules, roles, workflows, policies, guardrails, templates, knowledge, and capability definitions.

The Core does not replace Claude Code, Codex, IDEs, MCP, or agent runtimes. Instead, it resolves **what a given runtime, role, model, project, and task should know and be allowed to do**, then exposes that result through stable interfaces.

## Goals

- Keep AI development assets in one source of truth.
- Resolve only the context required for the current project, task, workflow, role, runtime, and model.
- Make resolution deterministic and explainable.
- Separate workflow definitions from orchestration decisions and runtime execution.
- Record execution context so past runs can be inspected and understood.
- Improve assets over time through journals, diagnostics, review, and human-approved changes.
- Work locally first, while keeping a path to remote, multi-PC, and team use.

## Core concepts

### Assets

The Core manages reusable AI development assets, including:

- Skills
- Rules
- Roles
- Workflows
- Task types
- Routing and model policies
- Hooks / guardrail definitions
- Templates / examples / checklists
- Project knowledge
- Capabilities and MCP/tool bindings

A **Skill** is the common callable asset format exposed to runtimes. Internally, skills may have semantic kinds such as workflow launcher, standalone task, procedure, advisory, or system/meta.

### Context resolution

The resolver evaluates assets against dimensions such as:

- Project
- Workflow
- Task type
- Role
- Provider
- Runtime
- Model
- Directory

Resolution includes scope matching, mandatory policy evaluation, disable/override handling, priority and specificity, dependency validation, conflict handling, materialization, and explanation of why each asset was included or excluded.

### Workflow and orchestration

A workflow defines the possible stages, roles, transition constraints, and completion states.

An orchestrator is a **Role**, not a required monolithic skill. It owns decisions such as assignment, transition, retry, reject, fallback, and return paths. The Core owns workflow definitions/state and returns the information required to make those decisions. The agent runtime performs the actual model/tool/subagent execution.

### Learning loop

The intended improvement loop is:

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

Diagnostics detect and correlate signals; they do not autonomously rewrite important assets.

## Architecture boundary

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

This repository contains **the Core only**.

Out of scope for this repository:

- VS Code extension / workbench implementation
- Claude Code or Codex runtime implementation
- General-purpose agent runtime / scheduler
- GitHub project management implementation
- Secret storage or secret-manager replacement
- General-purpose MCP server replacement
- Generic team chat / project management

Provider/runtime adapters that translate the Core's canonical representation into runtime-facing forms may live here when they are part of the Core contract.

## Local-first

The first target is a **single-user Core service on localhost**.

This is intended to remove the need to separately synchronize the same AI assets between environments such as Windows and WSL. Clients should depend on a logical Core connection rather than on where the Core is physically hosted.

The architecture should remain compatible with later deployment modes:

```text
Phase 1: single-user localhost Core
Phase 2: single-user remote Core / multi-PC
Phase 3: multi-user team Core
```

Remote or team deployment must not become a requirement for local use.

## Initial implementation direction

Current direction:

- Core domain/service: TypeScript / Node.js
- Desktop Core UI shell: Tauri 2 with a TypeScript frontend
- Asset source of truth: human-readable filesystem files
- Revision backend: Git-compatible history abstraction
- Optional index/runtime storage: SQLite when useful
- Interfaces: local API and MCP-facing interface as appropriate

The Core domain must remain independent from the desktop shell, IDE clients, and provider/runtime-specific adapters.

Rust may be introduced later for stable system-boundary components such as high-reliability guardrail execution, process supervision, file watching, credential/keychain integration, and performance-sensitive paths.

## MVP philosophy

The MVP is not only a resolver prototype. It is intended to be a **single-user, localhost-based version that can be used in day-to-day AI development**.

Implementation can still proceed incrementally:

1. Canonical assets, resolver, preview, and Claude/Codex materialization
2. Workflow state, orchestration bridge contracts, runtime integration, and snapshots
3. History, journal, diagnostics, context-cost metrics, and the learning loop

Team sharing, multi-user access control, remote hosting, and additional providers are post-MVP concerns.

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
