'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, ProgressBar, Skeleton } from '@/components/ui/primitives';
import { useTRPC } from '@/lib/trpc/client';

/**
 * The dashboard's widget row.
 *
 * Polls only while a synchronization is actually running. An interval that stops matters
 * as much as one that starts: a dashboard left open overnight should not keep querying
 * every three seconds forever (ADR 0010).
 */

const ACTIVE_POLL_MS = 3000;

export function StatWidgets() {
  const trpc = useTRPC();
  const { data, isPending } = useQuery(
    trpc.analytics.dashboard.queryOptions(undefined, {
      refetchInterval: (query) =>
        query.state.data?.isSyncing ? ACTIVE_POLL_MS : false,
    }),
  );

  if (isPending || !data) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading dashboard statistics"
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
      >
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-[86px]" />
        ))}
      </div>
    );
  }

  return (
    <section aria-label="Mailbox statistics">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total emails" value={data.totalEmails.toLocaleString()} />
        <Stat
          label="AI processed"
          value={data.analysedEmails.toLocaleString()}
          {...(data.totalEmails > 0
            ? {
                hint: `${Math.round(
                  (data.analysedEmails / data.totalEmails) * 100,
                )}% of mailbox`,
                progress: {
                  value: data.analysedEmails,
                  max: data.totalEmails,
                  label: 'Mailbox analysed',
                },
              }
            : {})}
        />
        <Stat
          label="Processing queue"
          value={data.queueDepth.toLocaleString()}
          // Not "analysis in progress": a non-empty queue means work is *waiting*, and
          // saying otherwise told the user something was happening when nothing was.
          hint={data.queueDepth > 0 ? 'Waiting to be analysed' : 'Nothing waiting'}
        />
        <Stat
          label="Failed"
          value={data.failedEmails.toLocaleString()}
          tone={data.failedEmails > 0 ? 'urgent' : 'default'}
        />
        <Stat label="Needs reply" value={data.needsReply.toLocaleString()} />
        <Stat
          label="Avg. processing"
          value={
            data.averageProcessingMs === null
              ? '—'
              : `${(data.averageProcessingMs / 1000).toFixed(1)}s`
          }
          hint="Per email"
        />
        <Stat
          label="Last sync"
          value={data.lastSyncedAt ? relativeTime(data.lastSyncedAt) : 'Never'}
        />
        <Stat
          label="Sync status"
          value={syncLabel(data)}
          tone={data.lastRun?.status === 'FAILED' ? 'urgent' : 'default'}
        />
      </dl>

      {data.lastRun?.error ? (
        <p role="status" className="text-urgent mt-3 text-sm">
          {data.lastRun.error}
        </p>
      ) : null}
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = 'default',
  progress,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'urgent';
  progress?: { value: number; max: number; label: string };
}) {
  return (
    <Card className="p-4">
      <dt className="text-ink-muted text-xs font-medium tracking-wide uppercase">
        {label}
      </dt>
      <dd
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tone === 'urgent' ? 'text-urgent' : ''
        }`}
      >
        {value}
      </dd>
      {progress ? (
        <div className="mt-2">
          <ProgressBar {...progress} />
        </div>
      ) : null}
      {hint ? <p className="text-ink-muted mt-0.5 text-xs">{hint}</p> : null}
    </Card>
  );
}

function syncLabel(data: {
  isSyncing: boolean;
  lastRun: { status: string; phase: string } | null;
}): string {
  if (data.isSyncing) return 'Syncing…';
  if (!data.lastRun) return 'Not yet run';

  switch (data.lastRun.status) {
    case 'COMPLETED':
      return 'Up to date';
    case 'PARTIAL':
      return 'More to sync';
    case 'FAILED':
      return 'Failed';
    default:
      return data.lastRun.status;
  }
}

/**
 * A compact relative time.
 *
 * Rendered client-side only (this is a client component), so it cannot produce a
 * server/client hydration mismatch from clock skew.
 */
function relativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
