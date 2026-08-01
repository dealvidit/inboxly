/**
 * Cookie names without the environment-dependent prefix.
 *
 * This module has no imports, deliberately. `./cookies` applies the `__Host-` prefix and
 * therefore depends on `lib/env`, which is server-only; the browser needs the CSRF cookie
 * name too, and importing it from there would pull configuration into the client bundle.
 *
 * So the names live here and the prefixing lives there.
 */

/**
 * The strongest binding a cookie can have: the browser refuses it unless it is `Secure`,
 * `Path=/`, and carries no `Domain`. Applied in production only — it cannot be set over
 * the plain http that local development runs on.
 */
export const HOST_PREFIX = '__Host-';

export const BASE_COOKIE_NAMES = {
  session: 'inboxly_session',
  csrf: 'inboxly_csrf',
  oauthState: 'inboxly_oauth_state',
  oauthVerifier: 'inboxly_oauth_verifier',
  oauthNonce: 'inboxly_oauth_nonce',
  /** Where to send the user after a successful sign-in. */
  oauthReturnTo: 'inboxly_oauth_return_to',
} as const;
