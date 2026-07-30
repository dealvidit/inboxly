import { NextResponse } from 'next/server';
import { db } from '@/server/db';
import { env } from '@/lib/env';
import { logger } from '@/server/logger';

/**
 * Liveness and readiness.
 *
 * Suitable for an uptime monitor and as a deployment gate. It checks the database,
 * because a process that cannot reach Postgres is not ready to serve even though it is
 * running — reporting 200 in that state is what makes health checks useless.
 *
 * It deliberately does *not* check Gmail or Anthropic: those are per-user, credential-
 * dependent, and their failure does not mean this deployment is unhealthy. Their health
 * is visible in SyncRun rows and AnalysisAttempt outcomes instead.
 */

const log = logger.child({ route: 'health' });

export const dynamic = 'force-dynamic';

const startedAt = Date.now();

export async function GET(): Promise<NextResponse> {
  const checkedAt = new Date().toISOString();

  try {
    const began = Date.now();
    await db.$queryRaw`SELECT 1`;
    const databaseMs = Date.now() - began;

    return NextResponse.json(
      {
        status: 'ok',
        checkedAt,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        environment: env.NODE_ENV,
        checks: { database: { status: 'ok', latencyMs: databaseMs } },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    log.error('health check failed', error);

    // 503 rather than 500: the service is unavailable, not broken in a way a retry
    // cannot fix — which is what a load balancer needs to know.
    return NextResponse.json(
      {
        status: 'degraded',
        checkedAt,
        // No error detail: this endpoint is typically public.
        checks: { database: { status: 'error' } },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
