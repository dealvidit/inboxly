import { z } from 'zod';

/**
 * The vocabulary of the email list: views, filters, sorting, and pagination.
 *
 * Defined as Zod schemas because they arrive from the URL and from the API, both of which
 * are user-controlled. Types are inferred, so the router, the repository, and the UI all
 * agree by construction.
 */

/**
 * The dashboard's views.
 *
 * A view is a named preset over the same filters, not a separate query path — which is
 * what keeps "Needs Reply" and "Finance" from drifting into two different code paths.
 */
export const EmailViewSchema = z.enum([
  'inbox',
  'needs-reply',
  'important',
  'meetings',
  'finance',
  'personal',
  'promotions',
]);

export type EmailView = z.infer<typeof EmailViewSchema>;

export const EMAIL_VIEW_LABELS: Record<EmailView, string> = {
  inbox: 'Inbox',
  'needs-reply': 'Needs Reply',
  important: 'Important',
  meetings: 'Meetings',
  finance: 'Finance',
  personal: 'Personal',
  promotions: 'Promotions',
};

export const EmailSortSchema = z.enum(['newest', 'oldest', 'urgency']);
export type EmailSort = z.infer<typeof EmailSortSchema>;

export const EmailListInputSchema = z.object({
  view: EmailViewSchema.default('inbox'),
  /** Full-text query. Matches subject, sender, snippet, and the AI summary. */
  search: z.string().trim().max(200).optional(),
  category: z
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
    .optional(),
  urgency: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  unreadOnly: z.boolean().default(false),
  /** Inclusive lower bound on receivedAt. */
  from: z.date().optional(),
  /** Inclusive upper bound on receivedAt. */
  to: z.date().optional(),
  sort: EmailSortSchema.default('newest'),
  limit: z.number().int().min(1).max(100).default(25),
  /**
   * Opaque cursor from the previous page.
   *
   * Cursor rather than offset because the list is ordered by `receivedAt` and new mail
   * arrives at the top: with offset pagination, an email arriving between requests shifts
   * every subsequent page and the reader sees a duplicate. See ADR 0008.
   */
  cursor: z.string().optional(),
});

export type EmailListInput = z.infer<typeof EmailListInputSchema>;

/**
 * Encodes the sort key of the last row on a page.
 *
 * `id` is included as a tiebreaker: `receivedAt` is not unique — bulk mail routinely
 * shares a timestamp to the millisecond — and a cursor on a non-unique column alone
 * either repeats or skips rows at the page boundary.
 */
export interface EmailCursor {
  readonly receivedAt: Date;
  readonly id: string;
}

export function encodeCursor(cursor: EmailCursor): string {
  return Buffer.from(
    JSON.stringify({ r: cursor.receivedAt.toISOString(), i: cursor.id }),
    'utf8',
  ).toString('base64url');
}

/** Returns null for anything malformed — a bad cursor shows page one, not an error. */
export function decodeCursor(encoded: string | undefined): EmailCursor | null {
  if (!encoded) return null;

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null) return null;

    const { r, i } = parsed as { r?: unknown; i?: unknown };
    if (typeof r !== 'string' || typeof i !== 'string') return null;

    const receivedAt = new Date(r);
    if (Number.isNaN(receivedAt.getTime())) return null;

    return { receivedAt, id: i };
  } catch {
    return null;
  }
}
