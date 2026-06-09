import { performance } from "node:perf_hooks";
import {
  buildEvidenceRetryQuestion,
  buildEvidenceGaps,
  evaluateDocumentEvidence,
  selectBetterRagResult,
} from "./agent-self-check.js";
import { finalizeAgentAnswer } from "./agent-finalizer.js";
import { buildAgentRetrievalPlan } from "./agent-query-planner.js";
import { recordRagTrace } from "./observability.js";
import {
  appendTraceStep,
  buildBudgetLimitStep,
  consumeBudget,
  createAgentBudget,
  getBudgetSnapshot,
} from "./agent-budget.js";
import {
  AGENT_SKILL_IDS,
  CUSTOM_SKILL_IDS,
  buildFailedSkillResult,
  createDefaultSkillRegistry,
  executeAgentSkill,
} from "./skills/registry.js";

const WEB_SIGNAL_PATTERN =
  /\b(latest|current|currently|today|now|recent|news|live|online|internet|web|search the web|real[-\s]?time)\b|最新|当前|现在|今天|近日|实时|联网|网页|网络|新闻/i;

const SKILL_CHAIN_MODE = "skill_chain";
const MAX_AGENT_FOLLOW_UPS = 1;
const MAX_CLARIFICATION_DOCUMENTS = 12;

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

const serializeError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error.message;
  }

  return fallbackMessage;
};

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

const normalizeText = (value) => (hasText(value) ? value.trim() : "");

const roundDurationMs = (durationMs) =>
  Number.isFinite(durationMs) ? Number(durationMs.toFixed(2)) : 0;

const getSkillKey = ({ skillId, id }) => skillId ?? id ?? "unknown";

const getSkillDescriptor = (skill = {}) => ({
  skillId: getSkillKey(skill),
  skillVersion: skill.skillVersion ?? skill.version ?? "unknown",
  label: skill.label ?? skill.skillId ?? skill.id ?? "Unknown skill",
  budgetKey: skill.budgetKey ?? null,
});

const getSkillCitationCount = (result = {}) =>
  result.citations?.length ?? result.value?.citations?.length ?? 0;

const getBudgetUsageDelta = (before = {}, after = {}) => {
  const beforeUsed = before.used ?? {};
  const afterUsed = after.used ?? {};
  const keys = new Set([...Object.keys(beforeUsed), ...Object.keys(afterUsed)]);

  return Object.fromEntries(
    [...keys]
      .map((key) => [key, (afterUsed[key] ?? 0) - (beforeUsed[key] ?? 0)])
      .filter(([, delta]) => delta !== 0)
  );
};

const sanitizeBudgetEvent = (budget = null) => {
  if (!budget) {
    return null;
  }

  return {
    ok: Boolean(budget.ok),
    key: budget.key ?? null,
    label: budget.label ?? null,
    limit: Number.isFinite(Number(budget.limit)) ? Number(budget.limit) : null,
    used: Number.isFinite(Number(budget.used)) ? Number(budget.used) : null,
    remaining: Number.isFinite(Number(budget.remaining))
      ? Number(budget.remaining)
      : null,
    reason: budget.reason ?? null,
  };
};

const buildStep = ({ index, type, label, status = "completed", summary, detail }) => ({
  id: `${index}-${type}`,
  type,
  label,
  status,
  summary,
  detail: detail ?? null,
});

const buildPlan = ({ question, docIds }) => {
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

const buildPreExecutionClarification = ({ plan, docIds = [] } = {}) => {
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

const buildEvidenceClarification = ({ reason, check, gaps = [] } = {}) => ({
  reason,
  summary:
    "The agent could not verify the answer from the selected document evidence.",
  question:
    "I could not verify the answer from the selected documents. Which specific section, term, date, or document should I focus on?",
  detail: {
    reasons: check?.reasons ?? [],
    gaps,
  },
});

const orderSelectedSkills = ({ selectedSkills = [], plan = {} } = {}) => {
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

const buildSkillChainSummary = ({ chainSkills = [] } = {}) =>
  `Chained ${chainSkills.length} skill${chainSkills.length === 1 ? "" : "s"}: ${
    chainSkills.map((skill) => skill.label).join(" -> ")
  }.`;

const buildChainedSkillQuestion = ({
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

const buildPlannerActions = ({ plan, docIds, skills }) => {
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

const buildSelfCheckSummary = (check) => {
  if (check.passed) {
    return `Evidence check passed with ${check.citationCount} citation${
      check.citationCount === 1 ? "" : "s"
    } across ${check.citedDocCount} cited document${
      check.citedDocCount === 1 ? "" : "s"
    }.`;
  }

  return `Evidence check needs attention: ${check.reasons.join(" ")}`;
};

const buildGapAnalysisSummary = (gaps = []) => {
  if (gaps.length === 0) {
    return "No evidence gaps require follow-up.";
  }

  const gapTypes = [...new Set(gaps.map((gap) => gap.type ?? "evidence_gap"))];

  return `Identified ${gaps.length} evidence gap${
    gaps.length === 1 ? "" : "s"
  } for follow-up: ${gapTypes.join(", ")}.`;
};

const buildSynthesisAnswer = ({
  plan,
  ragResult,
  webResult,
  customSkillResults,
  inventoryAnswer,
  discoveryAnswer,
  researchBrief,
}) => {
  if (plan.mode === SKILL_CHAIN_MODE) {
    const completedResults = customSkillResults
      .filter((result) => result.ok && normalizeText(result.text))
      .map((result) => normalizeText(result.text));

    return completedResults.length > 0
      ? completedResults.join("\n\n")
      : "The skill chain could not complete the request.";
  }

  if (Object.values(CUSTOM_SKILL_IDS).includes(plan.mode)) {
    const customResult = customSkillResults.find(
      (result) => result.ok && result.skillId === plan.mode
    );

    return customResult?.text ?? "The custom skill could not complete the request.";
  }

  if (plan.mode === "research_brief") {
    return researchBrief?.text ?? "The research brief could not be generated.";
  }

  if (plan.mode === "inventory") {
    return inventoryAnswer;
  }

  if (plan.mode === "document_discovery") {
    return discoveryAnswer;
  }

  if (ragResult?.ok && webResult?.ok) {
    return [
      "Document evidence:",
      normalizeText(ragResult.value.text),
      "",
      "Web context:",
      normalizeText(webResult.value.text),
    ].join("\n");
  }

  if (ragResult?.ok) {
    return normalizeText(ragResult.value.text);
  }

  if (webResult?.ok) {
    return normalizeText(webResult.value.text);
  }

  return "The agent could not complete the request because all selected tools failed.";
};

const buildFinalizerSummary = (finalizer) => {
  if (!finalizer.changed) {
    return `Final answer passed claim-level citation finalization with ${
      finalizer.claimSupport.supportedClaimCount
    } supported claim${finalizer.claimSupport.supportedClaimCount === 1 ? "" : "s"}.`;
  }

  if (finalizer.abstained) {
    return `Finalizer removed ${finalizer.removedClaims.length} unsupported claim${
      finalizer.removedClaims.length === 1 ? "" : "s"
    } and returned an evidence-limited answer.`;
  }

  return `Finalizer removed ${finalizer.removedClaims.length} unsupported claim${
    finalizer.removedClaims.length === 1 ? "" : "s"
  } from the final answer.`;
};

const buildQueryPlannerSummary = (retrievalPlan) =>
  `Planned ${retrievalPlan.retrievalQueries.length} ${retrievalPlan.intent} retrieval quer${
    retrievalPlan.retrievalQueries.length === 1 ? "y" : "ies"
  } with ${retrievalPlan.retrievalOptions.profile} topK profile.`;

const buildAgentTraceSummary = (trace = []) =>
  trace.map((step) => ({
    type: step.type,
    label: step.label,
    status: step.status ?? "completed",
  }));

const getClaimKey = (claimText = "") => normalizeText(claimText).toLowerCase();

const getGapKey = (gap = {}) =>
  [
    gap.skillId ?? "unknown",
    gap.type ?? "evidence_gap",
    normalizeText(gap.claim ?? gap.message),
  ].join(":").toLowerCase();

export const runAgentRag = async ({
  agentBudget,
  ragService,
  webChatService,
  question,
  docIds,
  sessionId,
  userId,
  accessScope,
  skillRegistry,
}) => {
  const trace = [];
  const budgetState = createAgentBudget(agentBudget);
  const registry = skillRegistry ?? createDefaultSkillRegistry();
  const skillExecutions = new Map();
  const skillObservations = new Map();
  const skillRuns = [];
  let agentRetrievalPlan = null;
  const workingMemory = {
    version: "1.0",
    goal: question,
    docIds,
    checkedQueries: [],
    supportedClaims: [],
    unsupportedClaims: [],
    unresolvedGaps: [],
    resolvedGaps: [],
  };
  const workingMemoryState = {
    checkedQueryKeys: new Set(),
    supportedClaimKeys: new Set(),
    unsupportedClaimKeys: new Set(),
    unresolvedGapKeys: new Set(),
    resolvedGapKeys: new Set(),
  };
  const executionLoop = {
    version: "1.0",
    maxFollowUps: MAX_AGENT_FOLLOW_UPS,
    followUpsRun: 0,
    gapsIdentified: 0,
    gaps: [],
    stoppedReason: "not_needed",
  };
  const recordExecutionGaps = ({ skill, check }) => {
    const descriptor = getSkillDescriptor(skill);
    const gaps = check.gaps?.length ? check.gaps : buildEvidenceGaps(check);
    const normalizedGaps = gaps.map((gap) => ({
      ...gap,
      skillId: descriptor.skillId,
      skillVersion: descriptor.skillVersion,
    }));

    executionLoop.gaps.push(...normalizedGaps);
    executionLoop.gapsIdentified = executionLoop.gaps.length;
    recordWorkingMemoryGaps({
      gaps: normalizedGaps,
      phase: "gap_analysis",
    });

    return normalizedGaps;
  };
  const recordWorkingMemoryQueries = ({ skill, phase, retrievalPlan }) => {
    if (!retrievalPlan?.retrievalQueries?.length) {
      return;
    }

    const descriptor = getSkillDescriptor(skill);

    for (const retrievalQuery of retrievalPlan.retrievalQueries) {
      const query = normalizeText(retrievalQuery.query);
      const key = query.toLowerCase();

      if (!query || workingMemoryState.checkedQueryKeys.has(key)) {
        continue;
      }

      workingMemoryState.checkedQueryKeys.add(key);
      workingMemory.checkedQueries.push({
        skillId: descriptor.skillId,
        skillVersion: descriptor.skillVersion,
        phase,
        queryId: retrievalQuery.id ?? null,
        label: retrievalQuery.label ?? null,
        query,
        primary: Boolean(retrievalQuery.primary),
      });
    }
  };
  const recordWorkingMemoryClaimSupport = ({ skill, phase, check }) => {
    const claims = check?.claimSupport?.claims ?? [];

    if (claims.length === 0) {
      return;
    }

    const descriptor = getSkillDescriptor(skill);

    for (const claim of claims) {
      const text = normalizeText(claim.text);
      const key = getClaimKey(text);

      if (!text || claim.heading) {
        continue;
      }

      const entry = {
        skillId: descriptor.skillId,
        skillVersion: descriptor.skillVersion,
        phase,
        text,
        tokenOverlap: claim.tokenOverlap ?? null,
        anchors: claim.anchors ?? [],
        missingAnchors: claim.missingAnchors ?? [],
      };

      if (claim.supported) {
        if (!workingMemoryState.supportedClaimKeys.has(key)) {
          workingMemoryState.supportedClaimKeys.add(key);
          workingMemory.supportedClaims.push(entry);
        }

        if (workingMemoryState.unsupportedClaimKeys.has(key)) {
          workingMemoryState.unsupportedClaimKeys.delete(key);
          workingMemory.unsupportedClaims = workingMemory.unsupportedClaims.filter(
            (unsupportedClaim) => getClaimKey(unsupportedClaim.text) !== key
          );
        }

        continue;
      }

      if (
        !workingMemoryState.supportedClaimKeys.has(key) &&
        !workingMemoryState.unsupportedClaimKeys.has(key)
      ) {
        workingMemoryState.unsupportedClaimKeys.add(key);
        workingMemory.unsupportedClaims.push(entry);
      }
    }
  };
  const recordWorkingMemoryGaps = ({ gaps = [], phase }) => {
    for (const gap of gaps) {
      const key = getGapKey(gap);

      if (workingMemoryState.unresolvedGapKeys.has(key)) {
        continue;
      }

      workingMemoryState.unresolvedGapKeys.add(key);
      workingMemory.unresolvedGaps.push({
        ...gap,
        phase,
      });
    }
  };
  const resolveWorkingMemoryGaps = ({ skill, phase }) => {
    const descriptor = getSkillDescriptor(skill);
    const resolvedGaps = workingMemory.unresolvedGaps.filter(
      (gap) => gap.skillId === descriptor.skillId
    );

    for (const gap of resolvedGaps) {
      const key = getGapKey(gap);

      if (workingMemoryState.resolvedGapKeys.has(key)) {
        continue;
      }

      workingMemoryState.resolvedGapKeys.add(key);
      workingMemory.resolvedGaps.push({
        ...gap,
        resolvedPhase: phase,
      });
    }

    workingMemory.unresolvedGaps = workingMemory.unresolvedGaps.filter(
      (gap) => gap.skillId !== descriptor.skillId
    );
    workingMemoryState.unresolvedGapKeys = new Set(
      workingMemory.unresolvedGaps.map((gap) => getGapKey(gap))
    );
  };
  const recordSkillResult = (result) => {
    if (!result?.skillId) {
      return;
    }

    const status = result.ok ? "completed" : "failed";
    const existing = skillExecutions.get(result.skillId);

    if (!existing || (existing.status !== "completed" && status === "completed")) {
      skillExecutions.set(result.skillId, {
        skillId: result.skillId,
        skillVersion: result.skillVersion,
        label: result.label,
        status,
      });
    }
  };
  const getAgentSkills = () => [...skillExecutions.values()];
  const buildSkillTraceDetail = (result, detail = {}) => ({
    skillId: result.skillId,
    skillVersion: result.skillVersion,
    durationMs: result.durationMs ?? null,
    ...detail,
  });
  const addTraceStep = (step) =>
    appendTraceStep({
      budgetState,
      trace,
      step: buildStep({
        index: trace.length + 1,
        ...step,
      }),
    });
  const addBudgetLimitTrace = ({ reason, tool }) =>
    appendTraceStep({
      budgetState,
      trace,
      step: buildBudgetLimitStep({
        index: trace.length + 1,
        reason,
        tool,
      }),
    });
  const plan = buildPlan({
    question,
    docIds,
  });
  const selectedSkills = orderSelectedSkills({
    selectedSkills: registry.select({
      plan,
      docIds,
    }),
    plan,
  });
  const chainSkills = Array.isArray(plan.skillChain)
    ? plan.skillChain
        .map((skillId) => selectedSkills.find((skill) => skill.id === skillId))
        .filter(Boolean)
    : [];
  const selectedSkillKeys = new Set(selectedSkills.map((skill) => skill.id));
  const getSelectedSkill = (skillId) =>
    selectedSkills.find((skill) => skill.id === skillId) ?? null;
  const getOrCreateSkillObservation = (skill) => {
    const descriptor = getSkillDescriptor(skill);
    const existing = skillObservations.get(descriptor.skillId);

    if (existing) {
      return existing;
    }

    const observation = {
      ...descriptor,
      selected: selectedSkillKeys.has(descriptor.skillId),
      status: "not_run",
      attempts: 0,
      skippedCount: 0,
      retryCount: 0,
      followUpCount: 0,
      totalDurationMs: 0,
      citationCount: 0,
      lastCitationCount: 0,
      abstained: false,
      errorCount: 0,
      errors: [],
      budgetUsed: null,
      budgetLimit: null,
      budgetRemaining: null,
      budgetDelta: {},
    };

    skillObservations.set(descriptor.skillId, observation);
    return observation;
  };
  const recordSkillObservation = ({
    skill,
    result,
    phase = "primary",
    status,
    durationMs = 0,
    budget = null,
    budgetDelta = {},
    budgetAfter = null,
  }) => {
    const descriptor = getSkillDescriptor(skill ?? result);
    const observation = getOrCreateSkillObservation({
      ...descriptor,
      budgetKey: descriptor.budgetKey ?? skill?.budgetKey ?? null,
    });
    const finalStatus = status ?? (result?.ok ? "completed" : "failed");
    const roundedDurationMs = roundDurationMs(durationMs);
    const citationCount = getSkillCitationCount(result);
    const error = result?.ok === false
      ? serializeError(result.error, `${observation.label} failed.`)
      : budget?.ok === false
        ? budget.reason ?? null
        : null;
    const budgetEvent = sanitizeBudgetEvent(budget);
    const run = {
      skillId: observation.skillId,
      skillVersion: observation.skillVersion,
      label: observation.label,
      phase,
      status: finalStatus,
      durationMs: roundedDurationMs,
      citationCount,
      abstained: Boolean(result?.abstained ?? result?.value?.abstained),
      error,
      budget: budgetEvent,
      budgetDelta,
    };

    skillRuns.push(run);

    if (finalStatus === "completed") {
      observation.status = "completed";
    } else if (observation.status !== "completed") {
      observation.status = finalStatus;
    }

    if (finalStatus === "skipped") {
      observation.skippedCount += 1;
    } else {
      observation.attempts += 1;
    }

    if (phase === "retry" || phase === "follow_up") {
      observation.retryCount += 1;
    }

    if (phase === "follow_up") {
      observation.followUpCount += 1;
    }

    observation.totalDurationMs = roundDurationMs(
      observation.totalDurationMs + roundedDurationMs
    );
    observation.citationCount += citationCount;
    observation.lastCitationCount = citationCount;
    observation.abstained = observation.abstained || run.abstained;
    observation.budgetDelta = Object.fromEntries(
      Object.entries({
        ...observation.budgetDelta,
        ...budgetDelta,
      }).map(([key, value]) => [
        key,
        (observation.budgetDelta[key] ?? 0) + (budgetDelta[key] ?? 0),
      ])
    );

    if (error) {
      observation.errorCount += 1;
      observation.errors.push(error);
      observation.errors = observation.errors.slice(0, 5);
    }

    const budgetKey = observation.budgetKey;
    const budgetSnapshot = budgetAfter ?? getBudgetSnapshot(budgetState);

    if (budgetKey && budgetSnapshot.limits?.[budgetKey] === undefined) {
      observation.budgetUsed = budgetEvent?.used ?? observation.budgetUsed;
      observation.budgetLimit = budgetEvent?.limit ?? observation.budgetLimit;
      observation.budgetRemaining =
        budgetEvent?.remaining ?? observation.budgetRemaining;
    } else if (budgetKey) {
      observation.budgetUsed = budgetSnapshot.used?.[budgetKey] ?? null;
      observation.budgetLimit = budgetSnapshot.limits?.[
        `max${budgetKey[0].toUpperCase()}${budgetKey.slice(1)}`
      ] ?? budgetEvent?.limit ?? null;
      observation.budgetRemaining =
        observation.budgetLimit === null || observation.budgetUsed === null
          ? budgetEvent?.remaining ?? null
          : Math.max(0, observation.budgetLimit - observation.budgetUsed);
    }
  };
  const executeObservedSkill = async (
    skill,
    context,
    { phase = "primary", budget = null } = {}
  ) => {
    recordWorkingMemoryQueries({
      skill,
      phase,
      retrievalPlan: context?.retrievalPlan,
    });

    const budgetBefore = getBudgetSnapshot(budgetState);
    const startedAt = performance.now();
    const result = await executeAgentSkill(skill, context);
    const durationMs = performance.now() - startedAt;
    const budgetAfter = getBudgetSnapshot(budgetState);

    result.durationMs = roundDurationMs(durationMs);
    recordSkillObservation({
      skill,
      result,
      phase,
      durationMs,
      budget,
      budgetDelta: getBudgetUsageDelta(budgetBefore, budgetAfter),
      budgetAfter,
    });

    return result;
  };
  const recordSkippedSkill = ({ skill, result, phase, budget }) => {
    recordSkillObservation({
      skill,
      result,
      phase,
      status: "skipped",
      budget,
      budgetAfter: getBudgetSnapshot(budgetState),
    });
  };
  const buildAgentObservability = ({ agentMode }) => ({
    agentMode,
    planMode: plan.mode,
    skillChain: chainSkills.map((skill) => getSkillDescriptor(skill)),
    executionLoop,
    workingMemory,
    selectedSkills: selectedSkills.map((skill) => getSkillDescriptor(skill)),
    skills: [...skillObservations.values()].sort((left, right) =>
      left.skillId.localeCompare(right.skillId)
    ),
    runs: skillRuns,
    budget: getBudgetSnapshot(budgetState),
  });
  const returnClarification = async (clarification) => {
    const agentMode = "clarification";

    addTraceStep({
      type: "clarification_gate",
      label: "Clarification Gate",
      status: "needs_input",
      summary: clarification.summary,
      detail: {
        reason: clarification.reason,
        clarificationQuestion: clarification.question,
        ...(clarification.detail ?? {}),
      },
    });

    const agentObservability = buildAgentObservability({
      agentMode,
    });
    const status = 200;

    await recordRagTrace({
      traceType: "agent",
      timestamp: new Date().toISOString(),
      agentMode,
      planMode: plan.mode,
      docIds,
      agentSkills: getAgentSkills(),
      agentObservability,
      agentRetrievalPlan,
      agentTraceSummary: buildAgentTraceSummary(trace),
      status,
    });

    return {
      status,
      body: {
        agentAnswer: clarification.question,
        agentMode,
        agentTrace: trace,
        agentSkills: getAgentSkills(),
        agentObservability,
        agentWorkingMemory: workingMemory,
        researchBrief: null,
        ragAnswer: clarification.question,
        ragSources: [],
        ragResolvedQuestion: question,
        ragMemoryApplied: false,
        ragAbstained: true,
        ragAbstainReason: clarification.summary,
        ragGapPlan: null,
        ragEvidenceSummary: null,
        mcpAnswer: "Web search not used: clarification needed.",
        clarification: {
          needed: true,
          reason: clarification.reason,
          question: clarification.question,
          detail: clarification.detail ?? null,
        },
        errors: {
          rag: null,
          mcp: null,
        },
      },
    };
  };

  for (const skill of selectedSkills) {
    getOrCreateSkillObservation(skill);
  }

  addTraceStep({
    type: "plan",
    label: "Plan",
    summary: plan.summary,
    detail: {
      mode: plan.mode,
      docIds,
      budget: getBudgetSnapshot(budgetState),
      actions: buildPlannerActions({
        plan,
        docIds,
        skills: selectedSkills,
      }),
    },
  });

  const preExecutionClarification = buildPreExecutionClarification({
    plan,
    docIds,
  });

  if (preExecutionClarification) {
    return returnClarification(preExecutionClarification);
  }

  let inventoryAnswer = null;
  let discoveryAnswer = null;
  let researchBrief = null;
  let ragResult = null;
  let webResult = null;
  let documentEvidenceClarification = null;
  const customSkillResults = [];
  const shouldPlanRetrieval = selectedSkills.some(
    (skill) => skill.id === AGENT_SKILL_IDS.documentRag || skill.kind === "custom"
  );
  agentRetrievalPlan = shouldPlanRetrieval
    ? buildAgentRetrievalPlan({
        question,
        plan,
        docIds,
      })
    : null;

  if (agentRetrievalPlan) {
    addTraceStep({
      type: "query_planner",
      label: "Query Planner",
      summary: buildQueryPlannerSummary(agentRetrievalPlan),
      detail: agentRetrievalPlan,
    });
  }

  if (chainSkills.length > 0) {
    addTraceStep({
      type: "skill_chain",
      label: "Skill Chain",
      summary: buildSkillChainSummary({
        chainSkills,
      }),
      detail: {
        mode: plan.mode,
        skills: chainSkills.map((skill) => getSkillDescriptor(skill)),
      },
    });
  }

  const researchSkill = getSelectedSkill(AGENT_SKILL_IDS.researchBrief);

  if (researchSkill) {
    const selectedDocuments = ragService
      .listDocuments?.(accessScope)
      ?.filter((document) => docIds.includes(document.docId)) ?? [];
    const researchPlan = researchSkill.createPlan({
      question,
      documents: selectedDocuments,
    });

    addTraceStep({
      type: "research_plan",
      label: "Research Plan",
      summary: `Planned ${researchPlan.questions.length} document-grounded research question${
        researchPlan.questions.length === 1 ? "" : "s"
      }.`,
      detail: {
        questions: researchPlan.questions,
      },
    });

    const researchResult = await executeObservedSkill(researchSkill, {
      budgetState,
      ragService,
      question,
      docIds,
      accessScope,
      researchPlan,
    });
    recordSkillResult(researchResult);
    researchBrief = researchResult.ok ? researchResult.value : null;

    if (!researchResult.ok) {
      addTraceStep({
        type: "research_question",
        label: "Research Question",
        status: "failed",
        summary: `Research brief failed: ${serializeError(
          researchResult.error,
          "Unable to generate research brief."
        )}`,
        detail: buildSkillTraceDetail(researchResult),
      });
    }

    for (const finding of researchBrief?.findings ?? []) {
      if (finding.status === "skipped") {
        addBudgetLimitTrace({
          tool: "Research Question",
          reason: finding.error ?? "Research question budget exhausted.",
        });
        continue;
      }

      addTraceStep({
        type: "research_question",
        label: "Research Question",
        status: finding.status === "completed" ? "completed" : "failed",
        summary: finding.question,
        detail: {
          citations: finding.citations?.length ?? 0,
          abstained: Boolean(finding.abstained),
          error: finding.error ?? null,
          skillId: researchResult.skillId,
          skillVersion: researchResult.skillVersion,
        },
      });
    }
  }

  const inventorySkill = getSelectedSkill(AGENT_SKILL_IDS.inventory);

  if (inventorySkill) {
    const inventoryResult = await executeObservedSkill(inventorySkill, {
      ragService,
      accessScope,
    });
    recordSkillResult(inventoryResult);
    const documents = inventoryResult.value?.documents ?? [];
    inventoryAnswer = inventoryResult.ok
      ? inventoryResult.text
      : `Workspace inventory unavailable: ${serializeError(
          inventoryResult.error,
          "Unable to list indexed documents."
        )}`;
    addTraceStep({
      type: "inventory",
      label: "Workspace Inventory",
      status: inventoryResult.ok ? "completed" : "failed",
      summary:
        inventoryResult.ok && documents.length === 0
          ? "No indexed documents found."
          : inventoryResult.ok
            ? `Found ${documents.length} indexed document${
                documents.length === 1 ? "" : "s"
              }.`
            : `Workspace inventory failed: ${serializeError(
                inventoryResult.error,
                "Unable to list indexed documents."
              )}`,
      detail: buildSkillTraceDetail(inventoryResult, {
        documentCount: documents.length,
      }),
    });
  }

  const discoverySkill = getSelectedSkill(AGENT_SKILL_IDS.documentDiscovery);

  if (discoverySkill) {
    const discoveryResult = await executeObservedSkill(discoverySkill, {
      ragService,
      question,
      docIds,
      accessScope,
    });
    recordSkillResult(discoveryResult);
    const matches = discoveryResult.value?.matches ?? [];
    discoveryAnswer = discoveryResult.ok
      ? discoveryResult.text
      : `Document discovery unavailable: ${serializeError(
          discoveryResult.error,
          "Unable to inspect workspace metadata."
        )}`;
    addTraceStep({
      type: "document_discovery",
      label: "Document Discovery",
      status: discoveryResult.ok ? "completed" : "failed",
      summary:
        discoveryResult.ok && matches.length === 0
          ? "No strong metadata match found."
          : discoveryResult.ok
            ? `Found ${matches.length} likely matching document${
                matches.length === 1 ? "" : "s"
              }.`
            : `Document discovery failed: ${serializeError(
                discoveryResult.error,
                "Unable to inspect workspace metadata."
              )}`,
      detail: buildSkillTraceDetail(discoveryResult, {
        matchCount: matches.length,
      }),
    });
  }

  const customSkills = selectedSkills.filter((skill) => skill.kind === "custom");
  const previousChainResults = [];

  for (const customSkill of customSkills) {
    const chainQuestion = plan.mode === SKILL_CHAIN_MODE
      ? buildChainedSkillQuestion({
          question,
          previousResults: previousChainResults,
        })
      : question;
    const customBudget = customSkill.budgetKey
      ? consumeBudget(budgetState, customSkill.budgetKey)
      : null;
    const customResult = customBudget && !customBudget.ok
      ? buildFailedSkillResult(customSkill, new Error(customBudget.reason))
      : await executeObservedSkill(customSkill, {
          ragService,
          question: chainQuestion,
          docIds,
          sessionId,
          userId,
          accessScope,
          retrievalPlan: agentRetrievalPlan,
        }, {
          phase: "primary",
          budget: customBudget,
        });

    customSkillResults.push(customResult);
    recordSkillResult(customResult);

    if (customResult.ok) {
      previousChainResults.push(customResult);
    }

    if (customBudget && !customBudget.ok) {
      recordSkippedSkill({
        skill: customSkill,
        result: customResult,
        phase: "primary",
        budget: customBudget,
      });
      addBudgetLimitTrace({
        tool: customSkill.label,
        reason: customBudget.reason,
      });
      continue;
    }

    addTraceStep({
      type: "custom_skill",
      label: customSkill.label,
      status: customResult.ok ? "completed" : "failed",
      summary: customResult.ok
        ? `${customSkill.label} completed with ${customResult.citations?.length ?? 0} citation${
            customResult.citations?.length === 1 ? "" : "s"
          }.`
        : `${customSkill.label} failed: ${serializeError(
            customResult.error,
            "Unable to run custom skill."
          )}`,
      detail: buildSkillTraceDetail(customResult, {
        skillKind: customSkill.kind,
        chainMode: plan.mode === SKILL_CHAIN_MODE,
        previousSkillCount: Math.max(0, previousChainResults.length - 1),
        ...(customResult.traceDetail ?? {}),
      }),
    });
  }

  const documentRagSkill = getSelectedSkill(AGENT_SKILL_IDS.documentRag);

  if (documentRagSkill) {
    const primaryBudget = consumeBudget(budgetState, documentRagSkill.budgetKey);
    const primaryRagResult = primaryBudget.ok
      ? await executeObservedSkill(documentRagSkill, {
          ragService,
          docIds,
          question,
          sessionId,
          userId,
          accessScope,
          retrievalPlan: agentRetrievalPlan,
        }, {
          phase: "primary",
          budget: primaryBudget,
        })
      : buildFailedSkillResult(documentRagSkill, new Error(primaryBudget.reason));

    ragResult = primaryRagResult;
    recordSkillResult(primaryRagResult);

    if (!primaryBudget.ok) {
      recordSkippedSkill({
        skill: documentRagSkill,
        result: primaryRagResult,
        phase: "primary",
        budget: primaryBudget,
      });
      addBudgetLimitTrace({
        tool: "Document RAG",
        reason: primaryBudget.reason,
      });
    } else {
      addTraceStep({
        type: "document_rag",
        label: "Document RAG",
        status: primaryRagResult.ok ? "completed" : "failed",
        summary: primaryRagResult.ok
          ? primaryRagResult.value.abstained
            ? "Document RAG ran but reported insufficient evidence."
            : `Document RAG returned ${
                primaryRagResult.value.citations?.length ?? 0
              } citation${
                primaryRagResult.value.citations?.length === 1 ? "" : "s"
              }.`
          : `Document RAG failed: ${serializeError(
              primaryRagResult.error,
              "Unable to answer from the document."
            )}`,
        detail: buildSkillTraceDetail(
          primaryRagResult,
          primaryRagResult.traceDetail ?? {}
        ),
      });
    }

    const primaryCheck = evaluateDocumentEvidence({
      ragResult: primaryRagResult,
      docIds,
    });

    if (primaryBudget.ok) {
      recordWorkingMemoryClaimSupport({
        skill: documentRagSkill,
        phase: "primary",
        check: primaryCheck,
      });

      addTraceStep({
        type: "self_check",
        label: "Self Check",
        status: primaryCheck.passed ? "completed" : "failed",
        summary: buildSelfCheckSummary(primaryCheck),
        detail: primaryCheck,
      });
    }

    if (
      primaryCheck.retryRecommended &&
      executionLoop.followUpsRun < executionLoop.maxFollowUps
    ) {
      const gaps = recordExecutionGaps({
        skill: documentRagSkill,
        check: primaryCheck,
      });

      executionLoop.stoppedReason = "follow_up_planned";

      addTraceStep({
        type: "gap_analysis",
        label: "Gap Analysis",
        status: gaps.length > 0 ? "completed" : "skipped",
        summary: buildGapAnalysisSummary(gaps),
        detail: {
          skillId: documentRagSkill.id,
          skillVersion: documentRagSkill.version,
          followUpRecommended: gaps.length > 0,
          gaps,
        },
      });

      const followUpQuestion = buildEvidenceRetryQuestion({
        question,
        check: primaryCheck,
      });
      const followUpRetrievalPlan = buildAgentRetrievalPlan({
        question: followUpQuestion,
        plan,
        docIds,
        phase: "follow_up",
        focus: {
          originalQuestion: question,
          reasons: primaryCheck.reasons,
          unsupportedClaims: primaryCheck.claimSupport?.claims
            ?.filter((claim) => !claim.supported)
            .map((claim) => claim.text) ?? [],
          gaps,
        },
      });
      const followUpBudget = consumeBudget(
        budgetState,
        documentRagSkill.budgetKey
      );

      if (!followUpBudget.ok) {
        executionLoop.stoppedReason = "budget_exhausted";
        documentEvidenceClarification = buildEvidenceClarification({
          reason: "document_follow_up_budget_exhausted",
          check: primaryCheck,
          gaps,
        });
        recordSkippedSkill({
          skill: documentRagSkill,
          result: buildFailedSkillResult(
            documentRagSkill,
            new Error(followUpBudget.reason)
          ),
          phase: "follow_up",
          budget: followUpBudget,
        });
        addBudgetLimitTrace({
          tool: "Document follow-up",
          reason: followUpBudget.reason,
        });
      } else {
        const followUpRagResult = await executeObservedSkill(documentRagSkill, {
          ragService,
          docIds,
          question: followUpQuestion,
          sessionId,
          userId,
          accessScope,
          retrievalPlan: followUpRetrievalPlan,
        }, {
          phase: "follow_up",
          budget: followUpBudget,
        });
        executionLoop.followUpsRun += 1;
        executionLoop.stoppedReason = "follow_up_completed";
        recordSkillResult(followUpRagResult);

        addTraceStep({
          type: "follow_up_retrieval",
          label: "Follow-up Retrieval",
          status: followUpRagResult.ok ? "completed" : "failed",
          summary: followUpRagResult.ok
            ? `Focused follow-up returned ${
                followUpRagResult.value.citations?.length ?? 0
              } citation${
                followUpRagResult.value.citations?.length === 1 ? "" : "s"
              }.`
            : `Focused follow-up failed: ${serializeError(
                followUpRagResult.error,
              "Unable to run follow-up document evidence lookup."
            )}`,
          detail: buildSkillTraceDetail(followUpRagResult, {
            followUpQuestion,
            retrievalPlan: followUpRetrievalPlan,
            gaps,
          }),
        });

        if (followUpRagResult.ok) {
          const followUpCheck = evaluateDocumentEvidence({
            ragResult: followUpRagResult,
            docIds,
          });
          recordWorkingMemoryClaimSupport({
            skill: documentRagSkill,
            phase: "follow_up",
            check: followUpCheck,
          });

          addTraceStep({
            type: "self_check",
            label: "Follow-up Self Check",
            status: followUpCheck.passed ? "completed" : "failed",
            summary: buildSelfCheckSummary(followUpCheck),
            detail: followUpCheck,
          });

          executionLoop.stoppedReason = followUpCheck.passed
            ? "follow_up_resolved"
            : "follow_up_unresolved";

          if (followUpCheck.passed) {
            resolveWorkingMemoryGaps({
              skill: documentRagSkill,
              phase: "follow_up",
            });
          }

          if (!followUpCheck.passed) {
            const followUpGaps = (followUpCheck.gaps?.length
              ? followUpCheck.gaps
              : buildEvidenceGaps(followUpCheck)).map((gap) => ({
                ...gap,
                skillId: documentRagSkill.id,
                skillVersion: documentRagSkill.version,
              }));

            recordWorkingMemoryGaps({
              gaps: followUpGaps,
              phase: "follow_up",
            });
            documentEvidenceClarification = buildEvidenceClarification({
              reason: "document_evidence_unresolved_after_follow_up",
              check: followUpCheck,
              gaps: followUpGaps,
            });
          }
        }

        ragResult = selectBetterRagResult({
          primary: primaryRagResult,
          retry: followUpRagResult,
        });
      }
    } else if (primaryCheck.retryRecommended) {
      executionLoop.stoppedReason = "follow_up_limit_reached";
      documentEvidenceClarification = buildEvidenceClarification({
        reason: "document_follow_up_limit_reached",
        check: primaryCheck,
        gaps: primaryCheck.gaps?.length
          ? primaryCheck.gaps
          : buildEvidenceGaps(primaryCheck),
      });
    }
  }

  if (documentEvidenceClarification && !plan.wantsWeb) {
    return returnClarification(documentEvidenceClarification);
  }

  const plannedWebSearchSkill = getSelectedSkill(AGENT_SKILL_IDS.webSearch);
  const webSearchSkill = plannedWebSearchSkill ?? registry.get(AGENT_SKILL_IDS.webSearch);
  const shouldRunWeb =
    Boolean(webSearchSkill) &&
    (Boolean(plannedWebSearchSkill) ||
      (ragResult?.ok && ragResult.value.abstained) ||
      ragResult?.ok === false);
  let skippedWebBecauseBudget = false;

  if (shouldRunWeb) {
    const webBudget = consumeBudget(budgetState, webSearchSkill.budgetKey);

    if (!webBudget.ok) {
      skippedWebBecauseBudget = true;
      recordSkippedSkill({
        skill: webSearchSkill,
        result: buildFailedSkillResult(webSearchSkill, new Error(webBudget.reason)),
        phase: plannedWebSearchSkill ? "primary" : "fallback",
        budget: webBudget,
      });
      addBudgetLimitTrace({
        tool: "Web Search",
        reason: webBudget.reason,
      });
    } else {
      webResult = await executeObservedSkill(webSearchSkill, {
        webChatService,
        question,
      }, {
        phase: plannedWebSearchSkill ? "primary" : "fallback",
        budget: webBudget,
      });
      recordSkillResult(webResult);

      addTraceStep({
        type: "web_search",
        label: "Web Search",
        status: webResult.ok ? "completed" : "failed",
        summary: webResult.ok
          ? "Web search returned supplemental context."
          : `Web search failed: ${serializeError(
              webResult.error,
              "Unable to answer from web search."
            )}`,
        detail: buildSkillTraceDetail(webResult),
      });
    }
  }

  const agentMode =
    ragResult?.ok && ragResult.value.abstained && webResult?.ok ? "document_web" : plan.mode;
  const successfulCustomResults = customSkillResults.filter((result) => result.ok);
  const primaryCustomResult = customSkillResults.find((result) => result.ok);
  const customCitations = successfulCustomResults.flatMap(
    (result) => result.citations ?? []
  );
  const directAnswerModes = new Set([
    "inventory",
    "document_discovery",
    "research_brief",
    SKILL_CHAIN_MODE,
    ...customSkills.map((skill) => skill.id),
  ]);
  const ragSources = researchBrief?.citations ??
    (ragResult?.ok
      ? ragResult.value.citations ?? []
      : customCitations);
  const baseAgentAnswer = buildSynthesisAnswer({
    plan: {
      ...plan,
      mode: agentMode,
    },
    ragResult,
    webResult,
    customSkillResults,
    inventoryAnswer,
    discoveryAnswer,
    researchBrief,
  });
  const shouldFinalizeAnswer =
    ragSources.length > 0 &&
    (agentMode === "document" ||
      agentMode === SKILL_CHAIN_MODE ||
      (primaryCustomResult && agentMode === primaryCustomResult.skillId));

  addTraceStep({
    type: "synthesis",
    label: "Synthesis",
    summary: "Composed the final agent answer from completed tool results.",
    detail: {
      budget: getBudgetSnapshot(budgetState),
    },
  });

  const finalizer = shouldFinalizeAnswer
    ? finalizeAgentAnswer({
        answerText: baseAgentAnswer,
        citations: ragSources,
      })
    : null;

  if (finalizer) {
    recordWorkingMemoryClaimSupport({
      skill: primaryCustomResult ?? documentRagSkill ?? {
        id: "answer_finalizer",
        version: "1.0.0",
        label: "Answer Finalizer",
      },
      phase: "final",
      check: {
        claimSupport: finalizer.claimSupport,
      },
    });

    addTraceStep({
      type: "answer_finalizer",
      label: "Answer Finalizer",
      summary: buildFinalizerSummary(finalizer),
      detail: {
        changed: finalizer.changed,
        abstained: finalizer.abstained,
        removedClaims: finalizer.removedClaims,
        claimSupport: finalizer.claimSupport,
      },
    });
  }

  const agentAnswer = finalizer?.text ?? baseAgentAnswer;

  const ragError = ragResult?.ok === false
    ? serializeError(ragResult.error, "Unable to answer from the document.")
    : null;
  const webError = webResult?.ok === false
    ? serializeError(webResult.error, "Unable to answer from web search.")
    : null;
  const rawRagAnswer = researchBrief
    ? researchBrief.text
    : ragResult?.ok
    ? ragResult.value.text
    : agentMode === SKILL_CHAIN_MODE
      ? baseAgentAnswer
    : primaryCustomResult?.text
      ? primaryCustomResult.text
    : ragError
      ? `RAG unavailable: ${ragError}`
      : "";
  const ragAnswer =
    finalizer &&
    (agentMode === "document" ||
      agentMode === SKILL_CHAIN_MODE ||
      (primaryCustomResult && agentMode === primaryCustomResult.skillId))
      ? agentAnswer
      : rawRagAnswer;
  const rawRagAbstained = researchBrief
    ? researchBrief.findings.some((finding) => finding.abstained)
    : ragResult?.ok
      ? Boolean(ragResult.value.abstained)
      : primaryCustomResult
        ? Boolean(primaryCustomResult.abstained)
        : null;
  const ragAbstained = finalizer?.abstained ? true : rawRagAbstained;
  const status =
    !directAnswerModes.has(plan.mode) &&
    !ragResult?.ok &&
    (shouldRunWeb ? !webResult?.ok : true)
      ? 502
      : 200;
  const agentObservability = buildAgentObservability({
    agentMode,
  });
  await recordRagTrace({
    traceType: "agent",
    timestamp: new Date().toISOString(),
    agentMode,
    planMode: plan.mode,
    docIds,
    agentSkills: getAgentSkills(),
    agentObservability,
    agentRetrievalPlan,
    agentTraceSummary: buildAgentTraceSummary(trace),
    status,
  });

  return {
    status,
    body: {
      agentAnswer,
      agentMode,
      agentTrace: trace,
      agentSkills: getAgentSkills(),
      agentObservability,
      agentWorkingMemory: workingMemory,
      researchBrief,
      ragAnswer,
      ragSources,
      ragResolvedQuestion: ragResult?.ok ? ragResult.value.resolvedQuery ?? question : question,
      ragMemoryApplied: ragResult?.ok ? Boolean(ragResult.value.memoryApplied) : false,
      ragAbstained,
      ragAbstainReason: ragResult?.ok
        ? ragResult.value.abstainReason ?? null
        : null,
      ragGapPlan: ragResult?.ok ? ragResult.value.gapPlan ?? null : null,
      ragEvidenceSummary: ragResult?.ok
        ? ragResult.value.evidenceSummary ?? null
        : null,
      mcpAnswer: webResult?.ok
        ? webResult.value.text
        : webResult?.ok === false
          ? `Web search unavailable: ${webError}`
          : skippedWebBecauseBudget
            ? "Web search not used: agent budget exhausted."
          : directAnswerModes.has(plan.mode)
            ? "Web search not used for this direct agent skill."
            : "Web search not used: document evidence was sufficient.",
      errors: {
        rag: ragError,
        mcp: webError,
      },
    },
  };
};
