import { afterEach, describe, expect, it } from 'vitest';
import { readCsrfToken } from './read-csrf-token';

/**
 * These run in the node environment, where `document` does not exist — which is itself
 * one of the cases worth asserting, since this module is imported during server rendering.
 */

function setCookies(value: string): void {
  Object.defineProperty(globalThis, 'document', {
    value: { cookie: value },
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

describe('readCsrfToken', () => {
  it('reads the development cookie name', () => {
    setCookies('inboxly_csrf=abc123');

    expect(readCsrfToken()).toBe('abc123');
  });

  it('reads the production __Host- prefixed name', () => {
    // The prefix is applied from `isProduction`, which the browser cannot see. Accepting
    // both names is what lets this module stay free of server configuration.
    setCookies('__Host-inboxly_csrf=abc123');

    expect(readCsrfToken()).toBe('abc123');
  });

  it('finds the token among unrelated cookies', () => {
    setCookies('other=1; inboxly_csrf=abc123; another=2');

    expect(readCsrfToken()).toBe('abc123');
  });

  it('does not confuse the session cookie for the CSRF one', () => {
    // Both share the `inboxly_` stem; a substring match here would return a session token
    // as a CSRF token, and every mutation would fail confusingly.
    setCookies('inboxly_session=session-token');

    expect(readCsrfToken()).toBeNull();
  });

  it('decodes a percent-encoded value', () => {
    setCookies('inboxly_csrf=a%2Bb%3Dc');

    expect(readCsrfToken()).toBe('a+b=c');
  });

  it('returns null when the cookie is absent', () => {
    setCookies('other=1');

    expect(readCsrfToken()).toBeNull();
  });

  it('returns null during server rendering, where there is no document', () => {
    expect(readCsrfToken()).toBeNull();
  });
});
