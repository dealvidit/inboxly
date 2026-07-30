import { z } from 'zod';

/**
 * Google's wire formats, validated at the boundary.
 *
 * Google is an external system, so its responses are parsed rather than asserted. The
 * types below are inferred from the schemas, which means the parser and the type can
 * never disagree.
 */

/** Endpoints, in one place so a test can point them somewhere else. */
export const GOOGLE_ENDPOINTS = {
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revocation: 'https://oauth2.googleapis.com/revoke',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
} as const;

/**
 * Scopes requested at sign-in.
 *
 * `gmail.readonly` is the narrowest scope that supports the product: it allows reading
 * messages and the History API, and grants no ability to send, modify, or delete
 * anything. Reply suggestions are drafted in the dashboard for the user to send
 * themselves, precisely so that a broader scope is not needed.
 */
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/**
 * A token response. `refresh_token` is present only when Google decides to issue one —
 * typically the first consent, or any consent with `prompt=consent` — which is why the
 * account service never overwrites a stored refresh token with an absent one.
 */
export const GoogleTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().default(''),
  token_type: z.string(),
  id_token: z.string().min(1).optional(),
});

export type GoogleTokenResponse = z.infer<typeof GoogleTokenResponseSchema>;

/** OAuth 2.0 error responses (RFC 6749 §5.2). */
export const GoogleErrorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

/**
 * The ID token claims we rely on. `sub` is the stable user identity; `email` can change
 * over the life of an account, so it is stored but never used as the lookup key.
 */
export const GoogleIdTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  picture: z.url().optional(),
});

export type GoogleIdTokenClaims = z.infer<typeof GoogleIdTokenClaimsSchema>;

/** Normalised token set, with an absolute expiry instead of a relative one. */
export interface GoogleTokenSet {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  /** Absent when Google chose not to issue a new one. */
  readonly refreshToken: string | undefined;
  readonly scopes: string[];
  readonly idToken: string | undefined;
}

export function toTokenSet(
  response: GoogleTokenResponse,
  now: Date = new Date(),
): GoogleTokenSet {
  return {
    accessToken: response.access_token,
    accessTokenExpiresAt: new Date(now.getTime() + response.expires_in * 1000),
    refreshToken: response.refresh_token,
    scopes: response.scope.split(' ').filter(Boolean),
    idToken: response.id_token,
  };
}

/** True when Gmail read access was actually granted, which the user can decline. */
export function hasGmailAccess(scopes: readonly string[]): boolean {
  return scopes.includes(GMAIL_READONLY_SCOPE);
}
