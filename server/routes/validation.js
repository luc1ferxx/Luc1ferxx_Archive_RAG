import { z } from "zod";

export const requiredTrimmedString = (message) =>
  z.string({ error: message }).trim().min(1, { error: message });

// Limits come from rag/config.js getters, passed as functions and read when a
// request is checked, so a schema built once at import still follows the
// environment (tests change it between requests).
const readLimit = (limit) => (typeof limit === "function" ? limit() : limit);

// requiredTrimmedString, and at most `maxLength` characters (UTF-16 code
// units) after trimming.
export const boundedRequiredTrimmedString = (message, { field, maxLength }) =>
  requiredTrimmedString(message).superRefine((value, context) => {
    const maximum = readLimit(maxLength);

    if (value.length > maximum) {
      context.addIssue({
        code: "custom",
        message: `${field} must be at most ${maximum} characters.`,
      });
    }
  });

// An optional string (absent or null passes) of at most `maxLength`
// characters after trimming.
export const optionalBoundedString = (field, { maxLength }) =>
  z
    .string({ error: `${field} must be a string.` })
    .trim()
    .superRefine((value, context) => {
      const maximum = readLimit(maxLength);

      if (value.length > maximum) {
        context.addIssue({
          code: "custom",
          message: `${field} must be at most ${maximum} characters.`,
        });
      }
    })
    .nullish();

// A list of ids in either form the routes read (helpers.js parseDocIds): a
// comma-separated string, which the frontend and GET query strings send, or
// an array of strings. Absent or null passes. The count is over the non-empty
// entries before duplicates are dropped, and every entry, trimmed, must be at
// most `maxLength` characters. Any other shape (a number, an object, an array
// holding a non-string) is refused rather than ignored.
export const boundedIdList = (field, { maxCount, maxLength }) =>
  z
    .union([z.string(), z.array(z.string())], {
      error: `${field} must be a comma-separated string or a list of strings.`,
    })
    .nullish()
    .superRefine((value, context) => {
      if (value == null) {
        return;
      }

      const ids = (Array.isArray(value) ? value : value.split(","))
        .map((id) => id.trim())
        .filter(Boolean);
      const maximumCount = readLimit(maxCount);
      const maximumLength = readLimit(maxLength);

      // A count limit of 0 means no limit (CHAT_MAX_DOC_IDS=0, or its default
      // in a process that retrieves itself).
      if (maximumCount > 0 && ids.length > maximumCount) {
        context.addIssue({
          code: "custom",
          message: `Too many ${field}: the limit is ${maximumCount}.`,
        });
        return;
      }

      if (ids.some((id) => id.length > maximumLength)) {
        context.addIssue({
          code: "custom",
          message: `Each entry of ${field} must be at most ${maximumLength} characters.`,
        });
      }
    });

// Nesting deeper than this is refused before anything serializes or walks the
// value recursively (a deep enough JSON body overflows the stack there).
export const MAX_PAYLOAD_DEPTH = 32;

// The nesting depth of a parsed JSON value (a scalar is 0), walked without
// recursion and abandoned as soon as it passes `limit`.
const exceedsDepth = (value, limit) => {
  const pending = [[value, 0]];

  while (pending.length > 0) {
    const [current, depth] = pending.pop();

    if (current === null || typeof current !== "object") {
      continue;
    }

    if (depth + 1 > limit) {
      return true;
    }

    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      pending.push([child, depth + 1]);
    }
  }

  return false;
};

/** The UTF-8 size of `value` serialized as JSON (0 for undefined). */
export const measureJsonBytes = (value) => {
  const text = JSON.stringify(value);

  return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
};

/**
 * Adds an issue to `context` when `value` (a parsed JSON value) is nested
 * deeper than MAX_PAYLOAD_DEPTH or serializes to more than `maxBytes` bytes
 * (0 = no size limit). Returns whether it passed.
 */
export const checkJsonPayloadBounds = (value, context, { field, maxBytes }) => {
  if (exceedsDepth(value, MAX_PAYLOAD_DEPTH)) {
    context.addIssue({ code: "custom", message: `${field} is nested more than ${MAX_PAYLOAD_DEPTH} levels deep.` });
    return false;
  }

  const maximum = readLimit(maxBytes);

  if (maximum > 0 && measureJsonBytes(value) > maximum) {
    context.addIssue({ code: "custom", message: `${field} must be at most ${maximum} bytes as JSON.` });
    return false;
  }

  return true;
};

// Any JSON value (absent passes) within checkJsonPayloadBounds.
export const boundedJsonPayload = (field, { maxBytes }) =>
  z.unknown().superRefine((value, context) => {
    checkJsonPayloadBounds(value, context, { field, maxBytes });
  });

// An optional id that may arrive as a string or a number (an idempotency key,
// which the routes turn into a string): at most `maxLength` characters once
// stringified and trimmed. Any other type is refused.
export const optionalBoundedKey = (field, { maxLength }) =>
  z
    .union([z.string(), z.number()], { error: `${field} must be a string.` })
    .nullish()
    .superRefine((value, context) => {
      const maximum = readLimit(maxLength);

      if (value != null && String(value).trim().length > maximum) {
        context.addIssue({ code: "custom", message: `${field} must be at most ${maximum} characters.` });
      }
    });

export const parseOrRespond = (schema, data, res) => {
  const result = schema.safeParse(data);

  if (!result.success) {
    res.status(400).json({ error: result.error.issues[0].message });
    return null;
  }

  return result.data;
};
