import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createServerContext, type TrpcContext } from './context';
import { appRouter } from './root';
import { createCallerFactory } from './trpc';
import { createTestEmail, createTestUser, resetDatabase, testDb } from '~/tests/db';

/**
 * The API through a server-side caller.
 *
 * Exercises the real routers, procedures, and repositories against a real database — the
 * only thing skipped is HTTP. The properties under test are the ones the procedure
 * hierarchy exists to guarantee: authentication cannot be forgotten, CSRF cannot be
 * bypassed, and one user cannot read another's mail.
 */

const createCaller = createCallerFactory(appRouter);

/** A caller with no session. */
function anonymousCaller() {
  const ctx: TrpcContext = {
    user: null,
    sessionId: null,
    csrfCookie: null,
    csrfHeader: null,
    requestId: 'test',
  };
  return createCaller(ctx);
}

function callerFor(user: { id: string; email: string }) {
  return createCaller(
    createServerContext({
      id: user.id,
      email: user.email,
      name: null,
      avatarUrl: null,
    }),
  );
}

/** A browser-shaped caller: CSRF cookie and header present, and expected to match. */
function browserCaller(
  user: { id: string; email: string },
  tokens: { cookie: string | null; header: string | null },
) {
  const ctx: TrpcContext = {
    user: { id: user.id, email: user.email, name: null, avatarUrl: null },
    sessionId: 'session-1',
    csrfCookie: tokens.cookie,
    csrfHeader: tokens.header,
    requestId: 'test',
  };
  return createCaller(ctx);
}

async function analysedEmail(
  userId: string,
  overrides: {
    subject?: string;
    category?: 'WORK' | 'FINANCE' | 'MEETING' | 'PERSONAL' | 'PROMOTION';
    urgency?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    requiresResponse?: boolean;
    summary?: string;
    receivedAt?: Date;
  } = {},
) {
  const email = await createTestEmail(userId, {
    ...(overrides.subject ? { subject: overrides.subject } : {}),
    ...(overrides.receivedAt ? { receivedAt: overrides.receivedAt } : {}),
  });

  await testDb.emailAnalysis.create({
    data: {
      emailId: email.id,
      userId,
      category: overrides.category ?? 'WORK',
      urgency: overrides.urgency ?? 'MEDIUM',
      sentiment: 'NEUTRAL',
      requiresResponse: overrides.requiresResponse ?? false,
      confidence: 0.9,
      summary: overrides.summary ?? 'A summary.',
      actionItems: [],
      deadlines: [],
      extractedEntities: {},
      providerId: 'fake',
      model: 'fake-model',
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
    },
  });

  await testDb.email.update({
    where: { id: email.id },
    data: { processingStatus: 'COMPLETED' },
  });

  return email;
}

beforeEach(resetDatabase);
afterAll(async () => {
  await testDb.$disconnect();
});

describe('authentication', () => {
  it('rejects protected queries without a session', async () => {
    await expect(anonymousCaller().emails.list({} as never)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects mutations without a session', async () => {
    await expect(anonymousCaller().sync.runNow()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('allows the public me query and reports no user', async () => {
    expect(await anonymousCaller().me()).toEqual({ user: null });
  });

  it('reports the signed-in user', async () => {
    const user = await createTestUser();
    expect((await callerFor(user).me()).user?.id).toBe(user.id);
  });
});

describe('CSRF', () => {
  it('rejects a mutation whose header does not match its cookie', async () => {
    const user = await createTestUser();

    await expect(
      browserCaller(user, { cookie: 'token-a', header: 'token-b' }).sync.runNow(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a mutation with a cookie but no header', async () => {
    const user = await createTestUser();

    await expect(
      browserCaller(user, { cookie: 'token-a', header: null }).sync.runNow(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('does not apply CSRF to queries, which change nothing', async () => {
    const user = await createTestUser();

    await expect(
      browserCaller(user, { cookie: 'token-a', header: null }).emails.list({} as never),
    ).resolves.toBeDefined();
  });
});

describe('user scoping', () => {
  it('lists only the caller’s emails', async () => {
    const [user, other] = await Promise.all([createTestUser(), createTestUser()]);
    await analysedEmail(user.id, { subject: 'Mine' });
    await analysedEmail(other.id, { subject: 'Theirs' });

    const page = await callerFor(user).emails.list({} as never);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.subject).toBe('Mine');
  });

  it('refuses to fetch another user’s email by id', async () => {
    const [user, other] = await Promise.all([createTestUser(), createTestUser()]);
    const theirs = await analysedEmail(other.id);

    await expect(callerFor(user).emails.byId({ id: theirs.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses to mark another user’s email read', async () => {
    const [user, other] = await Promise.all([createTestUser(), createTestUser()]);
    const theirs = await analysedEmail(other.id);

    await expect(
      callerFor(user).emails.markRead({ id: theirs.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // And it really was not modified.
    const after = await testDb.email.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(after.isUnread).toBe(true);
  });

  it('scopes dashboard aggregates to the caller', async () => {
    const [user, other] = await Promise.all([createTestUser(), createTestUser()]);
    await analysedEmail(user.id);
    await analysedEmail(other.id);
    await analysedEmail(other.id);

    const stats = await callerFor(user).analytics.dashboard();

    expect(stats.totalEmails).toBe(1);
    expect(stats.analysedEmails).toBe(1);
  });
});

describe('views and filters', () => {
  it('filters to emails needing a reply', async () => {
    const user = await createTestUser();
    await analysedEmail(user.id, { subject: 'Needs reply', requiresResponse: true });
    await analysedEmail(user.id, {
      subject: 'No reply needed',
      requiresResponse: false,
    });

    const page = await callerFor(user).emails.list({ view: 'needs-reply' } as never);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.subject).toBe('Needs reply');
  });

  it('filters by category view', async () => {
    const user = await createTestUser();
    await analysedEmail(user.id, { subject: 'Invoice', category: 'FINANCE' });
    await analysedEmail(user.id, { subject: 'Standup', category: 'MEETING' });

    const finance = await callerFor(user).emails.list({ view: 'finance' } as never);
    expect(finance.items.map((item) => item.subject)).toEqual(['Invoice']);
  });

  it('treats Gmail importance and AI urgency as equivalent signals', async () => {
    const user = await createTestUser();
    await analysedEmail(user.id, { subject: 'AI says urgent', urgency: 'CRITICAL' });

    const gmailImportant = await createTestEmail(user.id, {
      subject: 'Gmail says important',
    });
    await testDb.email.update({
      where: { id: gmailImportant.id },
      data: { isImportant: true },
    });

    await analysedEmail(user.id, { subject: 'Routine', urgency: 'LOW' });

    const page = await callerFor(user).emails.list({ view: 'important' } as never);

    expect(page.items.map((item) => item.subject).sort()).toEqual([
      'AI says urgent',
      'Gmail says important',
    ]);
  });

  it('combines a view with an explicit filter rather than replacing it', async () => {
    const user = await createTestUser();
    await analysedEmail(user.id, {
      subject: 'Urgent invoice',
      category: 'FINANCE',
      urgency: 'CRITICAL',
    });
    await analysedEmail(user.id, {
      subject: 'Routine invoice',
      category: 'FINANCE',
      urgency: 'LOW',
    });

    const page = await callerFor(user).emails.list({
      view: 'finance',
      urgency: 'CRITICAL',
    } as never);

    expect(page.items.map((item) => item.subject)).toEqual(['Urgent invoice']);
  });

  it('filters to unread only', async () => {
    const user = await createTestUser();
    const read = await analysedEmail(user.id, { subject: 'Read' });
    await analysedEmail(user.id, { subject: 'Unread' });
    await testDb.email.update({ where: { id: read.id }, data: { isUnread: false } });

    const page = await callerFor(user).emails.list({ unreadOnly: true } as never);
    expect(page.items.map((item) => item.subject)).toEqual(['Unread']);
  });
});

describe('pagination', () => {
  it('pages with a stable cursor and no repeats', async () => {
    const user = await createTestUser();
    for (let i = 0; i < 7; i += 1) {
      await analysedEmail(user.id, {
        subject: `Email ${i}`,
        receivedAt: new Date(Date.UTC(2026, 6, 1 + i)),
      });
    }

    const caller = callerFor(user);
    const first = await caller.emails.list({ limit: 3 } as never);
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();

    const second = await caller.emails.list({
      limit: 3,
      cursor: first.nextCursor,
    } as never);
    const third = await caller.emails.list({
      limit: 3,
      cursor: second.nextCursor,
    } as never);

    const all = [...first.items, ...second.items, ...third.items].map(
      (item) => item.id,
    );
    expect(new Set(all).size).toBe(7);
    expect(third.nextCursor).toBeNull();
  });

  it('does not repeat a row when emails share a timestamp', async () => {
    // Bulk mail routinely shares a timestamp; a cursor on receivedAt alone would repeat.
    const user = await createTestUser();
    const sameInstant = new Date('2026-07-01T12:00:00Z');
    for (let i = 0; i < 5; i += 1) {
      await analysedEmail(user.id, { subject: `Bulk ${i}`, receivedAt: sameInstant });
    }

    const caller = callerFor(user);
    const first = await caller.emails.list({ limit: 2 } as never);
    const second = await caller.emails.list({
      limit: 2,
      cursor: first.nextCursor,
    } as never);
    const third = await caller.emails.list({
      limit: 2,
      cursor: second.nextCursor,
    } as never);

    const ids = [...first.items, ...second.items, ...third.items].map(
      (item) => item.id,
    );
    expect(new Set(ids).size).toBe(5);
  });

  it('shows the first page for a malformed cursor rather than failing', async () => {
    const user = await createTestUser();
    await analysedEmail(user.id);

    const page = await callerFor(user).emails.list({ cursor: 'not-a-cursor' } as never);
    expect(page.items).toHaveLength(1);
  });
});

describe('search', () => {
  it('finds emails by subject and by AI summary', async () => {
    const user = await createTestUser();
    await analysedEmail(user.id, {
      subject: 'Quarterly invoice',
      summary: 'Acme is requesting payment.',
    });
    await analysedEmail(user.id, {
      subject: 'Team lunch',
      summary: 'Social plans for Friday.',
    });

    const caller = callerFor(user);
    expect(
      (await caller.emails.list({ search: 'invoice' } as never)).items,
    ).toHaveLength(1);
    // The summary is in the search vector too.
    expect(
      (await caller.emails.list({ search: 'payment' } as never)).items,
    ).toHaveLength(1);
    expect(
      (await caller.emails.list({ search: 'nonexistent' } as never)).items,
    ).toHaveLength(0);
  });

  it('does not leak another user’s emails into search results', async () => {
    const [user, other] = await Promise.all([createTestUser(), createTestUser()]);
    await analysedEmail(other.id, { subject: 'Secret invoice' });

    const page = await callerFor(user).emails.list({ search: 'invoice' } as never);
    expect(page.items).toHaveLength(0);
  });

  it('treats a search phrase safely rather than as SQL', async () => {
    const user = await createTestUser();
    await analysedEmail(user.id, { subject: 'Normal email' });

    const page = await callerFor(user).emails.list({
      search: "'; DROP TABLE emails; --",
    } as never);

    expect(page.items).toHaveLength(0);
    // The table is very much still there.
    expect(await testDb.email.count()).toBe(1);
  });
});

describe('sorting', () => {
  it('sorts newest first by default and oldest first on request', async () => {
    const user = await createTestUser();
    await analysedEmail(user.id, {
      subject: 'Older',
      receivedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await analysedEmail(user.id, {
      subject: 'Newer',
      receivedAt: new Date('2026-07-01T00:00:00Z'),
    });

    const caller = callerFor(user);
    expect((await caller.emails.list({} as never)).items[0]?.subject).toBe('Newer');
    expect(
      (await caller.emails.list({ sort: 'oldest' } as never)).items[0]?.subject,
    ).toBe('Older');
  });

  it('sorts by urgency, and excludes unanalysed emails from that ordering', async () => {
    const user = await createTestUser();
    await analysedEmail(user.id, { subject: 'Low', urgency: 'LOW' });
    await analysedEmail(user.id, { subject: 'Critical', urgency: 'CRITICAL' });
    // Unanalysed: has no urgency to sort on.
    await createTestEmail(user.id, { subject: 'Unanalysed' });

    const page = await callerFor(user).emails.list({ sort: 'urgency' } as never);

    expect(page.items.map((item) => item.subject)).toEqual(['Critical', 'Low']);
  });
});

describe('mutations', () => {
  it('marks an email read', async () => {
    const user = await createTestUser();
    const email = await analysedEmail(user.id);

    await callerFor(user).emails.markRead({ id: email.id });

    const after = await testDb.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(after.isUnread).toBe(false);
  });

  it('refuses a second concurrent sync', async () => {
    const user = await createTestUser();
    await testDb.syncRun.create({
      data: {
        userId: user.id,
        phase: 'INCREMENTAL',
        trigger: 'CRON',
        status: 'RUNNING',
      },
    });

    await expect(callerFor(user).sync.runNow()).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('rate limits repeated mutations', async () => {
    const user = await createTestUser();
    const email = await analysedEmail(user.id);
    const caller = callerFor(user);

    // The default window allows 30; the 31st must be refused.
    for (let i = 0; i < 30; i += 1) {
      await caller.emails.markRead({ id: email.id });
    }

    await expect(caller.emails.markRead({ id: email.id })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });
});

describe('dashboard', () => {
  it('reports the widget counts', async () => {
    const user = await createTestUser();
    await analysedEmail(user.id, { requiresResponse: true });
    await analysedEmail(user.id, { requiresResponse: false });
    await createTestEmail(user.id); // pending
    const failed = await createTestEmail(user.id);
    await testDb.email.update({
      where: { id: failed.id },
      data: { processingStatus: 'FAILED' },
    });

    const stats = await callerFor(user).analytics.dashboard();

    expect(stats.totalEmails).toBe(4);
    expect(stats.analysedEmails).toBe(2);
    expect(stats.queueDepth).toBe(1);
    expect(stats.failedEmails).toBe(1);
    expect(stats.needsReply).toBe(1);
    expect(stats.averageProcessingMs).toBe(100);
  });

  it('breaks down counts by category', async () => {
    const user = await createTestUser();
    await analysedEmail(user.id, { category: 'FINANCE' });
    await analysedEmail(user.id, { category: 'FINANCE' });
    await analysedEmail(user.id, { category: 'MEETING' });

    const stats = await callerFor(user).analytics.dashboard();

    expect(stats.categories).toContainEqual({ category: 'FINANCE', count: 2 });
    expect(stats.categories).toContainEqual({ category: 'MEETING', count: 1 });
  });

  it('works for a brand new user with no mail', async () => {
    const user = await createTestUser();

    const stats = await callerFor(user).analytics.dashboard();

    expect(stats.totalEmails).toBe(0);
    expect(stats.averageProcessingMs).toBeNull();
    expect(stats.isSyncing).toBe(false);
    expect(stats.lastRun).toBeNull();
  });
});
