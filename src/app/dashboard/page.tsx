import { redirect } from 'next/navigation';
import { getCurrentSession, googleAccountService } from '@/features/auth';
import { GoogleSignInButton } from '@/features/auth/components/google-sign-in-button';
import { SignOutButton } from '@/features/auth/components/sign-out-button';
import { ConnectionStatus } from '@/server/db';

/**
 * The authenticated shell.
 *
 * Deliberately minimal at this milestone: it proves the session and the Gmail connection
 * state end to end. The widgets, views, and email list arrive with the dashboard
 * milestone and will replace this body.
 */

export const metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/');

  const connection = await googleAccountService.getConnection(session.user.id);
  const needsReconnect =
    connection === null || connection.status !== ConnectionStatus.CONNECTED;

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-ink-muted mt-1 text-sm">
            Signed in as {session.user.name ?? session.user.email}
          </p>
        </div>
        <SignOutButton />
      </header>

      <section
        aria-labelledby="gmail-connection"
        className="border-border bg-surface mt-10 rounded-[var(--radius-card)] border p-5"
      >
        <h2 id="gmail-connection" className="font-medium">
          Gmail connection
        </h2>

        {needsReconnect ? (
          <>
            <p className="text-ink-muted mt-2 text-sm">
              {connection?.message ??
                'Connect Gmail to start synchronizing and analysing your mail.'}
            </p>
            <div className="mt-4">
              <GoogleSignInButton
                reconnect
                returnTo="/dashboard"
                label={connection === null ? 'Connect Gmail' : 'Reconnect Gmail'}
              />
            </div>
          </>
        ) : (
          <dl className="mt-3 grid gap-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-ink-muted">Mailbox</dt>
              <dd>{connection.gmailAddress ?? session.user.email}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-ink-muted">Status</dt>
              <dd className="text-success font-medium">Connected</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-ink-muted">Connected</dt>
              <dd>
                <time dateTime={connection.connectedAt?.toISOString()}>
                  {connection.connectedAt?.toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </time>
              </dd>
            </div>
          </dl>
        )}
      </section>

      <p className="text-ink-muted mt-8 text-sm">
        Synchronization and AI analysis arrive with the next milestones.
      </p>
    </main>
  );
}
