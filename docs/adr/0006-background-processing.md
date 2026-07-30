# 0006. Database-backed processing lifecycle instead of a queue service

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

Every synchronized email must be analysed by AI. Analysis is slow (seconds), fails
transiently, and must never run twice for the same email or be lost when a process dies
mid-flight. The deployment target is Vercel: invocations are short-lived, and there is no
long-running process to host a worker loop.

## Problem

What runs the analysis work, and how is "this email still needs analysing" represented so
that interrupted processing resumes safely and never duplicates?

## Alternatives considered

**A hosted queue (SQS, QStash, Inngest, Trigger.dev).** The textbook answer, with retries,
visibility timeouts, and dead-letter queues for free. But it adds infrastructure, a vendor,
and — most importantly — a second source of truth. The queue's idea of what needs
processing can drift from the database's, and reconciling those two views is its own class
of bug. The work here is not high-throughput fan-out; it is "walk a bounded set of rows in
one Postgres table."

**A separate `analysis_jobs` table.** Keeps queue semantics in our own database, which
removes the vendor but not the duplication: a job row and an email row both claim to know
whether the email has been analysed, and every failure mode has to keep them agreed.

**In-process work immediately after sync, inline.** Simplest, and tempting. But analysis
time scales with the number of new emails, so a large sync blows the invocation budget,
and a timeout loses every in-flight email with no record of how far it got.

**Lifecycle state on the `emails` table, claimed atomically** (chosen). The queue _is_ the
set of emails whose status is `PENDING` or `NEEDS_RETRY`. One source of truth.

## Decision

`Email` carries its own lifecycle:

```
PENDING ──claim──▶ PROCESSING ──success──▶ COMPLETED
                        │
                        ├── transient failure, budget remains ──▶ NEEDS_RETRY ──▶ PENDING
                        ├── permanent failure or budget exhausted ──▶ FAILED
                        └── lease expires (process died) ──▶ NEEDS_RETRY
```

Supporting columns: `processingStatus`, `processingAttempts`, `processingLeaseUntil`,
`processingError`, `processedAt`.

**Claiming** is a single atomic statement using `FOR UPDATE SKIP LOCKED`:

```sql
UPDATE emails SET
  processing_status     = 'PROCESSING',
  processing_lease_until = now() + interval '5 minutes',
  processing_attempts   = processing_attempts + 1
WHERE id IN (
  SELECT id FROM emails
  WHERE user_id = $1
    AND deleted_at IS NULL
    AND (
      processing_status IN ('PENDING', 'NEEDS_RETRY')
      OR (processing_status = 'PROCESSING' AND processing_lease_until < now())
    )
  ORDER BY received_at DESC
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
RETURNING id;
```

Two concurrent runners therefore cannot claim the same email: `SKIP LOCKED` makes the
second runner step over locked rows instead of blocking on them. This is the whole
concurrency-control story, and it is one statement.

**Lease expiry** is what makes a dead process recoverable. A runner killed mid-analysis
leaves rows in `PROCESSING` with a lease in the past; the next run reclaims them by the
same predicate that picks up new work. No separate janitor, no cleanup cron.

**Batches are bounded** by both count (`ANALYSIS_BATCH_SIZE`) and a wall-clock budget
checked between emails, so a run always finishes cleanly and commits its progress before
the platform can kill it. Progress is per-email, so partial batches are never wasted.

**Retry budget** is `ANALYSIS_MAX_ATTEMPTS` (default 3). Transient failures return the
email to the queue with backoff; permanent failures (a validation failure that survived
corrective retry, an oversized email) go straight to `FAILED` with a typed reason rather
than burning the budget.

**Invocation** comes from two places, both calling the same service: a Vercel Cron hitting
`POST /api/jobs/analyze` (authenticated by a shared secret in a header), and an
authenticated user action from the dashboard. Nothing about the runner cares which.

## Trade-offs

Throughput is bounded by cron frequency and batch size rather than scaling elastically
with queue depth; for per-user mailbox triage this is comfortably sufficient, and the
knobs are configuration rather than code. We hand-roll leases and retry counting instead
of inheriting them from a queue — about eighty lines, and directly testable. Claiming adds
write load to the hot `emails` table, mitigated by the `(user_id, processing_status)`
index. Priority is limited to "newest first"; a real priority ordering would mean an
explicit column, which we would add when a requirement asks for it.

## Consequences

- No duplicate processing, guaranteed by the database rather than by convention.
- A crashed runner self-heals on the next invocation.
- Queue depth, failure counts, and average processing time are ordinary SQL queries — which
  is exactly what the dashboard widgets need.
- Moving to a hosted queue later would mean replacing the claim function, not the domain.
