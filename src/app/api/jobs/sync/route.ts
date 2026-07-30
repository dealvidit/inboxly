import { NextResponse, type NextRequest } from 'next/server';
import { syncService } from '@/features/gmail';
import { findConnectedUserIds } from '@/features/gmail/repository/sync-repository';
import { toAppError } from '@/server/errors';
import { logger } from '@/server/logger';
import { assertCronAuthorized } from '../authorize';

/**
 * Runs incremental synchronization for connected mailboxes.
 *
 * Idempotent: every write is an upsert on a natural key, and each run resumes from the
 * stored checkpoint, so a duplicate invocation converges rather than duplicating
 * (ADR 0004).
 */

const log = logger.child({ route: 'jobs/sync' });

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Mailboxes visited per invocation, so the run stays inside its time budget. */
const MAX_USERS_PER_RUN = 5;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertCronAuthorized(request);
  } catch (caught) {
    const error = toAppError(caught);
    return NextResponse.json(
      { error: error.toClientPayload() },
      { status: error.httpStatus },
    );
  }

  const userIds = await findConnectedUserIds(MAX_USERS_PER_RUN);

  let synced = 0;
  let messagesCreated = 0;
  let failures = 0;

  for (const userId of userIds) {
    try {
      const result = await syncService.run(userId, 'CRON');
      synced += 1;
      messagesCreated += result.messagesCreated;
      if (result.status === 'FAILED') failures += 1;
    } catch (error) {
      log.error('sync run failed for a user', error, { userId });
      failures += 1;
    }
  }

  log.info('sync job finished', { users: userIds.length, messagesCreated, failures });

  return NextResponse.json({ users: synced, messagesCreated, failures });
}
