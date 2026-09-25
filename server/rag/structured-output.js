// JSON Schema response formats for model calls whose output the runtime parses.
//
// A planner's schema is built per request from the runtime-owned whitelist (the
// selected steps, the registered Skills, the request fields), so the model
// cannot decode an id the validator would reject. The schema narrows what the
// model can say; it never replaces the validator, which still accepts or rejects
// the parsed result whole, and which is the only check an endpoint that ignores
// response_format ever gets.
//
// Schemas follow the strict subset every structured-output backend accepts:
// every object lists all of its properties as required and sets
// additionalProperties to false, and an optional value is expressed as a union
// with null. Callers treat null as "absent".
//
// Every free-text string and every array is bounded. Constrained decoding keeps a
// small model inside the grammar but not inside a sensible length: an unbounded
// rationale ran to thousands of tokens against a local 7B model and turned a
// 12-second planner eval into minutes. Length is bounded with `pattern` rather
// than `maxLength` because strict mode documents pattern, not maxLength, and
// the bound matches what the runtime keeps after clamping anyway.

export const boundedString = (maxLength) => ({
  pattern: `^.{0,${maxLength}}$`,
  type: "string",
});

export const identifierString = (maxLength) => ({
  pattern: `^[A-Za-z0-9_.:-]{1,${maxLength}}$`,
  type: "string",
});

export const boundedArray = (items, maxItems) => ({
  items,
  maxItems,
  type: "array",
});

export const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });

export const oneOfSchemas = (schemas = []) =>
  schemas.length === 1 ? schemas[0] : { anyOf: schemas };

export const strictObject = (properties = {}) => ({
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
  type: "object",
});

export const stringEnum = (values = []) => ({
  enum: [...new Set(values)],
  type: "string",
});

/**
 * The first complete JSON object or array in `text`, or null.
 *
 * Constrained decoding is not a hard guarantee on every server: against Ollama
 * with qwen2.5:7b the schema held until the value closed, then the model kept
 * writing prose after it. Taking the first balanced value keeps that answer
 * instead of discarding it; the planner's validator still judges its content.
 */
export const extractFirstJsonValue = (text) => {
  const source = String(text ?? "");
  const start = source.search(/[{[]/);

  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return null;
};

// The parsed first value, or undefined when there is none to parse.
export const parseFirstJsonValue = (text) => {
  const value = extractFirstJsonValue(text);

  if (value === null) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

export const buildJsonSchemaResponseFormat = ({ name, schema }) => ({
  json_schema: {
    name,
    schema,
    strict: true,
  },
  type: "json_schema",
});
