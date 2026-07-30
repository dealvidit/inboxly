/**
 * The processing feature's public surface.
 *
 * The claim query is deliberately not exported — its correctness depends on being used
 * exactly as the runner uses it. `resetFailedAnalyses` is safe to expose: it only moves
 * FAILED rows back to PENDING.
 */

export { analysisRunner, createAnalysisRunner } from './service/analysis-runner';
export { resetFailed as resetFailedAnalyses } from './repository/queue-repository';
export type { AnalysisRunResult, AnalysisRunner } from './service/analysis-runner';
