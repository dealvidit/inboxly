# Inboxly Architecture

This document describes the system as it is intended to be built and maintained. It is
the entry point for a new engineer joining the project; individual decisions and their
trade-offs live in [`docs/adr/`](./adr).

---

## 1. System overview

Inboxly is a single deployable Next.js application backed by PostgreSQL. It has three
runtime concerns:

1. **Request/response** — the dashboard (React Server Components + client islands) and
   the tRPC API, both served by Next.js.
2. **Gmail synchronization** — pulls messages from the Gmail API into our database,
   incrementally and idempotently.
3. **AI analysis** — turns raw messages into a validated, typed domain model.

```
                     ┌────────────────────────────────────────────┐
   Google OAuth ────▶ │  Next.js (App Router)                      │
                     │                                            │
   Gmail API   ◀────▶ │  ┌──────────┐  ┌─────────┐  ┌───────────┐  │
                     │  │ Dashboard │  │  tRPC   │  │  Route    │  │
   Anthropic   ◀────▶ │  │  (RSC)    │  │ router  │  │ handlers  │  │
                     │  └─────┬─────┘  └────┬────┘  └─────┬─────┘  │
                     │        └─────────────┬┴─────────────┘        │
                     │                 features/*                   │
                     │        (services · domain · repositories)    │
                     └────────────────────┬───────────────────────┘
                                          │ Prisma
                                   ┌──────▼───────┐
                                   │  PostgreSQL  │
                                   └──────────────┘
```

There is no separate worker process. Synchronization and analysis run as *cooperative
batch jobs* invoked either by a scheduled trigger (Vercel Cron) or by an authenticated
user action, and they persist their progress after every batch so they can be resumed by
the next invocation. See [ADR 0006](./adr/0006-background-processing.md).

---

## 2. Folder structure

```
src/
  app/                        Next.js App Router — routing and HTTP only
    (marketing)/              Unauthenticated landing page
    (dashboard)/              Authenticated application shell + views
    api/
      auth/google/            OAuth start + callback + logout
      trpc/[trpc]/            tRPC HTTP adapter
      health/                 Liveness/readiness probe
      jobs/                   Cron-triggered sync + analysis runners
  features/                   Vertical slices. The application lives here.
    auth/
    gmail/
    sync/
    ai/
    emails/
    analytics/
  server/                     Cross-cutting server infrastructure
    db/                       Prisma client singleton
    trpc/                     tRPC init, context, procedures, root router
    logger/                   Structured logging
    errors/                   Typed application errors
  lib/                        Small, dependency-free utilities
    env.ts                    Zod-validated environment
    crypto.ts                 Token encryption, hashing
  components/                 Presentational components shared across features
    ui/                       shadcn/ui primitives
```

### Rules of dependency

- `app/` may import from `features/`, `server/`, `lib/`, `components/`.
- `features/*` may import from `server/`, `lib/`, `components/`, and its own slice.
- A feature imports another feature **only through that feature's public surface**
  (its `index.ts`-style barrel of services and domain types), never its repositories.
- `server/` and `lib/` never import from `features/` or `app/`.
- Nothing outside `features/ai/providers/` may import an AI SDK.
- Nothing outside `features/gmail/client/` may import `googleapis`.

These rules keep business logic testable without HTTP, without Next.js, and without
network access.

### Anatomy of a feature slice

```
features/emails/
  domain/          Zod schemas + inferred types + pure domain functions
  repository/      Prisma queries. The only place raw Prisma appears.
  service/         Business logic. Depends on repositories and other services.
  router.ts        tRPC procedures — thin: validate, authorize, delegate.
  components/      React components for this feature
```

No `BaseService`, no `BaseRepository`, no generic `utils.ts`. Repositories are plain
modules of exported functions; services are plain modules or small classes that take
their collaborators as constructor arguments when they need to be substituted in tests.

---

## 3. Domain model

The domain is small and deliberately explicit.

| Aggregate | Purpose |
| --- | --- |
| `User` | A person who signed in with Google. |
| `Session` | An opaque server-side session. |
| `GoogleAccount` | OAuth credentials + Gmail connection state for a user. |
| `SyncRun` | One synchronization attempt, with metrics and outcome. |
| `SyncCheckpoint` | Durable resume point (Gmail `historyId` / page token). |
| `Email` | A Gmail message projected into our schema. |
| `EmailAnalysis` | The validated AI result for an email (1:1 with `Email`). |
| `AnalysisAttempt` | Audit trail of AI calls, including validation failures. |

`Email` carries a **processing lifecycle** (`PENDING → PROCESSING → COMPLETED | FAILED |
NEEDS_RETRY`) rather than a separate queue table, because the queue *is* the set of
emails needing analysis. See [ADR 0006](./adr/0006-background-processing.md).

Full schema documentation: [`docs/database.md`](./database.md).

---

## 4. Authentication flow

Hand-rolled OAuth 2.0 with PKCE, opaque database-backed sessions, and encrypted refresh
tokens. Rationale and alternatives: [ADR 0003](./adr/0003-authentication.md).

```
1.  GET  /api/auth/google/start
      → generate code_verifier + state, store both in short-lived signed cookies
      → 302 to Google with code_challenge, access_type=offline, prompt=consent
2.  GET  /api/auth/callback/google?code&state
      → verify state cookie matches query (CSRF)
      → exchange code + code_verifier for tokens
      → verify id_token, upsert User + GoogleAccount (refresh_token encrypted at rest)
      → create Session, set __Host-inboxly_session (HttpOnly, Secure, SameSite=Lax)
      → 302 to /dashboard
3.  POST /api/auth/logout
      → require CSRF token, revoke session row, clear cookies
```

Access tokens are refreshed lazily: the Gmail client asks the account service for a
valid access token, which refreshes and re-persists when the token is within its
expiry skew. A refresh failure marks the account `NEEDS_RECONNECT`, which the dashboard
surfaces as a reconnect prompt rather than a hard error.

---

## 5. Gmail synchronization

Two phases behind one entry point, `SyncService.run(userId)`:

- **Backfill** (first connection): `users.messages.list` paged with `pageToken`,
  bounded by a configurable message cap, hydrating each page with a batched
  `users.messages.get`. The page token is checkpointed after every page.
- **Incremental** (subsequent runs): `users.history.list` from the stored `historyId`,
  applying `messagesAdded`, `messagesDeleted`, and label changes. A `404`/expired
  history id degrades gracefully into a fresh backfill.

Idempotency comes from the database, not from bookkeeping: every write is an upsert
keyed on `(userId, gmailMessageId)`, and label/read-state changes are last-write-wins on
Gmail's own state. Reprocessing a page is therefore always safe.

Reliability: bounded exponential backoff with jitter, `Retry-After` respect, and a
distinction between *retryable* (429, 5xx, network) and *terminal* (401, 403 scope)
failures. Details: [ADR 0004](./adr/0004-gmail-synchronization.md).

---

## 6. AI architecture

Business logic depends on one interface:

```ts
interface AiProvider {
  readonly id: AiProviderId;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>>;
}
```

`StructuredRequest` carries a prompt, a Zod schema, and generation limits. The provider
is responsible for coaxing JSON out of a model; it is *not* responsible for trusting it.

The pipeline, applied to every email:

```
Email → PromptBuilder → AiProvider → raw text
      → JSON extraction → Zod parse
      → (on failure) corrective retry with the validation error in the prompt
      → EmailAnalysis (typed domain model) → PostgreSQL → tRPC → React
```

Invalid output never leaves the pipeline: it is logged to `AnalysisAttempt`, retried with
corrective prompting, and after the retry budget the email is marked `FAILED` with a
typed reason. The domain model contains no `any`, no raw provider payloads, and no
free-form strings where an enum will do. See [ADR 0005](./adr/0005-ai-provider-abstraction.md)
and [ADR 0007](./adr/0007-typed-ai-pipeline.md).

---

## 7. API architecture

tRPC v11 over a single route handler, with three procedure levels:

- `publicProcedure` — no session (health, auth status).
- `protectedProcedure` — requires a valid session; injects `ctx.user`.
- `mutationProcedure` — `protectedProcedure` + CSRF header check + rate limit.

Routers mirror features: `auth`, `emails`, `sync`, `analytics`. Every input and output is
a Zod schema; client types are inferred, never hand-written. See
[ADR 0008](./adr/0008-api-design.md).

---

## 8. Frontend architecture

- Server Components fetch the initial payload for each dashboard view directly through
  the service layer (no HTTP hop), then hydrate a client island.
- Client interactivity (filters, pagination, polling sync status, reply generation) uses
  TanStack Query through the tRPC client.
- Tailwind CSS v4 + shadcn/ui for primitives; every interactive element is reachable by
  keyboard and labelled for assistive technology.
- URL is the source of truth for view state (`?view=needs-reply&q=&page=`) so views are
  shareable and back/forward works.

---

## 9. Testing strategy

| Layer | Tool | What it covers |
| --- | --- | --- |
| Unit | Vitest | Domain functions, Zod schemas, backoff, crypto, prompt building |
| Contract | Vitest + fakes | `AiProvider` implementations against a shared suite |
| Integration | Vitest + Postgres | Repositories, sync idempotency, session lifecycle |
| API | Vitest + tRPC caller | Procedures with a real DB and fake Gmail/AI |
| UI | Vitest + Testing Library | Critical components and accessibility affordances |

Gmail and Anthropic are always faked in tests behind their own interfaces. Integration
tests run against a disposable Postgres database (`docker compose up db`).

---

## 10. Deployment

Vercel for the application, a managed Postgres for data, Vercel Cron for the scheduled
sync and analysis runners. Secrets live in the platform's encrypted store and are
validated at startup by `lib/env.ts`, which fails fast with an actionable message.
See [`docs/deployment.md`](./deployment.md) and
[ADR 0009](./adr/0009-deployment.md).
