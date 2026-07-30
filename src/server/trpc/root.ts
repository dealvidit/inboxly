import { analyticsRouter } from '@/features/analytics/router';
import { emailsRouter } from '@/features/emails/router';
import { syncRouter } from '@/features/sync/router';
import { createTRPCRouter, publicProcedure } from './trpc';

/**
 * The API surface.
 *
 * Routers live in their feature slices and are composed here — the only file that knows
 * about all of them.
 */
export const appRouter = createTRPCRouter({
  /** Who the caller is, or null. Used by the client to decide what to render. */
  me: publicProcedure.query(({ ctx }) => ({ user: ctx.user })),

  emails: emailsRouter,
  sync: syncRouter,
  analytics: analyticsRouter,
});

export type AppRouter = typeof appRouter;
