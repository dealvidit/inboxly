import { generateToken, hashToken } from '@/lib/crypto';
import { logger } from '@/server/logger';
import {
  SESSION_DURATION_MS,
  SESSION_TOUCH_INTERVAL_MS,
  type AuthenticatedSession,
} from '../domain/session';
import * as repository from '../repository/auth-repository';

/**
 * Session lifecycle.
 *
 * The token the browser holds is 256 bits of randomness; only its SHA-256 hash is
 * stored. `issueSession` is therefore the one and only moment the raw token exists, and
 * it is returned rather than kept, so nothing else can leak it. See ADR 0003.
 */

const log = logger.child({ component: 'session-service' });

export interface IssuedSession {
  /** The value to put in the cookie. Never persisted, never logged. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface SessionRequestMetadata {
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
}

export async function issueSession(
  userId: string,
  metadata: SessionRequestMetadata,
  now: Date = new Date(),
): Promise<IssuedSession> {
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

  const sessionId = await repository.createSession({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    lastUsedAt: now,
    userAgent: metadata.userAgent,
    ipAddress: metadata.ipAddress,
  });

  log.info('session issued', { userId, sessionId });

  return { token, expiresAt };
}

/**
 * Resolves a cookie token to a session, or null when there is no valid one.
 *
 * Returns null rather than throwing for every "not signed in" case — an absent cookie,
 * an unknown token, an expired session — because none of them is exceptional, and the
 * caller's next step is the same for all three.
 */
export async function resolveSession(
  token: string | undefined,
  now: Date = new Date(),
): Promise<AuthenticatedSession | null> {
  if (!token) return null;

  const session = await repository.findActiveSessionByTokenHash(hashToken(token), now);
  if (!session) return null;

  // Rate-limited so an authenticated read does not always cost a write.
  if (now.getTime() - session.lastUsedAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    await repository.touchSession(session.sessionId, now);
  }

  return {
    sessionId: session.sessionId,
    user: session.user,
    expiresAt: session.expiresAt,
  };
}

/** Signs out one session. Idempotent: signing out twice is not an error. */
export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await repository.deleteSessionByTokenHash(hashToken(token));
}

/**
 * Signs out everywhere. Used when the Gmail connection is severed, so that a
 * disconnected account cannot be browsed from another device.
 */
export async function revokeAllSessions(userId: string): Promise<number> {
  const count = await repository.deleteSessionsForUser(userId);
  log.info('all sessions revoked', { userId, count });
  return count;
}

export async function purgeExpiredSessions(now: Date = new Date()): Promise<number> {
  const count = await repository.deleteExpiredSessions(now);
  if (count > 0) log.info('expired sessions purged', { count });
  return count;
}
