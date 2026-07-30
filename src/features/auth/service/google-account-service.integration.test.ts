import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EncryptionPurpose, decryptSecret, encryptSecret } from '@/lib/crypto';
import { ConnectionStatus } from '@/server/db';
import { GMAIL_READONLY_SCOPE, type GoogleTokenSet } from '../domain/google';
import { createGoogleAccountService } from './google-account-service';
import {
  GoogleReauthRequiredError,
  type GoogleOAuthClient,
} from './google-oauth-client';
import { createTestUser, resetDatabase, testDb } from '~/tests/db';

/**
 * The Gmail connection lifecycle: storing credentials, lazy refresh, and the paths that
 * lead to NEEDS_RECONNECT. The OAuth client is faked; the database is real, because what
 * is being asserted is largely about what ends up stored.
 */

beforeEach(resetDatabase);
afterAll(async () => {
  await testDb.$disconnect();
});

function tokenSet(overrides: Partial<GoogleTokenSet> = {}): GoogleTokenSet {
  return {
    accessToken: 'access-token-1',
    accessTokenExpiresAt: new Date('2026-07-30T11:00:00Z'),
    refreshToken: 'refresh-token-1',
    scopes: ['openid', 'email', 'profile', GMAIL_READONLY_SCOPE],
    idToken: undefined,
    ...overrides,
  };
}

/** A fake OAuth client that records calls and can be told how to behave. */
function fakeOauth(
  behaviour: {
    refresh?: () => Promise<GoogleTokenSet>;
    revoke?: () => Promise<void>;
  } = {},
): GoogleOAuthClient & { refreshCalls: string[]; revokedTokens: string[] } {
  const refreshCalls: string[] = [];
  const revokedTokens: string[] = [];

  return {
    refreshCalls,
    revokedTokens,
    buildAuthorizationUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    exchangeCode: async () => tokenSet(),
    refreshAccessToken: async (refreshToken) => {
      refreshCalls.push(refreshToken);
      return behaviour.refresh
        ? behaviour.refresh()
        : tokenSet({
            accessToken: 'refreshed-access-token',
            accessTokenExpiresAt: new Date('2026-07-30T13:00:00Z'),
            refreshToken: undefined,
          });
    },
    verifyIdToken: async () => {
      throw new Error('not used');
    },
    revokeToken: async (token) => {
      revokedTokens.push(token);
      if (behaviour.revoke) await behaviour.revoke();
    },
  };
}

describe('storeTokens', () => {
  it('encrypts both tokens at rest', async () => {
    const user = await createTestUser();
    const service = createGoogleAccountService({ oauthClient: fakeOauth() });

    await service.storeTokens(user.id, tokenSet(), 'person@gmail.com');

    const account = await testDb.googleAccount.findUniqueOrThrow({
      where: { userId: user.id },
    });

    // Neither plaintext token appears anywhere in the row.
    expect(JSON.stringify(account)).not.toContain('access-token-1');
    expect(JSON.stringify(account)).not.toContain('refresh-token-1');

    expect(
      decryptSecret(
        account.refreshTokenCiphertext ?? '',
        EncryptionPurpose.GoogleRefreshToken,
      ),
    ).toBe('refresh-token-1');
  });

  it('records the granted scopes and Gmail address', async () => {
    const user = await createTestUser();
    const service = createGoogleAccountService({ oauthClient: fakeOauth() });

    await service.storeTokens(user.id, tokenSet(), 'person@gmail.com');

    const account = await testDb.googleAccount.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(account.scopes).toContain(GMAIL_READONLY_SCOPE);
    expect(account.gmailAddress).toBe('person@gmail.com');
    expect(account.connectionStatus).toBe(ConnectionStatus.CONNECTED);
  });

  it('never overwrites a stored refresh token with an absent one', async () => {
    const user = await createTestUser();
    const service = createGoogleAccountService({ oauthClient: fakeOauth() });

    await service.storeTokens(user.id, tokenSet(), 'person@gmail.com');
    // A later sign-in without prompt=consent: Google omits the refresh token.
    await service.storeTokens(
      user.id,
      tokenSet({ accessToken: 'access-token-2', refreshToken: undefined }),
      'person@gmail.com',
    );

    const account = await testDb.googleAccount.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(
      decryptSecret(
        account.refreshTokenCiphertext ?? '',
        EncryptionPurpose.GoogleRefreshToken,
      ),
    ).toBe('refresh-token-1');
  });

  it('flags a reconnect when the user declines the Gmail scope', async () => {
    const user = await createTestUser();
    const service = createGoogleAccountService({ oauthClient: fakeOauth() });

    await service.storeTokens(
      user.id,
      tokenSet({ scopes: ['openid', 'email', 'profile'] }),
      'person@gmail.com',
    );

    const connection = await service.getConnection(user.id);
    expect(connection?.status).toBe(ConnectionStatus.NEEDS_RECONNECT);
    expect(connection?.hasGmailAccess).toBe(false);
    expect(connection?.message).toMatch(/approve Gmail access/);
  });
});

describe('getAccessToken', () => {
  it('returns the stored token without refreshing while it is comfortably valid', async () => {
    const user = await createTestUser();
    const oauth = fakeOauth();
    const service = createGoogleAccountService({
      oauthClient: oauth,
      now: () => new Date('2026-07-30T10:00:00Z'),
    });

    await service.storeTokens(user.id, tokenSet(), null);

    expect(await service.getAccessToken(user.id)).toBe('access-token-1');
    expect(oauth.refreshCalls).toHaveLength(0);
  });

  it('refreshes before the token actually expires, so a request cannot fail mid-flight', async () => {
    const user = await createTestUser();
    const oauth = fakeOauth();
    // 30 seconds before expiry: still valid, but inside the skew.
    const service = createGoogleAccountService({
      oauthClient: oauth,
      now: () => new Date('2026-07-30T10:59:30Z'),
    });

    await service.storeTokens(user.id, tokenSet(), null);

    expect(await service.getAccessToken(user.id)).toBe('refreshed-access-token');
    expect(oauth.refreshCalls).toEqual(['refresh-token-1']);
  });

  it('persists the refreshed token so the next call does not refresh again', async () => {
    const user = await createTestUser();
    const oauth = fakeOauth();
    const service = createGoogleAccountService({
      oauthClient: oauth,
      now: () => new Date('2026-07-30T11:30:00Z'),
    });

    await service.storeTokens(user.id, tokenSet(), null);

    await service.getAccessToken(user.id);
    await service.getAccessToken(user.id);

    // Second call is served from the stored, now-valid token.
    expect(oauth.refreshCalls).toHaveLength(1);
    const account = await testDb.googleAccount.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(account.accessTokenExpiresAt?.toISOString()).toBe(
      '2026-07-30T13:00:00.000Z',
    );
  });

  it('marks the account for reconnection when the refresh token is rejected', async () => {
    const user = await createTestUser();
    const oauth = fakeOauth({
      refresh: async () => {
        throw new GoogleReauthRequiredError('token has been revoked');
      },
    });
    const service = createGoogleAccountService({
      oauthClient: oauth,
      now: () => new Date('2026-07-30T12:00:00Z'),
    });

    await service.storeTokens(user.id, tokenSet(), null);

    await expect(service.getAccessToken(user.id)).rejects.toThrow(
      GoogleReauthRequiredError,
    );

    const connection = await service.getConnection(user.id);
    expect(connection?.status).toBe(ConnectionStatus.NEEDS_RECONNECT);
    expect(connection?.message).toMatch(/Reconnect/);
  });

  it('requires reconnection when there is no refresh token to use', async () => {
    const user = await createTestUser();
    const service = createGoogleAccountService({
      oauthClient: fakeOauth(),
      now: () => new Date('2026-07-30T12:00:00Z'),
    });

    await service.storeTokens(user.id, tokenSet({ refreshToken: undefined }), null);

    await expect(service.getAccessToken(user.id)).rejects.toThrow(
      GoogleReauthRequiredError,
    );
    expect((await service.getConnection(user.id))?.status).toBe(
      ConnectionStatus.NEEDS_RECONNECT,
    );
  });

  it('treats an unreadable stored credential as a reconnect, so key rotation is survivable', async () => {
    const user = await createTestUser();
    const service = createGoogleAccountService({
      oauthClient: fakeOauth(),
      now: () => new Date('2026-07-30T12:00:00Z'),
    });

    await service.storeTokens(user.id, tokenSet(), null);
    // Simulates a row encrypted under a previous ENCRYPTION_KEY: well-formed, undecryptable.
    await testDb.googleAccount.update({
      where: { userId: user.id },
      data: {
        refreshTokenCiphertext: `v1:${Buffer.alloc(12).toString('base64')}:${Buffer.alloc(16).toString('base64')}:${Buffer.from('nonsense').toString('base64')}`,
      },
    });

    await expect(service.getAccessToken(user.id)).rejects.toThrow(
      GoogleReauthRequiredError,
    );
    expect((await service.getConnection(user.id))?.status).toBe(
      ConnectionStatus.NEEDS_RECONNECT,
    );
  });

  it('refuses once the user has deliberately disconnected', async () => {
    const user = await createTestUser();
    const service = createGoogleAccountService({ oauthClient: fakeOauth() });

    await service.storeTokens(user.id, tokenSet(), null);
    await service.disconnect(user.id);

    await expect(service.getAccessToken(user.id)).rejects.toThrow(/disconnected/i);
  });

  it('reports a missing account rather than pretending it is unauthenticated', async () => {
    const user = await createTestUser();
    const service = createGoogleAccountService({ oauthClient: fakeOauth() });

    await expect(service.getAccessToken(user.id)).rejects.toThrow(/not found/i);
  });
});

describe('disconnect', () => {
  it('revokes the grant with Google and clears the stored credentials', async () => {
    const user = await createTestUser();
    const oauth = fakeOauth();
    const service = createGoogleAccountService({ oauthClient: oauth });

    await service.storeTokens(user.id, tokenSet(), 'person@gmail.com');
    await service.disconnect(user.id);

    expect(oauth.revokedTokens).toEqual(['refresh-token-1']);

    const account = await testDb.googleAccount.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(account.refreshTokenCiphertext).toBeNull();
    expect(account.accessTokenCiphertext).toBeNull();
    expect(account.connectionStatus).toBe(ConnectionStatus.DISCONNECTED);
  });

  it('clears credentials even when revocation fails, because we must stop using them', async () => {
    const user = await createTestUser();
    const service = createGoogleAccountService({
      oauthClient: fakeOauth({
        revoke: async () => {
          throw new Error('Google unreachable');
        },
      }),
    });

    await service.storeTokens(user.id, tokenSet(), null);
    await service.disconnect(user.id);

    const account = await testDb.googleAccount.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(account.refreshTokenCiphertext).toBeNull();
    expect(account.connectionStatus).toBe(ConnectionStatus.DISCONNECTED);
  });

  it('keeps the row, so "disconnected" stays distinguishable from "never connected"', async () => {
    const user = await createTestUser();
    const service = createGoogleAccountService({ oauthClient: fakeOauth() });

    expect(await service.getConnection(user.id)).toBeNull();

    await service.storeTokens(user.id, tokenSet(), null);
    await service.disconnect(user.id);

    expect((await service.getConnection(user.id))?.status).toBe(
      ConnectionStatus.DISCONNECTED,
    );
  });
});

describe('encryption purpose binding', () => {
  it('will not read a refresh token that was written as an access token', async () => {
    const user = await createTestUser();
    const service = createGoogleAccountService({
      oauthClient: fakeOauth(),
      now: () => new Date('2026-07-30T12:00:00Z'),
    });

    await service.storeTokens(user.id, tokenSet(), null);
    // Move an access-token ciphertext into the refresh-token column.
    await testDb.googleAccount.update({
      where: { userId: user.id },
      data: {
        refreshTokenCiphertext: encryptSecret(
          'access-token-1',
          EncryptionPurpose.GoogleAccessToken,
        ),
      },
    });

    await expect(service.getAccessToken(user.id)).rejects.toThrow(
      GoogleReauthRequiredError,
    );
  });
});
