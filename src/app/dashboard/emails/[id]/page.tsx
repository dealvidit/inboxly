import { notFound, redirect } from 'next/navigation';
import { Card } from '@/components/ui/primitives';
import { getCurrentSession } from '@/features/auth';
import { EmailDetail } from '@/features/emails/components/email-detail';
import { getEmailForUser } from '@/features/emails/repository/email-repository';

/**
 * The email detail view.
 *
 * Fetched in a Server Component, straight through the repository — no HTTP round trip for
 * the initial payload (ADR 0008).
 */

export const dynamic = 'force-dynamic';

export default async function EmailDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect('/');

  const { id } = await params;
  const email = await getEmailForUser(session.user.id, id);

  // `getEmailForUser` scopes by user, so another user's email is indistinguishable from
  // one that does not exist — which is the correct thing to reveal.
  if (!email) notFound();

  return (
    <div className="space-y-4">
      <a
        href="/dashboard"
        className="text-ink-muted hover:text-ink inline-block text-sm"
      >
        ← Back to inbox
      </a>

      <Card className="p-6">
        <EmailDetail email={email} />
      </Card>
    </div>
  );
}
