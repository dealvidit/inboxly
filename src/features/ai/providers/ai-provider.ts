import type { ZodType } from 'zod';
import {
  ExternalServiceError,
  RateLimitError,
  UnauthorizedError,
} from '@/server/errors';

/**
 * The AI boundary.
 *
 * Business logic depends on this interface and nothing else — no vendor SDK type crosses
 * it, in either direction. `eslint.config.mjs` enforces that by forbidding
 * `@anthropic-ai/sdk` outside `features/ai/providers/`.
 *
 * The single most important decision here: `generateStructured` returns **unvalidated
 * text**, not a parsed object. A provider's job is to coax JSON out of a model; deciding
 * whether that JSON is trustworthy is the pipeline's job. That keeps every provider
 * implementation trivial and keeps the trust boundary in exactly one place (ADR 0005).
 */

export const AI_PROVIDER_IDS = ['anthropic', 'fake'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/** Context handed back to the model after its previous output failed validation. */
export interface CorrectionContext {
  /** The output that failed, truncated. */
  readonly previousOutput: string;
  /** Human-readable validation errors, one per line. */
  readonly validationErrors: string;
  /** 1 for the first correction. */
  readonly attempt: number;
}

export interface StructuredRequest<TSchema extends ZodType> {
  /** System-level description of the task. Trusted; written by us. */
  readonly instruction: string;
  /** The content being analysed. Untrusted; delimited by the prompt builder. */
  readonly input: string;
  /** The shape we require back. Also drives provider-native JSON enforcement. */
  readonly schema: TSchema;
  /** Names the schema in logs and in the provider's structured-output request. */
  readonly schemaName: string;
  readonly maxOutputTokens: number;
  readonly correction?: CorrectionContext;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface StructuredGeneration {
  /** Raw model output. Never returned to a client, never stored in a domain field. */
  readonly text: string;
  readonly usage: TokenUsage;
  readonly model: string;
  readonly latencyMs: number;
}

export interface AiProvider {
  readonly id: AiProviderId;
  /** The model this provider is configured to call, for provenance on stored results. */
  readonly model: string;

  generateStructured<TSchema extends ZodType>(
    request: StructuredRequest<TSchema>,
  ): Promise<StructuredGeneration>;
}

/* ─── Error taxonomy ─────────────────────────────────────────────────────── */

/**
 * Provider errors are normalised onto our own types so that retry policy is written once,
 * against this taxonomy, rather than against each vendor's error shapes.
 */

export class AiRateLimitError extends RateLimitError {
  constructor(providerId: string, retryAfterSeconds?: number) {
    super(`${providerId} rate limit exceeded`, {
      userMessage: 'AI analysis is briefly rate limited. It will retry automatically.',
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
}

/** A transient provider failure — overload, timeout, 5xx. Worth retrying. */
export class AiTransientError extends ExternalServiceError {
  constructor(providerId: string, message: string, options: { cause?: unknown } = {}) {
    super(providerId, message, {
      retryable: true,
      userMessage: 'AI analysis is temporarily unavailable.',
      ...options,
    });
  }
}

/** The request itself is wrong — bad schema, oversized input. Retrying will not help. */
export class AiInvalidRequestError extends ExternalServiceError {
  constructor(providerId: string, message: string, options: { cause?: unknown } = {}) {
    super(providerId, message, {
      retryable: false,
      userMessage: 'This email could not be analysed.',
      ...options,
    });
  }
}

/** The API key is missing, wrong, or lacks credit. A human must intervene. */
export class AiAuthError extends UnauthorizedError {
  constructor(providerId: string, message: string) {
    super(`${providerId}: ${message}`, {
      userMessage: 'AI analysis is not configured correctly.',
    });
  }
}

/**
 * The model declined to respond. Terminal for this email: retrying the same content
 * produces the same refusal, so the pipeline records it rather than burning the budget.
 */
export class AiRefusalError extends ExternalServiceError {
  readonly category: string | null;

  constructor(providerId: string, category: string | null) {
    super(
      providerId,
      `Model declined to analyse this content (${category ?? 'unspecified'})`,
      {
        retryable: false,
        userMessage: 'This email could not be analysed.',
      },
    );
    this.category = category;
  }
}
