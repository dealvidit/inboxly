import { COOKIE_NAMES, resolveSession } from '@/features/auth';
import type { AuthenticatedUser } from '@/features/auth';

/**
 * Per-request context.
 *
 * Built from the raw Request rather than from `next/headers` so the same builder works
 * for the HTTP adapter and for a server-side caller in tests.
 */

export interface TrpcContext {
  readonly user: AuthenticatedUser | null;
  readonly sessionId: string | null;
  /** From the double-submit cookie; compared against the header by mutations. */
  readonly csrfCookie: string | null;
  readonly csrfHeader: string | null;
  readonly requestId: string;
}

export async function createTrpcContext(request: Request): Promise<TrpcContext> {
  const cookies = parseCookies(request.headers.get('cookie'));
  const session = await resolveSession(cookies[COOKIE_NAMES.session]);

  return {
    user: session?.user ?? null,
    sessionId: session?.sessionId ?? null,
    csrfCookie: cookies[COOKIE_NAMES.csrf] ?? null,
    csrfHeader: request.headers.get('x-csrf-token'),
    // Correlates a client-visible error with its server-side log entry.
    requestId: request.headers.get('x-request-id') ?? crypto.randomUUID(),
  };
}

/** Context for a trusted server-side caller — Server Components and tests. */
export function createServerContext(user: AuthenticatedUser): TrpcContext {
  return {
    user,
    sessionId: null,
    // A server-side caller is same-origin by definition; CSRF has no meaning here.
    csrfCookie: null,
    csrfHeader: null,
    requestId: crypto.randomUUID(),
  };
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};

  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) result[name] = decodeURIComponent(value);
  }
  return result;
}
