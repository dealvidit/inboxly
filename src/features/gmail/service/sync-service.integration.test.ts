import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ExternalServiceError } from '@/server/errors';
import {
  GmailAuthorizationError,
  GmailMessageNotFoundError,
} from '../client/gmail-transport';
import { createSyncService } from './sync-service';
import { FakeGmail } from '~/tests/fake-gmail';
import { createTestUser, resetDatabase, testDb } from '~/tests/db';

/**
 * The synchronization engine, driven end to end against a fake mailbox and a real
 * database.
 *
 * The properties under test are the two the design exists to provide: synchronization is
 * idempotent, and it resumes rather than restarts. Both are asserted by doing the thing
 * twice, or by interrupting it and running again.
 */

beforeEach(resetDatabase);
afterAll(async () => {
  await testDb.$disconnect();
});

function service(
  gmail: FakeGmail,
  overrides: Parameters<typeof createSyncService>[0] = {},
) {
  return createSyncService({
    createTransport: () => gmail,
    maxBackfillMessages: 100,
    ...overrides,
  });
}

async function storedEmails(userId: string) {
  return testDb.email.findMany({
    where: { userId },
    orderBy: { gmailMessageId: 'asc' },
  });
}

describe('backfill', () => {
  it('imports the mailbox and switches to incremental sync', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'm1', subject: 'First' });
    gmail.addMessage({ id: 'm2', subject: 'Second' });
    gmail.addMessage({ id: 'm3', subject: 'Third' });

    const result = await service(gmail).run(user.id, 'INITIAL_CONNECT');

    expect(result.status).toBe('COMPLETED');
    expect(result.messagesCreated).toBe(3);
    expect(result.hasMoreWork).toBe(false);

    const emails = await storedEmails(user.id);
    expect(emails.map((email) => email.subject)).toEqual(['First', 'Second', 'Third']);

    const checkpoint = await testDb.syncCheckpoint.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(checkpoint.phase).toBe('INCREMENTAL');
    expect(checkpoint.historyId).toBe(gmail.currentHistoryId);
    expect(checkpoint.backfillPageToken).toBeNull();
    expect(checkpoint.backfillCompletedAt).not.toBeNull();
  });

  it('pages through a mailbox larger than one page', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail(2);
    for (let i = 1; i <= 5; i += 1) gmail.addMessage({ id: `m${i}` });

    const result = await service(gmail).run(user.id, 'USER');

    expect(result.messagesCreated).toBe(5);
    expect(result.pagesProcessed).toBe(3);
    expect(await testDb.email.count({ where: { userId: user.id } })).toBe(5);
  });

  it('projects the message onto our columns', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail();
    gmail.addMessage({
      id: 'm1',
      subject: 'Quarterly invoice',
      from: 'Acme Billing <billing@acme.test>',
      body: 'Please remit by Friday.',
      labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'],
      internalDate: String(Date.parse('2026-07-15T10:00:00Z')),
    });

    await service(gmail).run(user.id, 'USER');

    const email = await testDb.email.findFirstOrThrow({ where: { userId: user.id } });
    expect(email.subject).toBe('Quarterly invoice');
    expect(email.fromName).toBe('Acme Billing');
    expect(email.fromEmail).toBe('billing@acme.test');
    expect(email.bodyText).toBe('Please remit by Friday.');
    expect(email.isUnread).toBe(true);
    expect(email.isImportant).toBe(true);
    expect(email.receivedAt.toISOString()).toBe('2026-07-15T10:00:00.000Z');
    // Every imported message enters the analysis queue.
    expect(email.processingStatus).toBe('PENDING');
  });

  it('honours the backfill cap, so a first run on a huge mailbox stays bounded', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail(2);
    for (let i = 1; i <= 10; i += 1) gmail.addMessage({ id: `m${i}` });

    await service(gmail, { maxBackfillMessages: 4 }).run(user.id, 'USER');

    expect(await testDb.email.count({ where: { userId: user.id } })).toBe(4);
  });

  it('records metrics on the run, including Gmail API calls', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail(2);
    for (let i = 1; i <= 3; i += 1) gmail.addMessage({ id: `m${i}` });

    const result = await service(gmail).run(user.id, 'CRON');

    const run = await testDb.syncRun.findFirstOrThrow({ where: { id: result.runId } });
    expect(run.phase).toBe('BACKFILL');
    expect(run.trigger).toBe('CRON');
    expect(run.status).toBe('COMPLETED');
    expect(run.messagesCreated).toBe(3);
    expect(run.apiCalls).toBeGreaterThan(0);
    expect(run.finishedAt).not.toBeNull();
  });
});

describe('idempotence', () => {
  it('produces the same rows when the same mailbox is synced twice', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'm1' });
    gmail.addMessage({ id: 'm2' });

    await service(gmail).run(user.id, 'USER');
    const first = await storedEmails(user.id);

    // A second backfill of the same mailbox: upserts, not inserts.
    await testDb.syncCheckpoint.update({
      where: { userId: user.id },
      data: { phase: 'BACKFILL', historyId: null, backfillMessagesSynced: 0 },
    });
    const second = await service(gmail).run(user.id, 'USER');

    expect(second.messagesCreated).toBe(0);
    expect(second.messagesUpdated).toBe(2);
    expect(await storedEmails(user.id)).toHaveLength(first.length);
  });

  it('does not re-analyse a message it re-fetches', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'm1' });

    await service(gmail).run(user.id, 'USER');

    // Pretend the analysis pipeline has already handled it.
    await testDb.email.updateMany({
      where: { userId: user.id },
      data: { processingStatus: 'COMPLETED', processedAt: new Date() },
    });

    gmail.changeLabels('m1', ['INBOX', 'STARRED']);
    await service(gmail).run(user.id, 'CRON');

    const email = await testDb.email.findFirstOrThrow({ where: { userId: user.id } });
    // Labels updated, lifecycle untouched — re-running AI here would be waste.
    expect(email.isStarred).toBe(true);
    expect(email.processingStatus).toBe('COMPLETED');
  });

  it('keeps mailboxes separate when two users have the same Gmail message ids', async () => {
    const [first, second] = await Promise.all([createTestUser(), createTestUser()]);
    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'shared-id', subject: 'Shared id' });

    await service(gmail).run(first.id, 'USER');
    await service(gmail).run(second.id, 'USER');

    expect(await testDb.email.count({ where: { userId: first.id } })).toBe(1);
    expect(await testDb.email.count({ where: { userId: second.id } })).toBe(1);
    expect(await testDb.email.count()).toBe(2);
  });
});

describe('incremental sync', () => {
  it('imports only what changed since the checkpoint', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'm1' });
    await service(gmail).run(user.id, 'INITIAL_CONNECT');

    gmail.addMessage({ id: 'm2', subject: 'Arrived later' });
    const result = await service(gmail).run(user.id, 'CRON');

    expect(result.phase).toBe('INCREMENTAL');
    expect(result.messagesCreated).toBe(1);
    expect(await testDb.email.count({ where: { userId: user.id } })).toBe(2);
  });

  it('does nothing when the mailbox has not changed', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'm1' });
    await service(gmail).run(user.id, 'INITIAL_CONNECT');

    const result = await service(gmail).run(user.id, 'CRON');

    expect(result.status).toBe('COMPLETED');
    expect(result.messagesFetched).toBe(0);
    expect(result.messagesCreated).toBe(0);
  });

  it('soft-deletes a message removed from Gmail, keeping its row', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'm1' });
    gmail.addMessage({ id: 'm2' });
    await service(gmail).run(user.id, 'INITIAL_CONNECT');

    gmail.deleteMessage('m1');
    const result = await service(gmail).run(user.id, 'CRON');

    expect(result.messagesDeleted).toBe(1);
    const deleted = await testDb.email.findFirstOrThrow({
      where: { userId: user.id, gmailMessageId: 'm1' },
    });
    expect(deleted.deletedAt).not.toBeNull();
    // Soft: the row and its analysis survive.
    expect(await testDb.email.count({ where: { userId: user.id } })).toBe(2);
  });

  it('applies label changes by re-fetching the authoritative message', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'm1', labelIds: ['INBOX', 'UNREAD'] });
    await service(gmail).run(user.id, 'INITIAL_CONNECT');

    gmail.changeLabels('m1', ['INBOX', 'STARRED']);
    await service(gmail).run(user.id, 'CRON');

    const email = await testDb.email.findFirstOrThrow({ where: { userId: user.id } });
    expect(email.isStarred).toBe(true);
    expect(email.isUnread).toBe(false);
    expect(email.labels).toEqual(['INBOX', 'STARRED']);
  });

  it('restores a message that comes back out of Trash', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'm1' });
    await service(gmail).run(user.id, 'INITIAL_CONNECT');

    gmail.deleteMessage('m1');
    await service(gmail).run(user.id, 'CRON');
    expect(
      (await testDb.email.findFirstOrThrow({ where: { userId: user.id } })).deletedAt,
    ).not.toBeNull();

    gmail.addMessage({ id: 'm1' });
    await service(gmail).run(user.id, 'CRON');

    expect(
      (await testDb.email.findFirstOrThrow({ where: { userId: user.id } })).deletedAt,
    ).toBeNull();
  });

  it('advances the checkpoint so the next run starts where this one stopped', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'm1' });
    await service(gmail).run(user.id, 'INITIAL_CONNECT');

    gmail.addMessage({ id: 'm2' });
    await service(gmail).run(user.id, 'CRON');

    const checkpoint = await testDb.syncCheckpoint.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(checkpoint.historyId).toBe(gmail.currentHistoryId);
    expect(checkpoint.lastSyncedAt).not.toBeNull();
  });
});

describe('expired history id', () => {
  it('falls back to a backfill instead of reporting a failure', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'm1' });
    await service(gmail).run(user.id, 'INITIAL_CONNECT');

    // What Gmail does after roughly a week of inactivity.
    gmail.historyExpired = true;
    gmail.addMessage({ id: 'm2' });
    const recovery = await service(gmail).run(user.id, 'CRON');

    expect(recovery.status).toBe('COMPLETED');
    expect(recovery.error).toBeNull();
    expect(await testDb.email.count({ where: { userId: user.id } })).toBe(2);

    const checkpoint = await testDb.syncCheckpoint.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(checkpoint.phase).toBe('INCREMENTAL');
    expect(checkpoint.historyId).toBe(gmail.currentHistoryId);
  });
});

describe('resumability', () => {
  it('resumes an interrupted backfill from the checkpointed page', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail(2);
    for (let i = 1; i <= 6; i += 1) gmail.addMessage({ id: `m${i}` });

    // A clock that jumps forward, exhausting the budget after the first page.
    let ticks = 0;
    const start = Date.parse('2026-07-30T10:00:00Z');
    const jumpyClock = () => {
      ticks += 1;
      return new Date(start + (ticks > 3 ? 60_000 : 0));
    };

    const interrupted = await service(gmail, {
      now: jumpyClock,
      timeBudgetMs: 30_000,
    }).run(user.id, 'USER');

    expect(interrupted.status).toBe('PARTIAL');
    expect(interrupted.hasMoreWork).toBe(true);

    const partialCount = await testDb.email.count({ where: { userId: user.id } });
    expect(partialCount).toBeGreaterThan(0);
    expect(partialCount).toBeLessThan(6);

    const checkpoint = await testDb.syncCheckpoint.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(checkpoint.backfillPageToken).not.toBeNull();
    expect(checkpoint.phase).toBe('BACKFILL');

    // The next invocation picks up rather than starting over.
    const resumed = await service(gmail).run(user.id, 'CRON');

    expect(resumed.status).toBe('COMPLETED');
    expect(await testDb.email.count({ where: { userId: user.id } })).toBe(6);
    // Only the remaining messages were created — earlier pages were not re-imported.
    expect(resumed.messagesCreated).toBe(6 - partialCount);
  });

  it('leaves a usable checkpoint when a page fails mid-run', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail(2);
    for (let i = 1; i <= 6; i += 1) gmail.addMessage({ id: `m${i}` });

    await service(gmail).run(user.id, 'USER');
    const total = await testDb.email.count({ where: { userId: user.id } });

    // A later incremental run fails outright.
    gmail.addMessage({ id: 'm7' });
    gmail.failNextGetMessage = new ExternalServiceError('gmail', 'boom', {
      retryable: false,
    });
    const failed = await service(gmail).run(user.id, 'CRON');

    expect(failed.status).toBe('FAILED');
    expect(failed.error).not.toBeNull();

    // Nothing was lost, and the next run recovers.
    const recovered = await service(gmail).run(user.id, 'CRON');
    expect(recovered.status).toBe('COMPLETED');
    expect(await testDb.email.count({ where: { userId: user.id } })).toBe(total + 1);
  });

  it('marks an abandoned run failed so the dashboard does not claim a sync forever', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'm1' });

    const stale = await testDb.syncRun.create({
      data: {
        userId: user.id,
        phase: 'BACKFILL',
        trigger: 'CRON',
        status: 'RUNNING',
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    await service(gmail).run(user.id, 'CRON');

    const abandoned = await testDb.syncRun.findUniqueOrThrow({
      where: { id: stale.id },
    });
    expect(abandoned.status).toBe('FAILED');
    expect(abandoned.finishedAt).not.toBeNull();
  });
});

describe('failures', () => {
  it('records a failed run without throwing, since the dashboard renders this state', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'm1' });
    gmail.failNextListMessages = new ExternalServiceError('gmail', 'upstream down', {
      retryable: false,
    });

    const result = await service(gmail).run(user.id, 'CRON');

    expect(result.status).toBe('FAILED');
    // A user-safe message, not the provider's text.
    expect(result.error).toBe(
      'A connected service is unavailable. Please try again shortly.',
    );
    expect(result.error).not.toContain('upstream down');
  });

  it('marks the account for reconnection when Gmail rejects our authorization', async () => {
    const user = await createTestUser();
    await testDb.googleAccount.create({ data: { userId: user.id } });

    const gmail = new FakeGmail();
    gmail.addMessage({ id: 'm1' });
    gmail.failNextListMessages = new GmailAuthorizationError(
      'insufficient permissions',
    );

    const result = await service(gmail).run(user.id, 'CRON');

    expect(result.status).toBe('FAILED');
    const account = await testDb.googleAccount.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(account.connectionStatus).toBe('NEEDS_RECONNECT');
  });

  it('treats a message that vanishes between list and fetch as a deletion, not a failure', async () => {
    const user = await createTestUser();
    const gmail = new FakeGmail(4);
    gmail.addMessage({ id: 'm1' });
    gmail.addMessage({ id: 'm2' });

    // One message is listed, then deleted before it can be fetched. An ordinary race:
    // the page must still import the rest rather than failing wholesale.
    gmail.failNextGetMessage = new GmailMessageNotFoundError('m1');

    const result = await service(gmail).run(user.id, 'USER');

    expect(result.status).toBe('COMPLETED');
    expect(result.messagesCreated).toBe(1);
    expect(await testDb.email.count({ where: { userId: user.id } })).toBe(1);
  });
});
