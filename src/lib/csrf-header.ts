/**
 * The header name carrying the CSRF token, alone in its own module.
 *
 * The browser needs this constant to send the header; it must never need anything else
 * from the CSRF module. Verification (`assertCsrfTokenMatches`) lives in `./csrf` and
 * reaches `lib/crypto` for a constant-time comparison, which reaches `lib/env` — so a
 * client component importing the name from there would pull server configuration into the
 * browser bundle, where `process.env` is empty and env validation throws at import time.
 *
 * That is not hypothetical: it happened, and it took down the whole page. Keeping the
 * constant in a leaf module with no imports of its own is what makes the mistake
 * impossible rather than merely unlikely.
 */

export const CSRF_HEADER = 'x-csrf-token';
