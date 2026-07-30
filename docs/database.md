# Database

PostgreSQL, accessed through Prisma. The schema is defined in
[`prisma/schema.prisma`](../prisma/schema.prisma); the reasoning behind its shape is in
[ADR 0002](./adr/0002-database-schema.md).

## Local setup

```bash
npm run db:up          # start Postgres (creates inboxly and inboxly_test)
npm run db:migrate     # apply migrations to the development database
npm run db:test:setup  # apply migrations to the integration-test database
```

`npm run db:studio` opens Prisma Studio. `npm run db:reset` drops and rebuilds the
development database.

## Entity relationships

```
User ──1:n──▶ Session
     ──1:1──▶ GoogleAccount
     ──1:1──▶ SyncCheckpoint
     ──1:n──▶ SyncRun
     ──1:n──▶ Email ──1:1──▶ EmailAnalysis
                     ──1:n──▶ AnalysisAttempt
```

Every user-scoped table carries `userId`, including `EmailAnalysis` and
`AnalysisAttempt` where it is denormalised. That is what lets repositories scope by user
in the `where` clause instead of joining to prove ownership — the mechanism that makes
cross-user access structurally impossible rather than merely unlikely (ADR 0008).

Deleting a `User` cascades to everything. `tests/schema.integration.test.ts` asserts
this, so a future model that is not reachable from a user will fail the test rather than
quietly leak rows.

## Tables

### `users`

Identity. `googleSubject` is Google's `sub` claim and is the lookup key at login: it
survives the user changing their email address, which `email` does not.

### `sessions`

Opaque server-side sessions. The cookie holds 256 bits of random token; this table holds
only its SHA-256 hash, so a database leak yields no usable sessions. `expiresAt` is an
absolute expiry, and deleting the row revokes immediately — the reason for choosing
database sessions over JWTs (ADR 0003).

### `google_accounts`

One per user. `accessTokenCiphertext` and `refreshTokenCiphertext` are AES-256-GCM
ciphertext with a version prefix; plaintext never leaves the account service.
`connectionStatus` drives the reconnect flow: `NEEDS_RECONNECT` is a normal state the
dashboard surfaces as a prompt, not an error. `scopes` records what Google actually
granted, which may be narrower than what was requested.

### `sync_checkpoints`

One mutable row per user answering "where should the next run start?". `phase` selects
backfill or incremental; `historyId` resumes incremental sync; `backfillPageToken`
resumes an interrupted backfill.

`historyId` is `text`, not `bigint`. Gmail's history ids are 64-bit, and we only ever
hand the value back to Gmail verbatim — never compare or do arithmetic on it — so text
avoids putting a `BigInt` across the JSON serialization boundary for no benefit.

### `sync_runs`

Append-only history of every synchronization attempt, with message counts, page counts,
API call counts, and duration. Feeds the dashboard's sync widgets and is the primary
signal for whether synchronization is healthy. Kept separate from `sync_checkpoints` so
history is immutable while resume state is a single mutable row.

### `emails`

The Gmail projection. `@@unique([userId, gmailMessageId])` is the natural key: every sync
write is an upsert on it, which is what makes synchronization idempotent by construction
rather than by bookkeeping (ADR 0004).

Deletes are soft (`deletedAt`), so a message removed from Gmail disappears from the
dashboard without destroying its analysis.

The processing lifecycle lives on this table — `processingStatus`,
`processingAttempts`, `processingLeaseUntil`, `processingError`, `processedAt` — because
the analysis queue _is_ the set of emails needing analysis. There is no separate job
table to drift out of agreement with it (ADR 0006).

`isImportant` is Gmail's own `IMPORTANT` label, kept deliberately distinct from the AI's
`urgency` judgement in `email_analyses`.

### `email_analyses`

The validated AI result, 1:1 with `emails`. Nothing reaches this table without passing
`EmailAnalysisSchema` first (ADR 0007).

The split between columns and `Json` is the interesting decision. Facets the dashboard
filters on — `category`, `urgency`, `sentiment`, `requiresResponse`, `confidence` — are
typed columns backed by indexes. Structures that are rendered but never filtered on by
individual leaf value — `actionItems`, `deadlines`, `meetingInformation`,
`extractedEntities` — are `Json`, each validated by Zod before it is written.

`schemaVersion` records which version of the analysis schema produced the row, so a
schema change can identify exactly which analyses need re-running. `providerId`, `model`,
token counts, and `latencyMs` make cost, latency, and model drift measurable.

### `analysis_attempts`

One row per AI call, successful or not. This is the audit trail that makes prompt
regressions diagnosable after the fact and validation failure rate measurable:

```sql
SELECT outcome, count(*)
FROM analysis_attempts
WHERE "createdAt" > now() - interval '1 day'
GROUP BY outcome;
```

`rawResponse` is the only place raw model output is persisted. It is truncated, used for
diagnostics only, and never returned to a client.

## Indexes

Indexes exist for queries the application actually runs, not speculatively.

| Index                                           | Serves                                               |
| ----------------------------------------------- | ---------------------------------------------------- |
| `emails(userId, receivedAt DESC)`               | The inbox page and every view built on it            |
| `emails(userId, processingStatus)`              | The atomic claim query in ADR 0006                   |
| `emails(userId, gmailThreadId)`                 | Grouping a conversation                              |
| `emails(userId, gmailMessageId)` unique         | The sync upsert's natural key                        |
| `emails USING GIN (searchVector)`               | Full-text search                                     |
| `email_analyses(userId, category)`              | The Meetings / Finance / Personal / Promotions views |
| `email_analyses(userId, urgency)`               | The Important view                                   |
| `email_analyses(userId, requiresResponse)`      | The Needs Reply view                                 |
| `sync_runs(userId, startedAt DESC)`             | "Last synchronization" widget                        |
| `analysis_attempts(userId, outcome, createdAt)` | Failure-rate queries                                 |
| `sessions(tokenHash)` unique                    | Session lookup on every authenticated request        |
| `sessions(expiresAt)`                           | Expired-session cleanup                              |

## Full-text search

`emails.searchVector` is a `tsvector` maintained by two database triggers, defined in
[`20260730051500_email_search_vector_trigger`](../prisma/migrations/20260730051500_email_search_vector_trigger/migration.sql).

The triggers, rather than application code, own this column for one reason: correctness
must not depend on which code path wrote the row. Sync upserts, label updates, analysis
writes, and a manual fix in `psql` all converge on the same definition.

Weighting reflects how people search their mail:

| Weight | Source                          |
| ------ | ------------------------------- |
| A      | Subject                         |
| B      | Sender display name and address |
| C      | AI summary                      |
| D      | Snippet                         |

Two details are worth knowing:

**The sender address is indexed twice.** Postgres's parser treats
`billing@acmecorp.test` as a single `email` lexeme, so searching for the domain or the
local part alone finds nothing. The trigger therefore also indexes the address with
`@ . _ - +` replaced by spaces, yielding `billing acmecorp test` as separate lexemes.
The original is kept so the full address still matches exactly. An integration test
covers both forms.

**The AI summary is folded in by a second trigger** on `email_analyses`, which updates
only `searchVector`. Because that column is not in the first trigger's column list, the
two triggers cannot recurse into each other.

Prisma cannot express `tsvector` operations, so the column is declared as
`Unsupported("tsvector")?` and searched through `$queryRaw`. Triggers are invisible to
Prisma's drift detection, so this arrangement does not fight future `prisma migrate dev`
runs.

## Migrations

Forward-only. `prisma migrate dev` during development, `prisma migrate deploy` on
deployment, both against the direct (unpooled) endpoint — a transaction pooler cannot
give a migration the session it needs. A destructive change is split into
expand → migrate data → contract across deployments, so a rollback never lands on a
schema the previous code cannot read. See ADR 0009.

## Prisma 7 notes

Prisma 7 requires a driver adapter and moves CLI configuration out of the schema:

- `prisma.config.ts` holds the datasource URL for the CLI, preferring
  `DIRECT_DATABASE_URL`. It reads `process.env` directly rather than through
  `src/lib/env.ts`, because the CLI must be able to run before the application's full
  configuration exists.
- The runtime connection is created in
  [`src/server/db/client.ts`](../src/server/db/client.ts) with `@prisma/adapter-pg`,
  capped at **one connection per instance**. Serverless scales by adding instances, so a
  large pool multiplied by the instance count is how connection limits get exhausted;
  concurrency comes from the pooler that `DATABASE_URL` points at.
- The client is generated into `src/generated/prisma`, which is not committed. It is
  produced by `postinstall` and by `npm run build`.
- Query logging is off by design: it would put email subjects and addresses into the
  logs.
