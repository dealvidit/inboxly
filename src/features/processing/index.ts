/**
 * The processing feature's public surface.
 *
 * The queue repository is deliberately not exported — the claim query's correctness
 * depends on it being used exactly as the runner uses it.
 */

export { analysisRunner, createAnalysisRunner } from './service/analysis-runner';
export type { AnalysisRunResult, AnalysisRunner } from './service/analysis-runner';
