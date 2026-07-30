import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEmail, createTestUser, resetDatabase, testDb } from './db';

/**
 * Tests for the guarantees that live in the database rather than in application code:
 * the natural key that makes synchronization idempotent, the cascades that keep a
 * deleted user from leaving orphans, and the triggers that maintain the search vector.
 *
 * These are exactly the behaviours a mocked Prisma client would fake successfully, so
 * they are worth the cost of a real Postgres.
 */

beforeEach(resetDatabase);
afterAll(async () => {
  await testDb.$disconnect();
});

describe('email natural key', () => {
  it('rejects a second row with the same Gmail message id for one user', async () => {
    const user = await createTestUser();
    await createTestEmail(user.id, { gmailMessageId: 'gmail-1' });

    await expect(
      createTestEmail(user.id, { gmailMessageId: 'gmail-1' }),
    ).rejects.toThrow();
  });

  it('allows the same Gmail message id for different users', async () => {
    const [first, second] = await Promise.all([createTestUser(), createTestUser()]);

    await createTestEmail(first.id, { gmailMessageId: 'shared-id' });
    await createTestEmail(second.id, { gmailMessageId: 'shared-id' });

    expect(await testDb.email.count()).toBe(2);
  });

  it('makes a repeated upsert idempotent, which is what resumable sync relies on', async () => {
    const user = await createTestUser();

    const payload = {
      userId: user.id,
      gmailMessageId: 'gmail-42',
      gmailThreadId: 'thread-42',
      subject: 'Quarterly review',
      snippet: 'Agenda attached',
      fromEmail: 'chair@example.test',
      receivedAt: new Date('2026-07-01T09:00:00Z'),
    };

    for (let i = 0; i < 3; i += 1) {
      await testDb.email.upsert({
        where: {
          userId_gmailMessageId: {
            userId: user.id,
            gmailMessageId: 'gmail-42',
          },
        },
        create: payload,
        update: { subject: payload.subject, labels: ['INBOX'] },
      });
    }

    const emails = await testDb.email.findMany();
    expect(emails).toHaveLength(1);
    expect(emails[0]?.subject).toBe('Quarterly review');
  });
});

describe('cascades', () => {
  it('removes everything belonging to a deleted user', async () => {
    const user = await createTestUser();
    const email = await createTestEmail(user.id);

    await testDb.session.create({
      data: {
        userId: user.id,
        tokenHash: 'hash-1',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await testDb.googleAccount.create({ data: { userId: user.id } });
    await testDb.syncCheckpoint.create({ data: { userId: user.id } });
    await testDb.syncRun.create({
      data: { userId: user.id, phase: 'BACKFILL', trigger: 'USER' },
    });
    await testDb.emailAnalysis.create({
      data: {
        emailId: email.id,
        userId: user.id,
        category: 'WORK',
        urgency: 'MEDIUM',
        sentiment: 'NEUTRAL',
        requiresResponse: false,
        confidence: 0.8,
        summary: 'A summary',
        actionItems: [],
        deadlines: [],
        extractedEntities: {},
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 100,
      },
    });

    await testDb.user.delete({ where: { id: user.id } });

    expect(await testDb.email.count()).toBe(0);
    expect(await testDb.session.count()).toBe(0);
    expect(await testDb.googleAccount.count()).toBe(0);
    expect(await testDb.syncCheckpoint.count()).toBe(0);
    expect(await testDb.syncRun.count()).toBe(0);
    expect(await testDb.emailAnalysis.count()).toBe(0);
  });

  it('keeps an analysis tied to its email, not to the message id', async () => {
    const user = await createTestUser();
    const email = await createTestEmail(user.id);
    await testDb.emailAnalysis.create({
      data: {
        emailId: email.id,
        userId: user.id,
        category: 'FINANCE',
        urgency: 'HIGH',
        sentiment: 'NEUTRAL',
        requiresResponse: true,
        confidence: 0.9,
        summary: 'Invoice due',
        actionItems: [],
        deadlines: [],
        extractedEntities: {},
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 100,
      },
    });

    await testDb.email.delete({ where: { id: email.id } });

    expect(await testDb.emailAnalysis.count()).toBe(0);
  });
});

describe('search vector triggers', () => {
  async function search(userId: string, query: string): Promise<number> {
    const rows = await testDb.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM "emails"
      WHERE "userId" = ${userId}::uuid
        AND "searchVector" @@ plainto_tsquery('english', ${query})
    `;
    return Number(rows[0]?.count ?? 0);
  }

  it('indexes the subject, sender name, sender address, and snippet on insert', async () => {
    const user = await createTestUser();
    await createTestEmail(user.id, {
      subject: 'Quarterly invoice attached',
      fromName: 'Acme Billing',
      fromEmail: 'billing@acmecorp.test',
      snippet: 'Please remit payment by Friday',
    });

    expect(await search(user.id, 'invoice')).toBe(1);
    expect(await search(user.id, 'Acme')).toBe(1);
    expect(await search(user.id, 'acmecorp')).toBe(1);
    expect(await search(user.id, 'remit')).toBe(1);
    expect(await search(user.id, 'unrelated')).toBe(0);
  });

  it('folds the AI summary in when an analysis is written', async () => {
    const user = await createTestUser();
    const email = await createTestEmail(user.id, {
      subject: 'Re: thing',
      snippet: 'see below',
    });

    expect(await search(user.id, 'reimbursement')).toBe(0);

    await testDb.emailAnalysis.create({
      data: {
        emailId: email.id,
        userId: user.id,
        category: 'FINANCE',
        urgency: 'LOW',
        sentiment: 'NEUTRAL',
        requiresResponse: false,
        confidence: 0.7,
        summary: 'Finance is asking about a travel reimbursement claim.',
        actionItems: [],
        deadlines: [],
        extractedEntities: {},
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 100,
      },
    });

    expect(await search(user.id, 'reimbursement')).toBe(1);
  });

  it('re-indexes when the subject is updated, without losing the summary', async () => {
    const user = await createTestUser();
    const email = await createTestEmail(user.id, { subject: 'Original subject' });
    await testDb.emailAnalysis.create({
      data: {
        emailId: email.id,
        userId: user.id,
        category: 'WORK',
        urgency: 'LOW',
        sentiment: 'NEUTRAL',
        requiresResponse: false,
        confidence: 0.5,
        summary: 'Discussion about the migration plan.',
        actionItems: [],
        deadlines: [],
        extractedEntities: {},
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 100,
      },
    });

    await testDb.email.update({
      where: { id: email.id },
      data: { subject: 'Rewritten subject about deployments' },
    });

    expect(await search(user.id, 'deployments')).toBe(1);
    expect(await search(user.id, 'migration')).toBe(1);
    expect(await search(user.id, 'Original')).toBe(0);
  });
});

describe('defaults', () => {
  it('starts an email in the PENDING state so it is picked up by the analysis queue', async () => {
    const user = await createTestUser();
    const email = await createTestEmail(user.id);

    expect(email.processingStatus).toBe('PENDING');
    expect(email.processingAttempts).toBe(0);
    expect(email.processingLeaseUntil).toBeNull();
    expect(email.deletedAt).toBeNull();
  });

  it('starts a Google account CONNECTED and a checkpoint in the BACKFILL phase', async () => {
    const user = await createTestUser();
    const account = await testDb.googleAccount.create({ data: { userId: user.id } });
    const checkpoint = await testDb.syncCheckpoint.create({
      data: { userId: user.id },
    });

    expect(account.connectionStatus).toBe('CONNECTED');
    expect(checkpoint.phase).toBe('BACKFILL');
    expect(checkpoint.backfillMessagesSynced).toBe(0);
    expect(checkpoint.historyId).toBeNull();
  });
});
