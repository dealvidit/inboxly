import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';

/**
 * Database access for integration tests.
 *
 * These tests run against a real Postgres — the whole point is to exercise the
 * constraints, cascades, triggers, and locking behaviour that a mocked client would
 * happily pretend to have. `npm run db:test:setup` prepares the database.
 *
 * A dedicated client is used rather than the application's singleton so that the test
 * database is chosen explicitly, and can never be the development database by accident.
 */

const testDatabaseUrl =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://inboxly:inboxly@localhost:5432/inboxly_test';

if (!/inboxly_test|_test\b/.test(testDatabaseUrl)) {
  throw new Error(
    `Refusing to run destructive tests against ${testDatabaseUrl}: the database name must identify it as a test database.`,
  );
}

export const testDb = new PrismaClient({
  adapter: new PrismaPg({ connectionString: testDatabaseUrl, max: 2 }),
});

/**
 * Empties every table. Truncating `users` cascades to everything else, which is a
 * useful check in itself: if a future model is not reachable from a user, this stops
 * clearing it and the leak shows up as a failing test.
 */
export async function resetDatabase(): Promise<void> {
  await testDb.$executeRawUnsafe('TRUNCATE TABLE "users" CASCADE');
}

let seq = 0;

/** A user with unique identity fields, so tests can create several without collisions. */
export async function createTestUser(overrides: { email?: string } = {}) {
  seq += 1;
  return testDb.user.create({
    data: {
      googleSubject: `test-subject-${seq}-${Date.now()}`,
      email: overrides.email ?? `user${seq}.${Date.now()}@example.test`,
    },
  });
}

/** A minimal valid email row. Fields tests care about are passed in as overrides. */
export async function createTestEmail(
  userId: string,
  overrides: Partial<{
    gmailMessageId: string;
    gmailThreadId: string;
    subject: string;
    snippet: string;
    fromName: string;
    fromEmail: string;
    receivedAt: Date;
  }> = {},
) {
  seq += 1;
  return testDb.email.create({
    data: {
      userId,
      gmailMessageId: overrides.gmailMessageId ?? `msg-${seq}`,
      gmailThreadId: overrides.gmailThreadId ?? `thread-${seq}`,
      subject: overrides.subject ?? `Subject ${seq}`,
      snippet: overrides.snippet ?? `Snippet ${seq}`,
      fromName: overrides.fromName ?? 'Test Sender',
      fromEmail: overrides.fromEmail ?? 'sender@example.test',
      receivedAt: overrides.receivedAt ?? new Date(),
    },
  });
}
