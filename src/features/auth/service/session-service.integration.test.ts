import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '@/lib/crypto';
import { SESSION_DURATION_MS, SESSION_TOUCH_INTERVAL_MS } from '../domain/session';
import {
  issueSession,
  purgeExpiredSessions,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from './session-service';
import { createTestUser, resetDatabase, testDb } from '~/tests/db';

/**
 * Session behaviour against a real database, because the guarantees being tested are
 * about what is and is not stored, and about queries that filter on time.
 */

const metadata = { userAgent: 'test-agent', ipAddress: '203.0.113.1' };

beforeEach(resetDatabase);
afterAll(async () => {
  await testDb.$disconnect();
});

describe('issueSession', () => {
  it('stores only the hash of the token, never the token itself', async () => {
    const user = await createTestUser();

    const { token } = await issueSession(user.id, metadata);

    const rows = await testDb.session.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashToken(token));
    // The whole point: the raw token appears nowhere in the row.
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it('sets an absolute expiry and records the request metadata', async () => {
    const user = await createTestUser();
    const now = new Date('2026-07-30T10:00:00Z');

    const { expiresAt } = await issueSession(user.id, metadata, now);

    expect(expiresAt.getTime()).toBe(now.getTime() + SESSION_DURATION_MS);
    const row = await testDb.session.findFirst();
    expect(row?.userAgent).toBe('test-agent');
    expect(row?.ipAddress).toBe('203.0.113.1');
  });

  it('issues independent sessions, so signing in on a second device does not evict the first', async () => {
    const user = await createTestUser();

    const first = await issueSession(user.id, metadata);
    const second = await issueSession(user.id, metadata);

    expect(first.token).not.toBe(second.token);
    expect(await testDb.session.count()).toBe(2);
    expect(await resolveSession(first.token)).not.toBeNull();
    expect(await resolveSession(second.token)).not.toBeNull();
  });
});

describe('resolveSession', () => {
  it('returns the session and its user for a valid token', async () => {
    const user = await createTestUser({ email: 'person@example.test' });
    const { token } = await issueSession(user.id, metadata);

    const resolved = await resolveSession(token);

    expect(resolved?.user.id).toBe(user.id);
    expect(resolved?.user.email).toBe('person@example.test');
  });

  it('returns null for an absent, unknown, or malformed token instead of throwing', async () => {
    expect(await resolveSession(undefined)).toBeNull();
    expect(await resolveSession('')).toBeNull();
    expect(await resolveSession('not-a-real-token')).toBeNull();
  });

  it('returns null once the session has expired', async () => {
    const user = await createTestUser();
    const issuedAt = new Date('2026-07-01T00:00:00Z');
    const { token } = await issueSession(user.id, metadata, issuedAt);

    const beforeExpiry = new Date(issuedAt.getTime() + SESSION_DURATION_MS - 1000);
    const afterExpiry = new Date(issuedAt.getTime() + SESSION_DURATION_MS + 1000);

    expect(await resolveSession(token, beforeExpiry)).not.toBeNull();
    expect(await resolveSession(token, afterExpiry)).toBeNull();
  });

  it('leaves lastUsedAt alone within the touch interval, keeping writes off the hot path', async () => {
    const user = await createTestUser();
    const issuedAt = new Date('2026-07-30T10:00:00Z');
    const { token } = await issueSession(user.id, metadata, issuedAt);

    const soon = new Date(issuedAt.getTime() + SESSION_TOUCH_INTERVAL_MS - 1000);
    await resolveSession(token, soon);

    expect((await testDb.session.findFirst())?.lastUsedAt.toISOString()).toBe(
      issuedAt.toISOString(),
    );
  });

  it('refreshes lastUsedAt once the touch interval has passed, so active users stay signed in', async () => {
    const user = await createTestUser();
    const issuedAt = new Date('2026-07-30T10:00:00Z');
    const { token } = await issueSession(user.id, metadata, issuedAt);

    const later = new Date(issuedAt.getTime() + SESSION_TOUCH_INTERVAL_MS + 1000);
    await resolveSession(token, later);

    expect((await testDb.session.findFirst())?.lastUsedAt.toISOString()).toBe(
      later.toISOString(),
    );
  });
});

describe('revokeSession', () => {
  it('makes the token immediately unusable, which is why sessions are server-side', async () => {
    const user = await createTestUser();
    const { token } = await issueSession(user.id, metadata);
    expect(await resolveSession(token)).not.toBeNull();

    await revokeSession(token);

    expect(await resolveSession(token)).toBeNull();
    expect(await testDb.session.count()).toBe(0);
  });

  it('is idempotent, so signing out twice is not an error', async () => {
    const user = await createTestUser();
    const { token } = await issueSession(user.id, metadata);

    await revokeSession(token);
    await expect(revokeSession(token)).resolves.toBeUndefined();
    await expect(revokeSession(undefined)).resolves.toBeUndefined();
  });

  it('revokes only the session it was given', async () => {
    const user = await createTestUser();
    const first = await issueSession(user.id, metadata);
    const second = await issueSession(user.id, metadata);

    await revokeSession(first.token);

    expect(await resolveSession(first.token)).toBeNull();
    expect(await resolveSession(second.token)).not.toBeNull();
  });
});

describe('revokeAllSessions', () => {
  it('signs the user out everywhere but leaves other users alone', async () => {
    const [user, other] = await Promise.all([createTestUser(), createTestUser()]);
    const tokens = await Promise.all([
      issueSession(user.id, metadata),
      issueSession(user.id, metadata),
      issueSession(user.id, metadata),
    ]);
    const otherToken = await issueSession(other.id, metadata);

    const count = await revokeAllSessions(user.id);

    expect(count).toBe(3);
    for (const { token } of tokens) {
      expect(await resolveSession(token)).toBeNull();
    }
    expect(await resolveSession(otherToken.token)).not.toBeNull();
  });
});

describe('purgeExpiredSessions', () => {
  it('deletes expired rows and keeps live ones', async () => {
    const user = await createTestUser();
    const now = new Date('2026-07-30T10:00:00Z');

    await testDb.session.create({
      data: {
        userId: user.id,
        tokenHash: 'expired-hash',
        expiresAt: new Date(now.getTime() - 1000),
      },
    });
    const live = await issueSession(user.id, metadata, now);

    const purged = await purgeExpiredSessions(now);

    expect(purged).toBe(1);
    expect(await resolveSession(live.token, now)).not.toBeNull();
  });
});
