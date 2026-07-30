# 0004. Gmail synchronization strategy

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

Gmail exposes two ways to learn what changed: list messages and diff, or read the
per-mailbox change log via `users.history.list` from a known `historyId`. Quotas are
metered in units per user per second, `messages.get` is the expensive call, history ids
expire after roughly a week of inactivity, and synchronization must survive being killed
mid-run by a serverless timeout.

## Problem

How do we keep our projection of the mailbox current, cheaply, correctly, and resumably?

## Alternatives considered

**Full list-and-diff on every run.** Simple and self-correcting, but it costs one
`messages.list` page per 100 messages plus a `get` for anything we haven't seen, every
single run. For a large mailbox synchronized every few minutes this is both slow and a
quota problem, and it scales with mailbox size rather than with change volume.

**Gmail push notifications via Pub/Sub.** The lowest-latency option and what a mature
product would eventually run. It needs a Google Cloud Pub/Sub topic, a verified webhook
endpoint, subscription renewal every seven days, and a fallback path anyway for missed
notifications and expired watches. The pull-based history sync *is* that fallback path, so
it must exist regardless; push is a latency optimisation layered on top. We build the
foundation first and leave the door open.

**`historyId` polling via the History API** (chosen), with list-based backfill for the
first run and as the recovery path when a history id expires.

## Decision

One entry point, `SyncService.run(userId)`, with two phases selected by checkpoint state.

**Backfill** — first connection, or recovery from an expired history id:

- Page `users.messages.list` with `pageToken`, bounded by `SYNC_MAX_BACKFILL_MESSAGES`.
- Hydrate each page with `users.messages.get(format=metadata|full)` in batches, with
  bounded concurrency rather than one request at a time.
- Persist the page's messages and the next `pageToken` in the same transaction, so an
  interrupted backfill resumes at the page boundary.
- On completion, store the mailbox's current `historyId` as the incremental starting
  point.

**Incremental** — every subsequent run:

- `users.history.list(startHistoryId)`, paging through all history pages.
- Apply `messagesAdded` (upsert), `messagesDeleted` (soft delete), and
  `labelsAdded`/`labelsRemoved` (label and read-state update).
- Advance the checkpoint's `historyId` after each page.
- A `404` means the history id expired: log it, clear the checkpoint, and fall back to
  backfill. This is expected behaviour, not an error.

**Idempotency** is a property of the writes, not of bookkeeping. Every message write is
`upsert` on `(userId, gmailMessageId)`; label state is last-write-wins from Gmail, which
is the authority. Replaying a page therefore converges on the same result, so a crash
between the API call and the commit is harmless.

**Deletions** are soft (`deletedAt`) rather than physical, so a message removed from Gmail
disappears from the dashboard without destroying its analysis or breaking foreign keys.

**Reliability** is centralised in the Gmail client rather than sprinkled through the sync
logic:

- Retry on `429`, `5xx`, and transport errors; never on `4xx` that will not change.
- Exponential backoff with full jitter, capped, and honouring `Retry-After`.
- `401` triggers exactly one token refresh and one replay; a second `401` is terminal and
  marks the account `NEEDS_RECONNECT`.
- `403 insufficientPermissions` is terminal and also means reconnect, with a different
  message.
- A per-run wall-clock budget stops the run cleanly before the platform kills it, leaving
  a valid checkpoint for the next invocation.

Every run writes a `SyncRun` row with counts and duration, which feeds the dashboard's
sync widgets and gives us a metric to watch.

## Trace of a resumed run

```
run 1: backfill  pages 1..7   → killed at budget   → checkpoint {pageToken: "p8"}
run 2: backfill  pages 8..12  → complete           → checkpoint {historyId: 91422}
run 3: history   from 91422   → 3 added, 1 deleted → checkpoint {historyId: 91480}
run 4: history   from 91480   → 404 expired        → checkpoint cleared, backfill queued
```

## Trade-offs

Polling means change latency is bounded by the cron interval rather than being immediate;
acceptable for a triage dashboard, and push can be added later without touching the
apply logic. Soft deletes mean rows accumulate; a retention job can prune them later.
Capping the backfill means very large mailboxes are synchronized partially — a deliberate
product decision, surfaced in the UI, that keeps first-run cost predictable.

## Consequences

- Steady-state API cost scales with change volume, not mailbox size.
- Interrupted runs always resume from a valid checkpoint; no run is unbounded.
- Expired history ids self-heal.
- Sync logic is testable against a fake `GmailTransport` with no network access.
