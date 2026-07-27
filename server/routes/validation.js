import { z } from "zod";

export const requiredTrimmedString = (message) =>
  z.string({ error: message }).trim().min(1, { error: message });

export const parseOrRespond = (schema, data, res) => {
  const result = schema.safeParse(data);

  if (!result.success) {
    res.status(400).json({ error: result.error.issues[0].message });
    return null;
  }

  return result.data;
};
