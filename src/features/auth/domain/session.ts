import type { ConnectionStatus } from '@/server/db';

/**
 * The authenticated principal, as the rest of the application sees it.
 *
 * This is deliberately not the `User` database row: it carries only what a request
 * handler legitimately needs, so a new column on `users` does not silently become part
 * of every request context.
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
}

/** A resolved session together with its user. */
export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly user: AuthenticatedUser;
  readonly expiresAt: Date;
}

/**
 * How the Gmail connection looks to the UI. `NEEDS_RECONNECT` is a normal state the
 * dashboard prompts on, not an error — see ADR 0003.
 */
export interface GmailConnection {
  readonly status: ConnectionStatus;
  readonly gmailAddress: string | null;
  readonly connectedAt: Date | null;
  /** Set when status is NEEDS_RECONNECT. Always a user-safe message. */
  readonly message: string | null;
  /** False when the user declined the Gmail scope at consent. */
  readonly hasGmailAccess: boolean;
}

/**
 * Session lifetime.
 *
 * Thirty days absolute, with the row's `lastUsedAt` refreshed at most once an hour so
 * that an active user is not logged out mid-session while an idle one still expires.
 * Writing on every request would put a database write on the hot path for no benefit.
 */
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** How long the OAuth handshake cookies live. Long enough to consent, short enough to matter. */
export const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

/**
 * Refresh the access token this long before it actually expires, so a request that
 * starts just under the wire does not fail mid-flight.
 */
export const ACCESS_TOKEN_EXPIRY_SKEW_MS = 2 * 60 * 1000;
