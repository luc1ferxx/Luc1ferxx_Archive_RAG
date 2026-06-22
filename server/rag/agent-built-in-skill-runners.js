import { consumeBudget } from "./agent-budget.js";
import { serializeAgentError as serializeError } from "./agent-response-builder.js";
import { runLifecycleStep } from "./agent-step-lifecycle-runner.js";
import {
  buildStepError,
  buildTextCitationStepOutput,
} from "./agent-step-io.js";
import {
  buildArxivImportSkillInput,
  buildWorkspaceActionSkillInput,
} from "./skills/built-ins.js";
import { buildFailedSkillResult } from "./skills/registry.js";

const noop = () => {};
const ARXIV_IMPORT_STEP_ID = "arxiv_import:primary";
const WORKSPACE_ACTION_STEP_ID = "workspace_action:primary";
const DOCUMENT_DISCOVERY_STEP_ID = "document_discovery:primary";
const INVENTORY_STEP_ID = "inventory:primary";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const buildResultStepError = (fallbackMessage) => (result = {}) =>
  buildStepError(result, fallbackMessage);

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
  stepLifecycle,
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

  const arxivStartInput = buildArxivImportSkillInput(question);
  const arxivResult = await runLifecycleStep({
    buildError: buildResultStepError("Unable to import arXiv papers."),
    buildOutput: (result) =>
      buildTextCitationStepOutput(result, {
        failedCount: result.value?.failedCount ?? 0,
        foundCount: result.value?.foundCount ?? 0,
        importedCount: result.value?.importedCount ?? 0,
        skippedCount: result.value?.skippedCount ?? 0,
      }),
    completeDetail: ({ result }) => ({
      foundCount: result.value?.foundCount ?? 0,
      importedCount: result.value?.importedCount ?? 0,
      requestedMaxResults: result.value?.requestedMaxResults ?? null,
      skippedCount: result.value?.skippedCount ?? 0,
      topic: result.value?.topic ?? arxivStartInput.topic,
    }),
    execute: () =>
      executeObservedSkill(
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
      ),
    failDetail: ({ result }) => ({
      requestedMaxResults:
        result?.value?.requestedMaxResults ?? arxivStartInput.maxResults,
      topic: result?.value?.topic ?? arxivStartInput.topic,
    }),
    id: ARXIV_IMPORT_STEP_ID,
    input: arxivStartInput,
    label: "arXiv Import",
    stepLifecycle,
    type: "arxiv_import",
  });
  recordSkillResult(arxivResult);
  const importedCount = arxivResult.value?.importedCount ?? 0;
  const skippedCount = arxivResult.value?.skippedCount ?? 0;
  const processedCount = importedCount + skippedCount;
  const arxivInput = {
    question: normalizeText(question),
    maxResults:
      arxivResult.value?.requestedMaxResults ?? arxivStartInput.maxResults,
    topic: arxivResult.value?.topic ?? arxivStartInput.topic,
  };

  addTraceStep({
    id: ARXIV_IMPORT_STEP_ID,
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
    input: arxivInput,
    output: buildTextCitationStepOutput(arxivResult, {
      failedCount: arxivResult.value?.failedCount ?? 0,
      foundCount: arxivResult.value?.foundCount ?? 0,
      importedCount,
      skippedCount,
    }),
    error: buildStepError(arxivResult, "Unable to import arXiv papers."),
    detail: buildSkillTraceDetail(arxivResult, arxivResult.traceDetail ?? {}),
  });

  return arxivResult.ok ? arxivResult.text : `arXiv import unavailable: ${serializeError(
    arxivResult.error,
    "Unable to import arXiv papers."
  )}`;
};

export const runWorkspaceActionSkill = async ({
  accessScope,
  addTraceStep = noop,
  buildSkillTraceDetail = (result) => result,
  capabilityRegistry,
  docIds = [],
  executeObservedSkill,
  plan,
  question,
  recordSkillResult = noop,
  workspaceActionSkill,
} = {}) => {
  if (!workspaceActionSkill) {
    return null;
  }

  const actionInput = buildWorkspaceActionSkillInput({
    docIds,
    plan,
    question,
  });
  const actionResult = await executeObservedSkill(workspaceActionSkill, {
    accessScope,
    capabilityRegistry,
    docIds,
    plan,
    question,
  });
  recordSkillResult(actionResult);

  addTraceStep({
    id: WORKSPACE_ACTION_STEP_ID,
    type: "capability_call",
    label: "Workspace Action",
    status: actionResult.ok ? "completed" : "failed",
    summary: actionResult.ok
      ? `Executed ${actionInput.capabilityId}.`
      : `Workspace action failed: ${serializeError(
          actionResult.error,
          "Unable to execute workspace action."
        )}`,
    input: {
      capabilityId: actionInput.capabilityId,
      ...actionInput.input,
    },
    output: buildTextCitationStepOutput(actionResult, {
      capabilityId: actionInput.capabilityId,
    }),
    error: buildStepError(actionResult, "Unable to execute workspace action."),
    detail: buildSkillTraceDetail(actionResult, {
      capabilityId: actionInput.capabilityId,
    }),
  });

  return actionResult.ok
    ? actionResult.text
    : `Workspace action unavailable: ${serializeError(
        actionResult.error,
        "Unable to execute workspace action."
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
  sessionId,
  stepLifecycle,
  userId,
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
    sessionId,
    stepLifecycle,
    userId,
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
      id: `research_question:${finding.id}`,
      type: "research_question",
      label: "Research Question",
      status: finding.status === "completed" ? "completed" : "failed",
      summary: finding.question,
      input: {
        docIds,
        question: finding.question,
        researchQuestionId: finding.id,
        sessionId: sessionId ?? null,
        skillId: researchResult.skillId,
        skillVersion: researchResult.skillVersion,
        userId: userId ?? null,
      },
      output: buildTextCitationStepOutput(finding, {
        researchQuestionId: finding.id,
      }),
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
  stepLifecycle,
} = {}) => {
  if (!inventorySkill) {
    return null;
  }

  const inventoryInput = {
    scope: "workspace",
  };
  const inventoryResult = await runLifecycleStep({
    buildError: buildResultStepError("Unable to list indexed documents."),
    buildOutput: (result) =>
      buildTextCitationStepOutput(result, {
        documentCount: result.value?.documents?.length ?? 0,
      }),
    execute: () =>
      executeObservedSkill(inventorySkill, {
        capabilityRegistry,
        ragService,
        accessScope,
      }),
    id: INVENTORY_STEP_ID,
    input: inventoryInput,
    label: "Workspace Inventory",
    stepLifecycle,
    type: "inventory",
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
    id: INVENTORY_STEP_ID,
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
    input: {
      ...inventoryInput,
    },
    output: buildTextCitationStepOutput(inventoryResult, {
      documentCount: documents.length,
    }),
    error: buildStepError(inventoryResult, "Unable to list indexed documents."),
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
  stepLifecycle,
} = {}) => {
  if (!discoverySkill) {
    return null;
  }

  const discoveryInput = {
    docIds,
    question,
  };
  const discoveryResult = await runLifecycleStep({
    buildError: buildResultStepError("Unable to inspect workspace metadata."),
    buildOutput: (result) =>
      buildTextCitationStepOutput(result, {
        matchCount: result.value?.matches?.length ?? 0,
      }),
    execute: () =>
      executeObservedSkill(discoverySkill, {
        capabilityRegistry,
        ragService,
        question,
        docIds,
        accessScope,
      }),
    id: DOCUMENT_DISCOVERY_STEP_ID,
    input: discoveryInput,
    label: "Document Discovery",
    stepLifecycle,
    type: "document_discovery",
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
    id: DOCUMENT_DISCOVERY_STEP_ID,
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
    input: discoveryInput,
    output: buildTextCitationStepOutput(discoveryResult, {
      matchCount: matches.length,
    }),
    error: buildStepError(
      discoveryResult,
      "Unable to inspect workspace metadata."
    ),
    detail: buildSkillTraceDetail(discoveryResult, {
      matchCount: matches.length,
    }),
  });

  return discoveryAnswer;
};
