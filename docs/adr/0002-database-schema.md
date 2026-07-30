# 0002. Database schema and Prisma as the data access layer

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

We store users, OAuth credentials, synchronization state, a projection of Gmail messages,
and the AI analysis of each message. Reads are dominated by one query shape: "page
through this user's emails, filtered by view/category/urgency, optionally matching a
search term, sorted by date." Writes are dominated by idempotent upserts from
synchronization.

## Problem

What schema keeps that read path fast, makes synchronization idempotent by construction,
and lets the AI lifecycle be driven without a separate queue?

## Alternatives considered

**One wide `emails` table with analysis columns inlined.** Fewer joins, and the hot query
becomes a single table scan. But analysis is optional, is rewritten independently of the
message, and has its own lifecycle and audit trail; inlining it means the message row is
updated on every AI attempt and every column is nullable. It also makes "delete all
analyses and re-run" a destructive migration instead of a delete.

**Storing AI output as a single `jsonb` column.** Flexible and cheap to evolve. But
filtering by category or urgency — a core dashboard requirement — then depends on
expression indexes over JSON, and the schema stops documenting itself. We use `jsonb`
only for genuinely open-ended nested structures (action items, entities, meeting details)
where we never filter on individual leaf values, and we keep the fields we filter and
sort on as real typed columns.

**A dedicated `analysis_jobs` queue table.** Explicit, but it duplicates state that
already exists: an email needing analysis *is* the queue. Two sources of truth means
reconciliation bugs. See ADR 0006.

**Drizzle instead of Prisma.** Attractive for its SQL-first ergonomics, but PROJECT.md
specifies Prisma, and Prisma's migration tooling and generated client are a better fit
for a codebase whose emphasis is explicitness and developer experience.

## Decision

Prisma over PostgreSQL, with these aggregates:

- `User` — identity.
- `Session` — opaque server-side sessions; the cookie holds a random token, the row holds
  its SHA-256 hash.
- `GoogleAccount` — one per user; encrypted `refreshToken`, plaintext-but-short-lived
  `accessToken`, granted scopes, and a `connectionStatus` enum driving the reconnect flow.
- `Email` — the Gmail projection, unique on `(userId, gmailMessageId)`, carrying the
  processing lifecycle (`processingStatus`, `processingAttempts`, `processingLeaseUntil`).
- `EmailAnalysis` — 1:1 with `Email`. Filterable facets (`category`, `urgency`,
  `sentiment`, `requiresResponse`, `confidence`) are typed columns; `actionItems`,
  `deadlines`, `meetingInformation`, and `extractedEntities` are validated `jsonb`.
- `SyncRun` — one synchronization attempt with metrics, for observability and the
  dashboard's "last sync" widget.
- `SyncCheckpoint` — one row per user; the durable resume point.
- `AnalysisAttempt` — every AI call, including failures and the validation error, so
  prompt regressions are diagnosable after the fact.

Indexes are added for the queries we actually run, not speculatively:
`(userId, receivedAt desc)` for the inbox page, `(userId, processingStatus)` for the
claim query, and a GIN index over a generated `tsvector` of subject, sender, snippet, and
AI summary for search.

Repositories are the only modules importing Prisma. They return domain types, not Prisma
models, so a storage change does not ripple into services.

## Trade-offs

Splitting `EmailAnalysis` from `Email` costs a join on the hot path; we accept it because
the join is on an indexed primary key and the clarity is worth more than the microseconds.
Storing filterable facets as columns means adding a facet requires a migration; we accept
that, because a migration is exactly the right amount of friction for changing the shape
of the domain. Postgres full-text search is less capable than a dedicated search engine;
we accept it because it removes an entire piece of infrastructure and comfortably handles
per-user corpora of this size.

## Consequences

- Synchronization is idempotent because every write is an upsert on a natural key.
- The dashboard's filters map directly onto indexed columns.
- Re-running analysis for a user is a `DELETE FROM email_analyses` plus a status reset.
- AI failures are diagnosable from the database alone.
