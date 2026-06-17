import { consumeBudget } from "./agent-budget.js";
import { serializeAgentError as serializeError } from "./agent-response-builder.js";
import { buildFailedSkillResult } from "./skills/registry.js";

const noop = () => {};

const buildStepOutput = (result = {}) =>
  result.status === "completed"
    ? {
        abstained: Boolean(result.abstained),
        citationCount: result.citations?.length ?? 0,
        resolvedQuery: result.resolvedQuery ?? result.question ?? "",
        text: result.text ?? "",
      }
    : null;

const buildStepError = (result = {}, fallbackMessage = "Step failed.") =>
  result.status === "failed" || result.ok === false
    ? {
        message:
          result.error instanceof Error
            ? result.error.message
            : String(result.error ?? fallbackMessage),
        name: result.error?.name ?? "Error",
      }
    : null;

export const runArxivImportSkill = async ({
  accessScope,
  addBudgetLimitTrace = noop,
  addTraceStep = noop,
  arxivImportService,
  arxivImportSkill,
  budgetState,
  buildSkillTraceDetail = (result) => result,
  capabilityRegistry,
  executeObservedSkill,
  question,
  recordSkippedSkill = noop,
  recordSkillResult = noop,
} = {}) => {
  if (!arxivImportSkill) {
    return null;
  }

  const arxivBudget = consumeBudget(budgetState, arxivImportSkill.budgetKey);

  if (!arxivBudget.ok) {
    recordSkippedSkill({
      skill: arxivImportSkill,
      result: buildFailedSkillResult(
        arxivImportSkill,
        new Error(arxivBudget.reason)
      ),
      phase: "primary",
      budget: arxivBudget,
    });
    addBudgetLimitTrace({
      tool: "arXiv Import",
      reason: arxivBudget.reason,
    });

    return null;
  }

  const arxivResult = await executeObservedSkill(
    arxivImportSkill,
    {
      accessScope,
      arxivImportService,
      capabilityRegistry,
      question,
    },
    {
      budget: arxivBudget,
      phase: "primary",
    }
  );
  recordSkillResult(arxivResult);
  const importedCount = arxivResult.value?.importedCount ?? 0;
  const skippedCount = arxivResult.value?.skippedCount ?? 0;
  const processedCount = importedCount + skippedCount;

  addTraceStep({
    type: "arxiv_import",
    label: "arXiv Import",
    status: arxivResult.ok ? "completed" : "failed",
    summary: arxivResult.ok
      ? `Processed ${processedCount} arXiv paper${
          processedCount === 1 ? "" : "s"
        } (${importedCount} imported, ${skippedCount} already indexed).`
      : `arXiv import failed: ${serializeError(
          arxivResult.error,
          "Unable to import arXiv papers."
        )}`,
    detail: buildSkillTraceDetail(arxivResult, arxivResult.traceDetail ?? {}),
  });

  return arxivResult.ok ? arxivResult.text : `arXiv import unavailable: ${serializeError(
    arxivResult.error,
    "Unable to import arXiv papers."
  )}`;
};

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
      input: {
        docIds,
        question,
        skillId: researchSkill.id,
        skillVersion: researchSkill.version,
      },
      error: buildStepError(
        researchResult,
        "Unable to generate research brief."
      ),
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
      input: {
        docIds,
        question: finding.question,
        researchQuestionId: finding.id,
        sessionId: null,
        skillId: researchResult.skillId,
        skillVersion: researchResult.skillVersion,
        userId: null,
      },
      output: buildStepOutput(finding),
      error: buildStepError(finding, "Research lookup failed."),
      detail: {
        citations: finding.citations?.length ?? 0,
        abstained: Boolean(finding.abstained),
        error: finding.error ?? null,
        researchQuestionId: finding.id,
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
  capabilityRegistry,
  executeObservedSkill,
  inventorySkill,
  ragService,
  recordSkillResult = noop,
} = {}) => {
  if (!inventorySkill) {
    return null;
  }

  const inventoryResult = await executeObservedSkill(inventorySkill, {
    capabilityRegistry,
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
  capabilityRegistry,
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
    capabilityRegistry,
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
