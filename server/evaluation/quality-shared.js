export const defaultHistoryLimit = 10;

const statusRank = {
  unknown: 0,
  ok: 1,
  pass: 1,
  warn: 2,
  fail: 3,
};

export const toPercent = (value) =>
  typeof value === "number" ? Number((value * 100).toFixed(1)) : null;

export const getWorstStatus = (statuses = []) =>
  statuses.reduce((worstStatus, status) => {
    const normalizedStatus = status ?? "unknown";

    return (statusRank[normalizedStatus] ?? 0) > (statusRank[worstStatus] ?? 0)
      ? normalizedStatus
      : worstStatus;
  }, "unknown");

export const getCorpusName = (corpusPath) => {
  if (!corpusPath) {
    return null;
  }

  return String(corpusPath).split(/[\\/]/).pop() ?? corpusPath;
};

export const getRunCorpusName = (run = {}) =>
  run.corpus?.name ?? getCorpusName(run.corpus?.path) ?? null;

export const toTimestamp = (createdAt) => {
  const parsed = Date.parse(createdAt ?? "");

  return Number.isFinite(parsed) ? parsed : 0;
};

export const isRecord = (value) => value && typeof value === "object";

export const toNonNegativeInteger = (value, fallbackValue = 0) => {
  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) && parsedValue >= 0
    ? Math.floor(parsedValue)
    : fallbackValue;
};

export const incrementMapCount = (target, key) => {
  target[key] = (target[key] ?? 0) + 1;
};
