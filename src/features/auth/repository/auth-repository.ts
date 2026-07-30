import { ConnectionStatus, db, type GoogleAccountRow } from '@/server/db';
import type { AuthenticatedSession, AuthenticatedUser } from '../domain/session';

/**
 * The only module in the auth feature that touches the database.
 *
 * Functions return domain types rather than Prisma rows wherever the caller does not
 * need a row, so a schema change does not ripple into services.
 */

/* ─── Users ──────────────────────────────────────────────────────────────── */

export interface UpsertUserInput {
  readonly googleSubject: string;
  readonly email: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
}

/**
 * Keyed on `googleSubject`, not email: Google's `sub` is stable, and a user who changes
 * their Gmail address must remain the same user rather than becoming a new one.
 */
export async function upsertUserByGoogleSubject(
  input: UpsertUserInput,
): Promise<AuthenticatedUser> {
  const user = await db.user.upsert({
    where: { googleSubject: input.googleSubject },
    create: {
      googleSubject: input.googleSubject,
      email: input.email,
      name: input.name,
      avatarUrl: input.avatarUrl,
      lastSeenAt: new Date(),
    },
    update: {
      email: input.email,
      name: input.name,
      avatarUrl: input.avatarUrl,
      lastSeenAt: new Date(),
    },
    select: { id: true, email: true, name: true, avatarUrl: true },
  });

  return user;
}

/* ─── Sessions ───────────────────────────────────────────────────────────── */

export interface CreateSessionInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  /**
   * Set explicitly rather than left to the column default, so the service's clock — not
   * the database's — governs the sliding-refresh logic that later reads this value.
   * `createdAt` stays on the database default, because it is an audit fact.
   */
  readonly lastUsedAt: Date;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
}

export async function createSession(input: CreateSessionInput): Promise<string> {
  const session = await db.session.create({
    data: {
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      lastUsedAt: input.lastUsedAt,
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    },
    select: { id: true },
  });

  return session.id;
}

/**
 * Looks a session up by the hash of its token. Expired sessions are filtered in the
 * query rather than in the caller, so there is no path that forgets to check.
 */
export async function findActiveSessionByTokenHash(
  tokenHash: string,
  now: Date,
): Promise<(AuthenticatedSession & { lastUsedAt: Date }) | null> {
  const session = await db.session.findFirst({
    where: { tokenHash, expiresAt: { gt: now } },
    select: {
      id: true,
      expiresAt: true,
      lastUsedAt: true,
      user: { select: { id: true, email: true, name: true, avatarUrl: true } },
    },
  });

  if (!session) return null;

  return {
    sessionId: session.id,
    expiresAt: session.expiresAt,
    lastUsedAt: session.lastUsedAt,
    user: session.user,
  };
}

export async function touchSession(sessionId: string, now: Date): Promise<void> {
  await db.session.update({
    where: { id: sessionId },
    data: { lastUsedAt: now },
  });
}

export async function deleteSessionByTokenHash(tokenHash: string): Promise<void> {
  // deleteMany rather than delete: signing out twice is not an error.
  await db.session.deleteMany({ where: { tokenHash } });
}

export async function deleteSessionsForUser(userId: string): Promise<number> {
  const { count } = await db.session.deleteMany({ where: { userId } });
  return count;
}

/** Housekeeping for expired rows. Called by the maintenance job, not on the hot path. */
export async function deleteExpiredSessions(now: Date): Promise<number> {
  const { count } = await db.session.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  return count;
}

/* ─── Google accounts ────────────────────────────────────────────────────── */

export interface UpsertGoogleAccountInput {
  readonly userId: string;
  readonly accessTokenCiphertext: string;
  readonly accessTokenExpiresAt: Date;
  /**
   * Absent when Google did not issue a new refresh token. The caller passes `null` to
   * mean "leave the stored one alone" — overwriting it with nothing is how a working
   * connection gets silently broken.
   */
  readonly refreshTokenCiphertext: string | null;
  readonly scopes: string[];
  readonly gmailAddress: string | null;
}

export async function upsertGoogleAccount(
  input: UpsertGoogleAccountInput,
): Promise<void> {
  const refreshTokenUpdate =
    input.refreshTokenCiphertext === null
      ? {}
      : { refreshTokenCiphertext: input.refreshTokenCiphertext };

  await db.googleAccount.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      accessTokenCiphertext: input.accessTokenCiphertext,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      refreshTokenCiphertext: input.refreshTokenCiphertext,
      scopes: input.scopes,
      gmailAddress: input.gmailAddress,
      connectionStatus: ConnectionStatus.CONNECTED,
      connectionError: null,
    },
    update: {
      accessTokenCiphertext: input.accessTokenCiphertext,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      ...refreshTokenUpdate,
      scopes: input.scopes,
      gmailAddress: input.gmailAddress,
      connectionStatus: ConnectionStatus.CONNECTED,
      connectionError: null,
    },
  });
}

export async function findGoogleAccount(
  userId: string,
): Promise<GoogleAccountRow | null> {
  return db.googleAccount.findUnique({ where: { userId } });
}

export async function updateAccessToken(
  userId: string,
  accessTokenCiphertext: string,
  accessTokenExpiresAt: Date,
): Promise<void> {
  await db.googleAccount.update({
    where: { userId },
    data: {
      accessTokenCiphertext,
      accessTokenExpiresAt,
      connectionStatus: ConnectionStatus.CONNECTED,
      connectionError: null,
    },
  });
}

export async function markConnectionStatus(
  userId: string,
  status: ConnectionStatus,
  message: string | null,
): Promise<void> {
  await db.googleAccount.updateMany({
    where: { userId },
    data: { connectionStatus: status, connectionError: message },
  });
}

/**
 * Clears credentials on disconnect. The row is kept so the dashboard can distinguish
 * "disconnected deliberately" from "never connected".
 */
export async function clearGoogleCredentials(userId: string): Promise<void> {
  await db.googleAccount.updateMany({
    where: { userId },
    data: {
      accessTokenCiphertext: null,
      accessTokenExpiresAt: null,
      refreshTokenCiphertext: null,
      connectionStatus: ConnectionStatus.DISCONNECTED,
      connectionError: null,
    },
  });
}
