import { z } from 'zod';

/**
 * Gmail's message format, and the projection from it into our `Email` shape.
 *
 * Gmail is an external system, so its responses are parsed rather than trusted. The
 * parsing here is deliberately lenient about *shape* — Gmail omits fields freely, and a
 * message with no subject or no body is ordinary, not an error — and strict about what
 * we then store.
 */

/* ─── Wire format ────────────────────────────────────────────────────────── */

const GmailHeaderSchema = z.object({
  name: z.string(),
  value: z.string().default(''),
});

const GmailBodySchema = z.object({
  attachmentId: z.string().optional(),
  size: z.number().int().nonnegative().default(0),
  /** base64url, present only for inline part bodies. */
  data: z.string().optional(),
});

/**
 * A MIME part. Recursive: `multipart/*` messages nest parts arbitrarily deep, so this is
 * declared with an explicit interface and a lazy schema.
 */
// Optional properties are written `?: T | undefined` because the project runs with
// `exactOptionalPropertyTypes`, under which a bare `?: T` forbids an explicit undefined —
// which is exactly what Zod's inferred output produces.
export interface GmailPart {
  partId?: string | undefined;
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: Array<{ name: string; value: string }> | undefined;
  body?:
    | { attachmentId?: string | undefined; size: number; data?: string | undefined }
    | undefined;
  parts?: GmailPart[] | undefined;
}

export const GmailPartSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(GmailHeaderSchema).optional(),
    body: GmailBodySchema.optional(),
    parts: z.array(GmailPartSchema).optional(),
  }),
);

export const GmailMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  labelIds: z.array(z.string()).default([]),
  snippet: z.string().default(''),
  historyId: z.string().optional(),
  /** Epoch milliseconds, as a string. Gmail's own notion of when the message arrived. */
  internalDate: z.string().optional(),
  sizeEstimate: z.number().int().nonnegative().default(0),
  payload: GmailPartSchema.optional(),
});

export type GmailMessage = z.infer<typeof GmailMessageSchema>;

/** A message stub, as returned by messages.list and inside history records. */
export const GmailMessageRefSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1).optional(),
});

export const GmailMessageListSchema = z.object({
  messages: z.array(GmailMessageRefSchema).default([]),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().int().nonnegative().optional(),
});

export type GmailMessageList = z.infer<typeof GmailMessageListSchema>;

export const GmailProfileSchema = z.object({
  emailAddress: z.email(),
  messagesTotal: z.number().int().nonnegative().default(0),
  threadsTotal: z.number().int().nonnegative().default(0),
  historyId: z.string(),
});

export type GmailProfile = z.infer<typeof GmailProfileSchema>;

/* ─── Labels ─────────────────────────────────────────────────────────────── */

export const GMAIL_LABELS = {
  inbox: 'INBOX',
  unread: 'UNREAD',
  starred: 'STARRED',
  important: 'IMPORTANT',
  trash: 'TRASH',
  spam: 'SPAM',
  sent: 'SENT',
  draft: 'DRAFT',
} as const;

/* ─── Projection ─────────────────────────────────────────────────────────── */

/**
 * Bodies are truncated before storage. The cap is generous enough to keep the part of a
 * message a person would actually read, and small enough that one enormous newsletter
 * cannot dominate a row, a payload, or an AI prompt.
 */
export const MAX_BODY_CHARS = 20_000;
export const MAX_SUBJECT_CHARS = 500;

export interface EmailAddress {
  readonly name: string | null;
  readonly email: string;
}

/** What synchronization writes. Deliberately flat — it maps onto the `emails` table. */
export interface EmailProjection {
  readonly gmailMessageId: string;
  readonly gmailThreadId: string;
  readonly subject: string;
  readonly snippet: string;
  readonly bodyText: string | null;
  readonly fromName: string | null;
  readonly fromEmail: string;
  readonly toEmails: string[];
  readonly ccEmails: string[];
  readonly replyTo: string | null;
  readonly receivedAt: Date;
  readonly labels: string[];
  readonly isUnread: boolean;
  readonly isStarred: boolean;
  readonly isImportant: boolean;
  readonly hasAttachments: boolean;
  readonly sizeEstimate: number;
}

/** Case-insensitive header lookup: Gmail's casing is not guaranteed. */
export function findHeader(part: GmailPart | undefined, name: string): string | null {
  if (!part?.headers) return null;
  const target = name.toLowerCase();
  const match = part.headers.find((header) => header.name.toLowerCase() === target);
  return match?.value ?? null;
}

/**
 * Parses an RFC 5322 address list into names and addresses.
 *
 * This is not a full RFC 5322 parser and does not try to be. It handles the forms that
 * actually appear in mail headers — `Name <addr>`, `"Quoted, Name" <addr>`, and a bare
 * address — and splits on commas that are not inside quotes or angle brackets, which is
 * the one piece of real parsing needed: display names containing commas are common
 * ("Doe, Jane <jane@example.com>") and a naive `split(',')` mangles them.
 */
export function parseAddressList(value: string | null): EmailAddress[] {
  if (!value) return [];

  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngles = false;

  for (const char of value) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === '<') {
      inAngles = true;
      current += char;
    } else if (char === '>') {
      inAngles = false;
      current += char;
    } else if (char === ',' && !inQuotes && !inAngles) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);

  return parts
    .map((part) => parseAddress(part.trim()))
    .filter((address): address is EmailAddress => address !== null);
}

function parseAddress(raw: string): EmailAddress | null {
  if (!raw) return null;

  const angled = /^(.*)<([^>]+)>$/.exec(raw);
  if (angled) {
    const name = angled[1]?.trim().replace(/^"|"$/g, '').trim() ?? '';
    const email = angled[2]?.trim().toLowerCase() ?? '';
    if (!email) return null;
    return { name: name.length > 0 ? name : null, email };
  }

  const bare = raw.trim().toLowerCase();
  // Not a strict validation — just enough to reject header noise that is not an address.
  if (!bare.includes('@')) return null;
  return { name: null, email: bare };
}

/** Decodes Gmail's base64url part data. Returns '' rather than throwing on bad input. */
function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Extracts readable text from a message.
 *
 * Prefers `text/plain`. Falls back to `text/html` with tags stripped, because a great
 * deal of real mail is HTML-only and a summary of nothing is worse than a summary of
 * imperfectly de-tagged text. Attachments (parts with a filename) are skipped — their
 * content is not part of the message body, and a text attachment would otherwise be
 * spliced into it.
 */
export function extractBodyText(payload: GmailPart | undefined): string | null {
  if (!payload) return null;

  const plain = collectPartText(payload, 'text/plain');
  if (plain.trim().length > 0) return truncate(plain.trim(), MAX_BODY_CHARS);

  const html = collectPartText(payload, 'text/html');
  if (html.trim().length > 0) {
    return truncate(stripHtml(html).trim(), MAX_BODY_CHARS);
  }

  return null;
}

function collectPartText(part: GmailPart, mimeType: string): string {
  // A part with a filename is an attachment, not body content.
  const isAttachment = Boolean(part.filename && part.filename.length > 0);

  let text = '';

  if (!isAttachment && part.mimeType === mimeType && part.body?.data) {
    text += decodeBase64Url(part.body.data);
  }

  for (const child of part.parts ?? []) {
    text += collectPartText(child, mimeType);
  }

  return text;
}

/**
 * Removes markup to leave readable text.
 *
 * Not a sanitiser and not used for rendering — this output is stored and sent to the AI
 * as text, never inserted into the DOM. `script` and `style` contents are dropped first
 * so their bodies do not end up in the summary.
 */
export function stripHtml(html: string): string {
  return (
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/[ \t]+/g, ' ')
      // Opening tags are replaced by a space, which leaves stray indentation at the start
      // of every line once the closing tags have become newlines. Strip whitespace either
      // side of a newline before collapsing blank lines.
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** True when any part is an attachment. */
export function hasAttachments(payload: GmailPart | undefined): boolean {
  if (!payload) return false;
  if (payload.filename && payload.filename.length > 0) return true;
  return (payload.parts ?? []).some((part) => hasAttachments(part));
}

/**
 * Determines when the message arrived.
 *
 * `internalDate` is preferred over the `Date` header: it is Gmail's own record of
 * receipt, whereas the header is written by the sender and is routinely wrong, missing,
 * or deliberately falsified. The header is the fallback, and `new Date()` the last
 * resort — a message must have a sortable timestamp, because the entire inbox view is
 * ordered by it.
 */
export function resolveReceivedAt(message: GmailMessage, now: Date = new Date()): Date {
  if (message.internalDate) {
    const epochMs = Number(message.internalDate);
    if (Number.isFinite(epochMs) && epochMs > 0) return new Date(epochMs);
  }

  const headerDate = findHeader(message.payload, 'Date');
  if (headerDate) {
    const parsed = new Date(headerDate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return now;
}

export function toEmailProjection(
  message: GmailMessage,
  now: Date = new Date(),
): EmailProjection {
  const payload = message.payload;
  const from = parseAddressList(findHeader(payload, 'From'))[0];
  const labels = message.labelIds;

  return {
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    subject: truncate(findHeader(payload, 'Subject') ?? '', MAX_SUBJECT_CHARS),
    snippet: message.snippet,
    bodyText: extractBodyText(payload),
    fromName: from?.name ?? null,
    // A message with no parseable From is rare but real (malformed bulk mail). An empty
    // string keeps the column non-null and is visibly wrong in the UI, which is better
    // than dropping the message from the mailbox entirely.
    fromEmail: from?.email ?? '',
    toEmails: parseAddressList(findHeader(payload, 'To')).map(
      (address) => address.email,
    ),
    ccEmails: parseAddressList(findHeader(payload, 'Cc')).map(
      (address) => address.email,
    ),
    replyTo: parseAddressList(findHeader(payload, 'Reply-To'))[0]?.email ?? null,
    receivedAt: resolveReceivedAt(message, now),
    labels,
    isUnread: labels.includes(GMAIL_LABELS.unread),
    isStarred: labels.includes(GMAIL_LABELS.starred),
    isImportant: labels.includes(GMAIL_LABELS.important),
    hasAttachments: hasAttachments(payload),
    sizeEstimate: message.sizeEstimate,
  };
}
