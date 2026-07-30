/**
 * Locating the JSON object in a model response.
 *
 * With structured outputs the response is already bare JSON, so the fast path is a plain
 * parse. This module exists for everything else: providers without native JSON
 * enforcement, and the occasional response that arrives wrapped in a fence or a sentence
 * of preamble. Recovering from that is cheap and saves a corrective round trip.
 *
 * Note what this deliberately does *not* do: it never repairs malformed JSON. A response
 * that is not valid JSON is a failure to be reported, not something to guess at.
 */

export interface JsonExtraction {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

export function extractJson(text: string): JsonExtraction {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: 'Response was empty' };
  }

  const candidates = [trimmed, stripCodeFence(trimmed), sliceOutermostObject(trimmed)];

  for (const candidate of candidates) {
    if (candidate === null || candidate.length === 0) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      // Try the next candidate.
    }
  }

  return { ok: false, error: 'Response did not contain parseable JSON' };
}

/** Removes a ```json … ``` wrapper. */
function stripCodeFence(text: string): string | null {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(text);
  return match?.[1]?.trim() ?? null;
}

/**
 * Extracts the outermost balanced `{ … }`, ignoring braces inside strings.
 *
 * Tracking string state matters: a summary containing a `}` would otherwise truncate the
 * candidate at the wrong place and turn a recoverable response into a failure.
 */
function sliceOutermostObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}
