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
import { toGeminiSchema } from './gemini-schema';

/**
 * The Google Gemini implementation of `AiProvider`.
 *
 * Adding it required no change to any business logic — the analyzer, the runner, the
 * repositories, and the dashboard are untouched. That was the claim in ADR 0005, and this
 * file is the test of it.
 *
 * Reached over `fetch` rather than `@google/genai`, for the same reason the Gmail client
 * is: one endpoint is used, and what matters about it is error classification, which we
 * want to own rather than inherit. Adding a large dependency to hide a single POST would
 * be the worse trade.
 *
 * As with Anthropic, the provider asks Gemini to enforce the schema (`responseMimeType`
 * plus `responseSchema`) as an *optimisation*. The pipeline still validates every
 * response with Zod, because correctness must be a property of our code (ADR 0007).
 */

const log = logger.child({ component: 'gemini-provider' });

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiProviderDeps {
  readonly apiKey?: string;
  readonly model?: string;
  readonly fetchFn?: typeof fetch;
}

export function createGeminiProvider(deps: GeminiProviderDeps = {}): AiProvider {
  const model = deps.model ?? env.GEMINI_MODEL;
  const apiKey = deps.apiKey ?? env.GEMINI_API_KEY ?? '';
  const fetchFn = deps.fetchFn ?? fetch;

  return {
    id: 'gemini',
    model,

    async generateStructured<TSchema extends ZodType>(
      request: StructuredRequest<TSchema>,
    ): Promise<StructuredGeneration> {
      const startedAt = Date.now();

      if (!apiKey) {
        throw new AiAuthError('gemini', 'GEMINI_API_KEY is not configured');
      }

      const body = {
        // Gemini has no separate system role in this endpoint shape; the instruction goes
        // in `systemInstruction`, which keeps it distinct from the untrusted email body.
        systemInstruction: { parts: [{ text: request.instruction }] },
        contents: [{ role: 'user', parts: [{ text: buildUserContent(request) }] }],
        generationConfig: {
          maxOutputTokens: request.maxOutputTokens,
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(request.schema),
        },
      };

      let response: Response;
      try {
        response = await fetchFn(
          `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // Sent as a header rather than a query parameter so the key cannot end up
              // in a proxy log or an error message containing the URL.
              'x-goog-api-key': apiKey,
            },
            body: JSON.stringify(body),
          },
        );
      } catch (cause) {
        throw new AiTransientError('gemini', 'Request failed', { cause });
      }

      const payload: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw toGeminiError(response.status, payload);
      }

      const parsed = payload as GeminiResponse;
      const candidate = parsed.candidates?.[0];

      // Gemini reports a content-policy stop on the candidate rather than as an error.
      if (
        candidate?.finishReason === 'SAFETY' ||
        candidate?.finishReason === 'PROHIBITED_CONTENT'
      ) {
        throw new AiRefusalError('gemini', candidate.finishReason);
      }

      if (candidate?.finishReason === 'MAX_TOKENS') {
        throw new AiInvalidRequestError(
          'gemini',
          'Response was truncated by the output token limit',
        );
      }

      const text = (candidate?.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('');

      return {
        text,
        usage: {
          inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
        },
        model: parsed.modelVersion ?? model,
        latencyMs: Date.now() - startedAt,
      };
    },
  };
}

/* ─── Wire shapes ────────────────────────────────────────────────────────── */

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

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
 * Maps Google's errors onto our taxonomy.
 *
 * The distinction that matters here is 429: a project with **zero** allocated quota
 * returns the same status as one that is merely being throttled. Both are classified
 * retryable, because from the pipeline's point of view they are — the email is fine, and
 * the operator either waits or fixes billing. Treating them differently would mean
 * guessing at Google's phrasing.
 */
function toGeminiError(status: number, payload: unknown): Error {
  const message = extractMessage(payload);

  if (status === 429) {
    return new AiRateLimitError('gemini');
  }

  if (status === 401 || status === 403) {
    return new AiAuthError('gemini', message ?? 'credentials rejected');
  }

  if (status === 400) {
    return new AiInvalidRequestError('gemini', message ?? 'bad request');
  }

  if (status >= 500) {
    return new AiTransientError('gemini', message ?? `upstream ${status}`);
  }

  log.warn('unrecognised Gemini status', { status });
  return new AiInvalidRequestError('gemini', message ?? `unexpected status ${status}`);
}

function extractMessage(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const error = (payload as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' ? error.message.slice(0, 300) : null;
}
