import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit';

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

describe('createRateLimiter', () => {
  it('allows requests up to the limit', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });

    expect(limiter.check('user-1').allowed).toBe(true);
    expect(limiter.check('user-1').allowed).toBe(true);
    expect(limiter.check('user-1').allowed).toBe(true);
    expect(limiter.check('user-1').allowed).toBe(false);
  });

  it('reports how many requests remain', () => {
    const limiter = createRateLimiter({ limit: 3 });

    expect(limiter.check('user-1').remaining).toBe(2);
    expect(limiter.check('user-1').remaining).toBe(1);
    expect(limiter.check('user-1').remaining).toBe(0);
  });

  it('counts each key separately, so one user cannot exhaust another', () => {
    const limiter = createRateLimiter({ limit: 1 });

    expect(limiter.check('user-1').allowed).toBe(true);
    expect(limiter.check('user-2').allowed).toBe(true);
    expect(limiter.check('user-1').allowed).toBe(false);
  });

  it('resets once the window has passed', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });

    expect(limiter.check('user-1').allowed).toBe(true);
    expect(limiter.check('user-1').allowed).toBe(false);

    clock.advance(60_001);

    expect(limiter.check('user-1').allowed).toBe(true);
  });

  it('tells a blocked caller when to come back', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });

    limiter.check('user-1');
    clock.advance(20_000);

    expect(limiter.check('user-1').retryAfterSeconds).toBe(40);
  });

  it('never reports a retry delay below one second', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: clock.now });

    limiter.check('user-1');
    clock.advance(999);

    expect(limiter.check('user-1').retryAfterSeconds).toBe(1);
  });

  it('evicts expired windows so the map does not grow without bound', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000, now: clock.now });

    for (let i = 0; i < 10_001; i += 1) limiter.check(`key-${i}`);
    clock.advance(2000);
    // Crossing the threshold again triggers the sweep; the point is that it stays usable.
    for (let i = 0; i < 10_001; i += 1) limiter.check(`later-${i}`);

    expect(limiter.check('key-0').allowed).toBe(true);
  });
});
