import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { env } from '@/lib/env';
import { ExternalServiceError, UnauthorizedError } from '@/server/errors';
import {
  GOOGLE_ENDPOINTS,
  GOOGLE_SCOPES,
  GoogleErrorResponseSchema,
  GoogleIdTokenClaimsSchema,
  GoogleTokenResponseSchema,
  toTokenSet,
  type GoogleIdTokenClaims,
  type GoogleTokenSet,
} from '../domain/google';

/**
 * Everything that talks to Google's OAuth endpoints.
 *
 * `fetch` and the JWKS resolver are injected so the whole flow — including the failure
 * paths that matter most, like `invalid_grant` — can be tested without network access
 * and without a browser.
 */

export interface AuthorizationUrlParams {
  readonly state: string;
  readonly codeChallenge: string;
  readonly nonce: string;
  /**
   * Forces the consent screen. Used for reconnection, because Google only re-issues a
   * refresh token when consent is granted again — without this a reconnect appears to
   * succeed but leaves us with no refresh token.
   */
  readonly forceConsent?: boolean;
  /** Pre-fills the account chooser when we know which mailbox is being reconnected. */
  readonly loginHint?: string;
}

export interface GoogleOAuthClient {
  buildAuthorizationUrl(params: AuthorizationUrlParams): string;
  exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokenSet>;
  refreshAccessToken(refreshToken: string): Promise<GoogleTokenSet>;
  verifyIdToken(idToken: string, expectedNonce: string): Promise<GoogleIdTokenClaims>;
  revokeToken(token: string): Promise<void>;
}

export interface GoogleOAuthClientDeps {
  readonly fetchFn?: typeof fetch;
  readonly getKey?: JWTVerifyGetKey;
  readonly now?: () => Date;
}

/**
 * Thrown when Google rejects a refresh token — revoked by the user, expired through
 * disuse, or invalidated by a password change. The account service turns this into
 * NEEDS_RECONNECT rather than an error, because it is a normal thing that happens.
 */
export class GoogleReauthRequiredError extends UnauthorizedError {
  constructor(reason: string) {
    super(`Google requires re-authorisation: ${reason}`, {
      userMessage: 'Your Gmail connection expired. Please reconnect to continue.',
    });
  }
}

/**
 * Cached across invocations on purpose: the key set is public, rotates slowly, and is
 * fetched on the sign-in path. `createRemoteJWKSet` handles its own TTL and
 * cache-miss refetch on unknown key ids. See ADR 0010.
 */
const defaultJwks = createRemoteJWKSet(new URL(GOOGLE_ENDPOINTS.jwks));

export function createGoogleOAuthClient(
  deps: GoogleOAuthClientDeps = {},
): GoogleOAuthClient {
  const fetchFn = deps.fetchFn ?? fetch;
  const getKey = deps.getKey ?? defaultJwks;
  const now = deps.now ?? (() => new Date());

  async function postForm(url: string, body: Record<string, string>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams(body).toString(),
      });
    } catch (cause) {
      throw new ExternalServiceError('google-oauth', 'Request failed', {
        cause,
        retryable: true,
      });
    }

    const text = await response.text();
    const payload: unknown = text ? safeJsonParse(text) : {};

    if (!response.ok) {
      throw toOAuthError(response.status, payload);
    }

    return payload;
  }

  return {
    buildAuthorizationUrl(params) {
      const url = new URL(GOOGLE_ENDPOINTS.authorization);
      const query = url.searchParams;

      query.set('client_id', env.GOOGLE_CLIENT_ID);
      query.set('redirect_uri', env.GOOGLE_REDIRECT_URI);
      query.set('response_type', 'code');
      query.set('scope', GOOGLE_SCOPES.join(' '));
      query.set('state', params.state);
      query.set('nonce', params.nonce);
      query.set('code_challenge', params.codeChallenge);
      query.set('code_challenge_method', 'S256');

      // Required for a refresh token at all.
      query.set('access_type', 'offline');
      // Lets the user grant Gmail access without re-granting the identity scopes.
      query.set('include_granted_scopes', 'true');
      query.set(
        'prompt',
        params.forceConsent ? 'consent select_account' : 'select_account',
      );

      if (params.loginHint) query.set('login_hint', params.loginHint);

      return url.toString();
    },

    async exchangeCode(code, codeVerifier) {
      const payload = await postForm(GOOGLE_ENDPOINTS.token, {
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: env.GOOGLE_REDIRECT_URI,
      });

      return toTokenSet(parseTokenResponse(payload), now());
    },

    async refreshAccessToken(refreshToken) {
      const payload = await postForm(GOOGLE_ENDPOINTS.token, {
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });

      return toTokenSet(parseTokenResponse(payload), now());
    },

    async verifyIdToken(idToken, expectedNonce) {
      let claims: Record<string, unknown>;
      try {
        const verified = await jwtVerify(idToken, getKey, {
          issuer: [...GOOGLE_ENDPOINTS.issuers],
          audience: env.GOOGLE_CLIENT_ID,
        });
        claims = verified.payload;
      } catch (cause) {
        throw new UnauthorizedError('ID token verification failed', {
          cause,
          userMessage: 'Sign-in could not be verified. Please try again.',
        });
      }

      // Verified separately from jwtVerify's checks: `nonce` binds the token to *this*
      // authorization request, which is what stops a token replayed from another one.
      if (claims['nonce'] !== expectedNonce) {
        throw new UnauthorizedError('ID token nonce mismatch', {
          userMessage: 'Sign-in could not be verified. Please try again.',
        });
      }

      const parsed = GoogleIdTokenClaimsSchema.safeParse(claims);
      if (!parsed.success) {
        throw new UnauthorizedError('ID token is missing required claims', {
          context: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
          userMessage: 'Sign-in could not be verified. Please try again.',
        });
      }

      if (parsed.data.email_verified === false) {
        throw new UnauthorizedError('Google account email is not verified', {
          userMessage:
            'Your Google account email is not verified. Verify it with Google and try again.',
        });
      }

      return parsed.data;
    },

    async revokeToken(token) {
      // Best-effort: the user has already been signed out locally by the time this
      // runs, and Google returns 400 for a token that was already revoked.
      try {
        await postForm(GOOGLE_ENDPOINTS.revocation, { token });
      } catch {
        // Intentionally swallowed — see above.
      }
    },
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: 'invalid_response', error_description: text.slice(0, 200) };
  }
}

function parseTokenResponse(payload: unknown) {
  const parsed = GoogleTokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ExternalServiceError(
      'google-oauth',
      'Token response did not match the expected shape',
      {
        retryable: false,
        context: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
      },
    );
  }
  return parsed.data;
}

/**
 * Maps Google's OAuth errors onto our taxonomy. The distinction that matters is
 * `invalid_grant` — a dead refresh token, which no amount of retrying will fix and
 * which must surface as "reconnect", not as a failure.
 */
function toOAuthError(status: number, payload: unknown): Error {
  const parsed = GoogleErrorResponseSchema.safeParse(payload);
  const code = parsed.success ? parsed.data.error : `http_${status}`;
  const description = parsed.success ? parsed.data.error_description : undefined;

  if (code === 'invalid_grant') {
    return new GoogleReauthRequiredError(description ?? code);
  }

  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return new ExternalServiceError(
      'google-oauth',
      `Client credentials rejected (${code})`,
      { retryable: false },
    );
  }

  return new ExternalServiceError(
    'google-oauth',
    `${code}${description ? `: ${description}` : ''}`,
    // 5xx and 429 are worth retrying; a 4xx describing a bad request is not.
    { retryable: status >= 500 || status === 429 },
  );
}
