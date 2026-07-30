import { ProcessingStatus, db, type EmailRow } from '@/server/db';

/**
 * The analysis queue.
 *
 * There is no queue table — the queue *is* the set of emails whose `processingStatus` is
 * PENDING or NEEDS_RETRY. One source of truth, nothing to reconcile (ADR 0006).
 */

/** A claimed email, as the runner sees it. */
export type ClaimedEmail = EmailRow;

/**
 * Atomically claims a batch of emails for analysis.
 *
 * This is the whole concurrency-control story, and it is one statement.
 *
 * `FOR UPDATE SKIP LOCKED` makes a second runner step *over* rows the first has locked
 * rather than blocking on them, so two runners cannot claim the same email — and neither
 * one waits. The claim and the status update happen in the same statement, so there is no
 * window in which a row is selected but not yet marked.
 *
 * The predicate also reclaims rows whose lease has expired. A runner killed mid-analysis
 * leaves rows in PROCESSING with a lease in the past; the next run picks them up by the
 * same query that finds new work. No janitor, no cleanup cron.
 */
export async function claimEmailsForAnalysis(
  userId: string,
  limit: number,
  leaseMs: number,
  now: Date = new Date(),
): Promise<ClaimedEmail[]> {
  const leaseUntil = new Date(now.getTime() + leaseMs);

  // The raw statement does exactly one job — claim atomically — and returns only ids.
  // Hydration happens through the typed client below. Returning whole rows from
  // `$queryRaw` looks tempting but goes wrong quietly: the `searchVector` tsvector cannot
  // be deserialized at all, and `text[]` columns come back as null rather than as arrays.
  const claimed = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "emails" SET
      "processingStatus"     = ${ProcessingStatus.PROCESSING}::"ProcessingStatus",
      "processingLeaseUntil" = ${leaseUntil},
      "processingAttempts"   = "processingAttempts" + 1,
      "updatedAt"            = ${now}
    WHERE "id" IN (
      SELECT "id" FROM "emails"
      WHERE "userId" = ${userId}::uuid
        AND "deletedAt" IS NULL
        AND (
          "processingStatus" IN (
            ${ProcessingStatus.PENDING}::"ProcessingStatus",
            ${ProcessingStatus.NEEDS_RETRY}::"ProcessingStatus"
          )
          OR (
            "processingStatus" = ${ProcessingStatus.PROCESSING}::"ProcessingStatus"
            AND "processingLeaseUntil" < ${now}
          )
        )
      ORDER BY "receivedAt" DESC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `;

  if (claimed.length === 0) return [];

  return db.email.findMany({
    where: { id: { in: claimed.map((row) => row.id) } },
    orderBy: { receivedAt: 'desc' },
  });
}

/** Marks an email analysed. The lease is cleared so nothing can reclaim it. */
export async function markCompleted(
  emailId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.email.update({
    where: { id: emailId },
    data: {
      processingStatus: ProcessingStatus.COMPLETED,
      processingLeaseUntil: null,
      processingError: null,
      processedAt: now,
    },
  });
}

/**
 * Returns an email to the queue after a transient failure.
 *
 * `processingAttempts` was already incremented by the claim, so the budget is consumed
 * whether or not this path is reached — which is what stops a permanently failing email
 * from being retried forever.
 */
export async function markNeedsRetry(emailId: string, reason: string): Promise<void> {
  await db.email.update({
    where: { id: emailId },
    data: {
      processingStatus: ProcessingStatus.NEEDS_RETRY,
      processingLeaseUntil: null,
      processingError: reason,
    },
  });
}

/** Terminal failure. `processingError` is always a user-safe message. */
export async function markFailed(emailId: string, reason: string): Promise<void> {
  await db.email.update({
    where: { id: emailId },
    data: {
      processingStatus: ProcessingStatus.FAILED,
      processingLeaseUntil: null,
      processingError: reason,
    },
  });
}

/** Queue depth for the dashboard, and for deciding whether a run is worth starting. */
export async function countClaimable(
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  return db.email.count({
    where: {
      userId,
      deletedAt: null,
      OR: [
        {
          processingStatus: {
            in: [ProcessingStatus.PENDING, ProcessingStatus.NEEDS_RETRY],
          },
        },
        {
          processingStatus: ProcessingStatus.PROCESSING,
          processingLeaseUntil: { lt: now },
        },
      ],
    },
  });
}

/** Users with work waiting, so the cron runner knows whose mailboxes to visit. */
export async function findUserIdsWithPendingWork(limit: number): Promise<string[]> {
  const rows = await db.email.findMany({
    where: {
      deletedAt: null,
      processingStatus: {
        in: [ProcessingStatus.PENDING, ProcessingStatus.NEEDS_RETRY],
      },
    },
    select: { userId: true },
    distinct: ['userId'],
    take: limit,
  });

  return rows.map((row) => row.userId);
}

/** Puts failed emails back in the queue — for an operator retrying after a fix. */
export async function resetFailed(userId: string): Promise<number> {
  const { count } = await db.email.updateMany({
    where: { userId, processingStatus: ProcessingStatus.FAILED },
    data: {
      processingStatus: ProcessingStatus.PENDING,
      processingAttempts: 0,
      processingError: null,
      processingLeaseUntil: null,
    },
  });
  return count;
}
