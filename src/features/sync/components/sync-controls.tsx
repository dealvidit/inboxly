'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Spinner } from '@/components/ui/primitives';
import { useTRPC } from '@/lib/trpc/client';

/**
 * Manual sync and analysis triggers.
 *
 * Both exist because waiting for the next cron tick is a poor first-run experience: a
 * user who has just connected Gmail wants to see their mailbox now.
 */
export function SyncControls() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  /** Refreshes everything the run could have changed, rather than the whole cache. */
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

  const analyze = useMutation(
    trpc.sync.analyzeNow.mutationOptions({
      onSuccess: async (result) => {
        setMessage(
          result.claimed === 0
            ? 'Nothing waiting to be analysed.'
            : `Analysed ${result.completed} email${result.completed === 1 ? '' : 's'}.` +
                (result.failed > 0 ? ` ${result.failed} failed.` : ''),
        );
        await invalidate();
      },
      onError: (error) => setMessage(error.message),
    }),
  );

  const busy = sync.isPending || analyze.isPending;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setMessage(null);
          sync.mutate();
        }}
        className="bg-brand text-on-brand hover:bg-brand-hover inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60"
      >
        {sync.isPending ? <Spinner label="Synchronizing" /> : null}
        {sync.isPending ? 'Syncing…' : 'Sync now'}
      </button>

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setMessage(null);
          analyze.mutate();
        }}
        className="border-border hover:bg-surface-muted inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60"
      >
        {analyze.isPending ? <Spinner label="Analysing" /> : null}
        {analyze.isPending ? 'Analysing…' : 'Analyse pending'}
      </button>

      {/* aria-live so the outcome is announced, not just shown. */}
      {message ? (
        <p role="status" aria-live="polite" className="text-ink-muted text-sm">
          {message}
        </p>
      ) : null}
    </div>
  );
}
