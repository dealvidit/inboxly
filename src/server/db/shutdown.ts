import { db } from './client';
import { logger } from '@/server/logger';

/**
 * Graceful shutdown.
 *
 * Serverless functions are frozen rather than signalled, so on Vercel this never fires —
 * there, the guarantee that no work is lost comes from checkpoints and per-email commits
 * (ADRs 0004 and 0006), not from cleanup on exit.
 *
 * It matters for the self-hosted and local cases, where the process really does receive
 * SIGTERM and an unclosed pool holds the connection open past exit.
 */

let registered = false;

export function registerShutdownHandlers(): void {
  if (registered) return;
  registered = true;

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void (async () => {
        logger.info('shutting down', { signal });
        try {
          await db.$disconnect();
        } catch (error) {
          logger.error('failed to close the database pool', error);
        }
        process.exit(0);
      })();
    });
  }
}
