import {
  ConnectionStatus,
  ProcessingStatus,
  SyncPhase,
  SyncStatus,
  type SyncTrigger,
  db,
  type SyncCheckpointRow,
  type SyncRunRow,
} from '@/server/db';
import type { EmailProjection } from '../domain/message';

/**
 * Database access for synchronization.
 *
 * Every function takes `userId` and includes it in the `where` clause, so it is
 * structurally impossible for a sync run to read or write another user's mail.
 */

/* ─── Checkpoints ────────────────────────────────────────────────────────── */

export async function getCheckpoint(userId: string): Promise<SyncCheckpointRow | null> {
  return db.syncCheckpoint.findUnique({ where: { userId } });
}

/** Creates the checkpoint on first use. New mailboxes start in the backfill phase. */
export async function ensureCheckpoint(userId: string): Promise<SyncCheckpointRow> {
  return db.syncCheckpoint.upsert({
    where: { userId },
    create: { userId, phase: SyncPhase.BACKFILL },
    update: {},
  });
}

export interface CheckpointUpdate {
  readonly phase?: SyncPhase;
  readonly historyId?: string | null;
  readonly backfillPageToken?: string | null;
  readonly backfillMessagesSynced?: number;
  readonly backfillCompletedAt?: Date | null;
  readonly lastSyncedAt?: Date;
}

export async function updateCheckpoint(
  userId: string,
  update: CheckpointUpdate,
): Promise<void> {
  await db.syncCheckpoint.update({ where: { userId }, data: update });
}

/**
 * Resets a user to a full backfill.
 *
 * Called when Gmail rejects a stored history id as expired — routine after about a week
 * of inactivity, not a fault. The history id is cleared so the next run cannot try it
 * again.
 */
export async function resetToBackfill(userId: string): Promise<void> {
  await db.syncCheckpoint.update({
    where: { userId },
    data: {
      phase: SyncPhase.BACKFILL,
      historyId: null,
      backfillPageToken: null,
      backfillMessagesSynced: 0,
      backfillCompletedAt: null,
    },
  });
}

/* ─── Runs ───────────────────────────────────────────────────────────────── */

export async function startRun(
  userId: string,
  phase: SyncPhase,
  trigger: SyncTrigger,
): Promise<string> {
  const run = await db.syncRun.create({
    data: { userId, phase, trigger, status: SyncStatus.RUNNING },
    select: { id: true },
  });
  return run.id;
}

export interface RunMetrics {
  readonly messagesFetched: number;
  readonly messagesCreated: number;
  readonly messagesUpdated: number;
  readonly messagesDeleted: number;
  readonly pagesProcessed: number;
  readonly apiCalls: number;
}

export async function finishRun(
  runId: string,
  status: SyncStatus,
  metrics: RunMetrics,
  error: string | null,
): Promise<void> {
  await db.syncRun.update({
    where: { id: runId },
    data: { status, finishedAt: new Date(), ...metrics, error },
  });
}

export async function findLatestRun(userId: string): Promise<SyncRunRow | null> {
  return db.syncRun.findFirst({
    where: { userId },
    orderBy: { startedAt: 'desc' },
  });
}

/**
 * Marks runs abandoned when a previous invocation died before finishing.
 *
 * A run left RUNNING forever would make the dashboard claim a sync is in progress
 * indefinitely. This is bookkeeping only — the checkpoint is what actually resumes the
 * work, so nothing is lost.
 */
export async function abandonStaleRuns(
  userId: string,
  olderThan: Date,
): Promise<number> {
  const { count } = await db.syncRun.updateMany({
    where: { userId, status: SyncStatus.RUNNING, startedAt: { lt: olderThan } },
    data: {
      status: SyncStatus.FAILED,
      finishedAt: new Date(),
      error: 'Synchronization was interrupted and did not resume.',
    },
  });
  return count;
}

export async function countRunningRuns(userId: string): Promise<number> {
  return db.syncRun.count({ where: { userId, status: SyncStatus.RUNNING } });
}

/* ─── Message writes ─────────────────────────────────────────────────────── */

export interface UpsertResult {
  readonly created: number;
  readonly updated: number;
}

/**
 * Writes a batch of messages.
 *
 * The upsert on `(userId, gmailMessageId)` is what makes synchronization idempotent:
 * replaying a page after a crash converges on the same rows rather than duplicating them.
 *
 * Two details matter on the update path. `deletedAt` is cleared, because a message can be
 * restored from Trash and should reappear. The processing lifecycle is deliberately *not*
 * reset — re-fetching a message because its labels changed must not throw away a
 * completed AI analysis and re-run it.
 */
export async function upsertEmails(
  userId: string,
  projections: readonly EmailProjection[],
): Promise<UpsertResult> {
  if (projections.length === 0) return { created: 0, updated: 0 };

  const existing = await db.email.findMany({
    where: {
      userId,
      gmailMessageId: { in: projections.map((p) => p.gmailMessageId) },
    },
    select: { gmailMessageId: true },
  });
  const existingIds = new Set(existing.map((row) => row.gmailMessageId));

  // Sequential rather than concurrent: the pool is one connection per instance
  // (ADR 0009), so parallel writes would only queue behind each other.
  for (const projection of projections) {
    await db.email.upsert({
      where: {
        userId_gmailMessageId: {
          userId,
          gmailMessageId: projection.gmailMessageId,
        },
      },
      create: { userId, ...projection },
      update: {
        gmailThreadId: projection.gmailThreadId,
        subject: projection.subject,
        snippet: projection.snippet,
        bodyText: projection.bodyText,
        fromName: projection.fromName,
        fromEmail: projection.fromEmail,
        toEmails: projection.toEmails,
        ccEmails: projection.ccEmails,
        replyTo: projection.replyTo,
        receivedAt: projection.receivedAt,
        labels: projection.labels,
        isUnread: projection.isUnread,
        isStarred: projection.isStarred,
        isImportant: projection.isImportant,
        hasAttachments: projection.hasAttachments,
        sizeEstimate: projection.sizeEstimate,
        // Restores a message that was un-trashed in Gmail.
        deletedAt: null,
      },
    });
  }

  const created = projections.filter(
    (projection) => !existingIds.has(projection.gmailMessageId),
  ).length;

  return { created, updated: projections.length - created };
}

/**
 * Soft-deletes messages removed from Gmail.
 *
 * Soft rather than physical so that the analysis survives and foreign keys stay intact;
 * the dashboard filters on `deletedAt`. Already-deleted rows are excluded so the count
 * reflects actual changes.
 */
export async function softDeleteEmails(
  userId: string,
  gmailMessageIds: readonly string[],
  deletedAt: Date = new Date(),
): Promise<number> {
  if (gmailMessageIds.length === 0) return 0;

  const { count } = await db.email.updateMany({
    where: {
      userId,
      gmailMessageId: { in: [...gmailMessageIds] },
      deletedAt: null,
    },
    data: { deletedAt },
  });

  return count;
}

/** Counts messages waiting for AI analysis. Used to decide whether to trigger a run. */
export async function countPendingAnalysis(userId: string): Promise<number> {
  return db.email.count({
    where: {
      userId,
      deletedAt: null,
      processingStatus: {
        in: [ProcessingStatus.PENDING, ProcessingStatus.NEEDS_RETRY],
      },
    },
  });
}

/**
 * Users whose Gmail connection is healthy enough to synchronize.
 *
 * Accounts marked NEEDS_RECONNECT or DISCONNECTED are excluded: running them would fail
 * on every invocation and bury real failures in noise. They return once the user
 * reconnects.
 */
export async function findConnectedUserIds(limit: number): Promise<string[]> {
  const accounts = await db.googleAccount.findMany({
    where: { connectionStatus: ConnectionStatus.CONNECTED },
    select: { userId: true },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });

  return accounts.map((account) => account.userId);
}
