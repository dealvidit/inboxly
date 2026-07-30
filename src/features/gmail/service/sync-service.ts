import { GoogleReauthRequiredError, googleAccountService } from '@/features/auth';
import { env } from '@/lib/env';
import { TimeBudget } from '@/lib/retry';
import { SyncPhase, SyncStatus, type SyncTrigger } from '@/server/db';
import { UnauthorizedError, toAppError } from '@/server/errors';
import { logger } from '@/server/logger';
import {
  GmailAuthorizationError,
  GmailHistoryExpiredError,
  GmailMessageNotFoundError,
  type GmailTransport,
} from '../client/gmail-transport';
import { createGmailHttpTransport } from '../client/gmail-http-transport';
import { fetchCount, reduceHistory } from '../domain/history';
import { toEmailProjection, type EmailProjection } from '../domain/message';
import * as repository from '../repository/sync-repository';

/**
 * The synchronization engine.
 *
 * One entry point, `run`, with two phases selected by the stored checkpoint. Every design
 * decision here serves one of two goals, and they are worth stating because they explain
 * the shape of the code:
 *
 *   **Idempotence** comes from the database, not from bookkeeping. Every message write is
 *   an upsert on `(userId, gmailMessageId)`, so replaying a page after a crash converges
 *   on the same result. Nothing needs to track what was already written.
 *
 *   **Resumability** comes from checkpointing after every page, and from a wall-clock
 *   budget checked between pages. A run always stops at a page boundary with a valid
 *   checkpoint, rather than being killed mid-write by the platform.
 *
 * See ADR 0004.
 */

const log = logger.child({ component: 'sync-service' });

/** Gmail's maximum for messages.list. Fewer pages means fewer API calls. */
const LIST_PAGE_SIZE = 100;

/**
 * How many message fetches run concurrently.
 *
 * Gmail meters quota per user per second, so unbounded concurrency buys rate-limit errors
 * rather than speed. Five is comfortably inside the per-user limit while still being far
 * faster than sequential fetching.
 */
const FETCH_CONCURRENCY = 5;

/** Reserved per page, so a run does not start a page it cannot finish. */
const PAGE_RESERVE_MS = 5000;

/** A run still RUNNING after this long belongs to an invocation that died. */
const STALE_RUN_MS = 15 * 60 * 1000;

export interface SyncResult {
  readonly runId: string;
  readonly phase: SyncPhase;
  readonly status: SyncStatus;
  readonly messagesFetched: number;
  readonly messagesCreated: number;
  readonly messagesUpdated: number;
  readonly messagesDeleted: number;
  readonly pagesProcessed: number;
  readonly apiCalls: number;
  /** True when the budget ran out with work remaining; the next run resumes. */
  readonly hasMoreWork: boolean;
  readonly error: string | null;
}

export interface SyncServiceDeps {
  /** Builds a transport for a user. Replaced with a fake mailbox in tests. */
  readonly createTransport?: (userId: string) => GmailTransport;
  readonly now?: () => Date;
  readonly timeBudgetMs?: number;
  readonly maxBackfillMessages?: number;
}

/** Mutable tally for one run. */
interface Metrics {
  messagesFetched: number;
  messagesCreated: number;
  messagesUpdated: number;
  messagesDeleted: number;
  pagesProcessed: number;
}

export function createSyncService(deps: SyncServiceDeps = {}) {
  const createTransport =
    deps.createTransport ??
    ((userId: string) =>
      createGmailHttpTransport({
        getAccessToken: () => googleAccountService.getAccessToken(userId),
      }));
  const now = deps.now ?? (() => new Date());
  const timeBudgetMs = deps.timeBudgetMs ?? env.SYNC_TIME_BUDGET_MS;
  const maxBackfillMessages =
    deps.maxBackfillMessages ?? env.SYNC_MAX_BACKFILL_MESSAGES;

  /**
   * Fetches messages with bounded concurrency, projecting each into our shape.
   *
   * A message that has disappeared between being listed and being fetched is reported as
   * deleted rather than failing the page — it is a normal race, not an error.
   */
  async function fetchMessages(
    transport: GmailTransport,
    userId: string,
    messageIds: readonly string[],
  ): Promise<{ projections: EmailProjection[]; missingIds: string[] }> {
    const projections: EmailProjection[] = [];
    const missingIds: string[] = [];
    const queue = [...messageIds];

    async function worker(): Promise<void> {
      for (;;) {
        const messageId = queue.shift();
        if (messageId === undefined) return;

        try {
          const message = await transport.getMessage(userId, messageId);
          projections.push(toEmailProjection(message, now()));
        } catch (error) {
          if (error instanceof GmailMessageNotFoundError) {
            missingIds.push(messageId);
            continue;
          }
          throw error;
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker),
    );

    return { projections, missingIds };
  }

  /**
   * Establishes the initial projection by paging messages.list.
   *
   * The page token is checkpointed after every page, so an interrupted backfill resumes
   * at the page boundary instead of starting over.
   */
  async function runBackfill(
    transport: GmailTransport,
    userId: string,
    budget: TimeBudget,
    metrics: Metrics,
  ): Promise<{ complete: boolean }> {
    const checkpoint = await repository.ensureCheckpoint(userId);
    let pageToken = checkpoint.backfillPageToken ?? undefined;
    let synced = checkpoint.backfillMessagesSynced;

    for (;;) {
      if (!budget.hasTimeRemaining(PAGE_RESERVE_MS)) {
        log.info('backfill paused at time budget', { userId, synced });
        return { complete: false };
      }

      if (synced >= maxBackfillMessages) {
        log.info('backfill reached the configured message cap', {
          userId,
          synced,
          cap: maxBackfillMessages,
        });
        break;
      }

      const remaining = maxBackfillMessages - synced;
      const page = await transport.listMessages(userId, {
        maxResults: Math.min(LIST_PAGE_SIZE, remaining),
        ...(pageToken === undefined ? {} : { pageToken }),
      });

      const { projections, missingIds } = await fetchMessages(
        transport,
        userId,
        page.messages.map((ref) => ref.id),
      );

      const { created, updated } = await repository.upsertEmails(userId, projections);
      metrics.messagesFetched += projections.length;
      metrics.messagesCreated += created;
      metrics.messagesUpdated += updated;
      metrics.messagesDeleted += await repository.softDeleteEmails(userId, missingIds);
      metrics.pagesProcessed += 1;
      synced += page.messages.length;

      pageToken = page.nextPageToken;

      // Committed before the next page is requested: this is the resume point.
      await repository.updateCheckpoint(userId, {
        backfillPageToken: pageToken ?? null,
        backfillMessagesSynced: synced,
      });

      if (!pageToken) break;
    }

    // The mailbox's current history id becomes the starting point for incremental sync.
    const profile = await transport.getProfile(userId);
    await repository.updateCheckpoint(userId, {
      phase: SyncPhase.INCREMENTAL,
      historyId: profile.historyId,
      backfillPageToken: null,
      backfillCompletedAt: now(),
    });

    log.info('backfill complete', { userId, synced });
    return { complete: true };
  }

  /**
   * Follows users.history.list from the stored history id.
   *
   * Label changes cause a re-fetch rather than a delta applied to our stored copy: Gmail
   * reports which labels changed, but the authoritative set lives on the message, and
   * applying deltas would drift permanently the moment one event were missed.
   */
  async function runIncremental(
    transport: GmailTransport,
    userId: string,
    startHistoryId: string,
    budget: TimeBudget,
    metrics: Metrics,
  ): Promise<{ complete: boolean }> {
    let pageToken: string | undefined;
    let historyId = startHistoryId;

    for (;;) {
      if (!budget.hasTimeRemaining(PAGE_RESERVE_MS)) {
        log.info('incremental sync paused at time budget', { userId, historyId });
        return { complete: false };
      }

      const page = await transport.listHistory(userId, {
        startHistoryId: historyId,
        ...(pageToken === undefined ? {} : { pageToken }),
      });

      const changes = reduceHistory(page);

      if (fetchCount(changes) > 0) {
        const { projections, missingIds } = await fetchMessages(transport, userId, [
          ...changes.addedMessageIds,
          ...changes.labelChangedMessageIds,
        ]);

        const { created, updated } = await repository.upsertEmails(userId, projections);
        metrics.messagesFetched += projections.length;
        metrics.messagesCreated += created;
        metrics.messagesUpdated += updated;
        metrics.messagesDeleted += await repository.softDeleteEmails(
          userId,
          missingIds,
        );
      }

      metrics.messagesDeleted += await repository.softDeleteEmails(
        userId,
        changes.deletedMessageIds,
      );
      metrics.pagesProcessed += 1;

      pageToken = page.nextPageToken;

      if (pageToken) {
        // More pages to come: keep the same startHistoryId and page through.
        continue;
      }

      // Last page: advance the checkpoint to the mailbox's current history id.
      if (page.historyId) {
        historyId = page.historyId;
        await repository.updateCheckpoint(userId, { historyId });
      }
      break;
    }

    return { complete: true };
  }

  return {
    /**
     * Synchronizes one user's mailbox.
     *
     * Always returns a result rather than throwing for expected conditions — a needed
     * reconnect, an exhausted budget, an expired history id — because all three are
     * states the dashboard renders, not failures. Genuine faults are recorded on the run
     * and rethrown as typed errors.
     */
    async run(userId: string, trigger: SyncTrigger): Promise<SyncResult> {
      const runLog = log.child({ userId, trigger });

      await repository.abandonStaleRuns(
        userId,
        new Date(now().getTime() - STALE_RUN_MS),
      );

      const checkpoint = await repository.ensureCheckpoint(userId);
      const transport = createTransport(userId);
      const budget = new TimeBudget(timeBudgetMs, () => now().getTime());

      const metrics: Metrics = {
        messagesFetched: 0,
        messagesCreated: 0,
        messagesUpdated: 0,
        messagesDeleted: 0,
        pagesProcessed: 0,
      };

      // Incremental only when a backfill has completed and left a history id behind.
      const phase =
        checkpoint.phase === SyncPhase.INCREMENTAL && checkpoint.historyId
          ? SyncPhase.INCREMENTAL
          : SyncPhase.BACKFILL;

      const runId = await repository.startRun(userId, phase, trigger);
      runLog.info('sync started', { runId, phase });

      try {
        let complete: boolean;

        if (phase === SyncPhase.INCREMENTAL && checkpoint.historyId) {
          try {
            ({ complete } = await runIncremental(
              transport,
              userId,
              checkpoint.historyId,
              budget,
              metrics,
            ));
          } catch (error) {
            if (!(error instanceof GmailHistoryExpiredError)) throw error;

            // Expected after about a week of inactivity. Recover by starting over rather
            // than reporting a failure the user can do nothing about.
            runLog.info('history id expired; falling back to backfill', { runId });
            await repository.resetToBackfill(userId);
            ({ complete } = await runBackfill(transport, userId, budget, metrics));
          }
        } else {
          ({ complete } = await runBackfill(transport, userId, budget, metrics));
        }

        await repository.updateCheckpoint(userId, { lastSyncedAt: now() });

        const status = complete ? SyncStatus.COMPLETED : SyncStatus.PARTIAL;
        const runMetrics = { ...metrics, apiCalls: transport.callCount };
        await repository.finishRun(runId, status, runMetrics, null);

        runLog.info('sync finished', { runId, status, ...runMetrics });

        return {
          runId,
          phase,
          status,
          ...runMetrics,
          hasMoreWork: !complete,
          error: null,
        };
      } catch (caught) {
        const error = toAppError(caught);
        const needsReconnect =
          caught instanceof GmailAuthorizationError ||
          caught instanceof GoogleReauthRequiredError;

        if (needsReconnect) {
          await googleAccountService.markNeedsReconnect(userId, error.userMessage);
        }

        const runMetrics = { ...metrics, apiCalls: transport.callCount };
        await repository.finishRun(
          runId,
          SyncStatus.FAILED,
          runMetrics,
          error.userMessage,
        );

        // Logged at warn for a reconnect — it is a user action, not an incident.
        if (needsReconnect) {
          runLog.warn('sync stopped: reconnection required', { runId });
        } else {
          runLog.error('sync failed', caught, { runId });
        }

        return {
          runId,
          phase,
          status: SyncStatus.FAILED,
          ...runMetrics,
          hasMoreWork: true,
          error: error.userMessage,
        };
      }
    },

    /** Whether a run is currently in progress, for the dashboard's sync widget. */
    async isRunning(userId: string): Promise<boolean> {
      return (await repository.countRunningRuns(userId)) > 0;
    },

    async getLatestRun(userId: string) {
      return repository.findLatestRun(userId);
    },

    async getCheckpoint(userId: string) {
      return repository.getCheckpoint(userId);
    },
  };
}

export type SyncService = ReturnType<typeof createSyncService>;

export const syncService = createSyncService();

/** Re-exported so callers can distinguish "reconnect" without importing the client. */
export { GmailAuthorizationError, UnauthorizedError };
