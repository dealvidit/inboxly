import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { createPkcePair } from '@/lib/crypto';
import { ExternalServiceError, UnauthorizedError } from '@/server/errors';
import { GOOGLE_ENDPOINTS, GMAIL_READONLY_SCOPE } from '../domain/google';
import {
  GoogleReauthRequiredError,
  createGoogleOAuthClient,
} from './google-oauth-client';

/**
 * The OAuth client is tested against a fake `fetch` and a locally generated signing key,
 * so every branch — including the ones that only happen when things go wrong — runs
 * without network access.
 */

const CLIENT_ID = 'test-client-id';

/** Captures requests and replays canned responses. */
function fakeFetch(
  handler: (url: string, body: URLSearchParams) => { status: number; body: unknown },
) {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url, body });

    const { status, body: responseBody } = handler(url, body);
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchFn, calls };
}

const tokenResponse = {
  access_token: 'ya29.access-token',
  expires_in: 3599,
  refresh_token: '1//refresh-token',
  scope: `openid email profile ${GMAIL_READONLY_SCOPE}`,
  token_type: 'Bearer',
};

describe('buildAuthorizationUrl', () => {
  const client = createGoogleOAuthClient();

  it('includes everything Google needs to return a refresh token', () => {
    const pkce = createPkcePair();
    const url = new URL(
      client.buildAuthorizationUrl({
        state: 'state-value',
        nonce: 'nonce-value',
        codeChallenge: pkce.challenge,
      }),
    );

    expect(url.origin + url.pathname).toBe(GOOGLE_ENDPOINTS.authorization);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('nonce')).toBe('nonce-value');
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // Without access_type=offline there is no refresh token at all.
    expect(url.searchParams.get('access_type')).toBe('offline');
  });

  it('requests the Gmail read-only scope and nothing broader', () => {
    const scopes =
      new URL(
        client.buildAuthorizationUrl({
          state: 's',
          nonce: 'n',
          codeChallenge: 'c',
        }),
      ).searchParams
        .get('scope')
        ?.split(' ') ?? [];

    expect(scopes).toContain(GMAIL_READONLY_SCOPE);
    expect(scopes.some((scope) => scope.includes('gmail.modify'))).toBe(false);
    expect(scopes.some((scope) => scope.includes('gmail.send'))).toBe(false);
    expect(scopes.some((scope) => scope.includes('mail.google.com'))).toBe(false);
  });

  it('forces the consent screen when reconnecting, so a refresh token is re-issued', () => {
    const withConsent = new URL(
      client.buildAuthorizationUrl({
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
        forceConsent: true,
      }),
    );
    const without = new URL(
      client.buildAuthorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }),
    );

    expect(withConsent.searchParams.get('prompt')).toContain('consent');
    expect(without.searchParams.get('prompt')).not.toContain('consent');
  });

  it('passes a login hint through when one is supplied', () => {
    const url = new URL(
      client.buildAuthorizationUrl({
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
        loginHint: 'person@example.com',
      }),
    );

    expect(url.searchParams.get('login_hint')).toBe('person@example.com');
  });
});

describe('exchangeCode', () => {
  it('sends the verifier and normalises the response', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: tokenResponse }));
    const client = createGoogleOAuthClient({
      fetchFn,
      now: () => new Date('2026-07-30T12:00:00Z'),
    });

    const tokens = await client.exchangeCode('auth-code', 'code-verifier');

    expect(calls[0]?.url).toBe(GOOGLE_ENDPOINTS.token);
    expect(calls[0]?.body.get('grant_type')).toBe('authorization_code');
    expect(calls[0]?.body.get('code')).toBe('auth-code');
    expect(calls[0]?.body.get('code_verifier')).toBe('code-verifier');

    expect(tokens.accessToken).toBe('ya29.access-token');
    expect(tokens.refreshToken).toBe('1//refresh-token');
    expect(tokens.scopes).toContain(GMAIL_READONLY_SCOPE);
    // expires_in is converted to an absolute instant at the point of receipt.
    expect(tokens.accessTokenExpiresAt.toISOString()).toBe('2026-07-30T12:59:59.000Z');
  });

  it('rejects a response that does not match the expected shape', async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 200,
      body: { access_token: 'token' }, // expires_in missing
    }));
    const client = createGoogleOAuthClient({ fetchFn });

    await expect(client.exchangeCode('code', 'verifier')).rejects.toThrow(
      ExternalServiceError,
    );
  });

  it('surfaces a dead grant as a reconnect requirement, not a retryable failure', async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been expired' },
    }));
    const client = createGoogleOAuthClient({ fetchFn });

    await expect(client.exchangeCode('code', 'verifier')).rejects.toThrow(
      GoogleReauthRequiredError,
    );
  });

  it('marks a 5xx retryable and a 4xx not', async () => {
    const serverError = createGoogleOAuthClient({
      fetchFn: fakeFetch(() => ({ status: 503, body: { error: 'unavailable' } }))
        .fetchFn,
    });
    const badRequest = createGoogleOAuthClient({
      fetchFn: fakeFetch(() => ({ status: 400, body: { error: 'invalid_request' } }))
        .fetchFn,
    });

    await expect(serverError.exchangeCode('c', 'v')).rejects.toMatchObject({
      retryable: true,
    });
    await expect(badRequest.exchangeCode('c', 'v')).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('treats rejected client credentials as unretryable', async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 401,
      body: { error: 'invalid_client' },
    }));
    const client = createGoogleOAuthClient({ fetchFn });

    await expect(client.exchangeCode('c', 'v')).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('converts a transport failure into a retryable external service error', async () => {
    const fetchFn = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const client = createGoogleOAuthClient({ fetchFn });

    await expect(client.exchangeCode('c', 'v')).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('does not crash on a non-JSON error body', async () => {
    const fetchFn = (async () =>
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
      })) as unknown as typeof fetch;
    const client = createGoogleOAuthClient({ fetchFn });

    await expect(client.exchangeCode('c', 'v')).rejects.toThrow(ExternalServiceError);
  });
});

describe('refreshAccessToken', () => {
  it('uses the refresh_token grant', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      status: 200,
      // Google usually omits refresh_token on a refresh.
      body: { ...tokenResponse, refresh_token: undefined },
    }));
    const client = createGoogleOAuthClient({ fetchFn });

    const tokens = await client.refreshAccessToken('1//stored-refresh-token');

    expect(calls[0]?.body.get('grant_type')).toBe('refresh_token');
    expect(calls[0]?.body.get('refresh_token')).toBe('1//stored-refresh-token');
    expect(tokens.accessToken).toBe('ya29.access-token');
    expect(tokens.refreshToken).toBeUndefined();
  });

  it('reports a revoked grant as requiring reconnection', async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 400,
      body: { error: 'invalid_grant' },
    }));
    const client = createGoogleOAuthClient({ fetchFn });

    await expect(client.refreshAccessToken('dead-token')).rejects.toThrow(
      GoogleReauthRequiredError,
    );
  });
});

describe('verifyIdToken', () => {
  async function signedIdToken(
    claims: Record<string, unknown>,
    options: { issuer?: string; audience?: string; expiresIn?: string } = {},
  ) {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);

    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(options.issuer ?? 'https://accounts.google.com')
      .setAudience(options.audience ?? CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '1h')
      .sign(privateKey);

    return { token, getKey: async () => ({ ...jwk, alg: 'RS256' }) };
  }

  const validClaims = {
    sub: 'google-subject-123',
    email: 'person@example.com',
    email_verified: true,
    name: 'A Person',
    nonce: 'expected-nonce',
  };

  it('returns the claims for a correctly signed token', async () => {
    const { token, getKey } = await signedIdToken(validClaims);
    const client = createGoogleOAuthClient({ getKey });

    const claims = await client.verifyIdToken(token, 'expected-nonce');

    expect(claims.sub).toBe('google-subject-123');
    expect(claims.email).toBe('person@example.com');
    expect(claims.name).toBe('A Person');
  });

  it('rejects a token whose nonce does not match this authorization request', async () => {
    const { token, getKey } = await signedIdToken(validClaims);
    const client = createGoogleOAuthClient({ getKey });

    await expect(client.verifyIdToken(token, 'a-different-nonce')).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it('rejects a token issued for a different client', async () => {
    const { token, getKey } = await signedIdToken(validClaims, {
      audience: 'someone-elses-client-id',
    });
    const client = createGoogleOAuthClient({ getKey });

    await expect(client.verifyIdToken(token, 'expected-nonce')).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it('rejects a token from an unexpected issuer', async () => {
    const { token, getKey } = await signedIdToken(validClaims, {
      issuer: 'https://evil.example.com',
    });
    const client = createGoogleOAuthClient({ getKey });

    await expect(client.verifyIdToken(token, 'expected-nonce')).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it('rejects an expired token', async () => {
    const { token, getKey } = await signedIdToken(validClaims, { expiresIn: '-1h' });
    const client = createGoogleOAuthClient({ getKey });

    await expect(client.verifyIdToken(token, 'expected-nonce')).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it('rejects a token signed by a key we do not trust', async () => {
    const { token } = await signedIdToken(validClaims);
    const other = await signedIdToken(validClaims);
    const client = createGoogleOAuthClient({ getKey: other.getKey });

    await expect(client.verifyIdToken(token, 'expected-nonce')).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it('rejects a token missing the claims we depend on', async () => {
    const { token, getKey } = await signedIdToken({
      email: 'person@example.com',
      nonce: 'expected-nonce',
      // sub absent
    });
    const client = createGoogleOAuthClient({ getKey });

    await expect(client.verifyIdToken(token, 'expected-nonce')).rejects.toThrow(
      /missing required claims/,
    );
  });

  it('rejects an unverified email address', async () => {
    const { token, getKey } = await signedIdToken({
      ...validClaims,
      email_verified: false,
    });
    const client = createGoogleOAuthClient({ getKey });

    await expect(client.verifyIdToken(token, 'expected-nonce')).rejects.toThrow(
      /not verified/,
    );
  });

  it('never leaks verification detail into the user-facing message', async () => {
    const { token, getKey } = await signedIdToken(validClaims, { expiresIn: '-1h' });
    const client = createGoogleOAuthClient({ getKey });

    await expect(client.verifyIdToken(token, 'expected-nonce')).rejects.toMatchObject({
      userMessage: 'Sign-in could not be verified. Please try again.',
    });
  });
});

describe('revokeToken', () => {
  it('posts the token to the revocation endpoint', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const client = createGoogleOAuthClient({ fetchFn });

    await client.revokeToken('1//refresh-token');

    expect(calls[0]?.url).toBe(GOOGLE_ENDPOINTS.revocation);
    expect(calls[0]?.body.get('token')).toBe('1//refresh-token');
  });

  it('does not throw when the token was already revoked', async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 400,
      body: { error: 'invalid_token' },
    }));
    const client = createGoogleOAuthClient({ fetchFn });

    await expect(client.revokeToken('already-dead')).resolves.toBeUndefined();
  });
});
