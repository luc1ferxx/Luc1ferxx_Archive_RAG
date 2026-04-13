const COMPARISON_PATTERNS = [
  "compare",
  "difference",
  "different",
  "versus",
  "vs",
  "same",
  "similar",
  "conflict",
  "contradict",
  "contrast",
  "which document",
  "which file",
  "\u533a\u522b",
  "\u5dee\u5f02",
  "\u4e0d\u540c",
  "\u5bf9\u6bd4",
  "\u51b2\u7a81",
  "\u4e00\u81f4",
  "\u76f8\u540c",
  "\u54ea\u4e2a\u6587\u6863",
  "\u54ea\u4efd\u6587\u6863",
];

export const routeQuery = ({ query, docIds }) => {
  const normalizedQuery = query.toLowerCase();
  const matchedSignals = COMPARISON_PATTERNS.filter((pattern) =>
    normalizedQuery.includes(pattern)
  );

  return {
    mode: docIds.length > 1 && matchedSignals.length > 0 ? "compare" : "qa",
    signals: matchedSignals,
  };
};
