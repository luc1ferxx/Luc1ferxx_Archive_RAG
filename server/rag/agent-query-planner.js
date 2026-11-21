import { buildAgentRetrievalQueries } from "./agent-retrieval-queries.js";
import { CUSTOM_SKILL_IDS } from "./skills/registry.js";

// The compar-, differ-, similar-, contrast- and conflict- words in their
// inflections ("differs", "compared", "similarities"), but not "compartment"
// or the technical terms "differential" and "contrastive".
const COMPARISON_SIGNAL_PATTERN =
  /\b(compar(?:e[ds]?|ing|isons?|ative|able)|differ(?:s|ed|ing|ences?|ent(?:ly)?)?|similar(?:ly|ity|ities)?|contrast(?:s|ed|ing)?|conflict(?:s|ed|ing)?|versus|vs|same|between|across)\b|区别|差别|差异|不同|异同|对比|比较|相比|相较|冲突|一致|相同|相似|类似|共同点/i;

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

export const classifyAgentQueryIntent = ({ question = "", plan = {}, docIds = [] } = {}) => {
  if (plan.wantsTimeline || plan.mode === CUSTOM_SKILL_IDS.extractTimeline) {
    return "timeline";
  }

  if (
    plan.wantsCompareDocuments ||
    plan.mode === CUSTOM_SKILL_IDS.compareDocuments ||
    (docIds.length > 1 && COMPARISON_SIGNAL_PATTERN.test(question))
  ) {
    return "comparison";
  }

  if (
    plan.wantsRiskReview ||
    plan.wantsContractSummary ||
    plan.wantsResearch ||
    plan.mode === CUSTOM_SKILL_IDS.riskReview ||
    plan.mode === CUSTOM_SKILL_IDS.summarizeContract ||
    plan.mode === "research_brief" ||
    ANALYSIS_SIGNAL_PATTERN.test(question)
  ) {
    return "analysis";
  }

  return "fact";
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
  const retrievalQueries = buildAgentRetrievalQueries({
    question,
    intent,
    phase,
    focus,
  });

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
