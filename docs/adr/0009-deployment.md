# 0009. Deployment on Vercel with managed Postgres

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

PROJECT.md specifies Vercel. The application needs a Postgres database, scheduled
execution for synchronization and analysis, and secret management. Serverless functions are
short-lived and horizontally scaled, and connections to Postgres are a finite resource.

## Problem

What is the deployment topology, how does scheduled work run, and how do we avoid
exhausting database connections?

## Alternatives considered

**Container platform (Fly.io, Railway, Render).** Would allow a long-running worker
process, a simple in-process scheduler, and ordinary connection pooling. But it gives up
Vercel's preview deployments and edge network, and it is not the specified target. The
resumable-batch design (ADR 0006) removes the need for a long-lived process anyway.

**Vercel plus a self-managed Postgres on a VPS.** Cheaper at scale, more operational work,
and no pooler out of the box. Not a trade we want to make.

**Vercel plus managed Postgres with a connection pooler** (chosen).

## Decision

- **Application:** Vercel. `main` deploys to production; every pull request gets a preview
  deployment.
- **Database:** managed Postgres (Neon, Supabase, or Vercel Postgres — all equivalent for
  our purposes). Two URLs are configured: `DATABASE_URL` pointing at the **pooled**
  endpoint for application traffic, and `DIRECT_DATABASE_URL` pointing at the direct
  endpoint for migrations, which need a real session. This is the single most important
  detail for running Prisma on serverless; without it, connections exhaust under
  concurrency.
- **Prisma client** is a module-level singleton cached on `globalThis` in development to
  survive hot reloads, with `connection_limit=1` per instance on the pooled URL.
- **Migrations** run as a build step (`prisma migrate deploy`) against
  `DIRECT_DATABASE_URL`. Migrations are forward-only and additive where possible; a
  destructive change is split into expand → migrate data → contract across deployments so
  a rollback never lands on a schema that the previous code cannot read.
- **Scheduled work** uses Vercel Cron against `POST /api/jobs/sync` and
  `POST /api/jobs/analyze`, authenticated by a `CRON_SECRET` compared in constant time.
  These handlers are thin: authenticate, call the service, return metrics. Both are
  idempotent, so a duplicate or retried invocation is harmless.
- **Secrets** live in Vercel's encrypted environment variables. `lib/env.ts` validates
  every variable with Zod at module load, so a missing or malformed secret fails the boot
  with a message naming the variable rather than surfacing as a confusing runtime error.
- **Runtime** is Node.js, not Edge: Prisma and the Google/Anthropic SDKs need Node APIs.
- **Health** is exposed at `GET /api/health`, which checks database connectivity and
  reports version and uptime — suitable for an uptime monitor and for a deployment gate.
- **Graceful shutdown:** serverless functions are frozen rather than signalled, so the
  design guarantee is that no work is lost if an invocation ends abruptly — checkpoints and
  per-email commits (ADRs 0004, 0006) are that guarantee. A `SIGTERM` handler that
  disconnects Prisma is registered for the self-hosted and local cases, where it does
  apply.

## Trade-offs

Invocation time limits cap how much work one run can do, which is why every job is
resumable and budget-bounded. Cold starts add latency to infrequently hit routes. Vendor
coupling to Vercel is real but shallow — the application is a standard Next.js app, and the
cron handlers are ordinary authenticated POST endpoints that any scheduler can call.
Migrations during build mean a failed migration fails the deployment, which is the
behaviour we want.

## Consequences

- Preview deployments per pull request, with an isolated database branch where the provider
  supports it.
- Connection exhaustion is prevented by the pooled/direct URL split.
- Scheduled work is observable through `SyncRun` rows and structured logs.
- The application can be moved to any Node host by replacing cron with another scheduler.
