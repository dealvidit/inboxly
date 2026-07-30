# Roadmap

Each milestone leaves the repository buildable, tested, and documented. Commits follow
[Conventional Commits](https://www.conventionalcommits.org/) and map to one logical
engineering step — never a batch of unrelated work.

| # | Milestone | Definition of done |
| --- | --- | --- |
| 0 | **Planning** | Architecture documented, ADRs written, folder structure and domain model agreed. |
| 1 | **Toolchain** | Next.js + TypeScript + Tailwind + ESLint + Prettier + Husky + Vitest. `npm run verify` green. Environment validated by Zod at startup. |
| 2 | **Database** | Prisma schema with all aggregates and indexes, migration committed, local Postgres via Docker, `docs/database.md`. |
| 3 | **Authentication** | Google OAuth with PKCE, opaque sessions, encrypted refresh tokens, lazy refresh, reconnect, logout, CSRF. Tests for crypto, sessions, and callback validation. |
| 4 | **Gmail sync** | Backfill + History API incremental sync, checkpoints, retries with backoff, quota handling, idempotent upserts, deletion and label updates, resumable runs. Fake-transport sync tests. |
| 5 | **AI pipeline** | `AiProvider` abstraction, Anthropic provider, prompt builder, Zod validation with corrective retry, attempt audit trail. Provider contract suite. |
| 6 | **Processing** | Full lifecycle with atomic claiming, stale-lease recovery, retry budget, batch runner invoked by cron and on demand. |
| 7 | **API** | tRPC routers for auth, emails, sync, analytics with search, filtering, sorting, pagination, rate limiting, CSRF. API tests through a server-side caller. |
| 8 | **Dashboard** | Seven widgets, seven views, email list and detail, reply generation, sync progress, responsive and accessible. |
| 9 | **Production readiness** | Structured logging, request logs, metrics, health endpoint, graceful shutdown, deployment guide, CI. |
| 10 | **Final review** | Staff-level review of the whole repository; stretch goals where they do not compromise the core. |

## Architectural checkpoints

Reviews happen at the end of milestones 0, 3, 4, 5, 8 and 10. Each checkpoint re-reads
the codebase against `docs/architecture.md`, refactors drift, removes dead code, updates
documentation and ADRs, and confirms the test suite passes.
