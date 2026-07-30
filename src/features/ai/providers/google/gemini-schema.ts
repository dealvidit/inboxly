import { z, type ZodType } from 'zod';

/**
 * Zod → Gemini `responseSchema`.
 *
 * Gemini's structured-output schema is a **subset of OpenAPI 3.0**, not JSON Schema, and
 * it rejects a request outright if it sees a keyword it does not know. Three differences
 * matter, and each is handled below:
 *
 *   1. `$schema` and `additionalProperties` are not recognised.
 *   2. Nullability is a `nullable: true` flag, not the `anyOf: [T, {type: "null"}]`
 *      union that JSON Schema uses — and our domain has plenty of nullable fields.
 *   3. `$ref`/`$defs` are not supported, so every reused subschema must be inlined.
 *
 * Keeping this conversion here rather than in the provider keeps the provider readable
 * and lets the conversion be tested on its own, which matters: a silently wrong schema
 * would show up as a confusing 400 from Google rather than as an obvious bug.
 */

/** The keywords Gemini accepts. Anything else is dropped rather than passed through. */
const SUPPORTED_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minItems',
  'maxItems',
  'propertyOrdering',
]);

export function toGeminiSchema(schema: ZodType): Record<string, unknown> {
  // `reused: 'inline'` is what keeps $ref out of the output; without it a schema used
  // twice (our nested objects are) emits a $defs block Gemini cannot resolve.
  const jsonSchema = z.toJSONSchema(schema, { io: 'output', reused: 'inline' });
  return sanitize(jsonSchema) as Record<string, unknown>;
}

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (typeof node !== 'object' || node === null) return node;

  const source = node as Record<string, unknown>;

  // Collapse `anyOf: [T, {type: "null"}]` — JSON Schema's nullable — into Gemini's flag.
  const anyOf = source['anyOf'];
  if (Array.isArray(anyOf)) {
    const withoutNull = anyOf.filter((member) => !isNullType(member)) as Record<
      string,
      unknown
    >[];
    const nullable = withoutNull.length !== anyOf.length;

    if (withoutNull.length === 1 && withoutNull[0]) {
      const collapsed = sanitize(withoutNull[0]) as Record<string, unknown>;
      return nullable ? { ...collapsed, nullable: true } : collapsed;
    }

    // A genuine multi-member union. Gemini has no `anyOf`, so the best available
    // approximation is an untyped value; a union in the analysis schema would be worth
    // reconsidering rather than papering over here.
    return nullable ? { type: 'string', nullable: true } : { type: 'string' };
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!SUPPORTED_KEYS.has(key)) continue;

    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        properties[name] = sanitize(child);
      }
      result['properties'] = properties;
      continue;
    }

    result[key] = sanitize(value);
  }

  return result;
}

function isNullType(member: unknown): boolean {
  return (
    typeof member === 'object' &&
    member !== null &&
    (member as { type?: unknown }).type === 'null'
  );
}
