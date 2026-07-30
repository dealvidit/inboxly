/**
 * Rate limiting.
 *
 * A fixed-window counter behind an interface, with an in-memory default. The interface is
 * the point: swapping in a Redis-backed limiter later is one implementation and one line
 * in `trpc.ts`, with no procedure changes.
 *
 * The in-memory limiter is **per instance**, so on a horizontally scaled deployment the
 * effective limit is the configured limit times the instance count. That is a documented
 * approximation, not an oversight: it is enough to stop a runaway client or an accidental
 * loop, which is what this defends against. Anything stricter needs shared state.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitDecision;
}

export interface RateLimiterOptions {
  readonly limit?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
}

const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_MS = 60_000;

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const now = options.now ?? (() => Date.now());

  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key) {
      const current = now();
      const existing = windows.get(key);

      if (!existing || existing.resetAt <= current) {
        windows.set(key, { count: 1, resetAt: current + windowMs });
        // Opportunistic sweep: without it the map grows once per distinct key forever,
        // which on a long-lived instance is a slow leak.
        if (windows.size > 10_000) evictExpired(windows, current);
        return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
      }

      if (existing.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((existing.resetAt - current) / 1000),
          ),
        };
      }

      existing.count += 1;
      return {
        allowed: true,
        remaining: limit - existing.count,
        retryAfterSeconds: 0,
      };
    },
  };
}

function evictExpired(
  windows: Map<string, { count: number; resetAt: number }>,
  now: number,
): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}
