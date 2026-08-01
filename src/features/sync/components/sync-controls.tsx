'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ProgressBar, Spinner } from '@/components/ui/primitives';
import { useTRPC } from '@/lib/trpc/client';

/**
 * Manual sync and analysis triggers.
 *
 * Both exist because waiting for the next cron tick is a poor first-run experience: a
 * user who has just connected Gmail wants to see their mailbox now.
 *
 * Two things here are less obvious than they look.
 *
 * **Running state comes from the server, not from the mutation.** `sync.runNow` holds one
 * HTTP request open for the duration of the run, so a reload abandons the request while
 * the server keeps working. Deriving the button state from `isSyncing` means a reloaded
 * page still shows the sync as running, which local `isPending` cannot do.
 *
 * **Analysis continues by itself.** One batch is `ANALYSIS_BATCH_SIZE` emails (ten by
 * default), bounded so a serverless invocation cannot time out. A first-time mailbox has
 * hundreds, so a single click looked like it had done nothing. It now runs batches in a
 * loop until the queue drains, reporting progress as it goes, and can be stopped.
 */
export function SyncControls() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  /** Progress for the current analysis run. */
  const [analysed, setAnalysed] = useState(0);
  const [queueAtStart, setQueueAtStart] = useState(0);
  const [analysing, setAnalysing] = useState(false);

  /**
   * A stable mutable box, not a ref.
   *
   * The loop below needs to observe a stop request made after it started, which a state
   * variable captured in its closure cannot show it. A `useRef` would be the usual answer
   * but reading one from a function created during render is exactly what the React
   * Compiler warns about; a `useState` initialiser gives the same stable identity without
   * that hazard, and it is only ever touched from event handlers.
   */
  const [control] = useState(() => ({ stopRequested: false }));

  /**
   * Shared with the widget row, so this adds no request of its own — TanStack Query
   * dedupes by key.
   */
  const { data: stats } = useQuery(trpc.analytics.dashboard.queryOptions());

  /** Refreshes everything a run could have changed, rather than the whole cache. */
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.emails.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.analytics.dashboard.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.sync.status.queryKey() }),
    ]);
  };

  const sync = useMutation(
    trpc.sync.runNow.mutationOptions({
      onSuccess: async (result) => {
        setMessage(
          result.status === 'FAILED'
            ? (result.error ?? 'Synchronization failed.')
            : `Synchronized ${result.messagesCreated} new email${
                result.messagesCreated === 1 ? '' : 's'
              }.` +
                (result.hasMoreWork ? ' More remaining — run again to continue.' : ''),
        );
        await invalidate();
      },
      onError: (error) => setMessage(error.message),
    }),
  );

  const analyze = useMutation(trpc.sync.analyzeNow.mutationOptions());

  /**
   * Requeues permanently failed emails.
   *
   * Exposed because the "Failed" widget was otherwise a dead end: it reported a number
   * the user could see but not act on, when the usual cause — a provider outage, a
   * throttled tier — is fixed by simply trying again.
   */
  const retryFailed = useMutation(
    trpc.sync.retryFailed.mutationOptions({
      onSuccess: async ({ requeued }) => {
        setMessage(
          requeued === 0
            ? 'Nothing to requeue.'
            : `Requeued ${emailCount(requeued)} for analysis.`,
        );
        await invalidate();
      },
      onError: (error) => setMessage(error.message),
    }),
  );

  /**
   * Runs batches until the queue is empty, the user stops, or one fails.
   *
   * A failed batch ends the run rather than continuing: repeating a call that just failed
   * — a rejected key, an exhausted quota — would march through the remaining queue
   * marking everything retryable for no benefit.
   */
  const runAnalysis = async () => {
    setMessage(null);
    setAnalysed(0);
    setQueueAtStart(stats?.queueDepth ?? 0);
    setAnalysing(true);
    control.stopRequested = false;

    let total = 0;
    let failed = 0;
    let halted: 'RATE_LIMIT' | 'PROVIDER_ERROR' | null = null;

    try {
      for (;;) {
        const result = await analyze.mutateAsync();

        total += result.completed;
        failed += result.failed;
        setAnalysed(total);
        await invalidate();

        // Stopping on a halt is the point of it: the provider has told us it cannot serve
        // the next batch either, and looping on would only defer the whole queue.
        if (result.haltedBy) {
          halted = result.haltedBy;
          break;
        }

        if (result.claimed === 0 || !result.hasMoreWork) break;
        if (control.stopRequested) break;
      }

      setMessage(
        describeRun({ total, failed, halted, stopped: control.stopRequested }),
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Analysis failed. Please try again.',
      );
    } finally {
      setAnalysing(false);
    }
  };

  // The server is the authority on whether a sync is running, so this survives a reload.
  const syncing = sync.isPending || stats?.isSyncing === true;
  const queueDepth = stats?.queueDepth ?? 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={syncing || analysing}
          onClick={() => {
            setMessage(null);
            sync.mutate();
          }}
          className="bg-brand text-on-brand hover:bg-brand-hover inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60"
        >
          {syncing ? <Spinner label="Synchronizing" /> : null}
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>

        {analysing ? (
          <button
            type="button"
            onClick={() => {
              control.stopRequested = true;
            }}
            disabled={control.stopRequested}
            className="border-border hover:bg-surface-muted inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60"
          >
            <Spinner label="Analysing" />
            {/* The count is what shows it is moving; a spinner alone does not. */}
            {control.stopRequested
              ? 'Finishing batch…'
              : queueAtStart > 0
                ? `Stop — ${analysed} of ${queueAtStart}`
                : `Stop — ${analysed} analysed`}
          </button>
        ) : (
          <button
            type="button"
            disabled={syncing || queueDepth === 0}
            onClick={() => void runAnalysis()}
            className="border-border hover:bg-surface-muted inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60"
          >
            {queueDepth > 0
              ? `Analyse ${queueDepth.toLocaleString()} email${queueDepth === 1 ? '' : 's'}`
              : 'Nothing to analyse'}
          </button>
        )}

        {(stats?.failedEmails ?? 0) > 0 && !analysing ? (
          <button
            type="button"
            disabled={syncing || retryFailed.isPending}
            onClick={() => {
              setMessage(null);
              retryFailed.mutate();
            }}
            className="border-border hover:bg-surface-muted inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60"
          >
            {retryFailed.isPending ? <Spinner label="Requeueing" /> : null}
            {`Retry ${(stats?.failedEmails ?? 0).toLocaleString()} failed`}
          </button>
        ) : null}

        {/* aria-live so the outcome is announced, not just shown. */}
        {message ? (
          <p role="status" aria-live="polite" className="text-ink-muted text-sm">
            {message}
          </p>
        ) : null}
      </div>

      {analysing && queueAtStart > 0 ? (
        <ProgressBar value={analysed} max={queueAtStart} label="Emails analysed" />
      ) : null}
    </div>
  );
}

function emailCount(count: number): string {
  return `${count} email${count === 1 ? '' : 's'}`;
}

/**
 * The end-of-run message.
 *
 * A run that stops early is the common case on a free provider tier, so saying *why* it
 * stopped — and that the remaining mail is still queued, not lost — matters more than the
 * final count.
 */
function describeRun({
  total,
  failed,
  halted,
  stopped,
}: {
  total: number;
  failed: number;
  halted: 'RATE_LIMIT' | 'PROVIDER_ERROR' | null;
  stopped: boolean;
}): string {
  if (total === 0 && failed === 0 && !halted) {
    return 'Nothing waiting to be analysed.';
  }

  const parts = [`Analysed ${emailCount(total)}.`];

  if (failed > 0) parts.push(`${emailCount(failed)} could not be analysed.`);

  if (halted === 'RATE_LIMIT') {
    parts.push(
      'Paused — the AI provider is rate limiting. The rest stay queued; try again shortly.',
    );
  } else if (halted === 'PROVIDER_ERROR') {
    parts.push('Paused — AI analysis is unavailable. The rest stay queued.');
  } else if (stopped) {
    parts.push('Stopped.');
  }

  return parts.join(' ');
}
