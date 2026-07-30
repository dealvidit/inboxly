import { constantTimeEqual } from '@/lib/crypto';
import { ForbiddenError } from '@/server/errors';

/**
 * CSRF protection for state-changing requests, using the double-submit cookie pattern.
 *
 * The client reads a non-HttpOnly cookie and echoes it in a header. Same-origin script
 * can do that; a cross-origin attacker cannot, because it can neither read our cookies
 * nor set custom headers on a simple cross-site request.
 *
 * This layers on top of `SameSite=Lax` rather than replacing it. Lax alone is good but
 * not a complete defence — it does not cover every browser or every request shape — and
 * the cost of the second layer is one header.
 */

export const CSRF_HEADER = 'x-csrf-token';

/** Methods that cannot change state, and so need no token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Throws unless the header matches the cookie. Both must be present: a missing token is
 * a failure, not a pass — the common way this check gets silently disabled is treating
 * "no token supplied" as "nothing to compare".
 */
export function assertCsrfTokenMatches(
  headerToken: string | null | undefined,
  cookieToken: string | null | undefined,
): void {
  if (!headerToken || !cookieToken) {
    throw new ForbiddenError('CSRF token missing', {
      userMessage: 'Your session could not be verified. Please refresh and try again.',
    });
  }

  if (!constantTimeEqual(headerToken, cookieToken)) {
    throw new ForbiddenError('CSRF token mismatch', {
      userMessage: 'Your session could not be verified. Please refresh and try again.',
    });
  }
}
