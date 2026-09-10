# IPC Client Consolidation and Stable Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@/infrastructure/worker` the single typed Node entrypoint for the stable named-pipe protocol and remove the global service barrel.

**Architecture:** Preserve the existing newline-delimited JSON transport and protocol-v2 event validation, while exposing command requests, return events, error reporting, handoff, and typed platform commands through one infrastructure facade. Existing service implementations remain private compatibility seams during the migration.

**Tech Stack:** TypeScript, Node.js named pipes, Jest, pnpm.

**Spec:** `CSHARP_SERVICE_MIGRATION.md` (Phase 6: IPC Client Consolidation & Clean Architecture)

## Global Constraints

- Preserve stable protocol v2 event validation, newline framing, request correlation, retry/deadline behavior, and the 8,192-byte default.
- Keep existing public service behavior unchanged.
- Do not introduce a general-purpose shell or command-execution endpoint.
- Keep platform capability selection and fallback policy outside the transport facade.

### Task 1: Add the canonical worker infrastructure facade

**Files:**
- Create: `src/infrastructure/worker/index.ts`
- Create: `src/infrastructure/worker/worker-client.ts`
- Test: `tests/services/worker-client.spec.ts`

- [x] Write a failing test proving `WorkerClient` exposes typed request, command, error, handoff, and return-pipe capabilities.
- [x] Run the focused test and confirm the new module is missing.
- [x] Implement the smallest facade by composing the existing transport implementations and preserving their types.
- [x] Run the focused test and the existing worker transport tests.

### Task 2: Migrate Node callers to the infrastructure entrypoint

**Files:**
- Modify: callers currently importing `worker-command-pipe`, `worker-return-pipe`, `worker-error-pipe`, `worker-handoff`, or `platform-worker-client` from `src/services`.
- Test: existing worker, printer, scan, hotspot, and platform-client suites.

- [x] Replace source imports with `@/infrastructure/worker`.
- [x] Keep domain services importing only the capability they need from the facade.
- [x] Run typecheck and focused tests.

### Task 3: Remove the global service barrel

**Files:**
- Modify: remaining `from '@/services'` callers.
- Delete: `src/services/index.ts`.

- [x] Replace each barrel import with explicit service/module imports.
- [x] Run a repository search proving no source import references the barrel.
- [x] Run the complete Node verification suite; unrelated pre-existing failures remain documented in the handoff.

### Task 4: Refresh graph and review the change

- [x] Run `graphify update .`.
- [x] Review the diff for protocol, architecture, security, and performance regressions.
- [x] Run final typecheck, focused test, lint, build, and diff checks.
