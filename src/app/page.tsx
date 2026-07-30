import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/features/auth';
import { GoogleSignInButton } from '@/features/auth/components/google-sign-in-button';

export const dynamic = 'force-dynamic';

const capabilities = [
  {
    title: 'Incremental sync',
    body: 'Gmail’s History API keeps your mailbox current at a cost that scales with what changed, not with how much mail you have.',
  },
  {
    title: 'Validated AI',
    body: 'Every model response is checked against a schema before it is allowed into the database. Invalid output never reaches you.',
  },
  {
    title: 'Triage, not reading',
    body: 'Category, urgency, action items, deadlines, and a suggested reply — so you can decide what deserves attention without opening anything.',
  },
];

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string }>;
}) {
  const session = await getCurrentSession();
  if (session) redirect('/dashboard');

  const { auth_error: authError } = await searchParams;

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-24">
      <p className="text-brand text-sm font-semibold tracking-wide uppercase">
        Inboxly
      </p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
        Understand your inbox without reading it.
      </h1>
      <p className="text-ink-muted mt-5 max-w-2xl text-lg">
        Inboxly connects to Gmail, synchronizes your mail incrementally, and analyses
        every message through a typed AI pipeline — then shows you only what matters.
      </p>

      {authError ? (
        <p
          role="alert"
          className="border-urgent/30 bg-urgent/5 text-urgent mt-8 rounded-[var(--radius-card)] border px-4 py-3 text-sm"
        >
          {authError}
        </p>
      ) : null}

      <div className="mt-10">
        <GoogleSignInButton />
        <p className="text-ink-muted mt-3 text-xs">
          Inboxly requests read-only access to Gmail. It cannot send, modify, or delete
          your mail.
        </p>
      </div>

      <ul className="mt-16 grid gap-6 sm:grid-cols-3">
        {capabilities.map((capability) => (
          <li
            key={capability.title}
            className="border-border bg-surface rounded-[var(--radius-card)] border p-5"
          >
            <h2 className="font-medium">{capability.title}</h2>
            <p className="text-ink-muted mt-2 text-sm leading-relaxed">
              {capability.body}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
