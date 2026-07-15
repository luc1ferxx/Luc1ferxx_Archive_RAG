const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const isRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

const toArray = (value) => (Array.isArray(value) ? value : []);

export const buildTextCitationStepOutput = (result = {}, extra = {}) => {
  if (result.status === "failed" || result.ok === false) {
    return null;
  }

  const value = isRecord(result.value) ? result.value : result;
  const citations = toArray(result.citations ?? value.citations);
  const text = normalizeText(result.text ?? value.text);
  const resolvedQuery = normalizeText(result.resolvedQuery ?? value.resolvedQuery);

  return {
    ...extra,
    abstained: Boolean(result.abstained ?? value.abstained),
    citationCount: citations.length,
    ...(resolvedQuery ? { resolvedQuery } : {}),
    text,
  };
};

export const buildStepError = (result = {}, fallbackMessage = "Step failed.") => {
  if (result.status !== "failed" && result.ok !== false) {
    return null;
  }

  const error = result.error;
  const message = error instanceof Error
    ? error.message
    : normalizeText(error) || fallbackMessage;

  return {
    ...(normalizeText(error?.code)
      ? { code: normalizeText(error.code) }
      : {}),
    message,
    name: error?.name ?? "Error",
  };
};
