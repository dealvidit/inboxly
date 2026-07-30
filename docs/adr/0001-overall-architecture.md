# 0001. Overall architecture: modular monolith in Next.js

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

Inboxly has a browser dashboard, an HTTP API, two integrations that must be called from
trusted server code (Gmail, Anthropic), and recurring background work. The specified
stack is Next.js, tRPC, Prisma, PostgreSQL, deployed on Vercel. One engineer owns the
codebase today; the code should read as if a team will own it tomorrow.

## Problem

How should the codebase be decomposed so that business logic stays independent of
Next.js, Gmail, and Anthropic — while still being a single, simple deployment?

## Alternatives considered

**Layered by technical role** (`controllers/`, `services/`, `repositories/`,
`models/`). Familiar, but every feature is smeared across four directories. Changing
"how emails are searched" touches four folders and gives no locality. It also invites
`BaseService`/`BaseRepository` inheritance, which CLAUDE.md explicitly rejects.

**Separate backend service plus a thin Next.js frontend.** Cleanly enforces the boundary
and would let sync run as a long-lived worker. But it doubles the deployment surface,
gives up tRPC's zero-cost end-to-end inference across the boundary, and is
overengineering for a single-database application with modest traffic. Vercel Cron plus
resumable batch jobs covers the background need without a second service.

**Hexagonal architecture with full port/adapter ceremony everywhere.** Correct in
principle and largely what we want at the _integration_ boundaries, but applying it
uniformly means an interface for every collaborator, including ones with exactly one
implementation and no test-substitution need. That is abstraction without a problem to
solve.

**Feature-sliced modular monolith** (chosen). Vertical slices with explicit dependency
rules, and ports only where a real boundary exists.

## Decision

A modular monolith organised into vertical feature slices under `src/features/`, with
cross-cutting infrastructure under `src/server/` and `src/lib/`. `src/app/` is treated as
a delivery mechanism: routing, HTTP concerns, and rendering only — never business logic.

Each slice owns `domain/` (Zod schemas, inferred types, pure functions), `repository/`
(the only place Prisma appears), `service/` (business logic), `router.ts` (thin tRPC
procedures), and `components/`.

Interfaces are introduced at exactly three boundaries, each of which has a real second
implementation or a real need to fake it in tests:

1. `AiProvider` — Anthropic today, others later (ADR 0005).
2. `GmailTransport` — the real Gmail API, and a fake used by sync tests (ADR 0004).
3. `Clock` / `RateLimiter` — small seams that make time-dependent logic testable.

Everywhere else, modules depend on concrete modules.

## Trade-offs

We accept that the dependency rules are enforced by lint configuration and review rather
than by the compiler or by package boundaries; a determined shortcut can still import a
repository from another slice. We accept that background work is bounded by serverless
invocation limits, which is why sync and analysis are designed as resumable batches
rather than long-running loops. We give up the ability to scale the API independently of
the dashboard, which is not a constraint at this scale.

## Consequences

- Business logic can be unit tested without Next.js, HTTP, a browser, or network access.
- Swapping Anthropic for another provider touches one directory.
- Moving to a dedicated worker later means calling the existing service entry points from
  a new process — no business logic changes.
- New engineers can find everything about a feature in one directory.
