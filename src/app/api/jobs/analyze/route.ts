import { NextResponse, type NextRequest } from 'next/server';
import { analysisRunner } from '@/features/processing';
import { findUserIdsWithPendingWork } from '@/features/processing/repository/queue-repository';
import { toAppError } from '@/server/errors';
import { logger } from '@/server/logger';
import { assertCronAuthorized } from '../authorize';

/**
 * Runs a batch of AI analysis.
 *
 * Idempotent by construction: it claims whatever is currently claimable, so a duplicate
 * or retried invocation processes the next batch rather than re-processing the last one.
 * That is what makes it safe for an at-least-once scheduler (ADR 0009).
 */

const log = logger.child({ route: 'jobs/analyze' });

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Users visited per invocation, so one busy mailbox cannot starve the rest. */
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

  const userIds = await findUserIdsWithPendingWork(MAX_USERS_PER_RUN);

  if (userIds.length === 0) {
    return NextResponse.json({ users: 0, completed: 0, failed: 0 });
  }

  let completed = 0;
  let failed = 0;
  let retrying = 0;

  for (const userId of userIds) {
    try {
      const result = await analysisRunner.run(userId);
      completed += result.completed;
      failed += result.failed;
      retrying += result.retrying;
    } catch (error) {
      // One user's failure must not abort the run for everyone else.
      log.error('analysis run failed for a user', error, { userId });
    }
  }

  log.info('analysis job finished', {
    users: userIds.length,
    completed,
    failed,
    retrying,
  });

  return NextResponse.json({ users: userIds.length, completed, failed, retrying });
}
