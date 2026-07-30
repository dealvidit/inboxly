import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EncryptionPurpose,
  constantTimeEqual,
  createPkcePair,
  decryptSecret,
  encryptSecret,
  generateToken,
  hashToken,
} from './crypto';

describe('encryptSecret / decryptSecret', () => {
  const purpose = EncryptionPurpose.GoogleRefreshToken;

  it('round-trips a value', () => {
    const secret = '1//0gRefreshTokenExample_with-symbols.and~stuff';
    expect(decryptSecret(encryptSecret(secret, purpose), purpose)).toBe(secret);
  });

  it('round-trips unicode and empty strings', () => {
    for (const value of ['', 'héllo wörld 🔐', 'a'.repeat(4096)]) {
      expect(decryptSecret(encryptSecret(value, purpose), purpose)).toBe(value);
    }
  });

  it('produces a different ciphertext each time, so equal secrets are not linkable', () => {
    const first = encryptSecret('same-value', purpose);
    const second = encryptSecret('same-value', purpose);

    expect(first).not.toBe(second);
    expect(decryptSecret(first, purpose)).toBe(decryptSecret(second, purpose));
  });

  it('emits the versioned format so the scheme can be rotated later', () => {
    const parts = encryptSecret('value', purpose).split(':');

    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });

  it('refuses to decrypt under a different purpose', () => {
    const encrypted = encryptSecret(
      'refresh-token',
      EncryptionPurpose.GoogleRefreshToken,
    );

    expect(() => decryptSecret(encrypted, EncryptionPurpose.GoogleAccessToken)).toThrow(
      /Failed to decrypt/,
    );
  });

  it('detects tampering with the ciphertext', () => {
    const [version, iv, tag, ciphertext] = encryptSecret('value', purpose).split(':');
    const flipped = Buffer.from(ciphertext!, 'base64');
    flipped[0] = (flipped[0]! ^ 0xff) & 0xff;

    expect(() =>
      decryptSecret([version, iv, tag, flipped.toString('base64')].join(':'), purpose),
    ).toThrow(/Failed to decrypt/);
  });

  it('detects tampering with the auth tag', () => {
    const [version, iv, , ciphertext] = encryptSecret('value', purpose).split(':');
    const forgedTag = Buffer.alloc(16, 1).toString('base64');

    expect(() =>
      decryptSecret([version, iv, forgedTag, ciphertext].join(':'), purpose),
    ).toThrow(/Failed to decrypt/);
  });

  it('rejects malformed input rather than returning garbage', () => {
    expect(() => decryptSecret('not-ciphertext', purpose)).toThrow(/Malformed/);
    expect(() => decryptSecret('v1:only:three', purpose)).toThrow(/Malformed/);
    expect(() => decryptSecret('v9:a:b:c', purpose)).toThrow(/Unsupported/);
  });

  it('never leaks the underlying crypto error text', () => {
    try {
      decryptSecret('v1:AAAA:AAAA:AAAA', purpose);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toBe('Failed to decrypt secret');
    }
  });
});

describe('generateToken', () => {
  it('returns URL-safe output', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('produces 256 bits of entropy by default', () => {
    expect(Buffer.from(generateToken(), 'base64url')).toHaveLength(32);
    expect(Buffer.from(generateToken(16), 'base64url')).toHaveLength(16);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateToken()));
    expect(tokens.size).toBe(1000);
  });
});

describe('hashToken', () => {
  it('matches SHA-256 of the input', () => {
    const token = 'session-token';
    expect(hashToken(token)).toBe(
      createHash('sha256').update(token, 'utf8').digest('hex'),
    );
  });

  it('is deterministic and 64 hex characters', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is not reversible to the token, which is the point of storing only the hash', () => {
    expect(hashToken('secret-token')).not.toContain('secret-token');
  });
});

describe('constantTimeEqual', () => {
  it('compares by value', () => {
    expect(constantTimeEqual('abc123', 'abc123')).toBe(true);
    expect(constantTimeEqual('abc123', 'abc124')).toBe(false);
  });

  it('returns false for different lengths instead of throwing', () => {
    expect(constantTimeEqual('short', 'much-longer-value')).toBe(false);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });

  it('treats two empty strings as equal', () => {
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('createPkcePair', () => {
  it('derives the challenge as base64url(SHA-256(verifier))', () => {
    const { verifier, challenge, method } = createPkcePair();

    expect(method).toBe('S256');
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('meets RFC 7636 length and character requirements', () => {
    const { verifier, challenge } = createPkcePair();

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is fresh on every call', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});
