'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import { useState, type ReactNode } from 'react';
import superjson from 'superjson';
import { CSRF_HEADER } from '@/lib/csrf-header';
import { readCsrfToken } from '@/features/auth/read-csrf-token';
import type { AppRouter } from '@/server/trpc/root';

/**
 * The browser-side tRPC client.
 *
 * Types come from `AppRouter` by inference, so renaming a field on the server surfaces as
 * a compile error in the component that reads it rather than as `undefined` at runtime.
 */

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

/**
 * Defaults chosen for this application's read pattern (ADR 0010).
 *
 * `staleTime` of 30s means moving between views does not refetch what was just fetched.
 * Retrying is off for mutations: they are not idempotent from the user's point of view,
 * and a silent retry of "run sync" is worse than an error the user can act on.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
      mutations: { retry: false },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient(): QueryClient {
  // A fresh client per server render; a single shared one in the browser, so navigating
  // between pages does not discard the cache.
  if (typeof window === 'undefined') return createQueryClient();
  browserQueryClient ??= createQueryClient();
  return browserQueryClient;
}

export function TrpcProviders({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();

  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: '/api/trpc',
          transformer: superjson,
          // Every request carries the CSRF token; mutations require it, and sending it
          // unconditionally means no call site has to remember.
          headers() {
            const token = readCsrfToken();
            return token ? { [CSRF_HEADER]: token } : {};
          },
        }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
