import { googleAccountService, revokeAllSessions } from '@/features/auth';
import { syncService } from '@/features/gmail';
import { analysisRunner } from '@/features/processing';
import { ConflictError } from '@/server/errors';
import {
  createTRPCRouter,
  mutationProcedure,
  protectedProcedure,
  toTrpcError,
} from '@/server/trpc/trpc';

/**
 * Synchronization and connection control.
 *
 * Everything here is a mutation on `mutationProcedure`, so each one is CSRF-checked and
 * rate limited — these are the endpoints that spend Gmail quota and AI budget.
 */
export const syncRouter = createTRPCRouter({
  status: protectedProcedure.query(async ({ ctx }) => {
    const [connection, isRunning, latestRun, queueDepth] = await Promise.all([
      googleAccountService.getConnection(ctx.user.id),
      syncService.isRunning(ctx.user.id),
      syncService.getLatestRun(ctx.user.id),
      analysisRunner.queueDepth(ctx.user.id),
    ]);

    return { connection, isRunning, latestRun, queueDepth };
  }),

  /**
   * Runs a synchronization now.
   *
   * Refuses when one is already in progress: a second concurrent run would duplicate API
   * calls for no benefit, since the first already holds the checkpoint.
   */
  runNow: mutationProcedure.mutation(async ({ ctx }) => {
    if (await syncService.isRunning(ctx.user.id)) {
      throw toTrpcError(
        new ConflictError(
          'A synchronization is already running. Please wait for it to finish.',
        ),
      );
    }

    return syncService.run(ctx.user.id, 'USER');
  }),

  /** Runs one analysis batch on demand, so the dashboard fills without waiting for cron. */
  analyzeNow: mutationProcedure.mutation(async ({ ctx }) =>
    analysisRunner.run(ctx.user.id),
  ),

  /**
   * Disconnects Gmail.
   *
   * Also signs the user out everywhere: a disconnected account should not stay browsable
   * from another device that still holds a session.
   */
  disconnect: mutationProcedure.mutation(async ({ ctx }) => {
    await googleAccountService.disconnect(ctx.user.id);
    await revokeAllSessions(ctx.user.id);
    return { ok: true };
  }),
});
