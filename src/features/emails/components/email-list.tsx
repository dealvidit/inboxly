'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { useTRPC } from '@/lib/trpc/client';
import {
  EMAIL_VIEW_LABELS,
  EmailSortSchema,
  EmailViewSchema,
  type EmailSort,
  type EmailView,
} from '../domain/query';
import { CategoryBadge, UrgencyBadge } from './email-badges';

/**
 * The email list.
 *
 * View state lives in the URL, so a filtered view is shareable, survives a refresh, and
 * works with the browser's back button. The component reads the URL rather than holding
 * its own copy, which means there is only one source of truth for what is displayed.
 */

const PAGE_SIZE = 25;

export function EmailList({ selectedId }: { selectedId?: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const params = useSearchParams();

  const view = parseEnum(EmailViewSchema, params.get('view'), 'inbox');
  const sort = parseEnum(EmailSortSchema, params.get('sort'), 'newest');
  const search = params.get('q') ?? '';
  const unreadOnly = params.get('unread') === '1';

  // Cursors are kept in component state rather than the URL: they are opaque and
  // position-dependent, so a shared link with a cursor in it would be meaningless.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors[cursors.length - 1];

  const { data, isPending, isFetching } = useQuery(
    trpc.emails.list.queryOptions({
      view,
      sort,
      unreadOnly,
      limit: PAGE_SIZE,
      ...(search ? { search } : {}),
      ...(cursor ? { cursor } : {}),
    }),
  );

  // Not wrapped in useCallback: the React Compiler handles memoization, and it cannot
  // preserve a manual one that closes over a state setter this way.
  const updateParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    // Changing filters invalidates the paging position.
    setCursors([]);
    router.push(`/dashboard?${next.toString()}`, { scroll: false });
  };

  return (
    <div className="flex min-h-0 flex-col">
      <Toolbar
        view={view}
        sort={sort}
        search={search}
        unreadOnly={unreadOnly}
        onChange={updateParams}
      />

      <Card className="mt-3 overflow-hidden">
        {isPending ? (
          <div
            aria-busy="true"
            aria-label="Loading emails"
            className="divide-border divide-y"
          >
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="p-4">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="mt-2 h-3 w-2/3" />
              </div>
            ))}
          </div>
        ) : data && data.items.length > 0 ? (
          <ul className="divide-border divide-y">
            {data.items.map((email) => (
              <EmailRow
                key={email.id}
                email={email}
                isSelected={email.id === selectedId}
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            title={
              search ? 'No matching emails' : `Nothing in ${EMAIL_VIEW_LABELS[view]}`
            }
            description={
              search
                ? 'Try a different search term, or clear the search to see everything.'
                : 'Once your mailbox has synchronized and been analysed, matching emails appear here.'
            }
          />
        )}
      </Card>

      {data && (cursors.length > 0 || data.nextCursor) ? (
        <nav aria-label="Pagination" className="mt-3 flex items-center justify-between">
          <button
            type="button"
            disabled={cursors.length === 0 || isFetching}
            onClick={() => setCursors((current) => current.slice(0, -1))}
            className="border-border hover:bg-surface-muted rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-ink-muted text-sm" aria-live="polite">
            Page {cursors.length + 1}
            {isFetching ? ' · updating…' : ''}
          </span>
          <button
            type="button"
            disabled={!data.nextCursor || isFetching}
            onClick={() =>
              setCursors((current) =>
                data.nextCursor ? [...current, data.nextCursor] : current,
              )
            }
            className="border-border hover:bg-surface-muted rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40"
          >
            Next
          </button>
        </nav>
      ) : null}
    </div>
  );
}

function Toolbar({
  view,
  sort,
  search,
  unreadOnly,
  onChange,
}: {
  view: EmailView;
  sort: EmailSort;
  search: string;
  unreadOnly: boolean;
  onChange: (changes: Record<string, string | null>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form
        role="search"
        className="min-w-[12rem] flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get('q');
          onChange({ q: typeof value === 'string' ? value.trim() : null });
        }}
      >
        <label htmlFor="email-search" className="sr-only">
          Search emails
        </label>
        <input
          id="email-search"
          name="q"
          type="search"
          defaultValue={search}
          placeholder="Search subject, sender, or AI summary…"
          className="border-border bg-surface w-full rounded-lg border px-3 py-1.5 text-sm"
        />
      </form>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={unreadOnly}
          onChange={(event) => onChange({ unread: event.target.checked ? '1' : null })}
          className="size-4"
        />
        Unread only
      </label>

      <label className="flex items-center gap-2 text-sm">
        <span className="text-ink-muted">Sort</span>
        <select
          value={sort}
          onChange={(event) => onChange({ sort: event.target.value })}
          className="border-border bg-surface rounded-lg border px-2 py-1.5 text-sm"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="urgency">Urgency</option>
        </select>
      </label>

      <span className="sr-only" aria-live="polite">
        Showing {EMAIL_VIEW_LABELS[view]}
      </span>
    </div>
  );
}

interface EmailRowProps {
  email: {
    id: string;
    subject: string;
    snippet: string;
    fromName: string | null;
    fromEmail: string;
    receivedAt: Date;
    isUnread: boolean;
    processingStatus: string;
    analysis: {
      category:
        | 'WORK'
        | 'PERSONAL'
        | 'FINANCE'
        | 'MEETING'
        | 'PROMOTION'
        | 'NEWSLETTER'
        | 'NOTIFICATION'
        | 'SUPPORT'
        | 'TRAVEL'
        | 'SPAM'
        | 'OTHER';
      urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      requiresResponse: boolean;
      summary: string;
    } | null;
  };
  isSelected: boolean;
}

function EmailRow({ email, isSelected }: EmailRowProps) {
  const params = useSearchParams();
  const href = `/dashboard/emails/${email.id}?${params.toString()}`;

  return (
    <li>
      <a
        href={href}
        aria-current={isSelected ? 'page' : undefined}
        className={`hover:bg-surface-muted block px-4 py-3 transition-colors ${
          isSelected ? 'bg-brand-subtle' : ''
        }`}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span
            className={`truncate text-sm ${email.isUnread ? 'font-semibold' : 'font-medium'}`}
          >
            {email.fromName ?? email.fromEmail}
          </span>
          <time
            dateTime={email.receivedAt.toISOString()}
            className="text-ink-muted shrink-0 text-xs"
          >
            {email.receivedAt.toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
            })}
          </time>
        </div>

        <p className={`mt-0.5 truncate text-sm ${email.isUnread ? 'font-medium' : ''}`}>
          {email.subject || '(no subject)'}
        </p>

        {/* The AI summary replaces the snippet where one exists — it is the reason to
            use this product rather than Gmail. */}
        <p className="text-ink-muted mt-1 line-clamp-2 text-sm">
          {email.analysis?.summary ?? email.snippet}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {email.analysis ? (
            <>
              <CategoryBadge category={email.analysis.category} />
              <UrgencyBadge urgency={email.analysis.urgency} />
              {email.analysis.requiresResponse ? (
                <span className="text-brand text-xs font-medium">Needs reply</span>
              ) : null}
            </>
          ) : (
            <span className="text-ink-muted text-xs">
              {email.processingStatus === 'FAILED'
                ? 'Analysis unavailable'
                : 'Awaiting analysis'}
            </span>
          )}
        </div>
      </a>
    </li>
  );
}

/** Falls back to a default rather than throwing — the URL is user-editable. */
function parseEnum<T extends string>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  value: string | null,
  fallback: T,
): T {
  const result = schema.safeParse(value);
  return result.success && result.data !== undefined ? result.data : fallback;
}
