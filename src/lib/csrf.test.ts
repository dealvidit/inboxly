import { describe, expect, it } from 'vitest';
import { generateToken } from './crypto';
import { ForbiddenError } from '@/server/errors';
import { assertCsrfTokenMatches } from './csrf';

describe('assertCsrfTokenMatches', () => {
  it('accepts a matching header and cookie', () => {
    const token = generateToken();
    expect(() => assertCsrfTokenMatches(token, token)).not.toThrow();
  });

  it('rejects a mismatch', () => {
    expect(() => assertCsrfTokenMatches(generateToken(), generateToken())).toThrow(
      ForbiddenError,
    );
  });

  it('rejects when either side is missing, rather than treating nothing as a match', () => {
    const token = generateToken();

    expect(() => assertCsrfTokenMatches(null, token)).toThrow(/missing/i);
    expect(() => assertCsrfTokenMatches(token, null)).toThrow(/missing/i);
    expect(() => assertCsrfTokenMatches(undefined, undefined)).toThrow(/missing/i);
    // Empty strings are absent, not equal.
    expect(() => assertCsrfTokenMatches('', '')).toThrow(/missing/i);
  });

  it('does not reveal which side failed in the user-facing message', () => {
    try {
      assertCsrfTokenMatches('a', 'b');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ForbiddenError).userMessage).toBe(
        'Your session could not be verified. Please refresh and try again.',
      );
    }
  });
});
