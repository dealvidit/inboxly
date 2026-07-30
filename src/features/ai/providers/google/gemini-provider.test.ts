import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EmailAnalysisSchema } from '../../analysis/schema';
import {
  AiAuthError,
  AiInvalidRequestError,
  AiRateLimitError,
  AiRefusalError,
  AiTransientError,
} from '../ai-provider';
import { createGeminiProvider } from './gemini-provider';
import { toGeminiSchema } from './gemini-schema';

/**
 * Gemini is tested against a fake `fetch`, like the other outbound clients: the request
 * shape and the error mapping are what matter, and neither needs a real network call.
 */

function fakeFetch(reply: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchFn, calls };
}

const successBody = {
  candidates: [
    {
      content: { parts: [{ text: '{"ok":true}' }] },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40 },
  modelVersion: 'gemini-2.0-flash-001',
};

const request = {
  instruction: 'You are an email triage analyst.',
  input: 'Analyse this.',
  schema: z.object({ ok: z.boolean() }),
  schemaName: 'test',
  maxOutputTokens: 1024,
};

describe('toGeminiSchema', () => {
  it('emits no $ref or $defs, which Gemini cannot resolve', () => {
    const serialised = JSON.stringify(toGeminiSchema(EmailAnalysisSchema));

    expect(serialised).not.toContain('$ref');
    expect(serialised).not.toContain('$defs');
  });

  it('strips keywords Gemini rejects', () => {
    const serialised = JSON.stringify(toGeminiSchema(EmailAnalysisSchema));

    expect(serialised).not.toContain('$schema');
    expect(serialised).not.toContain('additionalProperties');
  });

  it('converts a nullable union into Gemini’s nullable flag', () => {
    const schema = toGeminiSchema(z.object({ maybe: z.string().nullable() })) as {
      properties: { maybe: Record<string, unknown> };
    };

    expect(schema.properties.maybe).toMatchObject({ type: 'string', nullable: true });
    expect(schema.properties.maybe['anyOf']).toBeUndefined();
  });

  it('keeps enums, descriptions, and required lists', () => {
    const schema = toGeminiSchema(EmailAnalysisSchema) as {
      properties: { category: { enum?: string[]; description?: string } };
      required?: string[];
    };

    expect(schema.properties.category.enum).toContain('FINANCE');
    expect(schema.properties.category.description).toBeTruthy();
    expect(schema.required).toContain('summary');
  });

  it('preserves nested array item schemas', () => {
    const schema = toGeminiSchema(EmailAnalysisSchema) as {
      properties: {
        actionItems: { type: string; items: { properties: Record<string, unknown> } };
      };
    };

    expect(schema.properties.actionItems.type).toBe('array');
    expect(schema.properties.actionItems.items.properties).toHaveProperty(
      'description',
    );
  });
});

describe('request shape', () => {
  it('sends the key as a header, never in the URL', async () => {
    const { fetchFn, calls } = fakeFetch({ status: 200, body: successBody });
    const provider = createGeminiProvider({ apiKey: 'secret-key', fetchFn });

    await provider.generateStructured(request);

    // A key in the query string ends up in proxy logs and in error messages.
    expect(calls[0]?.url).not.toContain('secret-key');
    expect((calls[0]?.init.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'secret-key',
    );
  });

  it('asks Gemini to enforce the schema', async () => {
    const { fetchFn, calls } = fakeFetch({ status: 200, body: successBody });
    const provider = createGeminiProvider({ apiKey: 'k', fetchFn });

    await provider.generateStructured(request);

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      generationConfig: { responseMimeType: string; responseSchema: unknown };
    };
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toBeTruthy();
  });

  it('keeps the instruction separate from the untrusted email content', async () => {
    const { fetchFn, calls } = fakeFetch({ status: 200, body: successBody });
    const provider = createGeminiProvider({ apiKey: 'k', fetchFn });

    await provider.generateStructured(request);

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(body.systemInstruction.parts[0]?.text).toContain('triage analyst');
    expect(body.contents[0]?.parts[0]?.text).toBe('Analyse this.');
  });

  it('appends the validation errors when correcting', async () => {
    const { fetchFn, calls } = fakeFetch({ status: 200, body: successBody });
    const provider = createGeminiProvider({ apiKey: 'k', fetchFn });

    await provider.generateStructured({
      ...request,
      correction: {
        previousOutput: '{"bad":1}',
        validationErrors: '- category: required',
        attempt: 1,
      },
    });

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(body.contents[0]?.parts[0]?.text).toContain('- category: required');
  });

  it('returns the text and usage', async () => {
    const { fetchFn } = fakeFetch({ status: 200, body: successBody });
    const provider = createGeminiProvider({ apiKey: 'k', fetchFn });

    const result = await provider.generateStructured(request);

    expect(result.text).toBe('{"ok":true}');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
    expect(result.model).toBe('gemini-2.0-flash-001');
  });
});

describe('error mapping', () => {
  it('maps 429 to a retryable rate limit — including a zero-quota project', async () => {
    // A project with no allocated quota returns the same status as one being throttled.
    // Both are retryable from the pipeline's point of view: the email is fine.
    const { fetchFn } = fakeFetch({
      status: 429,
      body: {
        error: {
          code: 429,
          message:
            'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0',
        },
      },
    });
    const provider = createGeminiProvider({ apiKey: 'k', fetchFn });

    await expect(provider.generateStructured(request)).rejects.toThrow(
      AiRateLimitError,
    );
    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('maps 401 and 403 to an auth error, which stops the batch', async () => {
    for (const status of [401, 403]) {
      const { fetchFn } = fakeFetch({
        status,
        body: { error: { message: 'API key not valid' } },
      });
      const provider = createGeminiProvider({ apiKey: 'k', fetchFn });

      await expect(provider.generateStructured(request)).rejects.toThrow(AiAuthError);
    }
  });

  it('maps 400 to an unretryable invalid request', async () => {
    const { fetchFn } = fakeFetch({
      status: 400,
      body: { error: { message: 'Invalid JSON payload' } },
    });
    const provider = createGeminiProvider({ apiKey: 'k', fetchFn });

    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('maps 5xx to a retryable transient failure', async () => {
    const { fetchFn } = fakeFetch({
      status: 503,
      body: { error: { message: 'overloaded' } },
    });
    const provider = createGeminiProvider({ apiKey: 'k', fetchFn });

    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('treats a safety stop as a refusal, not a malformed response', async () => {
    const { fetchFn } = fakeFetch({
      status: 200,
      body: { candidates: [{ finishReason: 'SAFETY' }] },
    });
    const provider = createGeminiProvider({ apiKey: 'k', fetchFn });

    await expect(provider.generateStructured(request)).rejects.toThrow(AiRefusalError);
  });

  it('reports a truncated response clearly rather than as a JSON syntax error', async () => {
    const { fetchFn } = fakeFetch({
      status: 200,
      body: {
        candidates: [
          { finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"a"' }] } },
        ],
      },
    });
    const provider = createGeminiProvider({ apiKey: 'k', fetchFn });

    await expect(provider.generateStructured(request)).rejects.toThrow(
      AiInvalidRequestError,
    );
  });

  it('converts a transport failure into a retryable error', async () => {
    const fetchFn = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const provider = createGeminiProvider({ apiKey: 'k', fetchFn });

    await expect(provider.generateStructured(request)).rejects.toThrow(
      AiTransientError,
    );
  });

  it('fails clearly when no key is configured', async () => {
    const { fetchFn } = fakeFetch({ status: 200, body: successBody });
    const provider = createGeminiProvider({ apiKey: '', fetchFn });

    await expect(provider.generateStructured(request)).rejects.toThrow(AiAuthError);
  });

  it('never leaks the API key into an error message', async () => {
    const { fetchFn } = fakeFetch({
      status: 403,
      body: { error: { message: 'API key not valid. Pass a valid API key.' } },
    });
    const provider = createGeminiProvider({ apiKey: 'super-secret-key', fetchFn });

    await expect(provider.generateStructured(request)).rejects.toSatisfy(
      (error: Error) => !error.message.includes('super-secret-key'),
    );
  });
});
