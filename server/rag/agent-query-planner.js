import { normalizeWhitespace } from "./text-utils.js";
import { CUSTOM_SKILL_IDS } from "./skills/registry.js";

const COMPARISON_SIGNAL_PATTERN =
  /\b(compare|comparison|difference|differences|different|versus|vs|same|similar|conflict|conflicts|contrast|between|across)\b|区别|差异|不同|对比|比较|冲突|一致|相同/i;

const ANALYSIS_SIGNAL_PATTERN =
  /\b(analy[sz]e|analysis|risk|risks|gaps?|exceptions?|uncertaint(?:y|ies)|obligations?|findings?)\b|分析|风险|缺口|例外|不确定|义务|发现/i;

const INTENT_OPTIONS = {
  fact: {
    profile: "narrow",
    topK: 4,
    topKPerDoc: 2,
  },
  timeline: {
    profile: "timeline",
    topK: 9,
    topKPerDoc: 4,
  },
  comparison: {
    profile: "comparison",
    topK: 8,
    topKPerDoc: 4,
  },
  analysis: {
    profile: "broad",
    topK: 10,
    topKPerDoc: 4,
  },
};

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

export const classifyAgentQueryIntent = ({ question = "", plan = {}, docIds = [] } = {}) => {
  if (plan.wantsTimeline || plan.mode === CUSTOM_SKILL_IDS.extractTimeline) {
    return "timeline";
  }

  if (
    plan.wantsRiskReview ||
    plan.wantsResearch ||
    plan.mode === CUSTOM_SKILL_IDS.riskReview ||
    plan.mode === "research_brief" ||
    ANALYSIS_SIGNAL_PATTERN.test(question)
  ) {
    return "analysis";
  }

  if (docIds.length > 1 && COMPARISON_SIGNAL_PATTERN.test(question)) {
    return "comparison";
  }

  return "fact";
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

  if (phase === "retry") {
    const issueText = [
      ...(focus?.reasons ?? []),
      ...(focus?.unsupportedClaims ?? []).map((claim) => `Unsupported claim: ${claim}`),
    ].join(" ");

    return [
      ...baseQueries,
      {
        id: "retry-evidence",
        label: "Retry evidence repair",
        query: toQuery(`Find citation-backed evidence that fixes this issue: ${issueText || originalQuery}`),
        primary: false,
      },
      {
        id: "retry-source-check",
        label: "Retry source support",
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

export const buildAgentRetrievalPlan = ({
  question = "",
  plan = {},
  docIds = [],
  phase = "primary",
  focus = null,
} = {}) => {
  const intent = classifyAgentQueryIntent({
    question,
    plan,
    docIds,
  });
  const retrievalQueries = dedupeQueries(
    buildIntentQueries({
      question,
      intent,
      phase,
      focus,
    })
  );

  return {
    source: "agent-query-planner",
    phase,
    intent,
    retrievalQueries,
    retrievalOptions: {
      ...INTENT_OPTIONS[intent],
      queryCount: retrievalQueries.length,
    },
  };
};
