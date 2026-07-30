import { syncService } from '@/features/gmail';
import {
  getCategoryBreakdown,
  getDashboardStats,
} from '@/features/emails/repository/email-repository';
import { createTRPCRouter, protectedProcedure } from '@/server/trpc/trpc';

/**
 * The dashboard's widgets.
 *
 * Assembled here rather than in the UI so a Server Component and a client poll see the
 * same numbers computed the same way.
 */
export const analyticsRouter = createTRPCRouter({
  /**
   * Everything the widget row needs.
   *
   * `isSyncing` drives whether the client polls at all — an interval that stops matters
   * as much as one that starts (ADR 0010).
   */
  dashboard: protectedProcedure.query(async ({ ctx }) => {
    const [stats, categories, latestRun, isSyncing, checkpoint] = await Promise.all([
      getDashboardStats(ctx.user.id),
      getCategoryBreakdown(ctx.user.id),
      syncService.getLatestRun(ctx.user.id),
      syncService.isRunning(ctx.user.id),
      syncService.getCheckpoint(ctx.user.id),
    ]);

    return {
      ...stats,
      categories,
      isSyncing,
      lastSyncedAt: checkpoint?.lastSyncedAt ?? null,
      lastRun: latestRun
        ? {
            id: latestRun.id,
            phase: latestRun.phase,
            status: latestRun.status,
            startedAt: latestRun.startedAt,
            finishedAt: latestRun.finishedAt,
            messagesCreated: latestRun.messagesCreated,
            messagesUpdated: latestRun.messagesUpdated,
            messagesDeleted: latestRun.messagesDeleted,
            // A user-safe message; provider detail never reaches here.
            error: latestRun.error,
          }
        : null,
    };
  }),
});
