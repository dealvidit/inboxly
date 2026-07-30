import { z } from 'zod';
import type { EmailProjection } from '@/features/gmail';
import { env } from '@/lib/env';
import { AttemptOutcome } from '@/server/db';
import { logger } from '@/server/logger';
import {
  AiRateLimitError,
  AiRefusalError,
  AiTransientError,
  type AiProvider,
  type CorrectionContext,
} from '../providers/ai-provider';
import { extractJson } from './json';
import { ANALYSIS_INSTRUCTION, buildAnalysisInput } from './prompt';
import {
  ANALYSIS_SCHEMA_VERSION,
  EmailAnalysisSchema,
  type EmailAnalysis,
} from './schema';

/**
 * The typed AI pipeline.
 *
 * ```
 * Email → prompt → AiProvider → raw text → JSON extraction → Zod
 *      → success: EmailAnalysis (typed)
 *      → failure: corrective retry, then a typed failure
 * ```
 *
 * Two invariants hold on every path through this module:
 *
 *   1. **Invalid data is never returned.** A response that fails validation produces a
 *      failure result, never a partially-populated analysis.
 *   2. **Raw model output never escapes.** It is carried on attempt records for
 *      diagnostics, truncated, and is never part of a success result.
 *
 * See ADR 0007.
 */

const log = logger.child({ component: 'email-analyzer' });

const MAX_OUTPUT_TOKENS = 4096;
/** How much raw output to keep on an attempt record. Enough to diagnose, not to hoard. */
const RAW_RESPONSE_LIMIT = 4000;

/** One AI call and what became of it. Written to `analysis_attempts` verbatim. */
export interface AnalysisAttemptRecord {
  readonly attemptNumber: number;
  readonly outcome: AttemptOutcome;
  readonly providerId: string;
  readonly model: string;
  readonly validationErrors: unknown | null;
  readonly rawResponse: string | null;
  readonly errorMessage: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
}

export type AnalysisResult =
  | {
      readonly ok: true;
      readonly analysis: EmailAnalysis;
      readonly schemaVersion: number;
      readonly providerId: string;
      readonly model: string;
      readonly usage: { inputTokens: number; outputTokens: number };
      readonly latencyMs: number;
      readonly attempts: readonly AnalysisAttemptRecord[];
    }
  | {
      readonly ok: false;
      /** Whether the caller should return this email to the queue or fail it outright. */
      readonly retryable: boolean;
      /** User-safe reason, suitable for `Email.processingError`. */
      readonly reason: string;
      readonly attempts: readonly AnalysisAttemptRecord[];
    };

export interface EmailAnalyzerDeps {
  readonly provider: AiProvider;
  /** Corrective retries within one analysis. 0 disables correction. */
  readonly maxCorrections?: number;
}

export function createEmailAnalyzer(deps: EmailAnalyzerDeps) {
  const maxCorrections = deps.maxCorrections ?? env.ANALYSIS_MAX_CORRECTIONS;
  const provider = deps.provider;

  return {
    async analyze(email: EmailProjection): Promise<AnalysisResult> {
      const attempts: AnalysisAttemptRecord[] = [];
      const input = buildAnalysisInput(email);
      let correction: CorrectionContext | undefined;

      // One initial call plus the correction budget.
      for (
        let attemptNumber = 1;
        attemptNumber <= maxCorrections + 1;
        attemptNumber += 1
      ) {
        const startedAt = Date.now();

        let generation;
        try {
          generation = await provider.generateStructured({
            instruction: ANALYSIS_INSTRUCTION,
            input,
            schema: EmailAnalysisSchema,
            schemaName: 'email_analysis',
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            ...(correction ? { correction } : {}),
          });
        } catch (error) {
          attempts.push(
            failedAttempt(attemptNumber, provider, outcomeFor(error), error, startedAt),
          );

          // Provider-level failures are not something corrective prompting can fix, so
          // the loop stops here and lets the caller decide whether to requeue.
          return {
            ok: false,
            retryable: isRetryableProviderError(error),
            reason: reasonFor(error),
            attempts,
          };
        }

        const extraction = extractJson(generation.text);

        if (!extraction.ok) {
          attempts.push({
            attemptNumber,
            outcome: AttemptOutcome.UNPARSEABLE_OUTPUT,
            providerId: provider.id,
            model: generation.model,
            validationErrors: null,
            rawResponse: truncate(generation.text),
            errorMessage: extraction.error ?? 'Unparseable response',
            inputTokens: generation.usage.inputTokens,
            outputTokens: generation.usage.outputTokens,
            latencyMs: generation.latencyMs,
          });

          correction = {
            previousOutput: truncate(generation.text),
            validationErrors: 'The response was not valid JSON.',
            attempt: attemptNumber,
          };
          continue;
        }

        const parsed = EmailAnalysisSchema.safeParse(normalise(extraction.value));

        if (parsed.success) {
          attempts.push({
            attemptNumber,
            outcome: AttemptOutcome.SUCCEEDED,
            providerId: provider.id,
            model: generation.model,
            validationErrors: null,
            rawResponse: null,
            errorMessage: null,
            inputTokens: generation.usage.inputTokens,
            outputTokens: generation.usage.outputTokens,
            latencyMs: generation.latencyMs,
          });

          return {
            ok: true,
            analysis: parsed.data,
            schemaVersion: ANALYSIS_SCHEMA_VERSION,
            providerId: provider.id,
            model: generation.model,
            usage: generation.usage,
            latencyMs: generation.latencyMs,
            attempts,
          };
        }

        const issues = z.flattenError(parsed.error);

        attempts.push({
          attemptNumber,
          outcome: AttemptOutcome.INVALID_OUTPUT,
          providerId: provider.id,
          model: generation.model,
          validationErrors: issues,
          rawResponse: truncate(generation.text),
          errorMessage: 'Response failed schema validation',
          inputTokens: generation.usage.inputTokens,
          outputTokens: generation.usage.outputTokens,
          latencyMs: generation.latencyMs,
        });

        log.warn('ai response failed validation', {
          attemptNumber,
          issuePaths: parsed.error.issues.map((issue) => issue.path.join('.')),
        });

        correction = {
          previousOutput: truncate(generation.text),
          validationErrors: describeIssues(parsed.error),
          attempt: attemptNumber,
        };
      }

      // The correction budget is exhausted. A response that fails twice is usually
      // failing for a reason more prompting will not fix, so this is terminal.
      return {
        ok: false,
        retryable: false,
        reason: 'The AI response did not match the expected format.',
        attempts,
      };
    },
  };
}

export type EmailAnalyzer = ReturnType<typeof createEmailAnalyzer>;

/* ─── Helpers ────────────────────────────────────────────────────────────── */

/**
 * Repairs representational noise only — never meaning.
 *
 * Enum casing and stray whitespace are formatting differences that say nothing about
 * whether the model understood the email. Anything semantic (a missing category, an
 * out-of-range confidence) is left to fail validation, because inventing a plausible
 * value would defeat the point of validating at all.
 */
function normalise(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;

  const record = { ...(value as Record<string, unknown>) };

  for (const key of ['category', 'urgency', 'sentiment'] as const) {
    const entry = record[key];
    if (typeof entry === 'string') record[key] = entry.trim().toUpperCase();
  }

  // Some models return confidence as a percentage.
  if (typeof record['confidence'] === 'number' && record['confidence'] > 1) {
    record['confidence'] = record['confidence'] / 100;
  }

  return record;
}

/** Renders Zod issues as lines the model can act on. */
function describeIssues(error: z.ZodError<unknown>): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `- ${path}: ${issue.message}`;
    })
    .join('\n');
}

function truncate(text: string): string {
  return text.length <= RAW_RESPONSE_LIMIT
    ? text
    : `${text.slice(0, RAW_RESPONSE_LIMIT)}…`;
}

function outcomeFor(error: unknown): AttemptOutcome {
  if (error instanceof AiRateLimitError) return AttemptOutcome.RATE_LIMITED;
  if (error instanceof AiRefusalError) return AttemptOutcome.PROVIDER_ERROR;
  return AttemptOutcome.PROVIDER_ERROR;
}

function isRetryableProviderError(error: unknown): boolean {
  return error instanceof AiRateLimitError || error instanceof AiTransientError;
}

/** Always a user-safe message — provider text never reaches this. */
function reasonFor(error: unknown): string {
  if (error instanceof AiRateLimitError) {
    return 'AI analysis is briefly rate limited. It will retry automatically.';
  }
  if (error instanceof AiRefusalError) {
    return 'This email could not be analysed.';
  }
  if (error instanceof AiTransientError) {
    return 'AI analysis is temporarily unavailable.';
  }
  return 'This email could not be analysed.';
}

function failedAttempt(
  attemptNumber: number,
  provider: AiProvider,
  outcome: AttemptOutcome,
  error: unknown,
  startedAt: number,
): AnalysisAttemptRecord {
  return {
    attemptNumber,
    outcome,
    providerId: provider.id,
    model: provider.model,
    validationErrors: null,
    rawResponse: null,
    errorMessage: error instanceof Error ? error.message : String(error),
    inputTokens: null,
    outputTokens: null,
    latencyMs: Date.now() - startedAt,
  };
}
