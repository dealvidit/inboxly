import { isProduction } from '@/lib/env';
import { BASE_COOKIE_NAMES, HOST_PREFIX } from './cookie-names';
import { OAUTH_FLOW_TTL_MS, SESSION_DURATION_MS } from './domain/session';

/**
 * Cookie names and attributes, defined once.
 *
 * The `__Host-` prefix is applied only in production, for the reason given in
 * `./cookie-names`. Environments are separate deployments, so a different name in each
 * costs nothing.
 *
 * This module is server-only by way of `lib/env`. The unprefixed names live in
 * `./cookie-names`, which the browser can import safely.
 */

const prefix = isProduction ? HOST_PREFIX : '';

export const COOKIE_NAMES = {
  session: `${prefix}${BASE_COOKIE_NAMES.session}`,
  csrf: `${prefix}${BASE_COOKIE_NAMES.csrf}`,
  oauthState: `${prefix}${BASE_COOKIE_NAMES.oauthState}`,
  oauthVerifier: `${prefix}${BASE_COOKIE_NAMES.oauthVerifier}`,
  oauthNonce: `${prefix}${BASE_COOKIE_NAMES.oauthNonce}`,
  oauthReturnTo: `${prefix}${BASE_COOKIE_NAMES.oauthReturnTo}`,
} as const;

export interface CookieAttributes {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge: number;
}

/**
 * The session cookie.
 *
 * `SameSite=Lax` rather than `Strict` because `Strict` would withhold the cookie on the
 * redirect back from Google's consent screen, landing the user on the dashboard
 * apparently signed out. Lax still blocks cross-site POSTs, and mutations are
 * additionally protected by the CSRF token below.
 */
export function sessionCookieAttributes(): CookieAttributes {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_DURATION_MS / 1000),
  };
}

/**
 * The CSRF cookie is intentionally readable by JavaScript: the double-submit pattern
 * requires the client to echo it in a header, which same-origin script can do and a
 * cross-origin attacker cannot. It is not a secret — it is a proof of same-origin.
 */
export function csrfCookieAttributes(): CookieAttributes {
  return {
    httpOnly: false,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_DURATION_MS / 1000),
  };
}

/**
 * Handshake cookies are scoped to the auth routes and expire in ten minutes, so an
 * abandoned sign-in leaves nothing behind.
 */
export function oauthFlowCookieAttributes(): CookieAttributes {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: Math.floor(OAUTH_FLOW_TTL_MS / 1000),
  };
}

/** Attributes that clear a cookie: same flags, zero lifetime. */
export function expiredCookieAttributes(
  attributes: CookieAttributes,
): CookieAttributes {
  return { ...attributes, maxAge: 0 };
}
