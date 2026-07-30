import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createEmailAnalyzer, createFakeProvider } from '@/features/ai';
import { AiAuthError, AiRateLimitError, AiRefusalError } from '@/features/ai';
import * as queue from '../repository/queue-repository';
import { createAnalysisRunner } from './analysis-runner';
import { createTestEmail, createTestUser, resetDatabase, testDb } from '~/tests/db';

/**
 * The processing lifecycle against a real Postgres.
 *
 * The claim query is the reason these are integration tests: `FOR UPDATE SKIP LOCKED` is
 * the entire concurrency-control story, and it exists only in the database. A mocked
 * client would report success for a query that does not actually serialise anything.
 */

const validAnalysis = JSON.stringify({
  category: 'WORK',
  urgency: 'MEDIUM',
  sentiment: 'NEUTRAL',
  requiresResponse: false,
  confidence: 0.8,
  summary: 'A routine work email that needs no reply.',
  suggestedReply: null,
  actionItems: [],
  deadlines: [],
  meetingInformation: null,
  extractedEntities: {
    people: [],
    organisations: [],
    amounts: [],
    dates: [],
    links: [],
  },
});

function runner(
  options: {
    responses?: string[];
    errors?: (Error | null)[];
    batchSize?: number;
    maxAttempts?: number;
    leaseMs?: number;
    timeBudgetMs?: number;
    now?: () => Date;
  } = {},
) {
  const provider = createFakeProvider({
    responses: options.responses ?? [validAnalysis],
    ...(options.errors ? { errors: options.errors } : {}),
  });

  return createAnalysisRunner({
    analyzer: createEmailAnalyzer({ provider, maxCorrections: 0 }),
    batchSize: options.batchSize ?? 10,
    maxAttempts: options.maxAttempts ?? 3,
    leaseMs: options.leaseMs ?? 300_000,
    timeBudgetMs: options.timeBudgetMs ?? 45_000,
    ...(options.now ? { now: options.now } : {}),
  });
}

beforeEach(resetDatabase);
afterAll(async () => {
  await testDb.$disconnect();
});

describe('claiming', () => {
  it('claims pending emails and marks them PROCESSING with a lease', async () => {
    const user = await createTestUser();
    await createTestEmail(user.id);
    await createTestEmail(user.id);

    const claimed = await queue.claimEmailsForAnalysis(user.id, 10, 300_000);

    expect(claimed).toHaveLength(2);
    const rows = await testDb.email.findMany({ where: { userId: user.id } });
    for (const row of rows) {
      expect(row.processingStatus).toBe('PROCESSING');
      expect(row.processingAttempts).toBe(1);
      expect(row.processingLeaseUntil).not.toBeNull();
    }
  });

  it('never hands the same email to two concurrent runners', async () => {
    // The guarantee the whole design rests on. Without SKIP LOCKED these two claims
    // would either block or overlap.
    const user = await createTestUser();
    for (let i = 0; i < 10; i += 1) await createTestEmail(user.id);

    const [first, second] = await Promise.all([
      queue.claimEmailsForAnalysis(user.id, 5, 300_000),
      queue.claimEmailsForAnalysis(user.id, 5, 300_000),
    ]);

    const ids = [...first, ...second].map((email) => email.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(10);
  });

  it('respects the batch limit', async () => {
    const user = await createTestUser();
    for (let i = 0; i < 8; i += 1) await createTestEmail(user.id);

    expect(await queue.claimEmailsForAnalysis(user.id, 3, 300_000)).toHaveLength(3);
  });

  it('claims newest first, so recent mail is triaged before a backlog', async () => {
    const user = await createTestUser();
    await createTestEmail(user.id, {
      gmailMessageId: 'old',
      receivedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await createTestEmail(user.id, {
      gmailMessageId: 'new',
      receivedAt: new Date('2026-07-01T00:00:00Z'),
    });

    const claimed = await queue.claimEmailsForAnalysis(user.id, 1, 300_000);
    expect(claimed[0]?.gmailMessageId).toBe('new');
  });

  it('does not claim another user’s emails', async () => {
    const [user, other] = await Promise.all([createTestUser(), createTestUser()]);
    await createTestEmail(other.id);

    expect(await queue.claimEmailsForAnalysis(user.id, 10, 300_000)).toHaveLength(0);
  });

  it('skips deleted and completed emails', async () => {
    const user = await createTestUser();
    const deleted = await createTestEmail(user.id);
    const done = await createTestEmail(user.id);
    await testDb.email.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });
    await testDb.email.update({
      where: { id: done.id },
      data: { processingStatus: 'COMPLETED' },
    });

    expect(await queue.claimEmailsForAnalysis(user.id, 10, 300_000)).toHaveLength(0);
  });

  it('claims NEEDS_RETRY emails alongside pending ones', async () => {
    const user = await createTestUser();
    const email = await createTestEmail(user.id);
    await testDb.email.update({
      where: { id: email.id },
      data: { processingStatus: 'NEEDS_RETRY' },
    });

    expect(await queue.claimEmailsForAnalysis(user.id, 10, 300_000)).toHaveLength(1);
  });
});

describe('lease expiry', () => {
  it('reclaims an email whose runner died, with no separate janitor', async () => {
    const user = await createTestUser();
    const email = await createTestEmail(user.id);

    // A process that claimed the row and never came back.
    await testDb.email.update({
      where: { id: email.id },
      data: {
        processingStatus: 'PROCESSING',
        processingLeaseUntil: new Date(Date.now() - 60_000),
        processingAttempts: 1,
      },
    });

    const claimed = await queue.claimEmailsForAnalysis(user.id, 10, 300_000);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.processingAttempts).toBe(2);
  });

  it('leaves a live lease alone', async () => {
    const user = await createTestUser();
    const email = await createTestEmail(user.id);
    await testDb.email.update({
      where: { id: email.id },
      data: {
        processingStatus: 'PROCESSING',
        processingLeaseUntil: new Date(Date.now() + 300_000),
      },
    });

    expect(await queue.claimEmailsForAnalysis(user.id, 10, 300_000)).toHaveLength(0);
  });
});

describe('running a batch', () => {
  it('analyses claimed emails and stores the result', async () => {
    const user = await createTestUser();
    await createTestEmail(user.id, { subject: 'Project update' });

    const result = await runner().run(user.id);

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, retrying: 0 });

    const email = await testDb.email.findFirstOrThrow({ where: { userId: user.id } });
    expect(email.processingStatus).toBe('COMPLETED');
    expect(email.processedAt).not.toBeNull();
    expect(email.processingLeaseUntil).toBeNull();

    const analysis = await testDb.emailAnalysis.findFirstOrThrow({
      where: { emailId: email.id },
    });
    expect(analysis.category).toBe('WORK');
    expect(analysis.summary).toBe('A routine work email that needs no reply.');
    expect(analysis.providerId).toBe('fake');
  });

  it('records an attempt row for every analysis, successful or not', async () => {
    const user = await createTestUser();
    await createTestEmail(user.id);

    await runner().run(user.id);

    const attempts = await testDb.analysisAttempt.findMany({
      where: { userId: user.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('SUCCEEDED');
  });

  it('does nothing and reports no work when the queue is empty', async () => {
    const user = await createTestUser();

    expect(await runner().run(user.id)).toMatchObject({
      claimed: 0,
      hasMoreWork: false,
    });
  });

  it('is idempotent — a second run finds nothing left to do', async () => {
    const user = await createTestUser();
    await createTestEmail(user.id);

    await runner().run(user.id);
    const second = await runner().run(user.id);

    expect(second.claimed).toBe(0);
    expect(await testDb.emailAnalysis.count()).toBe(1);
  });

  it('re-runs analysis without duplicating the 1:1 row', async () => {
    const user = await createTestUser();
    const email = await createTestEmail(user.id);

    await runner().run(user.id);
    // An operator re-queues it, e.g. after a schema change.
    await testDb.email.update({
      where: { id: email.id },
      data: { processingStatus: 'PENDING', processingAttempts: 0 },
    });
    await runner().run(user.id);

    expect(await testDb.emailAnalysis.count()).toBe(1);
    expect(await testDb.analysisAttempt.count()).toBe(2);
  });

  it('reports more work when the batch fills up', async () => {
    const user = await createTestUser();
    for (let i = 0; i < 5; i += 1) await createTestEmail(user.id);

    const result = await runner({ batchSize: 2 }).run(user.id);

    expect(result.claimed).toBe(2);
    expect(result.hasMoreWork).toBe(true);
  });
});

describe('failure handling', () => {
  it('returns an email to the queue after a retryable failure', async () => {
    const user = await createTestUser();
    await createTestEmail(user.id);

    const result = await runner({
      errors: [new AiRateLimitError('fake', 30)],
    }).run(user.id);

    expect(result).toMatchObject({ completed: 0, retrying: 1 });

    const email = await testDb.email.findFirstOrThrow({ where: { userId: user.id } });
    expect(email.processingStatus).toBe('NEEDS_RETRY');
    expect(email.processingLeaseUntil).toBeNull();
    // A user-safe message, not provider text.
    expect(email.processingError).toContain('rate limited');
  });

  it('fails an email outright on a terminal failure, without spending retries', async () => {
    const user = await createTestUser();
    await createTestEmail(user.id);

    const result = await runner({
      errors: [new AiRefusalError('fake', 'cyber')],
    }).run(user.id);

    expect(result).toMatchObject({ failed: 1 });

    const email = await testDb.email.findFirstOrThrow({ where: { userId: user.id } });
    expect(email.processingStatus).toBe('FAILED');
    expect(email.processingAttempts).toBe(1);
  });

  it('gives up once the attempt budget is exhausted', async () => {
    const user = await createTestUser();
    const email = await createTestEmail(user.id);
    // Two attempts already spent, budget is three.
    await testDb.email.update({
      where: { id: email.id },
      data: { processingStatus: 'NEEDS_RETRY', processingAttempts: 2 },
    });

    await runner({
      errors: [new AiRateLimitError('fake')],
      maxAttempts: 3,
    }).run(user.id);

    const after = await testDb.email.findFirstOrThrow({ where: { id: email.id } });
    expect(after.processingStatus).toBe('FAILED');
    expect(after.processingError).toContain('giving up after 3 attempts');
  });

  it('keeps retrying while the budget remains', async () => {
    const user = await createTestUser();
    const email = await createTestEmail(user.id);
    await testDb.email.update({
      where: { id: email.id },
      data: { processingStatus: 'NEEDS_RETRY', processingAttempts: 1 },
    });

    await runner({ errors: [new AiRateLimitError('fake')], maxAttempts: 3 }).run(
      user.id,
    );

    expect(
      (await testDb.email.findFirstOrThrow({ where: { id: email.id } }))
        .processingStatus,
    ).toBe('NEEDS_RETRY');
  });

  it('fails an email whose output never validates, and keeps the diagnosis', async () => {
    const user = await createTestUser();
    await createTestEmail(user.id);

    const result = await runner({ responses: ['not json at all'] }).run(user.id);

    expect(result).toMatchObject({ failed: 1 });
    const attempt = await testDb.analysisAttempt.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(attempt.outcome).toBe('UNPARSEABLE_OUTPUT');
    expect(attempt.rawResponse).toContain('not json at all');
    // Nothing invalid was persisted as an analysis.
    expect(await testDb.emailAnalysis.count()).toBe(0);
  });

  it('stops the batch on a misconfiguration instead of failing every email', async () => {
    // A bad API key is an operator problem. Working through the batch would burn every
    // email's retry budget on the same fault and permanently fail the whole mailbox.
    const user = await createTestUser();
    for (let i = 0; i < 4; i += 1) await createTestEmail(user.id);

    const result = await runner({
      errors: [new AiAuthError('fake', 'API key is invalid')],
    }).run(user.id);

    expect(result.claimed).toBe(4);
    expect(result.failed).toBe(0);

    // Every email is back in the queue, and none was permanently failed.
    expect(await testDb.email.count({ where: { processingStatus: 'FAILED' } })).toBe(0);
    expect(await queue.countClaimable(user.id)).toBe(4);
  });

  it('does not consume the retry budget for a misconfiguration', async () => {
    const user = await createTestUser();
    const email = await createTestEmail(user.id);
    await testDb.email.update({
      where: { id: email.id },
      data: { processingStatus: 'NEEDS_RETRY', processingAttempts: 2 },
    });

    // Budget is 3 and two attempts are already spent; an auth failure must still not
    // retire the email, because the fault is not the email's.
    await runner({
      errors: [new AiAuthError('fake', 'API key is invalid')],
      maxAttempts: 3,
    }).run(user.id);

    expect(
      (await testDb.email.findFirstOrThrow({ where: { id: email.id } }))
        .processingStatus,
    ).toBe('NEEDS_RETRY');
  });

  it('one email failing does not stop the rest of the batch', async () => {
    const user = await createTestUser();
    for (let i = 0; i < 3; i += 1) await createTestEmail(user.id);

    const result = await runner({
      errors: [new AiRefusalError('fake', null), null, null],
    }).run(user.id);

    expect(result.claimed).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.completed).toBe(2);
  });
});

describe('time budget', () => {
  it('defers the rest of the batch rather than being killed mid-write', async () => {
    const user = await createTestUser();
    for (let i = 0; i < 4; i += 1) await createTestEmail(user.id);

    // A clock that jumps past the budget after the first email.
    let ticks = 0;
    const start = Date.parse('2026-07-30T10:00:00Z');
    const jumpyClock = () => {
      ticks += 1;
      return new Date(start + (ticks > 3 ? 60_000 : 0));
    };

    const result = await runner({ now: jumpyClock, timeBudgetMs: 30_000 }).run(user.id);

    expect(result.claimed).toBe(4);
    expect(result.retrying).toBeGreaterThan(0);
    expect(result.hasMoreWork).toBe(true);

    // Deferred emails are immediately claimable again, not stuck behind a lease.
    const claimable = await queue.countClaimable(user.id);
    expect(claimable).toBe(result.retrying);
  });
});

describe('queue introspection', () => {
  it('counts claimable emails, including expired leases', async () => {
    const user = await createTestUser();
    await createTestEmail(user.id);
    const stale = await createTestEmail(user.id);
    const done = await createTestEmail(user.id);

    await testDb.email.update({
      where: { id: stale.id },
      data: {
        processingStatus: 'PROCESSING',
        processingLeaseUntil: new Date(Date.now() - 1000),
      },
    });
    await testDb.email.update({
      where: { id: done.id },
      data: { processingStatus: 'COMPLETED' },
    });

    expect(await queue.countClaimable(user.id)).toBe(2);
  });

  it('lists users with work waiting, without duplicates', async () => {
    const [first, second] = await Promise.all([createTestUser(), createTestUser()]);
    await createTestEmail(first.id);
    await createTestEmail(first.id);
    await createTestEmail(second.id);

    const userIds = await queue.findUserIdsWithPendingWork(10);

    expect(userIds).toHaveLength(2);
    expect(new Set(userIds)).toEqual(new Set([first.id, second.id]));
  });

  it('puts failed emails back in the queue with a fresh budget', async () => {
    const user = await createTestUser();
    await createTestEmail(user.id);
    await runner({ errors: [new AiRefusalError('fake', null)] }).run(user.id);

    const reset = await queue.resetFailed(user.id);

    expect(reset).toBe(1);
    const email = await testDb.email.findFirstOrThrow({ where: { userId: user.id } });
    expect(email.processingStatus).toBe('PENDING');
    expect(email.processingAttempts).toBe(0);
    expect(email.processingError).toBeNull();
  });
});
