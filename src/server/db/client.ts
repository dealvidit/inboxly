import { PrismaPg } from '@prisma/adapter-pg';
import { env, isProduction } from '@/lib/env';
import { PrismaClient } from '@/generated/prisma/client';

/**
 * The application's single database connection.
 *
 * Two things here are deliberate rather than boilerplate.
 *
 * The pool is capped at one connection per instance. Serverless scales by adding
 * instances, so an unbounded pool multiplied by the instance count is how connection
 * limits get exhausted. Concurrency comes from the connection pooler that
 * DATABASE_URL points at, not from a large pool inside each function. See ADR 0009.
 *
 * In development the client is cached on globalThis, because hot reloading re-evaluates
 * modules and would otherwise leak a new pool on every edit.
 */

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: 1,
    // Fail fast rather than hanging a request when the pool is saturated.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  // Query logging is deliberately off: it would put email subjects and addresses into
  // the logs. Slow queries are found with the database's own statement logging.
  return new PrismaClient({ adapter, log: ['warn', 'error'] });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.prisma = db;
}
