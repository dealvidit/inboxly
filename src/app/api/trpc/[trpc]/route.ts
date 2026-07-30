import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createTrpcContext } from '@/server/trpc/context';
import { appRouter } from '@/server/trpc/root';
import { isProduction } from '@/lib/env';
import { logger } from '@/server/logger';

/**
 * The single HTTP entry point for the API.
 *
 * Errors are already formatted by the router's `errorFormatter`; this handler logs
 * anything that escaped so it is not lost, without adding it to the response.
 */

const log = logger.child({ route: 'trpc' });

export const dynamic = 'force-dynamic';

function handler(request: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    createContext: () => createTrpcContext(request),
    // Spread rather than `onError: cond ? fn : undefined`: under
    // exactOptionalPropertyTypes an explicit undefined is not the same as absent.
    ...(isProduction
      ? {}
      : {
          onError: ({ path, error }) => {
            log.error('trpc handler error', error, { path: path ?? 'unknown' });
          },
        }),
  });
}

export { handler as GET, handler as POST };
