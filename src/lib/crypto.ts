import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '@/lib/env';
import { ConfigurationError, InternalError } from '@/server/errors';

/**
 * Cryptographic primitives, kept in one place so the choices are reviewable together.
 *
 * Encryption is AES-256-GCM. The stored format is
 *
 *     v1:<iv-base64>:<authTag-base64>:<ciphertext-base64>
 *
 * The version prefix is what makes key or algorithm rotation possible later without
 * guessing at the format of existing rows: a future `v2` can be read alongside `v1`.
 *
 * Every ciphertext is bound to a `purpose` string, passed to GCM as additional
 * authenticated data. A refresh-token ciphertext therefore cannot be moved into the
 * access-token column and decrypted there — the auth tag check fails. It costs nothing
 * and closes an entire class of confused-deputy mistake.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM's standard nonce length.
const CURRENT_VERSION = 'v1';

/** Distinct purposes for values encrypted at rest. Bound into the ciphertext as AAD. */
export const EncryptionPurpose = {
  GoogleRefreshToken: 'google.refresh_token',
  GoogleAccessToken: 'google.access_token',
} as const;

export type EncryptionPurpose =
  (typeof EncryptionPurpose)[keyof typeof EncryptionPurpose];

let cachedKey: Buffer | undefined;

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const key = Buffer.from(env.ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) {
    // env.ts validates this, so reaching here means the validation was bypassed.
    throw new ConfigurationError('ENCRYPTION_KEY must decode to exactly 32 bytes');
  }

  cachedKey = key;
  return key;
}

export function encryptSecret(plaintext: string, purpose: EncryptionPurpose): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(purpose, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    CURRENT_VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Throws if the value was tampered with, encrypted for a different purpose, or
 * encrypted under a different key. Callers treat a throw as "this credential is
 * unusable", which for a refresh token means prompting the user to reconnect.
 */
export function decryptSecret(encoded: string, purpose: EncryptionPurpose): string {
  const parts = encoded.split(':');
  if (parts.length !== 4) {
    throw new InternalError('Malformed ciphertext: expected 4 segments');
  }

  const [version, ivPart, tagPart, ciphertextPart] = parts as [
    string,
    string,
    string,
    string,
  ];

  if (version !== CURRENT_VERSION) {
    throw new InternalError(`Unsupported ciphertext version: ${version}`);
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(ivPart, 'base64'),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64'));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    // The underlying message ("unable to authenticate data") says nothing useful and
    // could leak into a response, so it is replaced.
    throw new InternalError('Failed to decrypt secret', { cause });
  }
}

/**
 * A URL-safe random token. 32 bytes is 256 bits of entropy — the session token, the
 * OAuth `state`, and the CSRF token all use this.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * SHA-256, hex encoded. Used for session tokens: the database stores only the hash, so
 * a database leak yields nothing usable. A slow KDF is unnecessary here because the
 * input is already 256 bits of uniform randomness — there is nothing to brute force.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Timing-safe string comparison. Used wherever a secret supplied by a caller is checked
 * against a known value — CSRF tokens, the cron secret — so that comparison time does
 * not leak how much of a guess was correct.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  // timingSafeEqual throws on length mismatch, and the lengths themselves are not
  // secret, so an early return here leaks nothing.
  if (bufferA.length !== bufferB.length) return false;

  return timingSafeEqual(bufferA, bufferB);
}

export interface PkcePair {
  /** Held in a short-lived cookie and sent on the token exchange. */
  readonly verifier: string;
  /** Sent to the authorization endpoint. */
  readonly challenge: string;
  readonly method: 'S256';
}

/**
 * PKCE (RFC 7636). Used even though this is a confidential client: it means an
 * intercepted authorization code cannot be exchanged without the verifier, which never
 * leaves our cookie. See ADR 0003.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}
