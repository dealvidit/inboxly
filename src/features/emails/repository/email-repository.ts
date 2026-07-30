import { Prisma, ProcessingStatus, db } from '@/server/db';
import {
  decodeCursor,
  encodeCursor,
  type EmailCursor,
  type EmailListInput,
  type EmailView,
} from '../domain/query';

/**
 * Reads for the dashboard.
 *
 * Every function takes `userId` and puts it in the `where` clause. There is deliberately
 * no `getEmailById(id)` — only `getEmailForUser({ userId, emailId })` — so a missing
 * check in a router cannot expose another user's mail (ADR 0008).
 */

/** The shape the list renders. Bodies are excluded — the list never shows them. */
const listSelect = {
  id: true,
  gmailMessageId: true,
  gmailThreadId: true,
  subject: true,
  snippet: true,
  fromName: true,
  fromEmail: true,
  receivedAt: true,
  isUnread: true,
  isStarred: true,
  isImportant: true,
  hasAttachments: true,
  processingStatus: true,
  analysis: {
    select: {
      category: true,
      urgency: true,
      sentiment: true,
      requiresResponse: true,
      confidence: true,
      summary: true,
    },
  },
} satisfies Prisma.EmailSelect;

export type EmailListItem = Prisma.EmailGetPayload<{ select: typeof listSelect }>;

export interface EmailPage {
  readonly items: EmailListItem[];
  readonly nextCursor: string | null;
}

/**
 * Translates a view into filters, so views and explicit filters share one query path.
 *
 * A view contributes either constraints on the analysis, or a top-level clause when it
 * spans more than the analysis (as `important` does).
 */
function viewFilter(view: EmailView): {
  analysis?: Prisma.EmailAnalysisWhereInput;
  email?: Prisma.EmailWhereInput;
} {
  switch (view) {
    case 'needs-reply':
      return { analysis: { requiresResponse: true } };
    case 'important':
      // Either signal counts: Gmail's own IMPORTANT label, or the AI's judgement.
      return {
        email: {
          OR: [
            { isImportant: true },
            { analysis: { is: { urgency: { in: ['HIGH', 'CRITICAL'] } } } },
          ],
        },
      };
    case 'meetings':
      return { analysis: { category: 'MEETING' } };
    case 'finance':
      return { analysis: { category: 'FINANCE' } };
    case 'personal':
      return { analysis: { category: 'PERSONAL' } };
    case 'promotions':
      return { analysis: { category: { in: ['PROMOTION', 'NEWSLETTER'] } } };
    case 'inbox':
      return {};
  }
}

function buildWhere(userId: string, input: EmailListInput): Prisma.EmailWhereInput {
  const view = viewFilter(input.view);

  // Analysis constraints from the view and from explicit filters are merged into one
  // relation filter, rather than assigned in sequence — a later assignment would silently
  // replace the view's own constraint.
  const analysis: Prisma.EmailAnalysisWhereInput = {
    ...view.analysis,
    ...(input.category ? { category: input.category } : {}),
    ...(input.urgency ? { urgency: input.urgency } : {}),
  };

  // Sorting by urgency requires an analysis to sort on, so that sort implies the filter.
  const requiresAnalysis = input.sort === 'urgency';

  return {
    userId,
    deletedAt: null,
    ...view.email,
    ...(Object.keys(analysis).length > 0
      ? { analysis: { is: analysis } }
      : requiresAnalysis
        ? { analysis: { isNot: null } }
        : {}),
    ...(input.unreadOnly ? { isUnread: true } : {}),
    ...(input.from || input.to
      ? {
          receivedAt: {
            ...(input.from ? { gte: input.from } : {}),
            ...(input.to ? { lte: input.to } : {}),
          },
        }
      : {}),
  };
}

/**
 * Applies the keyset cursor.
 *
 * The comparison is on the tuple `(receivedAt, id)`, not on `receivedAt` alone: rows
 * sharing a timestamp would otherwise be repeated or skipped at the page boundary.
 */
function cursorFilter(
  cursor: EmailCursor | null,
  descending: boolean,
): Prisma.EmailWhereInput | null {
  if (!cursor) return null;

  return descending
    ? {
        OR: [
          { receivedAt: { lt: cursor.receivedAt } },
          { receivedAt: cursor.receivedAt, id: { lt: cursor.id } },
        ],
      }
    : {
        OR: [
          { receivedAt: { gt: cursor.receivedAt } },
          { receivedAt: cursor.receivedAt, id: { gt: cursor.id } },
        ],
      };
}

export async function listEmails(
  userId: string,
  input: EmailListInput,
): Promise<EmailPage> {
  // A search term is answered by a different query: full-text ranking lives in SQL.
  if (input.search && input.search.length > 0) {
    return searchEmails(userId, input);
  }

  const descending = input.sort !== 'oldest';
  const cursor = decodeCursor(input.cursor);
  const keyset = cursorFilter(cursor, descending);

  const where: Prisma.EmailWhereInput = keyset
    ? { AND: [buildWhere(userId, input), keyset] }
    : buildWhere(userId, input);

  const direction: Prisma.SortOrder = descending ? 'desc' : 'asc';

  // Sorting by urgency is only meaningful for emails that have been analysed, so that
  // sort restricts to them (see `buildWhere`) rather than relying on null ordering to
  // keep unanalysed mail out of the way. Date breaks ties within an urgency band.
  const orderBy: Prisma.EmailOrderByWithRelationInput[] =
    input.sort === 'urgency'
      ? [{ analysis: { urgency: 'desc' } }, { receivedAt: 'desc' }, { id: 'desc' }]
      : [{ receivedAt: direction }, { id: direction }];

  // One extra row tells us whether another page exists, without a second count query.
  const rows = await db.email.findMany({
    where,
    orderBy,
    take: input.limit + 1,
    select: listSelect,
  });

  const hasMore = rows.length > input.limit;
  const items = hasMore ? rows.slice(0, input.limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ receivedAt: last.receivedAt, id: last.id })
        : null,
  };
}

/**
 * Full-text search.
 *
 * Raw SQL because Prisma cannot express `tsvector` operators. Ranking is by
 * `ts_rank_cd` — a message whose subject matches should outrank one that merely mentions
 * the term in its body, which the weighted vector already encodes.
 *
 * Offset pagination here rather than keyset: the sort key is a computed rank, so there is
 * no stable column to page on. Search results are read in the first page or two, so the
 * cost of offset paging is not a real one.
 */
async function searchEmails(userId: string, input: EmailListInput): Promise<EmailPage> {
  const offset = Number(input.cursor ?? '0') || 0;
  const query = input.search ?? '';

  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT e."id"
    FROM "emails" e
    LEFT JOIN "email_analyses" a ON a."emailId" = e."id"
    WHERE e."userId" = ${userId}::uuid
      AND e."deletedAt" IS NULL
      AND e."searchVector" @@ websearch_to_tsquery('english', ${query})
      ${input.unreadOnly ? Prisma.sql`AND e."isUnread" = true` : Prisma.empty}
      ${
        input.category
          ? Prisma.sql`AND a."category" = ${input.category}::"EmailCategory"`
          : Prisma.empty
      }
      ${
        input.urgency
          ? Prisma.sql`AND a."urgency" = ${input.urgency}::"Urgency"`
          : Prisma.empty
      }
    ORDER BY ts_rank_cd(e."searchVector", websearch_to_tsquery('english', ${query})) DESC,
             e."receivedAt" DESC
    LIMIT ${input.limit + 1} OFFSET ${offset}
  `;

  const hasMore = rows.length > input.limit;
  const ids = (hasMore ? rows.slice(0, input.limit) : rows).map((row) => row.id);

  if (ids.length === 0) return { items: [], nextCursor: null };

  // Hydrate through the typed client, then restore the rank order the database chose.
  const items = await db.email.findMany({
    where: { id: { in: ids } },
    select: listSelect,
  });
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((item): item is EmailListItem => item !== undefined);

  return {
    items: ordered,
    nextCursor: hasMore ? String(offset + input.limit) : null,
  };
}

/** The detail view. Returns null rather than throwing when it belongs to someone else. */
export async function getEmailForUser(userId: string, emailId: string) {
  return db.email.findFirst({
    where: { id: emailId, userId, deletedAt: null },
    include: { analysis: true },
  });
}

/** Every message in a thread, so the detail view can show the conversation. */
export async function getThreadForUser(userId: string, gmailThreadId: string) {
  return db.email.findMany({
    where: { userId, gmailThreadId, deletedAt: null },
    orderBy: { receivedAt: 'asc' },
    select: listSelect,
  });
}

/* ─── Aggregates for the dashboard widgets ───────────────────────────────── */

export interface DashboardStats {
  readonly totalEmails: number;
  readonly analysedEmails: number;
  readonly queueDepth: number;
  readonly failedEmails: number;
  readonly needsReply: number;
  readonly averageProcessingMs: number | null;
}

/**
 * Every widget in one round trip.
 *
 * A grouped count plus one aggregate, rather than seven separate queries — the widgets
 * are rendered together, so they should cost one trip together.
 */
export async function getDashboardStats(userId: string): Promise<DashboardStats> {
  const [byStatus, latency, needsReply] = await Promise.all([
    db.email.groupBy({
      by: ['processingStatus'],
      where: { userId, deletedAt: null },
      _count: { _all: true },
    }),
    db.emailAnalysis.aggregate({
      where: { userId },
      _avg: { latencyMs: true },
    }),
    db.emailAnalysis.count({ where: { userId, requiresResponse: true } }),
  ]);

  const counts = new Map(
    byStatus.map((row) => [row.processingStatus, row._count._all] as const),
  );
  const countOf = (status: ProcessingStatus) => counts.get(status) ?? 0;

  return {
    totalEmails: [...counts.values()].reduce((sum, count) => sum + count, 0),
    analysedEmails: countOf(ProcessingStatus.COMPLETED),
    queueDepth:
      countOf(ProcessingStatus.PENDING) +
      countOf(ProcessingStatus.NEEDS_RETRY) +
      countOf(ProcessingStatus.PROCESSING),
    failedEmails: countOf(ProcessingStatus.FAILED),
    needsReply,
    averageProcessingMs: latency._avg.latencyMs,
  };
}

/** Counts per category, for the dashboard's breakdown. */
export async function getCategoryBreakdown(userId: string) {
  const rows = await db.emailAnalysis.groupBy({
    by: ['category'],
    where: { userId },
    _count: { _all: true },
    orderBy: { _count: { category: 'desc' } },
  });

  return rows.map((row) => ({ category: row.category, count: row._count._all }));
}

/** Marks an email read locally. Gmail remains the authority; sync will reconcile. */
export async function markRead(userId: string, emailId: string): Promise<boolean> {
  const { count } = await db.email.updateMany({
    where: { id: emailId, userId },
    data: { isUnread: false },
  });
  return count > 0;
}
