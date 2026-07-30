import type { ZodType } from 'zod';
import type {
  AiProvider,
  StructuredGeneration,
  StructuredRequest,
} from '../ai-provider';

/**
 * A provider that returns deterministic output without calling anything.
 *
 * Two uses, both real:
 *
 *   - **Tests.** The whole analysis pipeline runs against it with no network, no API key,
 *     and no cost — including the failure paths, which are hard to provoke on purpose
 *     against a real model.
 *   - **Local development** with `AI_ENABLED=false`, so the dashboard can be built and
 *     demonstrated against populated data without spending anything.
 *
 * It is also the second implementation that justifies `AiProvider` existing at all: an
 * interface with one implementation is speculation, and this one is used every test run.
 */

export interface FakeProviderDeps {
  /** Responses returned in order. The last one repeats once exhausted. */
  readonly responses?: readonly string[];
  /** Thrown instead of responding, in order. `null` means "respond normally". */
  readonly errors?: readonly (Error | null)[];
  readonly model?: string;
}

export interface FakeProvider extends AiProvider {
  /** Every request received, for assertions about prompts and corrections. */
  readonly calls: ReadonlyArray<StructuredRequest<ZodType>>;
}

export function createFakeProvider(deps: FakeProviderDeps = {}): FakeProvider {
  const calls: StructuredRequest<ZodType>[] = [];
  let index = 0;

  return {
    id: 'fake',
    model: deps.model ?? 'fake-model',
    calls,

    async generateStructured<TSchema extends ZodType>(
      request: StructuredRequest<TSchema>,
    ): Promise<StructuredGeneration> {
      calls.push(request as unknown as StructuredRequest<ZodType>);
      const callIndex = index;
      index += 1;

      const error = deps.errors?.[callIndex];
      if (error) throw error;

      const responses = deps.responses ?? [
        JSON.stringify(defaultAnalysis(request.input)),
      ];
      const text = responses[Math.min(callIndex, responses.length - 1)] ?? '';

      return {
        text,
        usage: { inputTokens: 100, outputTokens: 50 },
        model: deps.model ?? 'fake-model',
        latencyMs: 1,
      };
    },
  };
}

/**
 * A plausible analysis derived from the input by simple keyword matching.
 *
 * Not intelligence — just enough variation that a locally-seeded dashboard shows a mix of
 * categories and urgencies rather than a wall of identical rows.
 */
function defaultAnalysis(input: string) {
  const text = input.toLowerCase();

  const category =
    text.includes('invoice') || text.includes('payment')
      ? 'FINANCE'
      : text.includes('meeting') || text.includes('calendar')
        ? 'MEETING'
        : text.includes('unsubscribe')
          ? 'NEWSLETTER'
          : 'WORK';

  const urgency = text.includes('urgent') || text.includes('asap') ? 'HIGH' : 'MEDIUM';
  const requiresResponse = text.includes('?') || text.includes('please');

  return {
    category,
    urgency,
    sentiment: 'NEUTRAL',
    requiresResponse,
    confidence: 0.75,
    summary: 'Deterministic analysis produced without calling a model.',
    suggestedReply: requiresResponse
      ? 'Thanks — I will come back to you shortly.'
      : null,
    actionItems: [],
    deadlines: [],
    meetingInformation: null,
    extractedEntities: {
      people: [],
      organisations: [],
      amounts: [],
      dates: [],
      links: [],
    },
  };
}
