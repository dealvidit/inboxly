import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Integration tests share one Postgres database, so they must not run in
    // parallel across files.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/features/**', 'src/lib/**', 'src/server/**'],
      exclude: [
        '**/*.test.ts',
        '**/components/**',
        '**/router.ts',
        'src/server/db/client.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '~/tests': fileURLToPath(new URL('./tests', import.meta.url)),
      // `server-only` throws unless it is resolved under the `react-server` condition,
      // which only the Next.js bundler sets. Tests import server modules directly and
      // legitimately, so point it at the package's own no-op entry. Setting
      // `resolve.conditions` instead would also change how React resolves, pulling in
      // its RSC build — a much larger blast radius for the same result.
      'server-only': fileURLToPath(
        new URL('./node_modules/server-only/empty.js', import.meta.url),
      ),
    },
  },
});
