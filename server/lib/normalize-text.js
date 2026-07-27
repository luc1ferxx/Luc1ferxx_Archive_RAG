export const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
export const normalizeTrimmedText = (value) => String(value ?? "").trim();
export const normalizeClampedText = (value, maxLength) => normalizeText(value).slice(0, maxLength);
