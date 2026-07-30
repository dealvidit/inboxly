const capabilities = [
  {
    title: 'Incremental sync',
    body: 'Gmail’s History API keeps the mailbox current at a cost that scales with what changed, not with how much mail you have.',
  },
  {
    title: 'Validated AI',
    body: 'Every model response is parsed and checked against a schema before it is allowed into the database. Invalid output never reaches you.',
  },
  {
    title: 'Triage, not reading',
    body: 'Category, urgency, action items, deadlines, and a suggested reply — so you decide what deserves attention without opening anything.',
  },
];

export default function LandingPage() {
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

      <ul className="mt-14 grid gap-6 sm:grid-cols-3">
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

      <p className="text-ink-muted mt-14 text-sm">
        Sign-in arrives with the authentication milestone.
      </p>
    </main>
  );
}
