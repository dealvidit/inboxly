import { z } from 'zod';
import { type EmailCategory, type Sentiment, type Urgency } from '@/server/db';

/**
 * The contract every AI response must satisfy.
 *
 * This schema is the single definition: TypeScript types are inferred from it with
 * `z.infer`, the prompt is built from its `.describe()` annotations, and the runtime
 * check is `safeParse` against it. The prompt and the validator therefore cannot
 * disagree — which is the failure mode this design exists to prevent (ADR 0007).
 *
 * `.describe()` calls here are written for the model as much as for the reader.
 */

/** Bumped when the shape changes, so stored analyses can be identified and re-run. */
export const ANALYSIS_SCHEMA_VERSION = 1;

/* ─── Enumerations ───────────────────────────────────────────────────────── */

export const EmailCategorySchema = z
  .enum([
    'WORK',
    'PERSONAL',
    'FINANCE',
    'MEETING',
    'PROMOTION',
    'NEWSLETTER',
    'NOTIFICATION',
    'SUPPORT',
    'TRAVEL',
    'SPAM',
    'OTHER',
  ])
  .describe(
    'The single best category. MEETING for invitations and scheduling; FINANCE for ' +
      'invoices, receipts, and banking; NOTIFICATION for automated system mail; ' +
      'NEWSLETTER for subscribed bulk content; PROMOTION for marketing. OTHER only when ' +
      'nothing else fits.',
  );

export const UrgencySchema = z
  .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  .describe(
    'How soon this needs human attention. CRITICAL means same-day consequences if ' +
      'ignored; HIGH means within a couple of days; LOW means it can wait indefinitely.',
  );

export const SentimentSchema = z
  .enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'MIXED'])
  .describe('The tone of the sender. Most transactional mail is NEUTRAL.');

/* ─── Nested structures ──────────────────────────────────────────────────── */

export const ActionItemSchema = z.object({
  description: z
    .string()
    .describe('One concrete thing the recipient must do, phrased as an imperative.'),
  owner: z
    .string()
    .nullable()
    .describe('Who is responsible, if the email names someone. Otherwise null.'),
  dueDate: z
    .string()
    .nullable()
    .describe(
      'ISO 8601 date (YYYY-MM-DD) if one is stated or clearly implied, else null.',
    ),
});

export const DeadlineSchema = z.object({
  description: z.string().describe('What is due.'),
  date: z.string().describe('ISO 8601 date (YYYY-MM-DD).'),
  isExplicit: z
    .boolean()
    .describe('True if the email states this date; false if it was inferred.'),
});

export const MeetingInformationSchema = z.object({
  title: z.string().nullable().describe('The meeting subject, if given.'),
  startsAt: z
    .string()
    .nullable()
    .describe('ISO 8601 datetime if a specific time is given, else null.'),
  durationMinutes: z.number().int().positive().nullable(),
  location: z
    .string()
    .nullable()
    .describe('Physical location or the name of the platform (e.g. "Zoom").'),
  joinUrl: z.string().nullable().describe('Conference link, if present.'),
  attendees: z
    .array(z.string())
    .describe('Named attendees. Empty when none are listed.'),
});

export const ExtractedEntitiesSchema = z.object({
  people: z.array(z.string()).describe('Named individuals.'),
  organisations: z.array(z.string()).describe('Named companies or institutions.'),
  amounts: z
    .array(z.string())
    .describe('Monetary amounts as written, including currency (e.g. "£1,250.00").'),
  dates: z.array(z.string()).describe('Dates mentioned, as written.'),
  links: z.array(z.string()).describe('URLs that matter to the reader.'),
});

/* ─── The analysis ───────────────────────────────────────────────────────── */

export const EmailAnalysisSchema = z.object({
  category: EmailCategorySchema,
  urgency: UrgencySchema,
  sentiment: SentimentSchema,
  requiresResponse: z
    .boolean()
    .describe('True only if the sender is waiting on a reply from the recipient.'),
  confidence: z.number().describe('Your confidence in this analysis, from 0 to 1.'),
  summary: z
    .string()
    .describe(
      'One or two sentences capturing what this email is about and why it matters. ' +
        'Write for someone deciding whether to open it.',
    ),
  suggestedReply: z
    .string()
    .nullable()
    .describe(
      'A short draft reply the recipient could send, when requiresResponse is true. ' +
        'Null otherwise. Do not invent facts the recipient has not stated.',
    ),
  actionItems: z
    .array(ActionItemSchema)
    .describe('Concrete tasks for the recipient. Empty when there are none.'),
  deadlines: z
    .array(DeadlineSchema)
    .describe('Dated commitments. Empty when there are none.'),
  meetingInformation: MeetingInformationSchema.nullable().describe(
    'Populated only when the email proposes or confirms a meeting.',
  ),
  extractedEntities: ExtractedEntitiesSchema,
});

export type EmailAnalysis = z.infer<typeof EmailAnalysisSchema>;
export type ActionItem = z.infer<typeof ActionItemSchema>;
export type Deadline = z.infer<typeof DeadlineSchema>;
export type MeetingInformation = z.infer<typeof MeetingInformationSchema>;
export type ExtractedEntities = z.infer<typeof ExtractedEntitiesSchema>;

/* ─── Cross-checks against the database enums ────────────────────────────── */

/**
 * These assignments are compile-time assertions, not runtime code.
 *
 * The Zod enums above and the Prisma enums in schema.prisma are two independent
 * declarations of the same domain vocabulary. If they ever diverge — a value added to one
 * and not the other — `tsc` fails here rather than the mismatch surfacing at runtime as a
 * failed insert on a row the model was perfectly happy to produce.
 */
const _categoriesMatch: EmailCategory = 'WORK' satisfies EmailAnalysis['category'];
const _urgencyMatches: Urgency = 'HIGH' satisfies EmailAnalysis['urgency'];
const _sentimentMatches: Sentiment = 'NEUTRAL' satisfies EmailAnalysis['sentiment'];

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _categoryEnumsAreEqual: AssertEqual<
  EmailAnalysis['category'],
  `${EmailCategory}`
> = true;
const _urgencyEnumsAreEqual: AssertEqual<EmailAnalysis['urgency'], `${Urgency}`> = true;
const _sentimentEnumsAreEqual: AssertEqual<EmailAnalysis['sentiment'], `${Sentiment}`> =
  true;

void _categoriesMatch;
void _urgencyMatches;
void _sentimentMatches;
void _categoryEnumsAreEqual;
void _urgencyEnumsAreEqual;
void _sentimentEnumsAreEqual;
