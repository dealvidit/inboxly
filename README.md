# Inboxly

AI-powered Gmail triage. Inboxly connects to Gmail over Google OAuth, synchronizes your
mailbox incrementally, analyses every message through a provider-agnostic AI layer whose
output is validated before it is allowed into the system, and presents the result as a
fast, filterable dashboard.

```
Gmail ──▶ incremental sync ──▶ PostgreSQL ──▶ AI analysis ──▶ Zod validation
                                                                   │
                            React dashboard ◀── tRPC ◀── typed domain model
```

## Status

Under active development. Progress is tracked in [`docs/roadmap.md`](./docs/roadmap.md).

- [x] Milestone 0 — architecture, domain model, ADRs
- [x] Milestone 1 — toolchain
- [x] Milestone 2 — database
- [x] Milestone 3 — authentication
- [x] Milestone 4 — Gmail synchronization
- [ ] Milestone 5 — AI pipeline
- [ ] Milestone 6 — processing lifecycle
- [ ] Milestone 7 — API
- [ ] Milestone 8 — dashboard
- [ ] Milestone 9 — production readiness
- [ ] Milestone 10 — final review

## Getting started

Requires Node 22+ and Docker.

```bash
git clone <repository-url> inboxly && cd inboxly
npm install
cp .env.example .env
```

Fill in `.env`. Three values need generating or fetching:

```bash
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -hex 24      # CRON_SECRET
```

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` come from the
[Google Cloud Console](https://console.cloud.google.com/apis/credentials): create an
OAuth 2.0 Client ID of type **Web application**, enable the **Gmail API** on the same
project, and add `http://localhost:3000/api/auth/callback/google` to the client's
authorised redirect URIs. `ANTHROPIC_API_KEY` comes from the
[Anthropic Console](https://console.anthropic.com/settings/keys).

Then bring up the database and the app:

```bash
npm run db:up          # Postgres in Docker (creates inboxly and inboxly_test)
npm run db:migrate     # apply migrations
npm run db:test:setup  # prepare the integration-test database
npm run dev
```

Open <http://localhost:3000> and sign in with Google.

### Commands

| Command              | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `npm run dev`        | Development server                                   |
| `npm run verify`     | Format, lint, typecheck, and test — what CI runs     |
| `npm test`           | Test suite (integration tests need Postgres running) |
| `npm run test:watch` | Tests in watch mode                                  |
| `npm run db:migrate` | Create and apply a migration                         |
| `npm run db:studio`  | Browse the database                                  |
| `npm run db:reset`   | Drop and rebuild the development database            |

## Stack

| Concern       | Choice                                                    |
| ------------- | --------------------------------------------------------- |
| Framework     | Next.js (App Router), React, TypeScript                   |
| Styling       | Tailwind CSS, shadcn/ui                                   |
| API           | tRPC                                                      |
| Data fetching | TanStack Query                                            |
| Database      | PostgreSQL via Prisma                                     |
| Validation    | Zod — schemas are the source of truth, types are inferred |
| AI            | Provider-agnostic; Anthropic by default                   |
| Email         | Gmail API with History-based incremental sync             |
| Hosting       | Vercel                                                    |

## Documentation

| Document                               | Contents                                                          |
| -------------------------------------- | ----------------------------------------------------------------- |
| [Architecture](./docs/architecture.md) | System overview, folder structure, dependency rules, domain model |
| [Roadmap](./docs/roadmap.md)           | Milestones and their definitions of done                          |
| [ADRs](./docs/adr)                     | Why the architecture is the way it is, and what was rejected      |

## Design principles

**Business logic never touches an SDK.** Gmail lives behind a transport interface,
Anthropic behind an `AiProvider` interface. Neither SDK may be imported outside its own
directory, and that rule is enforced by lint.

**AI output is untrusted input.** Every model response is parsed, validated against a Zod
schema, and retried with corrective prompting on failure. Invalid data is never persisted
and never reaches the UI. See [ADR 0007](./docs/adr/0007-typed-ai-pipeline.md).

**Synchronization is idempotent and resumable.** Every write is an upsert on a natural key,
and every run checkpoints its progress, so an interrupted sync resumes rather than
restarts. See [ADR 0004](./docs/adr/0004-gmail-synchronization.md).

**The queue is the database.** Emails needing analysis are found by querying for them, not
by maintaining a parallel job table. Concurrency safety comes from
`FOR UPDATE SKIP LOCKED`. See [ADR 0006](./docs/adr/0006-background-processing.md).

**Abstractions must earn their place.** Interfaces exist at three boundaries, each with a
second implementation or a genuine need to be faked in tests. Everywhere else, modules
depend on concrete modules.

## License

[MIT](./LICENSE)
