import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * The interesting part of this file is not the recommended presets — it is the
 * `no-restricted-imports` blocks below, which turn the dependency rules from
 * docs/architecture.md into build failures instead of review comments.
 */
const config = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'coverage/**',
      'next-env.d.ts',
      'src/generated/**',
    ],
  },

  ...nextCoreWebVitals,
  ...nextTypescript,

  {
    rules: {
      // Unused variables are an error, but an underscore prefix is an explicit
      // "I know, and I mean it" for required-but-unused positional parameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'object-shorthand': ['error', 'properties'],
    },
  },

  /* ─── Architectural boundaries ─────────────────────────────────────────── */

  {
    // Vendor SDKs are confined to the modules that adapt them. See ADR 0005.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/features/ai/providers/**',
      'src/features/gmail/client/**',
      'src/server/db/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/sdk',
              message:
                'Business logic must not depend on an AI SDK. Go through the AiProvider interface (features/ai/providers). See ADR 0005.',
            },
            {
              name: 'googleapis',
              message:
                'Use the Gmail client wrapper in features/gmail/client, which owns retries, backoff, and quota handling. See ADR 0004.',
            },
            {
              name: 'google-auth-library',
              message:
                'OAuth token handling belongs to features/auth. Do not call the Google auth library directly.',
            },
            {
              name: '@prisma/client',
              message:
                'Import the shared client from @/server/db and query only from a feature repository.',
            },
          ],
        },
      ],
    },
  },

  {
    // Repositories are the only place Prisma queries are written; services and routers
    // go through them so that user scoping cannot be bypassed.
    //
    // Only the `db` client itself is banned, not the whole module: enums and row types
    // are domain vocabulary that services legitimately need, and banning them would push
    // callers into re-exporting Prisma's generated types by hand.
    files: ['src/features/*/service/**/*.ts', 'src/features/*/router.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/server/db',
              importNames: ['db'],
              message:
                'Services and routers must not query the database directly. Add a repository function that scopes by userId. See ADR 0008.',
            },
          ],
          patterns: [
            {
              group: ['@/server/db/client', '@/generated/prisma/client'],
              message:
                'Services and routers must not query the database directly. Add a repository function that scopes by userId. See ADR 0008.',
            },
          ],
        },
      ],
    },
  },

  {
    // Infrastructure must not depend on the features built on top of it.
    files: ['src/lib/**/*.ts', 'src/server/**/*.ts'],
    ignores: ['src/server/trpc/root.ts', 'src/server/trpc/context.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/*', '@/app/*'],
              message:
                'lib/ and server/ are the foundation; they must not import from features/ or app/. Invert the dependency.',
            },
          ],
        },
      ],
    },
  },

  {
    // Environment access is centralised so that every variable is validated once,
    // at startup, with an actionable error.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/env.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env']",
          message:
            'Read configuration from @/lib/env, which validates it with Zod at startup.',
        },
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            'Read configuration from @/lib/env, which validates it with Zod at startup.',
        },
      ],
    },
  },

  {
    // Tests need the freedom to poke at internals and log.
    files: ['tests/**/*.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    // Developer scripts are command-line tools: printing to stdout is their job, and
    // they run before the application's configuration module is necessarily loadable.
    files: ['scripts/**/*.{mjs,ts}'],
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  {
    // Instrumentation reads NEXT_RUNTIME, which Next.js injects to say which runtime the
    // process is. That is not application configuration and cannot come from lib/env —
    // this file runs before it, and in the edge runtime importing it would fail.
    files: ['src/instrumentation.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];

export default config;
