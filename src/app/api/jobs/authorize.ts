import type { NextRequest } from 'next/server';
import { constantTimeEqual } from '@/lib/crypto';
import { env } from '@/lib/env';
import { UnauthorizedError } from '@/server/errors';

/**
 * Authenticates a scheduled job request.
 *
 * These endpoints trigger work for *any* user, so without this they would let anyone on
 * the internet drive synchronization and spend AI budget. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; a plain `x-cron-secret` header is also accepted
 * so the endpoints can be exercised by other schedulers and by hand.
 *
 * The comparison is constant-time so response timing does not leak how much of a guessed
 * secret was correct.
 */
export function assertCronAuthorized(request: NextRequest): void {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const header = request.headers.get('x-cron-secret');
  const supplied = bearer ?? header;

  if (!supplied || !constantTimeEqual(supplied, env.CRON_SECRET)) {
    throw new UnauthorizedError('Invalid cron credentials', {
      userMessage: 'Not authorised.',
    });
  }
}
