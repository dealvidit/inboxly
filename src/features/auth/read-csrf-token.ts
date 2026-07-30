import { COOKIE_NAMES } from './cookies';

/**
 * Reads the CSRF token from its cookie, in the browser.
 *
 * This cookie is deliberately not HttpOnly — the double-submit pattern requires the
 * client to echo it in a header, which is precisely what a cross-origin attacker cannot
 * do. See features/auth/csrf.ts.
 */
export function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;

  const prefix = `${COOKIE_NAMES.csrf}=`;
  const match = document.cookie.split('; ').find((entry) => entry.startsWith(prefix));

  return match ? decodeURIComponent(match.slice(prefix.length)) : null;
}
