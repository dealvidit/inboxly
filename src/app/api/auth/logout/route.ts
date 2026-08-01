import { NextResponse, type NextRequest } from 'next/server';
import {
  COOKIE_NAMES,
  csrfCookieAttributes,
  expiredCookieAttributes,
  sessionCookieAttributes,
} from '@/features/auth/cookies';
import { assertCsrfTokenMatches } from '@/lib/csrf';
import { CSRF_HEADER } from '@/lib/csrf-header';
import { revokeSession } from '@/features/auth/service/session-service';
import { env } from '@/lib/env';
import { toAppError } from '@/server/errors';
import { logger } from '@/server/logger';

/**
 * Signs the user out.
 *
 * POST only, and CSRF-protected: a GET logout can be triggered by any image tag on any
 * page, which is an annoyance rather than a breach, but it is trivially avoidable.
 */

const log = logger.child({ route: 'auth/logout' });

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const sessionToken = request.cookies.get(COOKIE_NAMES.session)?.value;

  try {
    assertCsrfTokenMatches(
      request.headers.get(CSRF_HEADER),
      request.cookies.get(COOKIE_NAMES.csrf)?.value,
    );
  } catch (caught) {
    const error = toAppError(caught);
    log.warn('logout rejected', { code: error.code });
    return NextResponse.json(
      { error: error.toClientPayload() },
      { status: error.httpStatus },
    );
  }

  // Revoking deletes the row, so the token is dead server-side even if the browser keeps
  // the cookie. This is the reason for database-backed sessions (ADR 0003).
  await revokeSession(sessionToken);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    COOKIE_NAMES.session,
    '',
    expiredCookieAttributes(sessionCookieAttributes()),
  );
  response.cookies.set(
    COOKIE_NAMES.csrf,
    '',
    expiredCookieAttributes(csrfCookieAttributes()),
  );

  return response;
}

/**
 * A GET here is almost always someone following a stale `/api/auth/logout` link, so it
 * redirects home rather than returning a bare 405.
 */
export function GET(): NextResponse {
  return NextResponse.redirect(new URL('/', env.APP_URL));
}
