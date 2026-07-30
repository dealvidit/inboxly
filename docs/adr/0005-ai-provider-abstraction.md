# 0005. Provider-agnostic AI abstraction

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

Anthropic is the default provider. OpenAI, Gemini, and Azure OpenAI must be addable
without changing business logic. Models, SDKs, and structured-output mechanisms change far
faster than our domain does, so the boundary needs to be drawn where the churn is.

## Problem

What is the narrowest interface that hides provider differences without leaking their
concepts — and without becoming a lowest-common-denominator wrapper that we fight later?

## Alternatives considered

**Use the Anthropic SDK directly and refactor when a second provider appears.** Honest
and cheap, but the requirement is explicit, and the refactor is much harder once SDK types
have spread into services and tests. The abstraction here has a named, concrete second
implementation coming, so it is not speculative.

**Adopt a framework such as the Vercel AI SDK or LangChain.** Provider-agnostic out of the
box. But we would trade our own thin interface for a large dependency's model of prompts,
messages, tools, and streaming, and our validation and retry semantics — the part that
actually matters here — would sit inside someone else's control flow. The abstraction we
need is roughly forty lines.

**A broad interface mirroring chat APIs** (`messages`, `system`, `tools`, `stream`,
`stopSequences`, …). Maximum expressiveness, minimum portability: every provider
difference resurfaces as a conditional in business logic, and each new provider must
implement features it may not have.

**A single-purpose structured-generation interface** (chosen).

## Decision

Business logic depends on one interface, in `features/ai/providers/ai-provider.ts`:

```ts
export interface AiProvider {
  readonly id: AiProviderId;
  generateStructured<TSchema extends ZodType>(
    request: StructuredRequest<TSchema>,
  ): Promise<StructuredGeneration>;
}

export interface StructuredRequest<TSchema extends ZodType> {
  readonly instruction: string; // system-level task description
  readonly input: string; // the untrusted content being analysed
  readonly schema: TSchema; // the shape we require back
  readonly schemaName: string;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly correction?: CorrectionContext; // prior invalid output + error
}
```

`generateStructured` returns _unvalidated text plus usage metadata_, not a parsed object.
Parsing, validation, and retry belong to the pipeline (ADR 0007), not to the provider —
that keeps every provider implementation trivial and keeps the trust boundary in exactly
one place.

Deliberate exclusions: no streaming (the analysis pipeline has no streaming consumer), no
tool use, no conversation history. Each would be added when a feature needs it, as a
separate method, rather than being carried unused.

Provider selection happens once, in a factory keyed on `AI_PROVIDER`, and providers are
injected into services as constructor arguments. Nothing outside
`features/ai/providers/<name>/` may import a vendor SDK; this is enforced by an ESLint
`no-restricted-imports` rule.

Every provider implementation must pass one shared contract test suite, so "implements
`AiProvider`" means the same thing for each of them.

Provider errors are normalised into typed errors — `AiRateLimitError`,
`AiTransientError`, `AiInvalidRequestError`, `AiAuthError` — so retry policy is written
once against our own taxonomy rather than against vendor error shapes.

## Trade-offs

The narrow interface means provider-specific capabilities (Anthropic's tool-based JSON
mode, OpenAI's `response_format: json_schema`) are used _inside_ the implementations as
optimisations, but cannot be exposed as differing behaviour — each must still return text
that satisfies the schema. That is the point, and it does mean a provider with a strict
JSON mode looks no better from the outside than one without. Returning raw text rather
than a parsed object pushes a little work onto the pipeline, in exchange for one trust
boundary instead of N.

## Validation

The claim above was tested rather than assumed: Google Gemini was added afterwards as a
second real provider. It required one new directory
(`features/ai/providers/google/`), one `case` in the factory, and two environment
variables. **No business logic changed** — the analyzer, the runner, the repositories,
the API, and the dashboard were untouched.

Two differences surfaced, and both were absorbed inside the provider, which is where they
belong:

- Gemini's `responseSchema` is an OpenAPI 3.0 subset rather than JSON Schema. It rejects
  `$schema`, `additionalProperties`, and `$ref`, and expresses nullability as a
  `nullable: true` flag instead of a `anyOf: [T, null]` union. `gemini-schema.ts` does
  that conversion, and is tested on its own because a silently wrong schema would surface
  as a confusing 400 rather than an obvious bug.
- Gemini reports a content-policy stop as a `finishReason` on a `200` response, where
  Anthropic returns a distinct `stop_reason`. Both normalise to `AiRefusalError`.

Verified end to end against the live API on `gemini-3.5-flash-lite`: three seeded emails
were analysed correctly on the first attempt each — an overdue invoice as FINANCE/HIGH
with the amount, the chasing contact, and an _inferred_ deadline flagged as such; a
scheduling request as MEETING with the Zoom URL, start time, duration, and attendees
extracted; and a marketing blast as PROMOTION/LOW. No corrective retries were needed,
which is the structured-output optimisation doing its job while validation still owns
correctness.

One operational note worth recording: newly enabled Gemini models can return `404` from
`generateContent` for a period after they appear in `models.list`. That is propagation,
not a client bug — the same request succeeds later unchanged. Do not restructure a
working request in response to it.

## Consequences

- Adding a provider is one directory and one factory entry; no business logic changes.
- Business logic is testable against an in-memory fake provider, with no network or keys.
- Vendor SDK upgrades are contained to one directory.
- Retry and validation behave identically regardless of provider.
