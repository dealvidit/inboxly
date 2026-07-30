# 0007. Typed AI pipeline with corrective retry

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

A language model returns text. We need a typed domain object with enums, bounded numbers,
and nested structures, persisted to a relational schema and rendered in a UI. The model
will sometimes wrap JSON in prose, invent an enum value, return `"high"` where we expect
`"HIGH"`, omit a required field, or emit a confidence of `1.5`. Emails are also
attacker-controlled input: an email body can contain text instructing the model to ignore
its instructions.

## Problem

How does untrusted model output become a trusted domain model — and what happens when it
cannot?

## Alternatives considered

**Trust the model and cast.** `JSON.parse(text) as EmailAnalysis`. One bad response then
becomes a runtime error deep in the UI, or worse, silently wrong data in the database. The
type assertion is a lie the compiler cannot catch.

**Validate, and drop invalid responses.** Safe but wasteful: most validation failures are
near-misses the model would fix if told what was wrong.

**Provider-native structured output only** (JSON schema mode / tool calling). Materially
raises the first-attempt success rate and we _do_ use it inside the Anthropic
implementation. But it is not a guarantee — enum drift and semantic constraints still slip
through — and relying on it would make correctness a property of the provider rather than
of our code. It is an optimisation, not the trust boundary.

**Validate with corrective retry** (chosen), with the schema as the single source of truth
for both the prompt and the runtime check.

## Decision

Zod schemas in `features/ai/analysis/schema.ts` define the contract, and TypeScript types
are inferred from them with `z.infer` — the schema is the only definition, so the prompt
and the validator can never disagree.

The pipeline:

```
Email
  │  buildAnalysisPrompt()          instruction + schema description + delimited content
  ▼
AiProvider.generateStructured()     raw text + token usage
  │  extractJson()                  strip fences/prose, locate the JSON object
  ▼
  │  schema.safeParse()
  ├── success ──▶ EmailAnalysis (typed) ──▶ repository ──▶ PostgreSQL ──▶ tRPC ──▶ React
  └── failure ──▶ log AnalysisAttempt with the Zod issues
                   ├── attempts remain ──▶ retry with CorrectionContext
                   └── budget exhausted ──▶ Email.processingStatus = FAILED
```

**Corrective retry** sends back the previous invalid output and the flattened Zod issues,
and asks for a corrected object. In practice this fixes the common near-misses — a missing
field, a wrong enum casing, an out-of-range number — in one extra call. The retry budget
is small (default 2 corrective attempts) because a response that fails twice is usually
failing for a reason more prompting will not fix.

**Normalisation before validation** is deliberately minimal and only for
representational noise, never semantics: trimming whitespace, uppercasing enum
candidates, and coercing a bare number to a fixed precision. We do not repair meaning —
inventing a plausible `category` for a response that omitted one would defeat the purpose
of validating at all.

**Prompt injection** is treated as a data-integrity problem, not a solved one. Email
content is wrapped in explicit delimiters and labelled as untrusted data to be analysed
rather than instructions to follow; the instruction block states that any directives found
inside the content are data. Crucially, the _structural_ defence is the schema: even a
fully successful injection can only produce a value that satisfies `EmailAnalysisSchema`,
so the blast radius is a misleading summary, not arbitrary data entering the system. AI
output is never used to make an authorization decision, never interpolated into SQL, and
never rendered as HTML.

**Invariants** enforced by construction:

- No `any` and no vendor payload type crosses out of `features/ai/`.
- Raw model text is never returned by a service, never stored in a domain field, and never
  sent to the client. It is written only to `AnalysisAttempt.rawResponse`, truncated, for
  diagnostics.
- Invalid data is never persisted to `EmailAnalysis` — a failed validation writes an
  attempt row and nothing else.
- Every validation failure is logged with the schema name, the Zod issues, and the attempt
  number, so prompt regressions are visible in aggregate.

## Trade-offs

A corrective retry doubles latency and cost for the responses that need it; capped at two
attempts, and cheaper than the alternative of bad data in the database. Schema-derived
prompt descriptions must stay readable to the model, so schemas carry `.describe()`
annotations that exist for the prompt's benefit as much as the reader's. Strict validation
means a schema change can invalidate stored analyses; versioning the analysis schema and
re-running affected emails is the migration path.

## Consequences

- The database contains only data that satisfied the schema.
- Provider or model changes cannot silently change the shape of our domain.
- Validation failure rate is a measurable quality signal, queryable from
  `AnalysisAttempt`.
- The UI can render analysis fields without defensive null-checking beyond "analysis may
  not exist yet."
