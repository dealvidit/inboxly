import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_NAMES, oauthFlowCookieAttributes } from '@/features/auth/cookies';
import { authService } from '@/features/auth/service/auth-service';
import { env } from '@/lib/env';
import { logger } from '@/server/logger';

/**
 * Starts the Google OAuth flow.
 *
 * Redirects to Google with PKCE, `state`, and `nonce`, keeping the secret half of each
 * in short-lived HttpOnly cookies scoped to /api/auth. See ADR 0003.
 */

const log = logger.child({ route: 'auth/google/start' });

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest): NextResponse {
  const url = new URL(request.url);

  // `reconnect=1` forces the consent screen, which is the only way Google re-issues a
  // refresh token for an account that has already granted access.
  const forceConsent = url.searchParams.get('reconnect') === '1';
  const loginHint = url.searchParams.get('login_hint');

  const authorization = authService.beginAuthorization({
    forceConsent,
    ...(loginHint ? { loginHint } : {}),
  });

  const response = NextResponse.redirect(authorization.authorizationUrl);
  const attributes = oauthFlowCookieAttributes();

  response.cookies.set(COOKIE_NAMES.oauthState, authorization.state, attributes);
  response.cookies.set(
    COOKIE_NAMES.oauthVerifier,
    authorization.codeVerifier,
    attributes,
  );
  response.cookies.set(COOKIE_NAMES.oauthNonce, authorization.nonce, attributes);
  response.cookies.set(
    COOKIE_NAMES.oauthReturnTo,
    safeReturnTo(url.searchParams.get('return_to')),
    attributes,
  );

  log.info('authorization started', { forceConsent });

  return response;
}

/**
 * Only same-origin relative paths are accepted. Echoing an arbitrary `return_to` into a
 * redirect is an open-redirect vulnerability, and the sign-in flow is exactly where
 * someone would try it.
 */
function safeReturnTo(candidate: string | null): string {
  const fallback = '/dashboard';
  if (!candidate) return fallback;

  // Reject protocol-relative ("//evil.com") and absolute URLs outright.
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return fallback;

  const resolved = new URL(candidate, env.APP_URL);
  if (resolved.origin !== new URL(env.APP_URL).origin) return fallback;

  return `${resolved.pathname}${resolved.search}`;
}
