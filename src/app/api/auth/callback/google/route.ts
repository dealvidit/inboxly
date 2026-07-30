import { NextResponse, type NextRequest } from 'next/server';
import {
  COOKIE_NAMES,
  csrfCookieAttributes,
  expiredCookieAttributes,
  oauthFlowCookieAttributes,
  sessionCookieAttributes,
} from '@/features/auth/cookies';
import { authService } from '@/features/auth/service/auth-service';
import { env } from '@/lib/env';
import { isAppError, toAppError } from '@/server/errors';
import { logger } from '@/server/logger';

/**
 * Completes the Google OAuth flow.
 *
 * All validation lives in `authService.completeAuthorization`; this handler translates
 * between HTTP and that call, sets cookies, and turns failures into a redirect carrying
 * a user-safe message rather than an error page.
 */

const log = logger.child({ route: 'auth/callback/google' });

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const cookieStore = request.cookies;
  const returnTo = cookieStore.get(COOKIE_NAMES.oauthReturnTo)?.value ?? '/dashboard';

  try {
    const result = await authService.completeAuthorization({
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error'),
      expectedState: cookieStore.get(COOKIE_NAMES.oauthState)?.value,
      codeVerifier: cookieStore.get(COOKIE_NAMES.oauthVerifier)?.value,
      expectedNonce: cookieStore.get(COOKIE_NAMES.oauthNonce)?.value,
      metadata: {
        userAgent: request.headers.get('user-agent'),
        ipAddress: clientIp(request),
      },
    });

    const response = NextResponse.redirect(new URL(returnTo, env.APP_URL));

    response.cookies.set(
      COOKIE_NAMES.session,
      result.session.token,
      sessionCookieAttributes(),
    );
    response.cookies.set(COOKIE_NAMES.csrf, result.csrfToken, csrfCookieAttributes());

    clearHandshakeCookies(response);

    return response;
  } catch (caught) {
    const error = toAppError(caught);

    // Logged at warn, not error: a cancelled sign-in or an expired handshake is a normal
    // occurrence, and treating it as an incident makes real incidents harder to see.
    log.warn('sign-in failed', { code: error.code, reason: error.message });

    const response = NextResponse.redirect(
      new URL(
        `/?auth_error=${encodeURIComponent(
          isAppError(caught) ? caught.userMessage : 'Sign-in failed. Please try again.',
        )}`,
        env.APP_URL,
      ),
    );
    clearHandshakeCookies(response);
    return response;
  }
}

/** The handshake cookies are single-use; leaving them set would allow a replay attempt. */
function clearHandshakeCookies(response: NextResponse): void {
  const expired = expiredCookieAttributes(oauthFlowCookieAttributes());
  for (const name of [
    COOKIE_NAMES.oauthState,
    COOKIE_NAMES.oauthVerifier,
    COOKIE_NAMES.oauthNonce,
    COOKIE_NAMES.oauthReturnTo,
  ]) {
    response.cookies.set(name, '', expired);
  }
}

/**
 * Best-effort client address for the session audit trail. `x-forwarded-for` is a list;
 * the first entry is the client as seen by the outermost proxy.
 */
function clientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? null;
  return request.headers.get('x-real-ip');
}
