/**
 * Retry with exponential backoff and full jitter.
 *
 * Kept generic and dependency-free because two callers need it — the Gmail client and
 * the AI provider — and both need the same three things this gives them: a decision
 * function that says whether an error is worth retrying, jitter so that concurrent
 * runners do not synchronise into a thundering herd, and respect for a server-supplied
 * `Retry-After`.
 *
 * `sleep` and `random` are injectable so the tests can assert on the delay *sequence*
 * without actually waiting.
 */

export interface RetryDecision {
  readonly retry: boolean;
  /** Overrides the computed backoff — used when a server tells us how long to wait. */
  readonly retryAfterMs?: number;
}

export interface RetryOptions {
  /** Total attempts, including the first. `3` means one call and two retries. */
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Decides whether a given failure is worth retrying. */
  readonly shouldRetry: (error: unknown, attempt: number) => RetryDecision;
  /** Called before each retry — used for logging, never for control flow. */
  readonly onRetry?: (context: {
    error: unknown;
    attempt: number;
    delayMs: number;
  }) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Returns a value in [0, 1). Injected so delays are deterministic in tests. */
  readonly random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Full jitter: a uniformly random delay in `[0, exponential)`.
 *
 * "Equal jitter" or a fixed exponential would leave many callers retrying in step after
 * a shared outage, which is precisely when the upstream can least afford it. Full jitter
 * spreads them out, at the cost of an occasionally very short wait.
 */
export function computeBackoffMs(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exponential = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
  return Math.round(random() * exponential);
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      // Out of attempts: rethrow rather than asking whether to retry, so the decision
      // function cannot accidentally cause an extra call.
      if (attempt >= options.maxAttempts) break;

      const decision = options.shouldRetry(error, attempt);
      if (!decision.retry) break;

      const delayMs =
        decision.retryAfterMs ??
        computeBackoffMs(attempt, options.initialDelayMs, options.maxDelayMs, random);

      options.onRetry?.({ error, attempt, delayMs });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * A wall-clock budget for work that must finish before the platform kills it.
 *
 * Used by the sync and analysis runners: both check `hasTimeRemaining` between units of
 * work so that a run stops cleanly with a valid checkpoint rather than being terminated
 * mid-write. See ADRs 0004 and 0006.
 */
export class TimeBudget {
  private readonly deadline: number;

  constructor(
    budgetMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.deadline = now() + budgetMs;
  }

  get remainingMs(): number {
    return Math.max(0, this.deadline - this.now());
  }

  /**
   * True when there is enough time left to attempt another unit of work.
   *
   * `reserveMs` is the caller's estimate of how long that unit takes; passing it stops
   * the runner from starting something it cannot finish.
   */
  hasTimeRemaining(reserveMs = 0): boolean {
    return this.remainingMs > reserveMs;
  }

  get isExhausted(): boolean {
    return this.remainingMs === 0;
  }
}
