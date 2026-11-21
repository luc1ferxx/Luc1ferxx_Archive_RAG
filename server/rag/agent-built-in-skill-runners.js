import { consumeBudget } from "./agent-budget.js";
import { serializeError } from "../lib/error-text.js";
import { runLifecycleStep } from "./agent-step-lifecycle-runner.js";
import {
  buildStepError,
  buildTextCitationStepOutput,
} from "./agent-step-io.js";
import {
  buildArxivImportSkillInput,
  buildWorkspaceActionSkillInput,
} from "./skills/built-ins.js";
import { toDependencyOutageError } from "./dependency-outage.js";
import { buildSkippedSkillResult } from "./skills/registry.js";
import { normalizeText } from "../lib/normalize-text.js";

const noop = () => {};
const ARXIV_IMPORT_STEP_ID = "arxiv_import:primary";
const WORKSPACE_ACTION_STEP_ID = "workspace_action:primary";
const DOCUMENT_DISCOVERY_STEP_ID = "document_discovery:primary";
const INVENTORY_STEP_ID = "inventory:primary";

const buildResultStepError = (fallbackMessage) => (result = {}) =>
  buildStepError(result, fallbackMessage);

// The arXiv import, workspace action and document discovery Skills call a
// gated Capability, which never answers inside the outer plan: its approval
// interrupt pauses the Skill's step and the run (runLifecycleStep and
// executeAgentSkill rethrow it), and the approved capability_call step runs
// the Capability and answers (agent-run-step-handlers/capability-steps.js).
// What their runners get back is a failed Skill result: input the
// Capability's policy refused, no registry, or the Skill's own invariant
// error (skills/built-ins.js).

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
      result: buildSkippedSkillResult(arxivImportSkill, arxivBudget.reason),
      phase: "primary",
      budget: arxivBudget,
    });
    addBudgetLimitTrace({
      tool: "arXiv Import",
      reason: arxivBudget.reason,
    });

    return null;
  }

  const arxivInput = buildArxivImportSkillInput(question);
  const arxivResult = await runLifecycleStep({
    buildError: buildResultStepError("Unable to import arXiv papers."),
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
    failDetail: {
      requestedMaxResults: arxivInput.maxResults,
      topic: arxivInput.topic,
    },
    id: ARXIV_IMPORT_STEP_ID,
    input: arxivInput,
    label: "arXiv Import",
    persistedInput: null,
    stepLifecycle,
    type: "arxiv_import",
  });
  recordSkillResult(arxivResult);
  const failure = serializeError(
    arxivResult.error,
    "Unable to import arXiv papers."
  );

  addTraceStep({
    id: ARXIV_IMPORT_STEP_ID,
    type: "arxiv_import",
    label: "arXiv Import",
    status: "failed",
    summary: `arXiv import failed: ${failure}`,
    input: {
      question: normalizeText(question),
      maxResults: arxivInput.maxResults,
      topic: arxivInput.topic,
    },
    output: null,
    error: buildStepError(arxivResult, "Unable to import arXiv papers."),
    detail: buildSkillTraceDetail(arxivResult, {}),
  });

  return `arXiv import unavailable: ${failure}`;
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
  const failure = serializeError(
    actionResult.error,
    "Unable to execute workspace action."
  );

  addTraceStep({
    id: WORKSPACE_ACTION_STEP_ID,
    type: "capability_call",
    label: "Workspace Action",
    status: "failed",
    summary: `Workspace action failed: ${failure}`,
    input: {
      capabilityId: actionInput.capabilityId,
      ...actionInput.input,
    },
    output: null,
    error: buildStepError(actionResult, "Unable to execute workspace action."),
    detail: buildSkillTraceDetail(actionResult, {
      capabilityId: actionInput.capabilityId,
    }),
  });

  return `Workspace action unavailable: ${failure}`;
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

  // Every research question failed on a dependency outage: the run ends with
  // it (dependency-outage.js) instead of a brief that reads as missing
  // evidence.
  const outage = researchResult.ok ? null : toDependencyOutageError(researchResult.error);

  if (outage) {
    throw outage;
  }

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
    persistedInput: null,
    stepLifecycle,
    type: "document_discovery",
  });
  recordSkillResult(discoveryResult);
  const failure = serializeError(
    discoveryResult.error,
    "Unable to inspect workspace metadata."
  );

  addTraceStep({
    id: DOCUMENT_DISCOVERY_STEP_ID,
    type: "document_discovery",
    label: "Document Discovery",
    status: "failed",
    summary: `Document discovery failed: ${failure}`,
    input: discoveryInput,
    output: null,
    error: buildStepError(
      discoveryResult,
      "Unable to inspect workspace metadata."
    ),
    detail: buildSkillTraceDetail(discoveryResult, {
      matchCount: 0,
    }),
  });

  return `Document discovery unavailable: ${failure}`;
};
