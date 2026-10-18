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

export const parseOrRespond = (schema, data, res) => {
  const result = schema.safeParse(data);

  if (!result.success) {
    res.status(400).json({ error: result.error.issues[0].message });
    return null;
  }

  return result.data;
};
