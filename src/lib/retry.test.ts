import { describe, expect, it, vi } from 'vitest';
import { TimeBudget, computeBackoffMs, withRetry } from './retry';

/** Records delays instead of waiting, so the delay sequence can be asserted. */
function recordingSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

const alwaysRetry = () => ({ retry: true });
/** random() = 1 makes full jitter degenerate to the full exponential, so delays are exact. */
const noJitter = () => 1;

describe('withRetry', () => {
  it('returns the first successful result without sleeping', async () => {
    const { delays, sleep } = recordingSleep();
    const operation = vi.fn(async () => 'ok');

    const result = await withRetry(operation, {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      shouldRetry: alwaysRetry,
      sleep,
    });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('retries until it succeeds', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const operation = async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    };

    expect(
      await withRetry(operation, {
        maxAttempts: 5,
        initialDelayMs: 10,
        maxDelayMs: 100,
        shouldRetry: alwaysRetry,
        sleep,
      }),
    ).toBe('ok');
    expect(calls).toBe(3);
  });

  it('passes the attempt number to the operation', async () => {
    const { sleep } = recordingSleep();
    const attempts: number[] = [];

    await withRetry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 3) throw new Error('transient');
        return 'ok';
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1,
        maxDelayMs: 10,
        shouldRetry: alwaysRetry,
        sleep,
      },
    );

    expect(attempts).toEqual([1, 2, 3]);
  });

  it('backs off exponentially, capped at maxDelayMs', async () => {
    const { delays, sleep } = recordingSleep();

    await expect(
      withRetry(
        async () => {
          throw new Error('always fails');
        },
        {
          maxAttempts: 6,
          initialDelayMs: 100,
          maxDelayMs: 800,
          shouldRetry: alwaysRetry,
          sleep,
          random: noJitter,
        },
      ),
    ).rejects.toThrow('always fails');

    // 100, 200, 400, then capped at 800.
    expect(delays).toEqual([100, 200, 400, 800, 800]);
  });

  it('applies jitter so concurrent callers do not retry in lockstep', async () => {
    const { delays, sleep } = recordingSleep();

    await expect(
      withRetry(
        async () => {
          throw new Error('fail');
        },
        {
          maxAttempts: 3,
          initialDelayMs: 1000,
          maxDelayMs: 10_000,
          shouldRetry: alwaysRetry,
          sleep,
          random: () => 0.25,
        },
      ),
    ).rejects.toThrow();

    // A quarter of the exponential, not the exponential itself.
    expect(delays).toEqual([250, 500]);
  });

  it('honours a server-supplied retry delay over its own backoff', async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;

    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('rate limited');
        return 'ok';
      },
      {
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        shouldRetry: () => ({ retry: true, retryAfterMs: 5000 }),
        sleep,
        random: noJitter,
      },
    );

    expect(delays).toEqual([5000]);
  });

  it('stops immediately when the error is not retryable', async () => {
    const { delays, sleep } = recordingSleep();
    const operation = vi.fn(async () => {
      throw new Error('permanent');
    });

    await expect(
      withRetry(operation, {
        maxAttempts: 5,
        initialDelayMs: 10,
        maxDelayMs: 100,
        shouldRetry: () => ({ retry: false }),
        sleep,
      }),
    ).rejects.toThrow('permanent');

    expect(operation).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`failure ${calls}`);
        },
        {
          maxAttempts: 3,
          initialDelayMs: 10,
          maxDelayMs: 100,
          shouldRetry: alwaysRetry,
          sleep,
        },
      ),
    ).rejects.toThrow('failure 3');

    expect(calls).toBe(3);
    // Two sleeps for three attempts — never a sleep after the final failure.
    expect(delays).toHaveLength(2);
  });

  it('does not consult shouldRetry after the final attempt', async () => {
    const { sleep } = recordingSleep();
    const shouldRetry = vi.fn(alwaysRetry);

    await expect(
      withRetry(
        async () => {
          throw new Error('fail');
        },
        {
          maxAttempts: 2,
          initialDelayMs: 1,
          maxDelayMs: 10,
          shouldRetry,
          sleep,
        },
      ),
    ).rejects.toThrow();

    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it('reports each retry for logging', async () => {
    const { sleep } = recordingSleep();
    const retries: Array<{ attempt: number; delayMs: number }> = [];

    await expect(
      withRetry(
        async () => {
          throw new Error('fail');
        },
        {
          maxAttempts: 3,
          initialDelayMs: 100,
          maxDelayMs: 1000,
          shouldRetry: alwaysRetry,
          onRetry: ({ attempt, delayMs }) => retries.push({ attempt, delayMs }),
          sleep,
          random: noJitter,
        },
      ),
    ).rejects.toThrow();

    expect(retries).toEqual([
      { attempt: 1, delayMs: 100 },
      { attempt: 2, delayMs: 200 },
    ]);
  });

  it('runs exactly once when maxAttempts is 1', async () => {
    const operation = vi.fn(async () => {
      throw new Error('fail');
    });

    await expect(
      withRetry(operation, {
        maxAttempts: 1,
        initialDelayMs: 10,
        maxDelayMs: 100,
        shouldRetry: alwaysRetry,
      }),
    ).rejects.toThrow();

    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('computeBackoffMs', () => {
  it('doubles per attempt before the cap', () => {
    expect(computeBackoffMs(1, 100, 10_000, noJitter)).toBe(100);
    expect(computeBackoffMs(2, 100, 10_000, noJitter)).toBe(200);
    expect(computeBackoffMs(3, 100, 10_000, noJitter)).toBe(400);
    expect(computeBackoffMs(4, 100, 10_000, noJitter)).toBe(800);
  });

  it('never exceeds the cap, however many attempts have passed', () => {
    expect(computeBackoffMs(20, 100, 5000, noJitter)).toBe(5000);
  });

  it('stays within [0, exponential] for any random value', () => {
    for (const value of [0, 0.01, 0.5, 0.99]) {
      const delay = computeBackoffMs(3, 100, 10_000, () => value);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(400);
    }
  });
});

describe('TimeBudget', () => {
  /** A clock the test advances by hand. */
  function fakeClock(start = 1_000_000) {
    let current = start;
    return {
      now: () => current,
      advance: (ms: number) => {
        current += ms;
      },
    };
  }

  it('reports the time remaining as the clock advances', () => {
    const clock = fakeClock();
    const budget = new TimeBudget(10_000, clock.now);

    expect(budget.remainingMs).toBe(10_000);
    clock.advance(4000);
    expect(budget.remainingMs).toBe(6000);
  });

  it('clamps to zero rather than going negative', () => {
    const clock = fakeClock();
    const budget = new TimeBudget(1000, clock.now);

    clock.advance(5000);

    expect(budget.remainingMs).toBe(0);
    expect(budget.isExhausted).toBe(true);
  });

  it('refuses to start work it cannot finish, via the reserve', () => {
    const clock = fakeClock();
    const budget = new TimeBudget(10_000, clock.now);

    clock.advance(8000);

    // 2s left: enough for a 1s unit of work, not for a 5s one.
    expect(budget.hasTimeRemaining(1000)).toBe(true);
    expect(budget.hasTimeRemaining(5000)).toBe(false);
  });

  it('has time remaining until it is exactly exhausted', () => {
    const clock = fakeClock();
    const budget = new TimeBudget(1000, clock.now);

    expect(budget.hasTimeRemaining()).toBe(true);
    clock.advance(1000);
    expect(budget.hasTimeRemaining()).toBe(false);
  });
});
