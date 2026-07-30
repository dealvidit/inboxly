# 0003. Hand-rolled Google OAuth with opaque database sessions

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

Google is both the identity provider and the data provider. Signing in and connecting
Gmail are the same act: we need an ID token to know who the user is, and a long-lived
refresh token with Gmail scopes to synchronize on their behalf. Refresh tokens must be
encrypted at rest, and a revoked or expired refresh token must degrade into a reconnect
prompt rather than a broken dashboard.

## Problem

Do we adopt an authentication library, or implement the OAuth 2.0 authorization code flow
directly?

## Alternatives considered

**Auth.js (NextAuth v5) with the Prisma adapter.** The default choice for Next.js in 2026,
and it would handle the flow, the callback, and session cookies well. The friction is
everything after sign-in: the adapter's `Account` table stores refresh tokens in
plaintext, so encryption requires a custom adapter that wraps every account read and
write; Gmail's incremental-authorization and reconnect semantics live outside the
library's model; and the library's session abstraction would sit between us and the token
lifecycle we most need to control. We would end up owning the hard half anyway, with a
dependency's model to fight.

**Clerk / WorkOS / Auth0.** Excellent products, but they own the identity relationship,
and we still need our own Google OAuth grant with Gmail scopes for API access. That means
two OAuth relationships with Google for one user, plus a vendor and a monthly bill for the
part of the problem that is already the simplest.

**JWT sessions instead of database sessions.** Stateless and one less query per request.
But logout cannot revoke a JWT, and revocation matters here: a session grants access to
the user's mailbox contents. A stateless token also can't record the "this session's
account needs reconnecting" state we want to surface.

**Hand-rolled authorization code flow with PKCE and opaque database sessions** (chosen).

## Decision

Implement the authorization code flow directly against Google's endpoints:

- **PKCE** (S256) on every flow, even though this is a confidential client, so an
  intercepted code is useless on its own.
- **`state`** is a random value stored in a short-lived, `HttpOnly`, `SameSite=Lax`
  cookie and compared on callback. A mismatch aborts the flow. This is the CSRF defence
  for the login redirect itself.
- **`nonce`** in the authorization request, verified against the `id_token` claim.
- **ID token verification** against Google's JWKS, checking signature, `iss`, `aud`,
  `exp`, and `nonce` before trusting any claim.
- **Refresh tokens** encrypted with AES-256-GCM using a key from `ENCRYPTION_KEY`, stored
  as `v1:<iv>:<tag>:<ciphertext>` so the scheme can be rotated by version prefix. The
  plaintext never leaves the account service.
- **Sessions** are 256 bits of CSPRNG entropy sent in a `__Host-`prefixed, `HttpOnly`,
  `Secure`, `SameSite=Lax` cookie; only the SHA-256 hash is stored, so a database leak
  does not yield usable sessions. Sessions have an absolute expiry and a sliding
  refresh, and are revocable by deleting the row.
- **CSRF for mutations** uses the double-submit pattern: a readable random token cookie
  echoed in an `x-csrf-token` header, verified by every mutating tRPC procedure. This
  layers on top of `SameSite=Lax` rather than relying on it alone.
- **Access tokens** are refreshed lazily behind `getAccessToken(userId)`, which refreshes
  when within an expiry skew and persists the result. `invalid_grant` marks the account
  `NEEDS_RECONNECT` and the dashboard prompts a reconnect that re-runs the flow with
  `prompt=consent`.

## Trade-offs

We own code that a library would otherwise own, including its security-relevant edge
cases — this is the real cost, and it is mitigated by keeping the surface small
(one start handler, one callback handler, one session module, one account service) and
by testing each piece directly. Database sessions cost one indexed query per request. We
support only Google, by design; adding a second identity provider would mean generalising
the flow, which we would do at that point rather than speculatively.

## Consequences

- Refresh tokens are encrypted at rest with a rotatable scheme.
- Logout and administrative revocation actually revoke.
- The token lifecycle is ours to instrument, and reconnect is a first-class state rather
  than an error path.
- Every step of the flow is unit-testable without a browser.
