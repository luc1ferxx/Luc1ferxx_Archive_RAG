import { SKILL_CHAIN_MODE } from "./agent-planner.js";
import { CAPABILITY_IDS } from "./capabilities/shared.js";
import { CUSTOM_SKILL_IDS } from "./skills/registry.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const WEB_SIGNAL_PATTERN =
  /\b(latest|current|currently|today|now|recent|news|live|online|internet|web|search the web|real[-\s]?time)\b|最新|当前|现在|今天|近日|实时|联网|网页|网络|新闻/i;

const ARXIV_IMPORT_SIGNAL_PATTERN =
  /(?:\barxiv\b.*\b(fetch|download|import|ingest|collect|search)\b|\b(fetch|download|import|ingest|collect|search)\b.*\barxiv\b|\barxiv\b.*\b(papers?|pdfs?|preprints?)\b)|(?:arxiv|论文|预印本).*(?:抓取|下载|导入|收集|检索|搜索)|(?:抓取|下载|导入|收集|检索|搜索).*(?:arxiv|论文|预印本)/i;

const ACTION_SIGNAL_PATTERNS = [
  {
    capabilityId: CAPABILITY_IDS.taskCreate,
    pattern:
      /\b(create|add|generate|make)\b.*\b(task|todo|to-do|follow[-\s]?up)\b|\b(task|todo|to-do|follow[-\s]?up)\b.*\b(create|add|generate|make)\b|(?:创建|生成|新增|添加).*(?:任务|待办|事项)|(?:任务|待办|事项).*(?:创建|生成|新增|添加)/i,
  },
  {
    capabilityId: CAPABILITY_IDS.documentOrganize,
    pattern:
      /\b(organize|organise|arrange|group|folder|cluster)\b.*\b(documents?|files?|workspace)\b|\b(documents?|files?|workspace)\b.*\b(organize|organise|arrange|group|folder|cluster)\b|整理.*(?:文档|文件|资料)|(?:文档|文件|资料).*整理/i,
  },
  {
    capabilityId: CAPABILITY_IDS.summaryCreate,
    pattern:
      /\b(create|save|record|store)\b.*\b(summary|summaries)\b|\b(summary|summaries)\b.*\b(create|save|record|store)\b|(?:创建|保存|记录).*(?:摘要|总结)|(?:摘要|总结).*(?:创建|保存|记录)/i,
  },
  {
    capabilityId: CAPABILITY_IDS.externalImport,
    pattern:
      /\b(import|ingest|add)\b.*\b(external|url|source|link|web document)\b|\b(external|url|source|link|web document)\b.*\b(import|ingest|add)\b|导入.*(?:外部|链接|资料|来源)|(?:外部|链接|资料|来源).*导入/i,
  },
];

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

export const AGENT_INTENT_IDS = Object.freeze({
  arxivImport: "arxiv_import",
  workspaceAction: "workspace_action",
  compareRiskChain: "skill_chain_compare_risk",
  contractReviewChain: "skill_chain_contract_review",
  projectChangeChain: "skill_chain_project_change",
  extractTimeline: CUSTOM_SKILL_IDS.extractTimeline,
  compareDocuments: CUSTOM_SKILL_IDS.compareDocuments,
  riskReview: CUSTOM_SKILL_IDS.riskReview,
  summarizeContract: CUSTOM_SKILL_IDS.summarizeContract,
  researchBrief: "research_brief",
  inventory: "inventory",
  documentDiscovery: "document_discovery",
  web: "web",
  documentWeb: "document_web",
  document: "document",
});

const detectActionCapabilityId = (question) =>
  ACTION_SIGNAL_PATTERNS.find(({ pattern }) => pattern.test(question))
    ?.capabilityId ?? null;

export const detectPlanSignals = ({ question = "", docIds = [] } = {}) => {
  const wantsArxivImport = ARXIV_IMPORT_SIGNAL_PATTERN.test(question);
  const actionCapabilityId = detectActionCapabilityId(question);
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

  return {
    hasDocuments,
    actionCapabilityId,
    wantsAction: Boolean(actionCapabilityId),
    wantsArxivImport,
    wantsCompareDocuments,
    wantsContractReviewChain,
    wantsContractSummary,
    wantsDiscovery,
    wantsInventory,
    wantsProjectChangeChain,
    wantsResearch,
    wantsRiskComparisonChain,
    wantsRiskReview,
    wantsTimeline,
    wantsWeb,
  };
};

const createBasePlan = (overrides = {}) => ({
  mode: "document",
  wantsArxivImport: false,
  wantsAction: false,
  actionCapabilityId: null,
  wantsTimeline: false,
  wantsRiskReview: false,
  wantsContractSummary: false,
  wantsCompareDocuments: false,
  wantsResearch: false,
  wantsInventory: false,
  wantsDiscovery: false,
  wantsDocumentRag: false,
  wantsWeb: false,
  requiresDocuments: true,
  summary: "Use selected documents and synthesize a grounded answer.",
  ...overrides,
});

const buildIntentPlan = ({ intentId, signals = {} } = {}) => {
  if (intentId === AGENT_INTENT_IDS.arxivImport) {
    return createBasePlan({
      mode: "arxiv_import",
      wantsArxivImport: true,
      requiresDocuments: false,
      summary: "Search arXiv for the requested topic and ingest matching PDFs.",
    });
  }

  if (intentId === AGENT_INTENT_IDS.workspaceAction) {
    return createBasePlan({
      mode: "workspace_action",
      actionCapabilityId: signals.actionCapabilityId,
      wantsAction: true,
      requiresDocuments: false,
      summary: "Execute a scoped workspace action through the capability registry.",
    });
  }

  if (intentId === AGENT_INTENT_IDS.compareRiskChain) {
    return createBasePlan({
      mode: SKILL_CHAIN_MODE,
      skillChain: [CUSTOM_SKILL_IDS.compareDocuments, CUSTOM_SKILL_IDS.riskReview],
      wantsRiskReview: true,
      wantsCompareDocuments: true,
      summary: "Compare selected documents, then review the comparison for cited risks and gaps.",
    });
  }

  if (intentId === AGENT_INTENT_IDS.contractReviewChain) {
    return createBasePlan({
      mode: SKILL_CHAIN_MODE,
      skillChain: [CUSTOM_SKILL_IDS.summarizeContract, CUSTOM_SKILL_IDS.riskReview],
      wantsRiskReview: true,
      wantsContractSummary: true,
      summary: "Summarize selected contract documents, then review them for cited risks and gaps.",
    });
  }

  if (intentId === AGENT_INTENT_IDS.projectChangeChain) {
    return createBasePlan({
      mode: SKILL_CHAIN_MODE,
      skillChain: [CUSTOM_SKILL_IDS.extractTimeline, CUSTOM_SKILL_IDS.compareDocuments],
      wantsTimeline: true,
      wantsCompareDocuments: true,
      summary: "Extract a cited timeline, then compare selected documents for project changes.",
    });
  }

  if (intentId === AGENT_INTENT_IDS.extractTimeline) {
    return createBasePlan({
      mode: CUSTOM_SKILL_IDS.extractTimeline,
      wantsTimeline: true,
      summary: "Extract a cited chronological timeline from selected documents.",
    });
  }

  if (intentId === AGENT_INTENT_IDS.compareDocuments) {
    return createBasePlan({
      mode: CUSTOM_SKILL_IDS.compareDocuments,
      wantsCompareDocuments: true,
      summary: "Compare selected documents for cited common ground, differences, conflicts, and missing terms.",
    });
  }

  if (intentId === AGENT_INTENT_IDS.riskReview) {
    return createBasePlan({
      mode: CUSTOM_SKILL_IDS.riskReview,
      wantsRiskReview: true,
      summary: "Review selected documents for cited risks, gaps, conflicts, and exceptions.",
    });
  }

  if (intentId === AGENT_INTENT_IDS.summarizeContract) {
    return createBasePlan({
      mode: CUSTOM_SKILL_IDS.summarizeContract,
      wantsContractSummary: true,
      summary: "Summarize selected contract documents with cited key terms and obligations.",
    });
  }

  if (intentId === AGENT_INTENT_IDS.researchBrief) {
    return createBasePlan({
      mode: "research_brief",
      wantsResearch: true,
      summary: "Create a structured research brief from selected documents.",
    });
  }

  if (intentId === AGENT_INTENT_IDS.inventory) {
    return createBasePlan({
      mode: "inventory",
      wantsInventory: true,
      requiresDocuments: false,
      summary: "List the indexed workspace documents.",
    });
  }

  if (intentId === AGENT_INTENT_IDS.documentDiscovery) {
    return createBasePlan({
      mode: "document_discovery",
      wantsDiscovery: true,
      requiresDocuments: false,
      summary: "Search workspace document profiles for likely matching files.",
    });
  }

  if (intentId === AGENT_INTENT_IDS.web) {
    return createBasePlan({
      mode: "web",
      wantsWeb: true,
      requiresDocuments: false,
      summary: "Search the web because no document context is selected.",
    });
  }

  if (intentId === AGENT_INTENT_IDS.documentWeb) {
    return createBasePlan({
      mode: "document_web",
      wantsInventory: Boolean(signals.wantsInventory),
      wantsDocumentRag: true,
      wantsWeb: true,
      summary: "Use selected documents first, then web search for current context.",
    });
  }

  return createBasePlan({
    mode: "document",
    wantsInventory: Boolean(signals.wantsInventory),
    wantsDocumentRag: true,
  });
};

const createPlanCandidate = ({ id, plan, reason }) => ({
  id,
  plan,
  reason,
  summary: plan.summary,
});

export const buildIntentPlanCandidate = ({
  intentId,
  reason,
  signals = {},
} = {}) =>
  createPlanCandidate({
    id: intentId,
    plan: buildIntentPlan({
      intentId,
      signals,
    }),
    reason,
  });

export const buildIntentPlanCandidates = ({ question = "", docIds = [] } = {}) => {
  const signals = detectPlanSignals({
    question,
    docIds,
  });
  const candidates = [];
  const addCandidate = (id, reason) => {
    if (candidates.some((candidate) => candidate.id === id)) {
      return;
    }

    candidates.push(
      buildIntentPlanCandidate({
        intentId: id,
        reason,
        signals,
      })
    );
  };

  if (signals.wantsArxivImport) {
    addCandidate(AGENT_INTENT_IDS.arxivImport, "The request asks to import arXiv papers.");
  }

  const actionConflictsWithProjectChangeChain =
    signals.actionCapabilityId === CAPABILITY_IDS.documentOrganize &&
    signals.wantsProjectChangeChain;

  if (
    !signals.wantsArxivImport &&
    signals.wantsAction &&
    !actionConflictsWithProjectChangeChain
  ) {
    addCandidate(
      AGENT_INTENT_IDS.workspaceAction,
      "The request asks the agent to perform a workspace action."
    );
  }

  if (signals.wantsRiskComparisonChain) {
    addCandidate(
      AGENT_INTENT_IDS.compareRiskChain,
      "The request asks for comparison plus risk review."
    );
  }

  if (signals.wantsContractReviewChain) {
    addCandidate(
      AGENT_INTENT_IDS.contractReviewChain,
      "The request asks for contract review or audit."
    );
  }

  if (signals.wantsProjectChangeChain) {
    addCandidate(
      AGENT_INTENT_IDS.projectChangeChain,
      "The request asks for project changes across documents."
    );
  }

  if (signals.wantsTimeline) {
    addCandidate(AGENT_INTENT_IDS.extractTimeline, "Timeline wording was detected.");
  }

  if (signals.wantsCompareDocuments) {
    addCandidate(
      AGENT_INTENT_IDS.compareDocuments,
      "Comparison wording was detected."
    );
  }

  if (signals.wantsRiskReview) {
    addCandidate(AGENT_INTENT_IDS.riskReview, "Risk-review wording was detected.");
  }

  if (signals.wantsContractSummary) {
    addCandidate(
      AGENT_INTENT_IDS.summarizeContract,
      "Contract-summary wording was detected."
    );
  }

  if (signals.wantsResearch) {
    addCandidate(
      AGENT_INTENT_IDS.researchBrief,
      "Research or analysis wording was detected."
    );
  }

  if (signals.wantsInventory && !signals.hasDocuments) {
    addCandidate(
      AGENT_INTENT_IDS.inventory,
      "The request asks to list workspace documents."
    );
  }

  if (signals.wantsDiscovery && !signals.hasDocuments) {
    addCandidate(
      AGENT_INTENT_IDS.documentDiscovery,
      "The request asks to find a relevant workspace document."
    );
  }

  if (!signals.hasDocuments && signals.wantsWeb) {
    addCandidate(
      AGENT_INTENT_IDS.web,
      "The request asks for current web context without selected documents."
    );
  }

  addCandidate(
    signals.wantsWeb ? AGENT_INTENT_IDS.documentWeb : AGENT_INTENT_IDS.document,
    signals.wantsWeb
      ? "Default fallback: use selected documents before web context."
      : "Default fallback: answer from selected documents."
  );

  return candidates;
};

export const buildPlan = ({ question, docIds } = {}) =>
  buildIntentPlanCandidates({
    question,
    docIds,
  })[0]?.plan ??
  buildIntentPlan({
    intentId: AGENT_INTENT_IDS.document,
  });
