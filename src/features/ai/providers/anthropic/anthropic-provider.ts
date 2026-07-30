import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ZodType } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/server/logger';
import {
  AiAuthError,
  AiInvalidRequestError,
  AiRateLimitError,
  AiRefusalError,
  AiTransientError,
  type AiProvider,
  type StructuredGeneration,
  type StructuredRequest,
} from '../ai-provider';

/**
 * The Anthropic implementation of `AiProvider`.
 *
 * This is the only module in the application permitted to import an AI SDK.
 *
 * It uses Anthropic's structured-output support (`output_config.format`) to constrain the
 * response to our schema. That is an *optimisation*, not the trust boundary: it raises
 * the first-attempt success rate substantially, but the pipeline still validates every
 * response with Zod, because correctness must be a property of our code rather than of
 * the provider (ADR 0007).
 */

const log = logger.child({ component: 'anthropic-provider' });

/**
 * Email triage is a classification task, not a reasoning one. `low` effort keeps latency
 * and cost down without measurably hurting quality here; the knob is one line if that
 * stops being true.
 */
const EFFORT = 'low' as const;

export interface AnthropicProviderDeps {
  readonly apiKey?: string;
  readonly model?: string;
  /** Injected in tests to avoid constructing a real client. */
  readonly client?: Anthropic;
}

export function createAnthropicProvider(deps: AnthropicProviderDeps = {}): AiProvider {
  const model = deps.model ?? env.ANTHROPIC_MODEL;
  const client =
    deps.client ?? new Anthropic({ apiKey: deps.apiKey ?? env.ANTHROPIC_API_KEY });

  return {
    id: 'anthropic',
    model,

    async generateStructured<TSchema extends ZodType>(
      request: StructuredRequest<TSchema>,
    ): Promise<StructuredGeneration> {
      const startedAt = Date.now();

      try {
        const response = await client.messages.create({
          model,
          max_tokens: request.maxOutputTokens,
          system: request.instruction,
          output_config: {
            effort: EFFORT,
            // Derives a JSON schema from the Zod schema and strips the constraints
            // Anthropic's structured outputs do not support (numeric ranges, string
            // lengths). Those still hold — the pipeline enforces them on the way in.
            format: zodOutputFormat(request.schema),
          },
          messages: [{ role: 'user', content: buildUserContent(request) }],
        });

        // Checked before reading content: on a refusal the content array is empty, and
        // indexing into it would throw a confusing TypeError instead of a typed error.
        if (response.stop_reason === 'refusal') {
          throw new AiRefusalError(
            'anthropic',
            response.stop_details?.category ?? null,
          );
        }

        const text = response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');

        if (response.stop_reason === 'max_tokens') {
          // The JSON is truncated and cannot parse. Failing here with a clear reason
          // beats letting the pipeline report an inscrutable syntax error.
          throw new AiInvalidRequestError(
            'anthropic',
            'Response was truncated by the output token limit',
          );
        }

        return {
          text,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
          model: response.model,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        throw normaliseError(error);
      }
    },
  };
}

/**
 * Assembles the user turn.
 *
 * A correction is appended *after* the content, so the model sees what it was asked to do,
 * then what it got wrong. See ADR 0007.
 */
function buildUserContent<TSchema extends ZodType>(
  request: StructuredRequest<TSchema>,
): string {
  if (!request.correction) return request.input;

  return [
    request.input,
    '',
    '---',
    '',
    'Your previous response did not satisfy the required schema.',
    '',
    'Previous response:',
    request.correction.previousOutput,
    '',
    'Validation errors:',
    request.correction.validationErrors,
    '',
    'Return a corrected object that satisfies the schema. Output only the JSON object.',
  ].join('\n');
}

/**
 * Maps SDK errors onto our taxonomy.
 *
 * Uses the SDK's typed error classes rather than string-matching messages, so a change to
 * Anthropic's wording cannot silently reclassify an error as unretryable.
 */
function normaliseError(error: unknown): Error {
  // Already ours — thrown from inside the try block above.
  if (error instanceof AiRefusalError || error instanceof AiInvalidRequestError) {
    return error;
  }

  if (error instanceof Anthropic.RateLimitError) {
    const header = error.headers?.get?.('retry-after');
    const seconds = header ? Number(header) : Number.NaN;
    return new AiRateLimitError(
      'anthropic',
      Number.isFinite(seconds) ? seconds : undefined,
    );
  }

  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new AiAuthError('anthropic', error.message);
  }

  if (error instanceof Anthropic.BadRequestError) {
    return new AiInvalidRequestError('anthropic', error.message, { cause: error });
  }

  if (
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.APIConnectionError
  ) {
    return new AiTransientError('anthropic', error.message, { cause: error });
  }

  if (error instanceof Anthropic.APIError) {
    // Unrecognised status: retry only if it could plausibly be transient.
    const status = error.status ?? 0;
    const message = error.message;
    return status >= 500 || status === 408
      ? new AiTransientError('anthropic', message, { cause: error })
      : new AiInvalidRequestError('anthropic', message, { cause: error });
  }

  log.error('unrecognised error from the Anthropic SDK', error);
  return new AiTransientError(
    'anthropic',
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}
