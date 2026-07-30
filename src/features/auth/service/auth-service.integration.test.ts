import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GMAIL_READONLY_SCOPE, type GoogleIdTokenClaims } from '../domain/google';
import { createAuthService } from './auth-service';
import { createGoogleAccountService } from './google-account-service';
import type { GoogleOAuthClient } from './google-oauth-client';
import { resolveSession } from './session-service';
import { resetDatabase, testDb } from '~/tests/db';

/**
 * The callback is where a forged sign-in would be attempted, so its validation is worth
 * testing directly rather than only through the HTTP handler.
 *
 * The assertion that matters most in this file is negative: a failed check must not have
 * spent the authorization code. `exchangeCalls` proves it.
 */

beforeEach(resetDatabase);
afterAll(async () => {
  await testDb.$disconnect();
});

const claims: GoogleIdTokenClaims = {
  sub: 'google-subject-abc',
  email: 'person@example.com',
  email_verified: true,
  name: 'A Person',
  picture: 'https://example.com/avatar.png',
};

function fakeOauth(
  overrides: {
    verifyIdToken?: GoogleOAuthClient['verifyIdToken'];
    idToken?: string | undefined;
  } = {},
) {
  const exchangeCalls: Array<{ code: string; verifier: string }> = [];

  const client: GoogleOAuthClient = {
    buildAuthorizationUrl: (params) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${params.state}&nonce=${params.nonce}&code_challenge=${params.codeChallenge}`,
    exchangeCode: async (code, verifier) => {
      exchangeCalls.push({ code, verifier });
      return {
        accessToken: 'access-token',
        accessTokenExpiresAt: new Date('2026-07-30T11:00:00Z'),
        refreshToken: 'refresh-token',
        scopes: ['openid', 'email', 'profile', GMAIL_READONLY_SCOPE],
        idToken: 'idToken' in overrides ? overrides.idToken : 'signed.id.token',
      };
    },
    refreshAccessToken: async () => {
      throw new Error('not used');
    },
    verifyIdToken: overrides.verifyIdToken ?? (async () => claims),
    revokeToken: async () => {},
  };

  return { client, exchangeCalls };
}

function service(oauthClient: GoogleOAuthClient) {
  return createAuthService({
    oauthClient,
    accountService: createGoogleAccountService({ oauthClient }),
  });
}

const metadata = { userAgent: 'test-agent', ipAddress: '203.0.113.9' };

/** A callback whose local checks all pass. */
function validCallback(overrides: Record<string, unknown> = {}) {
  return {
    code: 'auth-code',
    state: 'the-state',
    error: null,
    expectedState: 'the-state',
    codeVerifier: 'the-verifier',
    expectedNonce: 'the-nonce',
    metadata,
    ...overrides,
  };
}

describe('beginAuthorization', () => {
  it('generates independent state, nonce, and PKCE values per attempt', () => {
    const { client } = fakeOauth();
    const auth = service(client);

    const first = auth.beginAuthorization();
    const second = auth.beginAuthorization();

    expect(first.state).not.toBe(second.state);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });

  it('sends the state and nonce it generated to Google', () => {
    const { client } = fakeOauth();
    const request = service(client).beginAuthorization();
    const url = new URL(request.authorizationUrl);

    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('nonce')).toBe(request.nonce);
  });

  it('does not put the code verifier in the URL — only its challenge', () => {
    const { client } = fakeOauth();
    const request = service(client).beginAuthorization();

    expect(request.authorizationUrl).not.toContain(request.codeVerifier);
  });
});

describe('completeAuthorization — rejected callbacks', () => {
  it('rejects a state mismatch without spending the authorization code', async () => {
    const { client, exchangeCalls } = fakeOauth();

    await expect(
      service(client).completeAuthorization(
        validCallback({ state: 'forged-state', expectedState: 'the-state' }),
      ),
    ).rejects.toThrow(/state mismatch/i);

    // The important part: a forged callback caused no request to Google.
    expect(exchangeCalls).toHaveLength(0);
    expect(await testDb.user.count()).toBe(0);
  });

  it('rejects a callback with no state cookie, which is what a bare replay looks like', async () => {
    const { client, exchangeCalls } = fakeOauth();

    await expect(
      service(client).completeAuthorization(
        validCallback({ expectedState: undefined }),
      ),
    ).rejects.toThrow(/state mismatch/i);
    expect(exchangeCalls).toHaveLength(0);
  });

  it('rejects when the handshake cookies have expired', async () => {
    const { client, exchangeCalls } = fakeOauth();

    await expect(
      service(client).completeAuthorization(validCallback({ codeVerifier: undefined })),
    ).rejects.toMatchObject({
      message: 'OAuth handshake cookies are missing',
      userMessage: 'Sign-in took too long. Please try again.',
    });
    expect(exchangeCalls).toHaveLength(0);
  });

  it('reports a cancelled sign-in in plain language', async () => {
    const { client } = fakeOauth();

    await expect(
      service(client).completeAuthorization(
        validCallback({ error: 'access_denied', code: null }),
      ),
    ).rejects.toMatchObject({ userMessage: 'Sign-in was cancelled.' });
  });

  it('rejects a callback missing the code', async () => {
    const { client } = fakeOauth();

    await expect(
      service(client).completeAuthorization(validCallback({ code: null })),
    ).rejects.toThrow(/missing code or state/i);
  });

  it('rejects a token response with no ID token, and creates no user', async () => {
    const { client } = fakeOauth({ idToken: undefined });

    await expect(
      service(client).completeAuthorization(validCallback()),
    ).rejects.toThrow(/no ID token/i);
    expect(await testDb.user.count()).toBe(0);
  });

  it('creates nothing when ID token verification fails', async () => {
    const { client } = fakeOauth({
      verifyIdToken: async () => {
        throw new Error('signature invalid');
      },
    });

    await expect(
      service(client).completeAuthorization(validCallback()),
    ).rejects.toThrow(/signature invalid/);
    expect(await testDb.user.count()).toBe(0);
    expect(await testDb.session.count()).toBe(0);
    expect(await testDb.googleAccount.count()).toBe(0);
  });
});

describe('completeAuthorization — successful sign-in', () => {
  it('creates the user, stores the connection, and issues a working session', async () => {
    const { client, exchangeCalls } = fakeOauth();

    const result = await service(client).completeAuthorization(validCallback());

    expect(exchangeCalls).toEqual([{ code: 'auth-code', verifier: 'the-verifier' }]);
    expect(result.user.email).toBe('person@example.com');
    expect(result.user.name).toBe('A Person');

    const resolved = await resolveSession(result.session.token);
    expect(resolved?.user.id).toBe(result.user.id);

    const account = await testDb.googleAccount.findUniqueOrThrow({
      where: { userId: result.user.id },
    });
    expect(account.scopes).toContain(GMAIL_READONLY_SCOPE);
  });

  it('issues a CSRF token alongside the session', async () => {
    const { client } = fakeOauth();

    const result = await service(client).completeAuthorization(validCallback());

    expect(result.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(result.csrfToken).not.toBe(result.session.token);
  });

  it('passes the nonce from the cookie to verification, binding the token to this request', async () => {
    const seen: string[] = [];
    const { client } = fakeOauth({
      verifyIdToken: async (_token, nonce) => {
        seen.push(nonce);
        return claims;
      },
    });

    await service(client).completeAuthorization(
      validCallback({ expectedNonce: 'nonce-from-cookie' }),
    );

    expect(seen).toEqual(['nonce-from-cookie']);
  });

  it('recognises a returning user by Google subject rather than creating a duplicate', async () => {
    const { client } = fakeOauth();
    const auth = service(client);

    const first = await auth.completeAuthorization(validCallback());
    const second = await auth.completeAuthorization(validCallback());

    expect(second.user.id).toBe(first.user.id);
    expect(await testDb.user.count()).toBe(1);
    // Two sign-ins, two independent sessions.
    expect(await testDb.session.count()).toBe(2);
  });

  it('follows an email change without creating a second user', async () => {
    const auth1 = service(fakeOauth().client);
    const first = await auth1.completeAuthorization(validCallback());

    const auth2 = service(
      fakeOauth({
        verifyIdToken: async () => ({ ...claims, email: 'renamed@example.com' }),
      }).client,
    );
    const second = await auth2.completeAuthorization(validCallback());

    expect(second.user.id).toBe(first.user.id);
    expect(second.user.email).toBe('renamed@example.com');
    expect(await testDb.user.count()).toBe(1);
  });

  it('records lastSeenAt so inactive accounts are identifiable', async () => {
    const { client } = fakeOauth();

    const result = await service(client).completeAuthorization(validCallback());

    const user = await testDb.user.findUniqueOrThrow({ where: { id: result.user.id } });
    expect(user.lastSeenAt).not.toBeNull();
  });
});
