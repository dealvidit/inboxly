import { describe, expect, it } from 'vitest';
import { __envSchemaForTests as envSchema } from './env';

/** A configuration that satisfies every required variable. */
function validEnv(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'postgresql://inboxly:inboxly@localhost:5432/inboxly',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/callback/google',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ANTHROPIC_API_KEY: 'sk-ant-test',
    CRON_SECRET: 'a'.repeat(32),
    ...overrides,
  };
}

describe('env schema', () => {
  it('accepts a complete configuration and applies defaults', () => {
    const result = envSchema.parse(validEnv());

    expect(result.NODE_ENV).toBe('development');
    expect(result.AI_PROVIDER).toBe('anthropic');
    expect(result.LOG_LEVEL).toBe('info');
    expect(result.SYNC_MAX_BACKFILL_MESSAGES).toBe(500);
    expect(result.ANALYSIS_BATCH_SIZE).toBe(10);
    expect(result.AI_ENABLED).toBe(true);
  });

  it('reports every missing variable at once rather than failing on the first', () => {
    const result = envSchema.safeParse({});

    expect(result.success).toBe(false);
    const missing = result.error!.issues.map((issue) => issue.path.join('.'));
    expect(missing).toContain('DATABASE_URL');
    expect(missing).toContain('GOOGLE_CLIENT_ID');
    expect(missing).toContain('ENCRYPTION_KEY');
    expect(missing).toContain('ANTHROPIC_API_KEY');
    expect(missing).toContain('CRON_SECRET');
  });

  it('rejects a database URL that is not PostgreSQL', () => {
    const result = envSchema.safeParse(
      validEnv({ DATABASE_URL: 'mysql://localhost/inboxly' }),
    );

    expect(result.success).toBe(false);
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    const result = envSchema.safeParse(
      validEnv({ ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }),
    );

    expect(result.success).toBe(false);
    expect(result.error!.issues[0]?.path).toEqual(['ENCRYPTION_KEY']);
  });

  it('rejects a cron secret short enough to brute force', () => {
    const result = envSchema.safeParse(validEnv({ CRON_SECRET: 'short' }));

    expect(result.success).toBe(false);
  });

  it('coerces numeric tuning variables from strings', () => {
    const result = envSchema.parse(
      validEnv({ ANALYSIS_BATCH_SIZE: '25', SYNC_MAX_BACKFILL_MESSAGES: '2000' }),
    );

    expect(result.ANALYSIS_BATCH_SIZE).toBe(25);
    expect(result.SYNC_MAX_BACKFILL_MESSAGES).toBe(2000);
  });

  it('caps the analysis batch size so one invocation cannot run unbounded', () => {
    const result = envSchema.safeParse(validEnv({ ANALYSIS_BATCH_SIZE: '5000' }));

    expect(result.success).toBe(false);
  });

  it('parses boolean flags from the forms people actually write', () => {
    for (const [input, expected] of [
      ['true', true],
      ['1', true],
      ['yes', true],
      ['false', false],
      ['0', false],
      ['no', false],
    ] as const) {
      expect(envSchema.parse(validEnv({ AI_ENABLED: input })).AI_ENABLED).toBe(
        expected,
      );
    }
  });
});
