import { cookies } from 'next/headers';
import { cache } from 'react';
import { UnauthorizedError } from '@/server/errors';
import { COOKIE_NAMES } from './cookies';
import type { AuthenticatedSession } from './domain/session';
import { resolveSession } from './service/session-service';

/**
 * Reads the session for the current request, for Server Components and route handlers.
 *
 * Wrapped in React's `cache` so that a page rendering several components that each need
 * the user performs one session lookup per request, not one per component. This is
 * request-scoped deduplication, not caching — nothing survives the request (ADR 0010).
 */
export const getCurrentSession = cache(
  async (): Promise<AuthenticatedSession | null> => {
    const cookieStore = await cookies();
    return resolveSession(cookieStore.get(COOKIE_NAMES.session)?.value);
  },
);

/**
 * The same, but for code that cannot proceed without a user. Throwing here keeps the
 * `null` check out of every caller that has already established it must be signed in.
 */
export async function requireCurrentSession(): Promise<AuthenticatedSession> {
  const session = await getCurrentSession();
  if (!session) throw new UnauthorizedError();
  return session;
}
