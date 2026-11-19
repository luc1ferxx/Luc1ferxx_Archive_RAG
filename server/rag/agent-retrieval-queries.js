import { normalizeWhitespace } from "./text-utils.js";

// The retrieval queries the agent query planner builds around a question, by
// intent and phase. Text only, so chat() (rag/index.js) can rebuild a plan's
// queries around the question session memory resolved without importing the
// planner and, through it, the skills registry.

const toQuery = (value = "") => normalizeWhitespace(value).replace(/\s+/g, " ").trim();

const dedupeQueries = (queries = []) => {
  const seen = new Set();
  const deduped = [];

  for (const query of queries) {
    const normalized = toQuery(query.query);
    const key = normalized.toLowerCase();

    if (!normalized || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      ...query,
      query: normalized,
    });
  }

  return deduped;
};

const buildIntentQueries = ({ question, intent, phase, focus }) => {
  const originalQuery = toQuery(question);
  const baseQueries = [
    {
      id: "primary",
      label: "Original request",
      query: originalQuery,
      primary: true,
    },
  ];

  if (phase === "retry" || phase === "follow_up") {
    const issueText = [
      ...(focus?.reasons ?? []),
      ...(focus?.unsupportedClaims ?? []).map((claim) => `Unsupported claim: ${claim}`),
    ].join(" ");

    return [
      ...baseQueries,
      {
        id: "follow-up-evidence",
        label: "Follow-up evidence repair",
        query: toQuery(`Find citation-backed evidence that fixes this issue: ${issueText || originalQuery}`),
        primary: false,
      },
      {
        id: "follow-up-source-check",
        label: "Follow-up source support",
        query: toQuery(`Find source excerpts that directly support the final answer for: ${focus?.originalQuestion ?? originalQuery}`),
        primary: false,
      },
    ];
  }

  if (intent === "timeline") {
    return [
      ...baseQueries,
      {
        id: "timeline-dates",
        label: "Dates and milestones",
        query: `Find dates, deadlines, effective periods, milestones, and event ordering for: ${originalQuery}`,
        primary: false,
      },
      {
        id: "timeline-gaps",
        label: "Chronology gaps",
        query: `Find missing, unspecified, or uncertain dates related to: ${originalQuery}`,
        primary: false,
      },
    ];
  }

  if (intent === "comparison") {
    return [
      ...baseQueries,
      {
        id: "compare-differences",
        label: "Cross-document differences",
        query: `Compare differences, similarities, conflicts, and exceptions across selected documents for: ${originalQuery}`,
        primary: false,
      },
      {
        id: "per-document-evidence",
        label: "Per-document evidence",
        query: `Find per-document cited evidence for each side of: ${originalQuery}`,
        primary: false,
      },
    ];
  }

  if (intent === "analysis") {
    return [
      ...baseQueries,
      {
        id: "analysis-findings",
        label: "Key findings",
        query: `Find key findings, obligations, risks, gaps, exceptions, and uncertainties for: ${originalQuery}`,
        primary: false,
      },
      {
        id: "analysis-support",
        label: "Supporting evidence",
        query: `Find source excerpts that support or qualify the analysis for: ${originalQuery}`,
        primary: false,
      },
    ];
  }

  return [
    ...baseQueries,
    {
      id: "fact-citation",
      label: "Exact citation evidence",
      query: `Find exact cited evidence for: ${originalQuery}`,
      primary: false,
    },
  ];
};

export const buildAgentRetrievalQueries = ({ question, intent, phase, focus }) =>
  dedupeQueries(buildIntentQueries({ question, intent, phase, focus }));
