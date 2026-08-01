import { BASE_COOKIE_NAMES, HOST_PREFIX } from './cookie-names';

/**
 * Reads the CSRF token from its cookie, in the browser.
 *
 * This cookie is deliberately not HttpOnly — the double-submit pattern requires the
 * client to echo it in a header, which is precisely what a cross-origin attacker cannot
 * do. See lib/csrf.ts.
 *
 * The name is `__Host-` prefixed in production and bare in development, and that choice
 * is made from `isProduction` — server configuration the browser must not import. Rather
 * than plumbing the environment to the client, we accept either name: a browser holds
 * exactly one of them, because the prefix is a property of the deployment, so there is
 * nothing to disambiguate.
 */

const ACCEPTED_NAMES = [
  `${HOST_PREFIX}${BASE_COOKIE_NAMES.csrf}`,
  BASE_COOKIE_NAMES.csrf,
] as const;

export function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;

  const entries = document.cookie.split('; ');

  for (const name of ACCEPTED_NAMES) {
    const prefix = `${name}=`;
    const match = entries.find((entry) => entry.startsWith(prefix));

    if (match) return decodeURIComponent(match.slice(prefix.length));
  }

  return null;
}
