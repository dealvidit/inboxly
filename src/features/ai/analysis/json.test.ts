import { describe, expect, it } from 'vitest';
import { extractJson } from './json';

describe('extractJson', () => {
  it('parses bare JSON, which is what structured outputs return', () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('tolerates surrounding whitespace', () => {
    expect(extractJson('\n\n  {"a":1}  \n').value).toEqual({ a: 1 });
  });

  it('unwraps a fenced code block', () => {
    expect(extractJson('```json\n{"a":1}\n```').value).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```').value).toEqual({ a: 1 });
  });

  it('recovers JSON wrapped in prose, saving a corrective round trip', () => {
    const result = extractJson('Here is the analysis:\n{"a":1}\nHope that helps!');
    expect(result.value).toEqual({ a: 1 });
  });

  it('handles braces inside strings without truncating', () => {
    // A naive lastIndexOf('}') would cut this in the wrong place.
    const payload = '{"summary":"Use the {placeholder} syntax","n":1}';
    expect(extractJson(`prose ${payload} more prose`).value).toEqual({
      summary: 'Use the {placeholder} syntax',
      n: 1,
    });
  });

  it('handles escaped quotes inside strings', () => {
    const payload = '{"summary":"They said \\"hello\\" to me"}';
    expect(extractJson(payload).value).toEqual({ summary: 'They said "hello" to me' });
  });

  it('handles nested objects', () => {
    const payload = '{"a":{"b":{"c":[1,2,{"d":3}]}}}';
    expect(extractJson(`text ${payload}`).value).toEqual({
      a: { b: { c: [1, 2, { d: 3 }] } },
    });
  });

  it('reports failure for an empty response', () => {
    expect(extractJson('')).toMatchObject({ ok: false });
    expect(extractJson('   \n  ')).toMatchObject({ ok: false });
  });

  it('reports failure for text containing no JSON', () => {
    expect(extractJson('I cannot help with that.')).toMatchObject({ ok: false });
  });

  it('reports failure rather than repairing malformed JSON', () => {
    // Deliberately does not guess at intent — a broken response is a failure to report.
    expect(extractJson('{"a": 1,}')).toMatchObject({ ok: false });
    expect(extractJson('{"a": }')).toMatchObject({ ok: false });
    expect(extractJson('{"unclosed": "value"')).toMatchObject({ ok: false });
  });
});
