import { Badge } from '@/components/ui/primitives';
import type { EmailAnalysisRow, EmailRow } from '@/server/db';
import {
  ActionItemSchema,
  DeadlineSchema,
  ExtractedEntitiesSchema,
  MeetingInformationSchema,
} from '@/features/ai';
import { CategoryBadge, ConfidenceBadge, UrgencyBadge } from './email-badges';
import { SuggestedReply } from './suggested-reply';

/**
 * The email detail view.
 *
 * The AI's structured output is the point of this screen, so it appears above the raw
 * message rather than below it.
 *
 * The `Json` columns are re-validated here with the same Zod schemas that produced them.
 * That is not redundant: the row may predate a schema change, or have been written by a
 * previous version. Validating at read time means a stale shape renders as "not
 * available" instead of crashing the page.
 */

export function EmailDetail({
  email,
}: {
  email: EmailRow & { analysis: EmailAnalysisRow | null };
}) {
  const { analysis } = email;

  return (
    <article>
      <header>
        <h1 className="text-xl font-semibold tracking-tight">
          {email.subject || '(no subject)'}
        </h1>
        <p className="text-ink-muted mt-1 text-sm">
          {email.fromName ? `${email.fromName} · ` : ''}
          {email.fromEmail}
          {' · '}
          <time dateTime={email.receivedAt.toISOString()}>
            {email.receivedAt.toLocaleString('en-GB', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </time>
        </p>
        {email.toEmails.length > 0 ? (
          <p className="text-ink-muted mt-0.5 text-sm">
            To: {email.toEmails.join(', ')}
          </p>
        ) : null}
      </header>

      {analysis ? (
        <section aria-labelledby="ai-analysis" className="mt-6">
          <h2 id="ai-analysis" className="sr-only">
            AI analysis
          </h2>

          <div className="flex flex-wrap items-center gap-1.5">
            <CategoryBadge category={analysis.category} />
            <UrgencyBadge urgency={analysis.urgency} />
            <Badge tone="neutral">
              <span className="sr-only">Sentiment: </span>
              {sentenceCase(analysis.sentiment)}
            </Badge>
            {analysis.requiresResponse ? <Badge tone="info">Needs reply</Badge> : null}
            <ConfidenceBadge confidence={analysis.confidence} />
          </div>

          <p className="mt-4 text-[15px] leading-relaxed">{analysis.summary}</p>

          <ActionItems value={analysis.actionItems} />
          <Deadlines value={analysis.deadlines} />
          <Meeting value={analysis.meetingInformation} />
          <Entities value={analysis.extractedEntities} />

          {analysis.suggestedReply ? (
            <SuggestedReply reply={analysis.suggestedReply} />
          ) : null}

          <p className="text-ink-muted mt-6 text-xs">
            Analysed by {analysis.model} in {(analysis.latencyMs / 1000).toFixed(1)}s
          </p>
        </section>
      ) : (
        <p className="text-ink-muted mt-6 text-sm">
          {email.processingStatus === 'FAILED'
            ? (email.processingError ?? 'This email could not be analysed.')
            : 'This email has not been analysed yet.'}
        </p>
      )}

      <section
        aria-labelledby="original-message"
        className="border-border mt-8 border-t pt-6"
      >
        <h2
          id="original-message"
          className="text-ink-muted text-xs font-medium tracking-wide uppercase"
        >
          Original message
        </h2>
        {/* Rendered as plain text in a `pre`, never as HTML: the body is
            attacker-controlled, and this is the one place it reaches the DOM. */}
        <pre className="mt-3 font-sans text-sm leading-relaxed whitespace-pre-wrap">
          {email.bodyText ?? email.snippet}
        </pre>
      </section>
    </article>
  );
}

/* ─── Sections, each rendering nothing when it has nothing to say ────────── */

function ActionItems({ value }: { value: unknown }) {
  const parsed = ActionItemSchema.array().safeParse(value);
  if (!parsed.success || parsed.data.length === 0) return null;

  return (
    <section className="mt-5">
      <h3 className="text-sm font-medium">Action items</h3>
      <ul className="mt-2 space-y-1.5">
        {parsed.data.map((item, index) => (
          <li key={index} className="flex gap-2 text-sm">
            <span aria-hidden="true" className="text-ink-muted">
              •
            </span>
            <span>
              {item.description}
              {item.owner ? (
                <span className="text-ink-muted"> — {item.owner}</span>
              ) : null}
              {item.dueDate ? (
                <span className="text-ink-muted"> (due {item.dueDate})</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Deadlines({ value }: { value: unknown }) {
  const parsed = DeadlineSchema.array().safeParse(value);
  if (!parsed.success || parsed.data.length === 0) return null;

  return (
    <section className="mt-5">
      <h3 className="text-sm font-medium">Deadlines</h3>
      <ul className="mt-2 space-y-1.5">
        {parsed.data.map((deadline, index) => (
          <li key={index} className="text-sm">
            <span className="font-medium">{deadline.date}</span> —{' '}
            {deadline.description}
            {/* Inferred dates are marked, so a guessed deadline is not mistaken for a
                stated one. */}
            {!deadline.isExplicit ? (
              <span className="text-ink-muted"> (inferred)</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Meeting({ value }: { value: unknown }) {
  if (value === null) return null;
  const parsed = MeetingInformationSchema.safeParse(value);
  if (!parsed.success) return null;

  const meeting = parsed.data;

  return (
    <section className="mt-5">
      <h3 className="text-sm font-medium">Meeting</h3>
      <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
        {meeting.title ? (
          <>
            <dt className="text-ink-muted">Title</dt>
            <dd>{meeting.title}</dd>
          </>
        ) : null}
        {meeting.startsAt ? (
          <>
            <dt className="text-ink-muted">Starts</dt>
            <dd>{meeting.startsAt}</dd>
          </>
        ) : null}
        {meeting.durationMinutes ? (
          <>
            <dt className="text-ink-muted">Duration</dt>
            <dd>{meeting.durationMinutes} minutes</dd>
          </>
        ) : null}
        {meeting.location ? (
          <>
            <dt className="text-ink-muted">Location</dt>
            <dd>{meeting.location}</dd>
          </>
        ) : null}
        {meeting.attendees.length > 0 ? (
          <>
            <dt className="text-ink-muted">Attendees</dt>
            <dd>{meeting.attendees.join(', ')}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function Entities({ value }: { value: unknown }) {
  const parsed = ExtractedEntitiesSchema.safeParse(value);
  if (!parsed.success) return null;

  const groups = [
    { label: 'People', items: parsed.data.people },
    { label: 'Organisations', items: parsed.data.organisations },
    { label: 'Amounts', items: parsed.data.amounts },
    { label: 'Dates', items: parsed.data.dates },
  ].filter((group) => group.items.length > 0);

  if (groups.length === 0) return null;

  return (
    <section className="mt-5">
      <h3 className="text-sm font-medium">Mentioned</h3>
      <div className="mt-2 space-y-1.5">
        {groups.map((group) => (
          <p key={group.label} className="text-sm">
            <span className="text-ink-muted">{group.label}: </span>
            {group.items.join(', ')}
          </p>
        ))}
      </div>
    </section>
  );
}

function sentenceCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}
