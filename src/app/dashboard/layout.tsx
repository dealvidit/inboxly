import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getCurrentSession } from '@/features/auth';
import { SignOutButton } from '@/features/auth/components/sign-out-button';
import { ViewNav } from '@/features/emails/components/view-nav';
import { SyncControls } from '@/features/sync/components/sync-controls';
import { TrpcProviders } from '@/lib/trpc/client';

/**
 * The authenticated shell.
 *
 * The session check lives here rather than in each page, so a new page under /dashboard
 * is protected by existing rather than by remembering to add a guard.
 */

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect('/');

  return (
    <TrpcProviders>
      <div className="min-h-dvh">
        <header className="border-border bg-surface sticky top-0 z-10 border-b">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
            <a href="/dashboard" className="text-brand font-semibold tracking-tight">
              Inboxly
            </a>

            <div className="ml-auto flex flex-wrap items-center gap-3">
              <SyncControls />
              <span className="text-ink-muted hidden text-sm sm:inline">
                {session.user.name ?? session.user.email}
              </span>
              <SignOutButton />
            </div>
          </div>
        </header>

        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 lg:flex-row">
          <ViewNav />
          <main id="main" className="min-w-0 flex-1">
            {children}
          </main>
        </div>
      </div>
    </TrpcProviders>
  );
}
