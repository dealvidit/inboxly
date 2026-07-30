import { env } from '@/lib/env';
import { ConfigurationError } from '@/server/errors';
import { logger } from '@/server/logger';
import type { AiProvider } from './ai-provider';
import { createAnthropicProvider } from './anthropic/anthropic-provider';
import { createFakeProvider } from './fake/fake-provider';
import { createGeminiProvider } from './google/gemini-provider';

/**
 * Provider selection, in one place.
 *
 * Adding OpenAI, Gemini, or Azure OpenAI is a new directory under `providers/` and one
 * `case` here. No business logic changes — which is the entire point of ADR 0005.
 */

const log = logger.child({ component: 'ai-provider-factory' });

let cached: AiProvider | undefined;

export function createAiProvider(): AiProvider {
  // Escape hatch for local development: run the whole pipeline, spend nothing.
  if (!env.AI_ENABLED) {
    log.warn('AI_ENABLED is false — using the deterministic fake provider');
    return createFakeProvider();
  }

  switch (env.AI_PROVIDER) {
    case 'anthropic':
      return createAnthropicProvider();
    case 'gemini':
      if (!env.GEMINI_API_KEY) {
        // Fail at startup with a message naming the variable, rather than letting every
        // request fail with an auth error that looks like a provider outage.
        throw new ConfigurationError(
          'AI_PROVIDER is "gemini" but GEMINI_API_KEY is not set',
        );
      }
      return createGeminiProvider();
    default: {
      // Unreachable while AI_PROVIDER is a validated enum; this makes adding a value to
      // that enum without adding a case here a compile error rather than a runtime one.
      const exhaustive: never = env.AI_PROVIDER;
      throw new Error(`Unsupported AI provider: ${String(exhaustive)}`);
    }
  }
}

/** The shared instance. Providers are stateless, so one is enough. */
export function aiProvider(): AiProvider {
  cached ??= createAiProvider();
  return cached;
}
