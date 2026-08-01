import { constantTimeEqual } from './crypto';
import { ForbiddenError } from '@/server/errors';

/**
 * CSRF protection for state-changing requests, using the double-submit cookie pattern.
 *
 * The client reads a non-HttpOnly cookie and echoes it in a header. Same-origin script
 * can do that; a cross-origin attacker cannot, because it can neither read our cookies
 * nor set custom headers on a simple cross-site request.
 *
 * It lives in lib/ rather than in features/auth because it is a generic HTTP defence:
 * it knows nothing about Google, sessions, or how the token was issued.
 *
 * This layers on top of `SameSite=Lax` rather than replacing it. Lax alone is good but
 * not a complete defence — it does not cover every browser or every request shape — and
 * the cost of the second layer is one header.
 *
 * This module is server-only, by way of `lib/crypto` → `lib/env`. The header *name* that
 * the browser also needs is deliberately not re-exported from here; it lives in
 * `./csrf-header`, so that importing it cannot drag configuration into the client bundle.
 */

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
