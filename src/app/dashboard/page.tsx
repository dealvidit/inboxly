import { redirect } from 'next/navigation';
import { getCurrentSession, googleAccountService } from '@/features/auth';
import { GoogleSignInButton } from '@/features/auth/components/google-sign-in-button';
import { StatWidgets } from '@/features/analytics/components/stat-widgets';
import { EmailList } from '@/features/emails/components/email-list';
import { Card } from '@/components/ui/primitives';
import { ConnectionStatus } from '@/server/db';

export const metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/');

  // Fetched on the server so the reconnect prompt is present in the first paint rather
  // than appearing after hydration.
  const connection = await googleAccountService.getConnection(session.user.id);
  const needsAttention =
    connection === null || connection.status !== ConnectionStatus.CONNECTED;

  return (
    <div className="space-y-6">
      {needsAttention ? (
        <Card className="border-warning/40 bg-warning/5 p-4">
          <h2 className="font-medium">
            {connection === null ? 'Connect Gmail' : 'Reconnect Gmail'}
          </h2>
          <p className="text-ink-muted mt-1 text-sm">
            {connection?.message ??
              'Connect your Gmail account to start synchronizing and analysing your mail.'}
          </p>
          <div className="mt-4">
            <GoogleSignInButton
              reconnect
              returnTo="/dashboard"
              label={connection === null ? 'Connect Gmail' : 'Reconnect Gmail'}
            />
          </div>
        </Card>
      ) : null}

      <StatWidgets />
      <EmailList />
    </div>
  );
}
