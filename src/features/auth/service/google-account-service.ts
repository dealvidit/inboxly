import { EncryptionPurpose, decryptSecret, encryptSecret } from '@/lib/crypto';
import { ConnectionStatus } from '@/server/db';
import { NotFoundError, UnauthorizedError } from '@/server/errors';
import { logger } from '@/server/logger';
import { hasGmailAccess, type GoogleTokenSet } from '../domain/google';
import { ACCESS_TOKEN_EXPIRY_SKEW_MS, type GmailConnection } from '../domain/session';
import * as repository from '../repository/auth-repository';
import {
  GoogleReauthRequiredError,
  createGoogleOAuthClient,
  type GoogleOAuthClient,
} from './google-oauth-client';

/**
 * Owns the Gmail connection: storing credentials, handing out valid access tokens, and
 * deciding when a connection has become unusable.
 *
 * Decrypted tokens are returned but never logged and never stored in plaintext. Every
 * caller that needs Gmail access goes through `getAccessToken`, which is the single
 * place that knows how to refresh — so there is no second implementation to drift.
 */

const log = logger.child({ component: 'google-account-service' });

const RECONNECT_MESSAGE =
  'Your Gmail connection expired. Reconnect to resume synchronization.';
const SCOPE_MESSAGE =
  'Inboxly needs permission to read your Gmail. Reconnect and approve Gmail access.';
const CREDENTIAL_UNREADABLE_MESSAGE =
  'Your stored Gmail credentials could not be read. Reconnect to continue.';

export interface GoogleAccountServiceDeps {
  readonly oauthClient?: GoogleOAuthClient;
  readonly now?: () => Date;
}

export interface GoogleAccountService {
  storeTokens(
    userId: string,
    tokens: GoogleTokenSet,
    gmailAddress: string | null,
  ): Promise<void>;
  getAccessToken(userId: string): Promise<string>;
  markNeedsReconnect(userId: string, message: string): Promise<void>;
  getConnection(userId: string): Promise<GmailConnection | null>;
  disconnect(userId: string): Promise<void>;
}

export function createGoogleAccountService(
  deps: GoogleAccountServiceDeps = {},
): GoogleAccountService {
  const oauth = deps.oauthClient ?? createGoogleOAuthClient();
  const now = deps.now ?? (() => new Date());

  async function markNeedsReconnect(userId: string, message: string): Promise<void> {
    await repository.markConnectionStatus(
      userId,
      ConnectionStatus.NEEDS_RECONNECT,
      message,
    );
    log.warn('gmail connection needs reconnect', { userId, reason: message });
  }

  /**
   * Decryption fails when `ENCRYPTION_KEY` has been rotated, or when a row was tampered
   * with. Neither is recoverable by retrying, and both mean the same thing to the user:
   * reconnect. Treating it as a reauth case rather than an internal error is what makes
   * key rotation a survivable operation.
   */
  async function decryptOrRequireReconnect(
    userId: string,
    ciphertext: string,
    purpose: EncryptionPurpose,
  ): Promise<string> {
    try {
      return decryptSecret(ciphertext, purpose);
    } catch (cause) {
      await markNeedsReconnect(userId, CREDENTIAL_UNREADABLE_MESSAGE);
      log.error('stored google credential could not be decrypted', cause, { userId });
      throw new GoogleReauthRequiredError('stored credential could not be decrypted');
    }
  }

  return {
    /**
     * Persists a freshly granted token set.
     *
     * The subtlety is the refresh token: Google issues one only on first consent, or
     * when `prompt=consent` is used. On a later sign-in the field is simply absent, and
     * writing that absence over the stored token is how a working connection gets
     * silently broken. Passing `null` to the repository means "leave the stored one
     * alone".
     */
    async storeTokens(userId, tokens, gmailAddress) {
      await repository.upsertGoogleAccount({
        userId,
        accessTokenCiphertext: encryptSecret(
          tokens.accessToken,
          EncryptionPurpose.GoogleAccessToken,
        ),
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenCiphertext: tokens.refreshToken
          ? encryptSecret(tokens.refreshToken, EncryptionPurpose.GoogleRefreshToken)
          : null,
        scopes: tokens.scopes,
        gmailAddress,
      });

      const gmailGranted = hasGmailAccess(tokens.scopes);

      if (!gmailGranted) {
        // Consent succeeded, but the user unticked Gmail. A state, not an error.
        await markNeedsReconnect(userId, SCOPE_MESSAGE);
      }

      log.info('google tokens stored', {
        userId,
        gmailAccessGranted: gmailGranted,
        refreshTokenIssued: tokens.refreshToken !== undefined,
      });
    },

    /**
     * Returns a usable access token, refreshing first when it is within the expiry skew
     * so that a request starting just under the wire does not fail mid-flight.
     *
     * Throws `GoogleReauthRequiredError` when the connection is dead. Callers treat that
     * as "stop and prompt the user", never as something to retry.
     */
    async getAccessToken(userId) {
      const account = await repository.findGoogleAccount(userId);
      if (!account) throw new NotFoundError('Google account');

      if (account.connectionStatus === ConnectionStatus.DISCONNECTED) {
        throw new UnauthorizedError('Gmail is disconnected', {
          userMessage: 'Connect Gmail to synchronize your mail.',
        });
      }

      const current = now();
      const { accessTokenCiphertext, accessTokenExpiresAt, refreshTokenCiphertext } =
        account;

      if (
        accessTokenCiphertext !== null &&
        accessTokenExpiresAt !== null &&
        accessTokenExpiresAt.getTime() - current.getTime() > ACCESS_TOKEN_EXPIRY_SKEW_MS
      ) {
        return decryptOrRequireReconnect(
          userId,
          accessTokenCiphertext,
          EncryptionPurpose.GoogleAccessToken,
        );
      }

      if (refreshTokenCiphertext === null) {
        await markNeedsReconnect(userId, RECONNECT_MESSAGE);
        throw new GoogleReauthRequiredError('no refresh token stored');
      }

      const refreshToken = await decryptOrRequireReconnect(
        userId,
        refreshTokenCiphertext,
        EncryptionPurpose.GoogleRefreshToken,
      );

      let refreshed: GoogleTokenSet;
      try {
        refreshed = await oauth.refreshAccessToken(refreshToken);
      } catch (error) {
        if (error instanceof GoogleReauthRequiredError) {
          await markNeedsReconnect(userId, RECONNECT_MESSAGE);
        }
        throw error;
      }

      await repository.updateAccessToken(
        userId,
        encryptSecret(refreshed.accessToken, EncryptionPurpose.GoogleAccessToken),
        refreshed.accessTokenExpiresAt,
      );

      log.debug('access token refreshed', { userId });

      return refreshed.accessToken;
    },

    markNeedsReconnect,

    /** What the dashboard renders. Never exposes tokens or raw provider errors. */
    async getConnection(userId) {
      const account = await repository.findGoogleAccount(userId);
      if (!account) return null;

      return {
        status: account.connectionStatus,
        gmailAddress: account.gmailAddress,
        connectedAt: account.connectedAt,
        message: account.connectionError,
        hasGmailAccess: hasGmailAccess(account.scopes),
      };
    },

    /**
     * Disconnects Gmail: revokes the grant with Google, then clears local credentials.
     * Revocation is attempted first, so a failure to clear locally cannot leave a live
     * grant that we have no record of.
     */
    async disconnect(userId) {
      const account = await repository.findGoogleAccount(userId);

      if (account?.refreshTokenCiphertext) {
        try {
          await oauth.revokeToken(
            decryptSecret(
              account.refreshTokenCiphertext,
              EncryptionPurpose.GoogleRefreshToken,
            ),
          );
        } catch (error) {
          // A grant we cannot revoke is still a grant we must stop using.
          log.warn('failed to revoke Google grant; clearing locally anyway', {
            userId,
            error,
          });
        }
      }

      await repository.clearGoogleCredentials(userId);
      log.info('gmail disconnected', { userId });
    },
  };
}

/** The instance used by request handlers and jobs. */
export const googleAccountService = createGoogleAccountService();
