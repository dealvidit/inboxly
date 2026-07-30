import { constantTimeEqual, createPkcePair, generateToken } from '@/lib/crypto';
import { UnauthorizedError } from '@/server/errors';
import { logger } from '@/server/logger';
import type { AuthenticatedUser } from '../domain/session';
import * as repository from '../repository/auth-repository';
import {
  googleAccountService,
  type GoogleAccountService,
} from './google-account-service';
import { createGoogleOAuthClient, type GoogleOAuthClient } from './google-oauth-client';
import {
  issueSession,
  type IssuedSession,
  type SessionRequestMetadata,
} from './session-service';

/**
 * Orchestrates the two halves of the OAuth flow.
 *
 * The route handlers above this are deliberately thin — they translate between HTTP and
 * these two functions — so the interesting logic, particularly the callback's
 * validation, is testable without a browser or a running server.
 */

const log = logger.child({ component: 'auth-service' });

export interface AuthServiceDeps {
  readonly oauthClient?: GoogleOAuthClient;
  readonly accountService?: GoogleAccountService;
}

/** Values the start handler must hand to the browser as short-lived cookies. */
export interface AuthorizationRequest {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce: string;
}

export interface CallbackInput {
  /** From the query string. */
  readonly code: string | null;
  readonly state: string | null;
  readonly error: string | null;
  /** From the handshake cookies. */
  readonly expectedState: string | undefined;
  readonly codeVerifier: string | undefined;
  readonly expectedNonce: string | undefined;
  readonly metadata: SessionRequestMetadata;
}

export interface CallbackResult {
  readonly user: AuthenticatedUser;
  readonly session: IssuedSession;
  readonly csrfToken: string;
}

export function createAuthService(deps: AuthServiceDeps = {}) {
  const oauth = deps.oauthClient ?? createGoogleOAuthClient();
  const accounts = deps.accountService ?? googleAccountService;

  return {
    /**
     * Begins a sign-in. `forceConsent` is set when reconnecting, because Google
     * re-issues a refresh token only when consent is granted again — without it a
     * reconnect appears to succeed while leaving us unable to refresh.
     */
    beginAuthorization(
      options: { forceConsent?: boolean; loginHint?: string } = {},
    ): AuthorizationRequest {
      const state = generateToken();
      const nonce = generateToken();
      const pkce = createPkcePair();

      const authorizationUrl = oauth.buildAuthorizationUrl({
        state,
        nonce,
        codeChallenge: pkce.challenge,
        ...(options.forceConsent === undefined
          ? {}
          : { forceConsent: options.forceConsent }),
        ...(options.loginHint === undefined ? {} : { loginHint: options.loginHint }),
      });

      return { authorizationUrl, state, codeVerifier: pkce.verifier, nonce };
    },

    /**
     * Completes a sign-in.
     *
     * The order of checks matters: everything cheap and local is verified before the
     * authorization code is spent, so a forged callback never causes a request to
     * Google.
     */
    async completeAuthorization(input: CallbackInput): Promise<CallbackResult> {
      // The user declined at the consent screen, or Google refused.
      if (input.error) {
        throw new UnauthorizedError(`Google returned an error: ${input.error}`, {
          userMessage:
            input.error === 'access_denied'
              ? 'Sign-in was cancelled.'
              : 'Google could not complete sign-in. Please try again.',
        });
      }

      if (!input.code || !input.state) {
        throw new UnauthorizedError('Callback is missing code or state');
      }

      // CSRF defence for the redirect itself: the state in the URL must match the one we
      // put in an HttpOnly cookie when the flow started.
      if (
        !input.expectedState ||
        !constantTimeEqual(input.state, input.expectedState)
      ) {
        throw new UnauthorizedError('OAuth state mismatch', {
          userMessage: 'Sign-in expired or was tampered with. Please try again.',
        });
      }

      if (!input.codeVerifier || !input.expectedNonce) {
        // The handshake cookies expired, or the flow started in a different browser.
        throw new UnauthorizedError('OAuth handshake cookies are missing', {
          userMessage: 'Sign-in took too long. Please try again.',
        });
      }

      const tokens = await oauth.exchangeCode(input.code, input.codeVerifier);

      if (!tokens.idToken) {
        throw new UnauthorizedError('Token response contained no ID token');
      }

      const claims = await oauth.verifyIdToken(tokens.idToken, input.expectedNonce);

      const user = await repository.upsertUserByGoogleSubject({
        googleSubject: claims.sub,
        email: claims.email,
        name: claims.name ?? null,
        avatarUrl: claims.picture ?? null,
      });

      await accounts.storeTokens(user.id, tokens, claims.email);

      const session = await issueSession(user.id, input.metadata);

      log.info('sign-in completed', { userId: user.id });

      return { user, session, csrfToken: generateToken() };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;

export const authService = createAuthService();
