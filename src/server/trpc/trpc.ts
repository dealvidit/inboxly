import { TRPCError, initTRPC } from '@trpc/server';
import superjson from 'superjson';
import type { ZodError } from 'zod';
import { assertCsrfTokenMatches } from '@/lib/csrf';
import { isAppError, toAppError, type AppError } from '@/server/errors';
import { logger } from '@/server/logger';
import { createRateLimiter } from './rate-limit';
import type { TrpcContext } from './context';

/**
 * tRPC initialisation and the procedure hierarchy.
 *
 * The hierarchy exists so the safe thing is the default: `protectedProcedure` resolves the
 * user, and `mutationProcedure` additionally checks CSRF and rate limits. A mutation built
 * on anything but `mutationProcedure` is a visible mistake in review rather than a silent
 * hole (ADR 0008).
 */

const log = logger.child({ component: 'trpc' });

const t = initTRPC.context<TrpcContext>().create({
  // Dates and Maps survive the wire, so `receivedAt` arrives as a Date rather than a
  // string the client has to remember to parse.
  transformer: superjson,

  /**
   * Maps errors to what the client is allowed to see.
   *
   * Only `userMessage` crosses the boundary. Stack traces, provider text, and internal
   * identifiers stay server-side; the client gets a `requestId` to quote instead.
   */
  errorFormatter({ shape, error, ctx }) {
    const cause = error.cause;
    const appError = isAppError(cause) ? cause : null;

    return {
      ...shape,
      message: appError?.userMessage ?? safeMessage(error.code, shape.message),
      data: {
        ...shape.data,
        appCode: appError?.code ?? null,
        requestId: ctx?.requestId ?? null,
        // Zod issues are safe and genuinely useful to a client rendering a form.
        validationIssues:
          error.code === 'BAD_REQUEST' && isZodError(cause)
            ? cause.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
              }))
            : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;

/**
 * Converts our typed errors into tRPC errors, and logs anything unrecognised.
 *
 * Placed on the base procedure so every route gets it — including ones added later by
 * someone who has not read this file.
 */
const errorMiddleware = t.middleware(async ({ next, path, ctx }) => {
  const result = await next();
  if (result.ok) return result;

  const error = result.error;
  const appError = isAppError(error.cause) ? error.cause : null;

  if (appError) {
    log.warn('procedure failed', {
      path,
      code: appError.code,
      requestId: ctx.requestId,
      userId: ctx.user?.id,
    });
  } else {
    // Unrecognised: log the detail, return the generic message.
    log.error('unhandled procedure error', error.cause ?? error, {
      path,
      requestId: ctx.requestId,
      userId: ctx.user?.id,
    });
  }

  return result;
});

export const publicProcedure = t.procedure.use(errorMiddleware);

/**
 * Requires a session. Injects a non-null `user`, so no procedure body checks
 * authentication and none can forget to.
 */
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Please sign in to continue.',
    });
  }

  return next({ ctx: { ...ctx, user: ctx.user } });
});

const rateLimiter = createRateLimiter();

/**
 * For every state-changing procedure: authentication, CSRF, and a rate limit.
 *
 * CSRF is skipped when there is no cookie at all, which is the server-side caller case —
 * same-origin by construction, with no browser involved. A browser request always carries
 * the cookie, so this cannot be used to bypass the check from outside.
 */
export const mutationProcedure = protectedProcedure.use(({ ctx, next, path }) => {
  if (ctx.csrfCookie !== null || ctx.csrfHeader !== null) {
    try {
      assertCsrfTokenMatches(ctx.csrfHeader, ctx.csrfCookie);
    } catch (error) {
      throw toTrpcError(error);
    }
  }

  const decision = rateLimiter.check(`${ctx.user.id}:${path}`);
  if (!decision.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Too many requests. Try again in ${decision.retryAfterSeconds}s.`,
    });
  }

  return next();
});

/* ─── Helpers ────────────────────────────────────────────────────────────── */

const TRPC_CODE_BY_STATUS: Record<number, TRPCError['code']> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_SERVER_ERROR',
  502: 'BAD_GATEWAY',
};

/** Wraps an application error so tRPC reports the right code and our safe message. */
export function toTrpcError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;

  const appError: AppError = toAppError(error);
  return new TRPCError({
    code: TRPC_CODE_BY_STATUS[appError.httpStatus] ?? 'INTERNAL_SERVER_ERROR',
    message: appError.userMessage,
    cause: appError,
  });
}

/** Never echo an internal message for a 500 — it may contain anything. */
function safeMessage(code: string, fallback: string): string {
  return code === 'INTERNAL_SERVER_ERROR'
    ? 'Something went wrong on our end.'
    : fallback;
}

function isZodError(error: unknown): error is ZodError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown }).issues)
  );
}
