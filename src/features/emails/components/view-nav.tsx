'use client';

import { useSearchParams } from 'next/navigation';
import { EMAIL_VIEW_LABELS, type EmailView } from '../domain/query';

/**
 * The view switcher.
 *
 * Rendered as a `nav` of links rather than buttons, because each view *is* a URL: it is
 * shareable, bookmarkable, and works with the back button. `aria-current` marks the
 * active one for assistive technology rather than relying on colour alone.
 */

const VIEW_ORDER: EmailView[] = [
  'inbox',
  'needs-reply',
  'important',
  'meetings',
  'finance',
  'personal',
  'promotions',
];

export function ViewNav() {
  const params = useSearchParams();
  const current = (params.get('view') ?? 'inbox') as EmailView;

  return (
    <nav aria-label="Email views" className="lg:w-48 lg:shrink-0">
      <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
        {VIEW_ORDER.map((view) => {
          const isActive = view === current;
          // Preserve the search term across view changes; drop the unread filter, which
          // is a per-view refinement rather than a global one.
          const next = new URLSearchParams();
          if (view !== 'inbox') next.set('view', view);
          const search = params.get('q');
          if (search) next.set('q', search);
          const query = next.toString();

          return (
            <li key={view}>
              <a
                href={`/dashboard${query ? `?${query}` : ''}`}
                aria-current={isActive ? 'page' : undefined}
                className={`block rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-brand-subtle text-brand font-medium'
                    : 'hover:bg-surface-muted'
                }`}
              >
                {EMAIL_VIEW_LABELS[view]}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
