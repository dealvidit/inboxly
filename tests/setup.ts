/**
 * Vitest setup. Runs before every test file.
 *
 * Tests must never reach the network or a real provider, so the environment is
 * populated with deterministic placeholders here. Existing values win: integration
 * tests need the developer's own DATABASE_URL, and CI supplies its own.
 *
 * NODE_ENV is set to 'test' by Vitest itself, so it is deliberately absent below —
 * @types/node types it as read-only, and assigning it would need a cast that hides
 * the fact that nothing needs to assign it.
 */
const defaults: Record<string, string> = {
  DATABASE_URL: 'postgresql://inboxly:inboxly@localhost:5432/inboxly_test',
  DIRECT_DATABASE_URL: 'postgresql://inboxly:inboxly@localhost:5432/inboxly_test',
  APP_URL: 'http://localhost:3000',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/callback/google',
  ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'),
  ANTHROPIC_API_KEY: 'sk-ant-test-key',
  CRON_SECRET: 'test-cron-secret-that-is-long-enough',
  LOG_LEVEL: 'error',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
