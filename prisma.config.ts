import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Configuration for the Prisma CLI only — migrations, studio, and introspection. The
 * application's runtime connection is created in src/server/db/client.ts.
 *
 * Migrations run against the direct (unpooled) endpoint: they need a real session, and
 * a transaction pooler cannot give them one. In local development the two URLs are the
 * same; on serverless they must differ. See ADR 0009.
 *
 * This file reads process.env directly rather than going through src/lib/env.ts,
 * because the CLI must be able to run before the application's full configuration is
 * present — for example in a fresh checkout with only a database URL set.
 */
const url = process.env['DIRECT_DATABASE_URL'] ?? process.env['DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // Omitted rather than set to undefined when unset, so that `prisma generate` — which
  // needs no connection — still works in a fresh checkout with no .env yet.
  ...(url ? { datasource: { url } } : {}),
});
