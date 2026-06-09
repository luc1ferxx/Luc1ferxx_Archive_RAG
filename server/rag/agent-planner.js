import { CUSTOM_SKILL_IDS } from "./skills/registry.js";

export const SKILL_CHAIN_MODE = "skill_chain";

const MAX_CLARIFICATION_DOCUMENTS = 12;

const WEB_SIGNAL_PATTERN =
  /\b(latest|current|currently|today|now|recent|news|live|online|internet|web|search the web|real[-\s]?time)\b|最新|当前|现在|今天|近日|实时|联网|网页|网络|新闻/i;

const INVENTORY_SIGNAL_PATTERN =
  /\b(what documents|which documents|list documents|show documents|workspace documents|uploaded documents|what files|which files|list files)\b|有哪些(?:文档|资料|文件)|列出.*(?:文档|资料|文件)|当前.*(?:文档|资料|文件)|上传.*(?:文档|资料|文件)/i;

const DISCOVERY_SIGNAL_PATTERN =
  /\b(which document|which file|what document|what file|find document|find file|document covers|file covers|covers .*document|about)\b|哪份(?:文档|资料|文件)|哪个(?:文档|资料|文件)|(?:文档|资料|文件).*?(讲|包含|关于|提到)/i;

const RESEARCH_SIGNAL_PATTERN =
  /\b(research|brief|report|analy[sz]e|analysis|investigate|study|risk|risks|key findings|executive summary)\b|研究|简报|报告|分析|调研|风险|结论|发现|梳理/i;

const TIMELINE_SIGNAL_PATTERN =
  /\b(timeline|chronology|chronological|sequence|milestones?|key dates?|event order|date order)\b|时间线|时间顺序|按时间|大事记|里程碑|事件顺序|关键日期/i;

const RISK_REVIEW_SIGNAL_PATTERN =
  /\b(risk review|review risks?|risk analysis|gaps?|exceptions?|conflicts?|contradictions?|uncertaint(?:y|ies)|red flags?|missing terms?)\b|风险审查|风险|缺口|例外|冲突|矛盾|不确定|遗漏/i;

const CONTRACT_SUMMARY_SIGNAL_PATTERN =
  /\b(summarize|summary|summarise|contract summary|agreement summary|key terms?|parties|obligations?|deadlines?|effective date|renewal|termination)\b.*\b(contract|agreement|policy|terms|msa|sow|nda)\b|\b(contract|agreement|msa|sow|nda)\b.*\b(summarize|summary|summarise|key terms?|parties|obligations?|deadlines?|renewal|termination)\b|合同摘要|协议摘要|合同总结|关键条款|合同义务|协议义务|合同期限|续约|终止/i;

const COMPARE_DOCUMENTS_SIGNAL_PATTERN =
  /\b(compare|comparison|differences?|different|versus|vs|same|similar|contrast|common ground|missing terms?|across|between)\b|对比|比较|差异|不同|相同|一致|共同点|缺失条款|遗漏条款|之间/i;

const CONTRACT_REVIEW_CHAIN_SIGNAL_PATTERN =
  /\b(review|audit|assess|analy[sz]e)\b.*\b(contract|agreement|msa|sow|nda)\b|\b(contract|agreement|msa|sow|nda)\b.*\b(review|audit|assess|analy[sz]e)\b|审查.*(?:合同|协议)|审核.*(?:合同|协议)|(?:合同|协议).*审查|(?:合同|协议).*审核/i;

const RISK_CHAIN_SIGNAL_PATTERN =
  /\brisks?\b|风险|risk review|risk analysis/i;

const PROJECT_CHANGE_CHAIN_SIGNAL_PATTERN =
  /\b(project changes?|change log|change history|changes across|evolution|what changed|changed across)\b|项目变化|项目变更|整理.*(?:变化|变更)|(?:变化|变更).*整理/i;

const normalizeText = (value) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : "";

export const buildPlan = ({ question, docIds }) => {
  const wantsResearch = RESEARCH_SIGNAL_PATTERN.test(question);
  const wantsInventory = INVENTORY_SIGNAL_PATTERN.test(question);
  const wantsDiscovery = DISCOVERY_SIGNAL_PATTERN.test(question);
  const wantsWeb = WEB_SIGNAL_PATTERN.test(question);
  const wantsTimeline = TIMELINE_SIGNAL_PATTERN.test(question);
  const wantsRiskReview = RISK_REVIEW_SIGNAL_PATTERN.test(question);
  const wantsContractSummary = CONTRACT_SUMMARY_SIGNAL_PATTERN.test(question);
  const wantsCompareDocuments = COMPARE_DOCUMENTS_SIGNAL_PATTERN.test(question);
  const wantsContractReviewChain =
    (wantsRiskReview && wantsContractSummary) ||
    CONTRACT_REVIEW_CHAIN_SIGNAL_PATTERN.test(question);
  const wantsRiskComparisonChain =
    wantsCompareDocuments && RISK_CHAIN_SIGNAL_PATTERN.test(question);
  const wantsProjectChangeChain = PROJECT_CHANGE_CHAIN_SIGNAL_PATTERN.test(question);
  const hasDocuments = docIds.length > 0;

  if (wantsRiskComparisonChain) {
    return {
      mode: SKILL_CHAIN_MODE,
      skillChain: [CUSTOM_SKILL_IDS.compareDocuments, CUSTOM_SKILL_IDS.riskReview],
      wantsTimeline: false,
      wantsRiskReview: true,
      wantsContractSummary: false,
      wantsCompareDocuments: true,
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: false,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: true,
      summary: "Compare selected documents, then review the comparison for cited risks and gaps.",
    };
  }

  if (wantsContractReviewChain) {
    return {
      mode: SKILL_CHAIN_MODE,
      skillChain: [CUSTOM_SKILL_IDS.summarizeContract, CUSTOM_SKILL_IDS.riskReview],
      wantsTimeline: false,
      wantsRiskReview: true,
      wantsContractSummary: true,
      wantsCompareDocuments: false,
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: false,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: true,
      summary: "Summarize selected contract documents, then review them for cited risks and gaps.",
    };
  }

  if (wantsProjectChangeChain) {
    return {
      mode: SKILL_CHAIN_MODE,
      skillChain: [CUSTOM_SKILL_IDS.extractTimeline, CUSTOM_SKILL_IDS.compareDocuments],
      wantsTimeline: true,
      wantsRiskReview: false,
      wantsContractSummary: false,
      wantsCompareDocuments: true,
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: false,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: true,
      summary: "Extract a cited timeline, then compare selected documents for project changes.",
    };
  }

  if (wantsTimeline) {
    return {
      mode: CUSTOM_SKILL_IDS.extractTimeline,
      wantsTimeline: true,
      wantsRiskReview: false,
      wantsContractSummary: false,
      wantsCompareDocuments: false,
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: false,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: true,
      summary: "Extract a cited chronological timeline from selected documents.",
    };
  }

  if (wantsCompareDocuments) {
    return {
      mode: CUSTOM_SKILL_IDS.compareDocuments,
      wantsTimeline: false,
      wantsRiskReview: false,
      wantsContractSummary: false,
      wantsCompareDocuments: true,
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: false,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: true,
      summary: "Compare selected documents for cited common ground, differences, conflicts, and missing terms.",
    };
  }

  if (wantsRiskReview) {
    return {
      mode: CUSTOM_SKILL_IDS.riskReview,
      wantsTimeline: false,
      wantsRiskReview: true,
      wantsContractSummary: false,
      wantsCompareDocuments: false,
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: false,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: true,
      summary: "Review selected documents for cited risks, gaps, conflicts, and exceptions.",
    };
  }

  if (wantsContractSummary) {
    return {
      mode: CUSTOM_SKILL_IDS.summarizeContract,
      wantsTimeline: false,
      wantsRiskReview: false,
      wantsContractSummary: true,
      wantsCompareDocuments: false,
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: false,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: true,
      summary: "Summarize selected contract documents with cited key terms and obligations.",
    };
  }

  if (wantsResearch) {
    return {
      mode: "research_brief",
      wantsTimeline: false,
      wantsRiskReview: false,
      wantsContractSummary: false,
      wantsCompareDocuments: false,
      wantsResearch: true,
      wantsInventory: false,
      wantsDiscovery: false,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: true,
      summary: "Create a structured research brief from selected documents.",
    };
  }

  if (wantsInventory && !hasDocuments) {
    return {
      mode: "inventory",
      wantsTimeline: false,
      wantsRiskReview: false,
      wantsContractSummary: false,
      wantsCompareDocuments: false,
      wantsResearch: false,
      wantsInventory: true,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: false,
      summary: "List the indexed workspace documents.",
    };
  }

  if (wantsDiscovery && !hasDocuments) {
    return {
      mode: "document_discovery",
      wantsTimeline: false,
      wantsRiskReview: false,
      wantsContractSummary: false,
      wantsCompareDocuments: false,
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: true,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: false,
      summary: "Search workspace document profiles for likely matching files.",
    };
  }

  if (!hasDocuments && wantsWeb) {
    return {
      mode: "web",
      wantsTimeline: false,
      wantsRiskReview: false,
      wantsContractSummary: false,
      wantsCompareDocuments: false,
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: false,
      wantsDocumentRag: false,
      wantsWeb: true,
      requiresDocuments: false,
      summary: "Search the web because no document context is selected.",
    };
  }

  return {
    mode: wantsWeb ? "document_web" : "document",
    wantsTimeline: false,
    wantsRiskReview: false,
    wantsContractSummary: false,
    wantsCompareDocuments: false,
    wantsResearch: false,
    wantsInventory,
    wantsDiscovery: false,
    wantsDocumentRag: true,
    wantsWeb,
    requiresDocuments: true,
    summary: wantsWeb
      ? "Use selected documents first, then web search for current context."
      : "Use selected documents and synthesize a grounded answer.",
  };
};

export const buildPreExecutionClarification = ({ plan, docIds = [] } = {}) => {
  if (plan.wantsCompareDocuments && docIds.length < 2) {
    return {
      reason: "comparison_requires_multiple_documents",
      summary: "The comparison request needs at least two selected documents.",
      question:
        "Which two or more documents should I compare? Select the documents, then send the comparison request again.",
      detail: {
        selectedDocumentCount: docIds.length,
        requiredDocumentCount: 2,
      },
    };
  }

  if (plan.requiresDocuments && docIds.length === 0) {
    return {
      reason: "missing_required_documents",
      summary: "The request needs selected document context before the agent can answer.",
      question:
        "Which document should I use for this request? Select at least one document, then send the request again.",
      detail: {
        selectedDocumentCount: 0,
        requiredDocumentCount: 1,
      },
    };
  }

  if (plan.requiresDocuments && docIds.length > MAX_CLARIFICATION_DOCUMENTS) {
    return {
      reason: "too_many_documents",
      summary: "The request has too many selected documents to answer reliably without narrowing scope.",
      question: `You selected ${docIds.length} documents. Which ${MAX_CLARIFICATION_DOCUMENTS} or fewer should I focus on for this request?`,
      detail: {
        selectedDocumentCount: docIds.length,
        maxDocumentCount: MAX_CLARIFICATION_DOCUMENTS,
      },
    };
  }

  return null;
};

export const orderSelectedSkills = ({ selectedSkills = [], plan = {} } = {}) => {
  if (!Array.isArray(plan.skillChain) || plan.skillChain.length === 0) {
    return selectedSkills;
  }

  const byId = new Map(selectedSkills.map((skill) => [skill.id, skill]));
  const chainSkills = plan.skillChain
    .map((skillId) => byId.get(skillId))
    .filter(Boolean);
  const chainIds = new Set(chainSkills.map((skill) => skill.id));
  const remainingSkills = selectedSkills.filter((skill) => !chainIds.has(skill.id));

  return [...chainSkills, ...remainingSkills];
};

export const buildSkillChainSummary = ({ chainSkills = [] } = {}) =>
  `Chained ${chainSkills.length} skill${chainSkills.length === 1 ? "" : "s"}: ${
    chainSkills.map((skill) => skill.label).join(" -> ")
  }.`;

export const buildChainedSkillQuestion = ({
  question,
  previousResults = [],
} = {}) => {
  const usableResults = previousResults
    .filter((result) => result?.ok && normalizeText(result.text))
    .slice(-3);

  if (usableResults.length === 0) {
    return question;
  }

  return [
    "Continue the same agent task using previous skill outputs as context.",
    `Original request: ${normalizeText(question)}`,
    "Previous skill outputs:",
    ...usableResults.map((result) =>
      [
        `${result.label}:`,
        normalizeText(result.text),
      ].join("\n")
    ),
    "Use previous outputs to avoid repeating work, but verify every final claim against selected document citations.",
  ].join("\n\n");
};

export const buildPlannerActions = ({ plan, docIds, skills }) => {
  const actions = [
    {
      id: "classify_request",
      label: "Classify request",
      summary: plan.summary,
    },
  ];

  for (const skill of skills) {
    actions.push(...(skill.plannerActions?.({
      plan,
      docIds,
    }) ?? []));
  }

  actions.push({
    id: "synthesis",
    label: "Synthesize answer",
    summary: "Compose the final response from verified tool results.",
  });

  return actions;
};
