#!/usr/bin/env node
/**
 * Applies migrations to the integration-test database.
 *
 * Integration tests run against a separate database so that a test run can truncate
 * freely without touching development data. `docker compose up db` creates it (see
 * scripts/init-test-db.sql); this script brings its schema up to date.
 *
 * The URL comes from TEST_DATABASE_URL when set, so CI can point elsewhere.
 */
import { spawnSync } from 'node:child_process';

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://inboxly:inboxly@localhost:5432/inboxly_test';

console.log(`Applying migrations to ${redact(testDatabaseUrl)}`);

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    // prisma.config.ts prefers DIRECT_DATABASE_URL, so both are set to keep the
    // developer's .env from redirecting this at the development database.
    DATABASE_URL: testDatabaseUrl,
    DIRECT_DATABASE_URL: testDatabaseUrl,
  },
});

process.exit(result.status ?? 1);

/** Keeps credentials out of the terminal and out of CI logs. */
function redact(url) {
  return url.replace(/\/\/[^@]*@/, '//***@');
}
