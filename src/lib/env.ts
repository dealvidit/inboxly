import { z } from 'zod';

/**
 * Every environment variable the application reads is declared, described, and
 * validated here — once, at module load. A missing or malformed variable fails the
 * boot with a message naming the variable, rather than surfacing later as a confusing
 * runtime error deep inside a request.
 *
 * `no-restricted-syntax` in eslint.config.mjs forbids `process.env` everywhere else,
 * so this file is the only door to configuration.
 */

const nonEmpty = (label: string) => z.string().min(1, `${label} must not be empty`);

const base64Key = (bytes: number) =>
  z.string().refine((value) => {
    try {
      return Buffer.from(value, 'base64').length === bytes;
    } catch {
      return false;
    }
  }, `must be ${bytes} random bytes, base64-encoded (generate with: openssl rand -base64 ${bytes})`);

/**
 * Coerces "1"/"true"/"yes" into a boolean, so flags can be written naturally in a
 * .env file. The default is the decoded boolean, because `.default()` sits after the
 * transform and therefore applies to the output type.
 */
const booleanFlag = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .transform((value) => value === 'true' || value === '1' || value === 'yes')
    .default(defaultValue);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Public origin of this deployment. Used to build OAuth redirects and absolute URLs. */
  APP_URL: z.url().default('http://localhost:3000'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /* ─── Database ─────────────────────────────────────────────────────────────
   * Two URLs by design: application traffic goes through the connection pooler,
   * migrations need a direct session. See ADR 0009.
   */
  DATABASE_URL: nonEmpty('DATABASE_URL').startsWith(
    'postgres',
    'DATABASE_URL must be a PostgreSQL connection string',
  ),
  DIRECT_DATABASE_URL: z.string().optional(),

  /* ─── Google OAuth / Gmail ─────────────────────────────────────────────── */
  GOOGLE_CLIENT_ID: nonEmpty('GOOGLE_CLIENT_ID'),
  GOOGLE_CLIENT_SECRET: nonEmpty('GOOGLE_CLIENT_SECRET'),
  GOOGLE_REDIRECT_URI: z.url(),

  /* ─── Cryptography ─────────────────────────────────────────────────────────
   * Encrypts OAuth refresh tokens at rest (AES-256-GCM). Rotating this key
   * invalidates stored refresh tokens, which forces users to reconnect Gmail.
   */
  ENCRYPTION_KEY: base64Key(32),

  /* ─── AI ───────────────────────────────────────────────────────────────────
   * AI_PROVIDER selects the implementation of the AiProvider interface. Adding a
   * provider means extending this enum and the factory — no business logic changes.
   */
  AI_PROVIDER: z.enum(['anthropic']).default('anthropic'),
  ANTHROPIC_API_KEY: nonEmpty('ANTHROPIC_API_KEY'),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),

  /* ─── Background jobs ──────────────────────────────────────────────────────
   * CRON_SECRET authenticates the scheduler against /api/jobs/*. Without it those
   * endpoints would let anyone trigger synchronization for any user.
   */
  CRON_SECRET: nonEmpty('CRON_SECRET').min(
    24,
    'CRON_SECRET should be at least 24 characters',
  ),

  /** Upper bound on messages pulled during a first-time backfill. See ADR 0004. */
  SYNC_MAX_BACKFILL_MESSAGES: z.coerce.number().int().positive().default(500),
  /** Wall-clock budget for one sync invocation, leaving headroom before the platform timeout. */
  SYNC_TIME_BUDGET_MS: z.coerce.number().int().positive().default(45_000),

  /** Emails analysed per runner invocation. See ADR 0006. */
  ANALYSIS_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(10),
  /** Total lifecycle attempts before an email is marked FAILED. */
  ANALYSIS_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  /** Corrective retries within a single analysis attempt. See ADR 0007. */
  ANALYSIS_MAX_CORRECTIONS: z.coerce.number().int().min(0).max(3).default(2),
  /** How long a claimed email stays leased before another runner may reclaim it. */
  ANALYSIS_LEASE_MS: z.coerce.number().int().positive().default(300_000),
  /** Wall-clock budget for one analysis invocation. */
  ANALYSIS_TIME_BUDGET_MS: z.coerce.number().int().positive().default(45_000),

  /** Set false in local development to skip AI calls and use deterministic output. */
  AI_ENABLED: booleanFlag(true),
});

export type Env = z.infer<typeof envSchema>;

function formatIssues(error: z.ZodError<unknown>): string {
  const lines = error.issues.map((issue) => {
    const variable = issue.path.join('.') || '(root)';
    return `  • ${variable}: ${issue.message}`;
  });

  return [
    'Invalid environment configuration.',
    '',
    ...lines,
    '',
    'Copy .env.example to .env and fill in the missing values.',
  ].join('\n');
}

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Thrown at import time on purpose: a misconfigured process should not start.
    throw new Error(formatIssues(parsed.error));
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

/**
 * Exported for tests, which need to assert on validation behaviour without
 * mutating the real process environment.
 */
export const __envSchemaForTests = envSchema;
