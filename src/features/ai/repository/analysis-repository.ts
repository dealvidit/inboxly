import { Prisma, db } from '@/server/db';
import type { AnalysisAttemptRecord } from '../analysis/analyzer';
import type { EmailAnalysis } from '../analysis/schema';

/**
 * Persistence for AI results.
 *
 * `saveAnalysis` is the only path by which an `EmailAnalysis` reaches the database, and it
 * only accepts an already-validated one — the type system enforces what ADR 0007 asserts.
 */

export interface SaveAnalysisInput {
  readonly emailId: string;
  readonly userId: string;
  readonly analysis: EmailAnalysis;
  readonly schemaVersion: number;
  readonly providerId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

/**
 * Writes the analysis, replacing any previous one for the email.
 *
 * An upsert rather than a create so that re-running analysis — after a schema change, or
 * on request — is idempotent instead of colliding with the 1:1 constraint.
 */
export async function saveAnalysis(input: SaveAnalysisInput): Promise<void> {
  const { analysis } = input;

  const payload = {
    userId: input.userId,
    category: analysis.category,
    urgency: analysis.urgency,
    sentiment: analysis.sentiment,
    requiresResponse: analysis.requiresResponse,
    confidence: analysis.confidence,
    summary: analysis.summary,
    suggestedReply: analysis.suggestedReply,
    // Cast at the storage boundary only: these were validated by Zod immediately before
    // this call, and Prisma's Json type cannot express their shape.
    actionItems: analysis.actionItems as unknown as Prisma.InputJsonValue,
    deadlines: analysis.deadlines as unknown as Prisma.InputJsonValue,
    meetingInformation: (analysis.meetingInformation ??
      Prisma.JsonNull) as Prisma.InputJsonValue,
    extractedEntities: analysis.extractedEntities as unknown as Prisma.InputJsonValue,
    schemaVersion: input.schemaVersion,
    providerId: input.providerId,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    latencyMs: input.latencyMs,
    analyzedAt: new Date(),
  };

  await db.emailAnalysis.upsert({
    where: { emailId: input.emailId },
    create: { emailId: input.emailId, ...payload },
    update: payload,
  });
}

/**
 * Records every AI call, successful or not.
 *
 * Written even when the analysis failed — that is the point. Validation failure rate is
 * only measurable because failures leave a row behind.
 */
export async function recordAttempts(
  emailId: string,
  userId: string,
  attempts: readonly AnalysisAttemptRecord[],
): Promise<void> {
  if (attempts.length === 0) return;

  await db.analysisAttempt.createMany({
    data: attempts.map((attempt) => ({
      emailId,
      userId,
      attemptNumber: attempt.attemptNumber,
      outcome: attempt.outcome,
      providerId: attempt.providerId,
      model: attempt.model,
      validationErrors: (attempt.validationErrors ??
        Prisma.JsonNull) as Prisma.InputJsonValue,
      rawResponse: attempt.rawResponse,
      errorMessage: attempt.errorMessage,
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      latencyMs: attempt.latencyMs,
    })),
  });
}
