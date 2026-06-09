import { consumeBudget } from "./agent-budget.js";
import {
  SKILL_CHAIN_MODE,
  buildChainedSkillQuestion,
} from "./agent-planner.js";
import { serializeAgentError as serializeError } from "./agent-response-builder.js";
import { buildFailedSkillResult } from "./skills/registry.js";

const noop = () => {};

export const runResearchBriefSkill = async ({
  accessScope,
  addBudgetLimitTrace = noop,
  addTraceStep = noop,
  budgetState,
  buildSkillTraceDetail = (result) => result,
  docIds = [],
  executeObservedSkill,
  question,
  ragService,
  recordSkillResult = noop,
  researchSkill,
} = {}) => {
  if (!researchSkill) {
    return null;
  }

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
  const researchBrief = researchResult.ok ? researchResult.value : null;

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

  return researchBrief;
};

export const runInventorySkill = async ({
  accessScope,
  addTraceStep = noop,
  buildSkillTraceDetail = (result) => result,
  executeObservedSkill,
  inventorySkill,
  ragService,
  recordSkillResult = noop,
} = {}) => {
  if (!inventorySkill) {
    return null;
  }

  const inventoryResult = await executeObservedSkill(inventorySkill, {
    ragService,
    accessScope,
  });
  recordSkillResult(inventoryResult);
  const documents = inventoryResult.value?.documents ?? [];
  const inventoryAnswer = inventoryResult.ok
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

  return inventoryAnswer;
};

export const runDocumentDiscoverySkill = async ({
  accessScope,
  addTraceStep = noop,
  buildSkillTraceDetail = (result) => result,
  discoverySkill,
  docIds = [],
  executeObservedSkill,
  question,
  ragService,
  recordSkillResult = noop,
} = {}) => {
  if (!discoverySkill) {
    return null;
  }

  const discoveryResult = await executeObservedSkill(discoverySkill, {
    ragService,
    question,
    docIds,
    accessScope,
  });
  recordSkillResult(discoveryResult);
  const matches = discoveryResult.value?.matches ?? [];
  const discoveryAnswer = discoveryResult.ok
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

  return discoveryAnswer;
};

export const runCustomSkills = async ({
  accessScope,
  addBudgetLimitTrace = noop,
  addTraceStep = noop,
  budgetState,
  buildSkillTraceDetail = (result, detail = {}) => ({
    skillId: result?.skillId,
    skillVersion: result?.skillVersion,
    ...detail,
  }),
  customSkills = [],
  docIds = [],
  executeObservedSkill,
  plan,
  question,
  ragService,
  recordSkippedSkill = noop,
  recordSkillResult = noop,
  retrievalPlan,
  sessionId,
  userId,
} = {}) => {
  const customSkillResults = [];
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
          retrievalPlan,
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

  return customSkillResults;
};

export const runWebSearchSkill = async ({
  addBudgetLimitTrace = noop,
  addTraceStep = noop,
  budgetState,
  buildSkillTraceDetail = (result) => result,
  executeObservedSkill,
  plannedWebSearchSkill,
  question,
  recordSkippedSkill = noop,
  recordSkillResult = noop,
  shouldRunWeb,
  webChatService,
  webSearchSkill,
} = {}) => {
  if (!shouldRunWeb) {
    return {
      skippedWebBecauseBudget: false,
      webResult: null,
    };
  }

  const webBudget = consumeBudget(budgetState, webSearchSkill.budgetKey);

  if (!webBudget.ok) {
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

    return {
      skippedWebBecauseBudget: true,
      webResult: null,
    };
  }

  const webResult = await executeObservedSkill(webSearchSkill, {
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

  return {
    skippedWebBecauseBudget: false,
    webResult,
  };
};
