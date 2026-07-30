import { createEmailAnalyzer, aiProvider, type EmailAnalyzer } from '@/features/ai';
import {
  recordAttempts,
  saveAnalysis,
} from '@/features/ai/repository/analysis-repository';
import type { EmailProjection } from '@/features/gmail';
import { env } from '@/lib/env';
import { TimeBudget } from '@/lib/retry';
import type { ClaimedEmail } from '../repository/queue-repository';
import { logger } from '@/server/logger';
import * as queue from '../repository/queue-repository';

/**
 * The analysis runner.
 *
 * Claims a bounded batch, analyses each email, and commits per email so that a run killed
 * part-way through keeps everything it finished. Bounded by both a batch size and a
 * wall-clock budget, so a run always stops cleanly rather than being terminated
 * mid-write (ADR 0006).
 */

const log = logger.child({ component: 'analysis-runner' });

/** Reserved per email so a run does not start work it cannot finish. */
const EMAIL_RESERVE_MS = 8000;

export interface AnalysisRunResult {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly retrying: number;
  /** True when the batch or the budget filled up and work remains. */
  readonly hasMoreWork: boolean;
}

export interface AnalysisRunnerDeps {
  readonly analyzer?: EmailAnalyzer;
  readonly now?: () => Date;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly leaseMs?: number;
  readonly timeBudgetMs?: number;
}

export function createAnalysisRunner(deps: AnalysisRunnerDeps = {}) {
  const analyzer = deps.analyzer ?? createEmailAnalyzer({ provider: aiProvider() });
  const now = deps.now ?? (() => new Date());
  const batchSize = deps.batchSize ?? env.ANALYSIS_BATCH_SIZE;
  const maxAttempts = deps.maxAttempts ?? env.ANALYSIS_MAX_ATTEMPTS;
  const leaseMs = deps.leaseMs ?? env.ANALYSIS_LEASE_MS;
  const timeBudgetMs = deps.timeBudgetMs ?? env.ANALYSIS_TIME_BUDGET_MS;

  return {
    /** Runs one bounded batch for a user. */
    async run(userId: string): Promise<AnalysisRunResult> {
      const runLog = log.child({ userId });
      const budget = new TimeBudget(timeBudgetMs, () => now().getTime());

      const claimed = await queue.claimEmailsForAnalysis(
        userId,
        batchSize,
        leaseMs,
        now(),
      );

      if (claimed.length === 0) {
        return { claimed: 0, completed: 0, failed: 0, retrying: 0, hasMoreWork: false };
      }

      runLog.info('analysis batch claimed', { count: claimed.length });

      let completed = 0;
      let failed = 0;
      let retrying = 0;
      let stoppedEarly = false;

      for (const [index, email] of claimed.entries()) {
        if (!budget.hasTimeRemaining(EMAIL_RESERVE_MS)) {
          // Release the rest of the batch immediately rather than leaving them leased
          // until expiry — the next invocation can pick them up straight away.
          await queue.markNeedsRetry(email.id, 'Deferred to the next run.');
          retrying += 1;
          stoppedEarly = true;
          continue;
        }

        const outcome = await analyseOne(email, maxAttempts);
        if (outcome === 'completed') completed += 1;
        else if (outcome === 'failed') failed += 1;
        else retrying += 1; // 'retry' and 'fatal' both leave the email queued

        if (outcome === 'fatal') {
          // The failure is a property of the deployment, not of this email — a bad API
          // key, say. Every remaining email would fail identically, so release them
          // untouched rather than burning each one's retry budget on the same fault.
          //
          // Releasing explicitly rather than letting the lease lapse matters: a lease
          // runs for minutes, and the operator who fixes the key wants the next run to
          // pick the work up immediately.
          const remaining = claimed.slice(index + 1);
          for (const deferred of remaining) {
            await queue.markNeedsRetry(
              deferred.id,
              'Deferred: AI analysis is unavailable.',
            );
          }
          retrying += remaining.length;

          runLog.error(
            'stopping batch: AI analysis is misconfigured',
            new Error('provider authentication failed'),
            { released: remaining.length },
          );
          stoppedEarly = true;
          break;
        }
      }

      const result: AnalysisRunResult = {
        claimed: claimed.length,
        completed,
        failed,
        retrying,
        hasMoreWork: stoppedEarly || claimed.length === batchSize,
      };

      runLog.info('analysis batch finished', { ...result });
      return result;
    },

    async queueDepth(userId: string): Promise<number> {
      return queue.countClaimable(userId, now());
    },
  };

  /**
   * Analyses one email and records the outcome.
   *
   * Attempts are written before the status changes, so a failure is always diagnosable
   * even if the status write is the thing that fails.
   */
  async function analyseOne(
    email: ClaimedEmail,
    attemptBudget: number,
  ): Promise<'completed' | 'failed' | 'retry' | 'fatal'> {
    const result = await analyzer.analyze(toProjection(email));

    await recordAttempts(email.id, email.userId, result.attempts);

    if (result.ok) {
      await saveAnalysis({
        emailId: email.id,
        userId: email.userId,
        analysis: result.analysis,
        schemaVersion: result.schemaVersion,
        providerId: result.providerId,
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        latencyMs: result.latencyMs,
      });
      await queue.markCompleted(email.id, now());
      return 'completed';
    }

    // A deployment-level fault must not consume this email's retry budget: the email is
    // fine, the configuration is not. Return it to the queue and let the caller stop.
    if (result.fatal) {
      await queue.markNeedsRetry(email.id, result.reason);
      return 'fatal';
    }

    // The claim incremented `processingAttempts` and the row was loaded afterwards, so
    // this value already counts the attempt that just failed — no `+ 1`.
    const budgetExhausted = email.processingAttempts >= attemptBudget;

    if (result.retryable && !budgetExhausted) {
      await queue.markNeedsRetry(email.id, result.reason);
      return 'retry';
    }

    await queue.markFailed(
      email.id,
      budgetExhausted && result.retryable
        ? `${result.reason} (giving up after ${attemptBudget} attempts)`
        : result.reason,
    );
    return 'failed';
  }
}

export type AnalysisRunner = ReturnType<typeof createAnalysisRunner>;

export const analysisRunner = createAnalysisRunner();

/**
 * Adapts a stored row to the shape the analyzer expects.
 *
 * The analyzer takes an `EmailProjection` — the same type synchronization produces — so it
 * has no opinion about whether the email came from Gmail just now or from our database.
 */
function toProjection(email: ClaimedEmail): EmailProjection {
  return {
    gmailMessageId: email.gmailMessageId,
    gmailThreadId: email.gmailThreadId,
    subject: email.subject,
    snippet: email.snippet,
    bodyText: email.bodyText,
    fromName: email.fromName,
    fromEmail: email.fromEmail,
    toEmails: email.toEmails,
    ccEmails: email.ccEmails,
    replyTo: email.replyTo,
    receivedAt: email.receivedAt,
    labels: email.labels,
    isUnread: email.isUnread,
    isStarred: email.isStarred,
    isImportant: email.isImportant,
    hasAttachments: email.hasAttachments,
    sizeEstimate: email.sizeEstimate,
  };
}
