/**
 * The AI feature's public surface.
 *
 * Nothing here exposes a vendor SDK type. The provider implementations are not exported
 * at all — callers get a provider from the factory and depend only on `AiProvider`.
 */

export { createEmailAnalyzer } from './analysis/analyzer';
export type {
  AnalysisAttemptRecord,
  AnalysisResult,
  EmailAnalyzer,
} from './analysis/analyzer';

export {
  ANALYSIS_SCHEMA_VERSION,
  ActionItemSchema,
  DeadlineSchema,
  EmailAnalysisSchema,
  ExtractedEntitiesSchema,
  MeetingInformationSchema,
  EmailCategorySchema,
  SentimentSchema,
  UrgencySchema,
} from './analysis/schema';
export type {
  ActionItem,
  Deadline,
  EmailAnalysis,
  ExtractedEntities,
  MeetingInformation,
} from './analysis/schema';

export { aiProvider, createAiProvider } from './providers/factory';
export { createFakeProvider } from './providers/fake/fake-provider';
export {
  AiAuthError,
  AiInvalidRequestError,
  AiRateLimitError,
  AiRefusalError,
  AiTransientError,
} from './providers/ai-provider';
export type { AiProvider, AiProviderId } from './providers/ai-provider';
