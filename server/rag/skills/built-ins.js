import { consumeBudget } from "../agent-budget.js";
import {
  buildResearchPlan,
  formatResearchBrief,
} from "../research-brief.js";
import {
  DEFAULT_ARXIV_MAX_RESULTS,
  normalizeArxivMaxResults,
} from "../arxiv-client.js";
import { isAgentRunInterrupt } from "../agent-interrupts.js";
import { toDependencyOutageError } from "../dependency-outage.js";
import { CAPABILITY_IDS } from "../capabilities/index.js";
import { attachRetrievedEvidence } from "../citations.js";
import { getDocumentFormatForMimeType } from "../document-formats.js";
import { rebaseEvidenceResults } from "../source-labels.js";
import { serializeError } from "../../lib/error-text.js";
import { normalizeTrimmedText as normalizeText } from "../../lib/normalize-text.js";
import {
  SKILL_EFFECTS,
  SKILL_IDEMPOTENCY,
  describeSkillReplayContract,
} from "./skill-contract.js";

export const AGENT_SKILL_IDS = {
  arxivImport: "arxiv_import",
  documentRag: "document_rag",
  webSearch: "web_search",
  inventory: "inventory",
  documentDiscovery: "document_discovery",
  researchBrief: "research_brief",
  workspaceAction: "workspace_action",
};

export const BUILT_IN_SKILL_VERSION = "1.0.0";

const normalizeSentence = (value, fallback = "Workspace action") => {
  const text = normalizeText(value).replace(/\s+/g, " ") || fallback;
  const capitalized = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

  return /[.!?。！？]$/.test(capitalized) ? capitalized : `${capitalized}.`;
};

const buildInterruptStepDetail = (error = {}) => ({
  approvalGate: error.detail?.approvalGate ?? null,
  interruptType: error.type ?? null,
});

const ARXIV_COMMAND_PATTERN =
  /\b(arxiv|paper|papers|pdfs?|publications?|preprints?|fetch|download|import|ingest|collect|search|topic|about|on|for|latest|recent|top)\b|论文|文章|预印本|抓取|下载|导入|收集|搜索|检索|主题|方向|关于|有关|最新|最近|篇/gi;

const extractRequestedPaperCount = (question) => {
  const countMatch = normalizeText(question).match(
    /(?:top\s*)?(\d{1,2})\s*(?:papers?|pdfs?|preprints?|篇|个)?/i
  );

  return normalizeArxivMaxResults(
    countMatch?.[1],
    DEFAULT_ARXIV_MAX_RESULTS
  );
};

const extractArxivTopic = (question) => {
  const normalizedQuestion = normalizeText(question);
  const explicitTopicMatch = normalizedQuestion.match(
    /(?:topic|主题|方向|about|on|for|关于|有关)[:：]?\s*["“]?([^"”]+?)["”]?(?:\s*(?:papers?|论文|预印本))?$/i
  );
  const topicCandidate = explicitTopicMatch?.[1] ?? normalizedQuestion;
  const cleanedTopic = topicCandidate
    .replace(ARXIV_COMMAND_PATTERN, " ")
    .replace(/(?:方面|相关|一些|几篇|的)/g, " ")
    .replace(/\b\d{1,2}\b/g, " ")
    .replace(/[，。！？、,.!?;；:："'“”()[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleanedTopic || normalizedQuestion;
};

export const buildArxivImportSkillInput = (question) => ({
  maxResults: extractRequestedPaperCount(question),
  question: normalizeText(question),
  topic: extractArxivTopic(question),
});

const URL_PATTERN = /https?:\/\/[^\s)]+/i;

const ACTION_TASK_PATTERN =
  /(?:create|add|generate|make)\s+(?:a\s+)?(?:task|todo|to-do|follow[-\s]?up)(?:\s+to|:)?\s*(.+)$/i;

const stripActionCommand = (question, capabilityId) => {
  const normalizedQuestion = normalizeText(question);

  if (capabilityId === CAPABILITY_IDS.taskCreate) {
    return normalizedQuestion.match(ACTION_TASK_PATTERN)?.[1] ?? normalizedQuestion;
  }

  return normalizedQuestion;
};

const detectWorkspaceActionCapabilityId = ({ plan = {}, question = "" } = {}) => {
  if (plan.actionCapabilityId) {
    return plan.actionCapabilityId;
  }

  if (ACTION_TASK_PATTERN.test(question)) {
    return CAPABILITY_IDS.taskCreate;
  }

  if (/\b(organize|organise|arrange|group|folder|cluster)\b|整理/i.test(question)) {
    return CAPABILITY_IDS.documentOrganize;
  }

  if (/\b(create|save|record|store)\b.*\b(summary|summaries)\b|(?:创建|保存|记录).*(?:摘要|总结)/i.test(question)) {
    return CAPABILITY_IDS.summaryCreate;
  }

  if (/\b(import|ingest|add)\b.*\b(external|url|source|link|web document)\b|导入.*(?:外部|链接|资料|来源)/i.test(question)) {
    return CAPABILITY_IDS.externalImport;
  }

  return null;
};

export const buildWorkspaceActionSkillInput = ({
  docIds = [],
  plan = {},
  question = "",
} = {}) => {
  const capabilityId = detectWorkspaceActionCapabilityId({
    plan,
    question,
  });
  const normalizedQuestion = normalizeText(question);
  const selectedDocIds = Array.isArray(docIds) ? docIds : [];

  if (capabilityId === CAPABILITY_IDS.taskCreate) {
    const title = normalizeSentence(
      stripActionCommand(normalizedQuestion, capabilityId),
      "Follow up"
    );

    return {
      capabilityId,
      input: {
        description: normalizedQuestion,
        title,
      },
    };
  }

  if (capabilityId === CAPABILITY_IDS.documentOrganize) {
    return {
      capabilityId,
      input: {
        docIds: selectedDocIds,
        strategy: "profile_tags",
        title: "Workspace Document Organization",
      },
    };
  }

  if (capabilityId === CAPABILITY_IDS.summaryCreate) {
    return {
      capabilityId,
      input: {
        docIds: selectedDocIds,
        summary: normalizedQuestion,
        title: "Workspace Summary",
      },
    };
  }

  if (capabilityId === CAPABILITY_IDS.externalImport) {
    const sourceUrl = normalizedQuestion.match(URL_PATTERN)?.[0] ?? "";

    return {
      capabilityId,
      input: {
        provider: sourceUrl ? "url" : "manual",
        sourceUrl,
        title: sourceUrl || "External Source",
      },
    };
  }

  return {
    capabilityId: null,
    input: {},
  };
};

const requireCapabilityRegistry = (capabilityRegistry, capabilityId) => {
  if (!capabilityRegistry?.execute) {
    throw new Error(
      `Capability registry is required to execute ${capabilityId}.`
    );
  }

  return capabilityRegistry;
};

// The Capabilities of the arXiv import, workspace action, Web search and
// discovery Skills ask the user first (approvalPolicy user_confirmation), and
// a request carries no approval: the call throws the approval interrupt and
// the run pauses at the gate, or the policy refuses the input before that.
// Once the gate is approved, the capability_call step runs the Capability and
// answers (agent-run-step-handlers/capability-steps.js). A call that returns
// anyway fails the Skill; nothing here answers from its result.
const executeGatedCapability = async (capabilityRegistry, capabilityId, payload) => {
  await requireCapabilityRegistry(capabilityRegistry, capabilityId).execute(
    capabilityId,
    payload
  );

  throw new Error(
    `${capabilityId} requires approval and runs only from the approved capability_call step.`
  );
};

// What an Office document's pageCount counts: rag/document-loader.js makes a
// page per section, slide or visible sheet. A PDF, or a document of no known
// type, keeps the page wording it always had.
const OFFICE_PAGE_UNITS = Object.freeze({
  docx: ["section", "sections"],
  pptx: ["slide", "slides"],
  xlsx: ["sheet", "sheets"],
});

const formatPageCount = (document, pageCount) => {
  const units = OFFICE_PAGE_UNITS[getDocumentFormatForMimeType(document?.mimeType)];

  return units ? `${pageCount} ${pageCount === 1 ? units[0] : units[1]}` : `${pageCount} pages`;
};

const getDocumentLabel = (document) => {
  const pageCount = Number.parseInt(document?.pageCount ?? "0", 10);
  const chunkCount = Number.parseInt(document?.chunkCount ?? "0", 10);
  const stats = [
    Number.isFinite(pageCount) && pageCount > 0 ? formatPageCount(document, pageCount) : null,
    Number.isFinite(chunkCount) && chunkCount > 0 ? `${chunkCount} chunks` : null,
  ].filter(Boolean);

  return `${document.fileName ?? "Untitled document"}${
    stats.length > 0 ? ` (${stats.join(", ")})` : ""
  }`;
};

const buildInventoryAnswer = (documents) => {
  if (!documents.length) {
    return "No documents are currently indexed in this workspace.";
  }

  return [
    `The workspace currently has ${documents.length} indexed document${
      documents.length === 1 ? "" : "s"
    }:`,
    ...documents.map((document, index) => `${index + 1}. ${getDocumentLabel(document)}`),
  ].join("\n");
};

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Refuses a RAG result whose evidence fields have the wrong type, so a
// malformed result fails the Skill call (a failed Skill result) instead of
// reaching the document loop and the finalizer, which read these fields from
// the result's `value`. A missing field is allowed. (It also used to project
// the fields into a typed `evidence` output that only the removed v3 unified
// graph read; ADR 0001 phases 10 and 11.)
const assertDocumentRagResultTypes = (value) => {
  if (!isRecord(value) || (value.text != null && typeof value.text !== "string")) {
    throw new Error("Document evidence must contain answer text.");
  }

  if (
    value.citations != null &&
    (!Array.isArray(value.citations) || !value.citations.every(isRecord))
  ) {
    throw new Error("Document evidence citations must be an object array.");
  }

  if (value.abstained != null && typeof value.abstained !== "boolean") {
    throw new Error("Document evidence abstained flag must be boolean.");
  }

  if (
    value.retrievedContexts != null &&
    (!Array.isArray(value.retrievedContexts) ||
      !value.retrievedContexts.every(isRecord))
  ) {
    throw new Error("Document evidence retrieved contexts must be an object array.");
  }

  if (
    value.comparisonAnalysisSummary !== undefined &&
    value.comparisonAnalysisSummary !== null &&
    !isRecord(value.comparisonAnalysisSummary)
  ) {
    throw new Error("Document evidence comparison analysis must be an object.");
  }
};

const createDocumentRagSkill = () => ({
  id: AGENT_SKILL_IDS.documentRag,
  version: BUILT_IN_SKILL_VERSION,
  label: "Document RAG",
  kind: "built_in",
  budgetKey: "documentRagCalls",
  requiresAccessScope: true,
  // ragService.chat runs with the live session/user identity. It is asked not
  // to write memory, but nothing proves an injected ragService honours that,
  // and a replay could append such writes again without an idempotency key.
  effects: SKILL_EFFECTS.workspaceWrite,
  idempotency: SKILL_IDEMPOTENCY.adapterDefined,
  parallelSafe: false,
  replaySafe: false,
  retryable: false,
  match: ({ plan }) => Boolean(plan.wantsDocumentRag),
  plannerActions: ({ docIds }) => [
    {
      id: "document_rag",
      label: "Run document RAG",
      summary: `Search ${docIds.length} selected document${
        docIds.length === 1 ? "" : "s"
      }.`,
    },
    {
      id: "self_check",
      label: "Verify evidence",
      summary: "Check citation count and document coverage before synthesis.",
    },
  ],
  execute: async ({
    ragService,
    docIds,
    question,
    sessionId,
    userId,
    accessScope,
    retrievalPlan,
  }) => {
    const value = await ragService.chat(docIds, question, {
      sessionId,
      userId,
      includeRetrievedContexts: true,
      accessScope,
      retrievalPlan,
      // Neither answer is final yet (a follow-up or the finalizer may replace
      // it): the agent records the user's exchange once, after finalizing.
      memoryWrites: false,
    });
    assertDocumentRagResultTypes(value);

    return {
      value,
      text: value.text,
      citations: value.citations ?? [],
      abstained: Boolean(value.abstained),
      traceDetail: {
        citations: value.citations?.length ?? 0,
        abstained: Boolean(value.abstained),
        retrievalPlan,
      },
    };
  },
});

const createArxivImportSkill = () => ({
  id: AGENT_SKILL_IDS.arxivImport,
  version: BUILT_IN_SKILL_VERSION,
  label: "arXiv Import",
  kind: "built_in",
  budgetKey: "arxivPaperFetches",
  requiresAccessScope: true,
  // The capability searches externally and ingests PDFs into the workspace.
  effects: SKILL_EFFECTS.workspaceWrite,
  idempotency: SKILL_IDEMPOTENCY.adapterDefined,
  parallelSafe: false,
  replaySafe: false,
  retryable: false,
  match: ({ plan }) => Boolean(plan.wantsArxivImport),
  plannerActions: () => [
    {
      id: "arxiv_import",
      label: "Import arXiv papers",
      summary: "Search arXiv for the requested topic and ingest matching PDFs.",
    },
  ],
  execute: async ({
    accessScope,
    capabilityRegistry,
    question,
  }) => {
    const { maxResults, topic } = buildArxivImportSkillInput(question);

    return executeGatedCapability(
      capabilityRegistry,
      CAPABILITY_IDS.arxivImportTopic,
      {
        accessScope,
        input: {
          maxResults,
          topic,
        },
      }
    );
  },
});

const createWorkspaceActionSkill = () => ({
  id: AGENT_SKILL_IDS.workspaceAction,
  version: BUILT_IN_SKILL_VERSION,
  label: "Workspace Action",
  kind: "built_in",
  budgetKey: null,
  requiresAccessScope: true,
  // The selected capability can create tasks, artifacts, or imported sources.
  effects: SKILL_EFFECTS.workspaceWrite,
  idempotency: SKILL_IDEMPOTENCY.adapterDefined,
  parallelSafe: false,
  replaySafe: false,
  retryable: false,
  match: ({ plan }) => Boolean(plan.wantsAction),
  plannerActions: ({ plan }) => [
    {
      id: "workspace_action",
      label: "Run workspace action",
      summary: `Execute ${plan.actionCapabilityId ?? "a workspace action"} through the capability registry.`,
    },
  ],
  execute: async ({
    accessScope,
    capabilityRegistry,
    docIds,
    plan,
    question,
  }) => {
    const actionInput = buildWorkspaceActionSkillInput({
      docIds,
      plan,
      question,
    });

    if (!actionInput.capabilityId) {
      throw new Error("Workspace action capability could not be resolved.");
    }

    return executeGatedCapability(
      capabilityRegistry,
      actionInput.capabilityId,
      {
        accessScope,
        input: actionInput.input,
      }
    );
  },
});

const createWebSearchSkill = () => ({
  id: AGENT_SKILL_IDS.webSearch,
  version: BUILT_IN_SKILL_VERSION,
  label: "Web Search",
  kind: "built_in",
  budgetKey: "webSearchCalls",
  requiresAccessScope: false,
  // This is an external, nondeterministic call even though it does not write
  // workspace data; replay still goes through the capability policy.
  effects: SKILL_EFFECTS.externalRead,
  idempotency: SKILL_IDEMPOTENCY.nondeterministic,
  parallelSafe: false,
  replaySafe: false,
  retryable: false,
  match: ({ plan }) => Boolean(plan.wantsWeb),
  plannerActions: () => [
    {
      id: "web_search",
      label: "Use web fallback",
      summary: "Use web context only after document evidence is checked.",
    },
  ],
  execute: async ({ accessScope, capabilityRegistry, question }) =>
    executeGatedCapability(capabilityRegistry, CAPABILITY_IDS.webSearch, {
      accessScope,
      input: {
        question,
      },
    }),
});

const createInventorySkill = () => ({
  id: AGENT_SKILL_IDS.inventory,
  version: BUILT_IN_SKILL_VERSION,
  label: "Workspace Inventory",
  kind: "built_in",
  budgetKey: null,
  requiresAccessScope: true,
  // listDocuments is a scoped, local metadata read. It neither calls RAG nor
  // writes a session, so it is safe to replay.
  effects: SKILL_EFFECTS.readOnly,
  idempotency: SKILL_IDEMPOTENCY.readOnlyRag,
  parallelSafe: false,
  replaySafe: true,
  retryable: true,
  match: ({ plan }) => Boolean(plan.wantsInventory),
  plannerActions: () => [
    {
      id: "workspace_metadata",
      label: "Inspect workspace metadata",
      summary: "Use indexed document metadata without running document RAG.",
    },
  ],
  execute: async ({ ragService, accessScope }) => {
    const documents = ragService.listDocuments?.(accessScope) ?? [];
    const text = buildInventoryAnswer(documents);

    return {
      value: {
        text,
        documents,
      },
      text,
      citations: [],
      abstained: false,
      traceDetail: {
        documentCount: documents.length,
      },
    };
  },
});

const createDocumentDiscoverySkill = () => ({
  id: AGENT_SKILL_IDS.documentDiscovery,
  version: BUILT_IN_SKILL_VERSION,
  label: "Document Discovery",
  kind: "built_in",
  budgetKey: null,
  requiresAccessScope: true,
  // Metadata search itself is read-only, but its capability requires user
  // confirmation.
  effects: SKILL_EFFECTS.readOnly,
  idempotency: SKILL_IDEMPOTENCY.adapterDefined,
  parallelSafe: false,
  replaySafe: false,
  retryable: false,
  match: ({ plan }) => Boolean(plan.wantsDiscovery),
  plannerActions: () => [
    {
      id: "workspace_metadata",
      label: "Inspect workspace metadata",
      summary: "Use indexed document metadata without running document RAG.",
    },
  ],
  execute: async ({
    accessScope,
    capabilityRegistry,
    docIds,
    question,
  }) =>
    executeGatedCapability(
      capabilityRegistry,
      CAPABILITY_IDS.documentDiscovery,
      {
        accessScope,
        input: {
          docIds,
          question,
        },
      }
    ),
});

const createResearchBriefSkill = () => ({
  id: AGENT_SKILL_IDS.researchBrief,
  version: BUILT_IN_SKILL_VERSION,
  label: "Research Brief",
  kind: "built_in",
  budgetKey: "researchQuestions",
  requiresAccessScope: true,
  // The questions call ragService.chat with the live session/user identity
  // and memoryWrites: false, which nothing proves an injected ragService
  // honours. A restarted worker cannot infer from an in-flight run whether
  // such a write landed.
  effects: SKILL_EFFECTS.workspaceWrite,
  idempotency: SKILL_IDEMPOTENCY.adapterDefined,
  parallelSafe: false,
  replaySafe: false,
  retryable: false,
  match: ({ plan }) => Boolean(plan.wantsResearch),
  plannerActions: () => [
    {
      id: "research_questions",
      label: "Run research questions",
      summary: "Break the request into deterministic document-grounded questions.",
    },
  ],
  createPlan: ({ question, documents }) =>
    buildResearchPlan({
      question,
      documents,
    }),
  execute: async ({
    accessScope,
    budgetState,
    docIds,
    question,
    ragService,
    researchPlan,
    sessionId,
    stepLifecycle,
    userId,
  }) => {
    const documents = ragService.listDocuments?.(accessScope) ?? [];
    const selectedDocuments = documents.filter((document) => docIds.includes(document.docId));
    const plan = researchPlan ?? buildResearchPlan({
      question,
      documents: selectedDocuments,
    });
    const results = [];
    const evidenceResults = [];
    // The outages behind failed questions (dependency-outage.js); a finding
    // keeps only its message.
    const outages = [];

    for (const entry of plan.questions) {
      const budget = consumeBudget(budgetState, "researchQuestions");

      if (!budget.ok) {
        results.push({
          id: entry.id,
          question: entry.question,
          status: "skipped",
          text: "",
          citations: [],
          abstained: false,
          abstainReason: null,
          resolvedQuery: entry.question,
          error: budget.reason,
        });
        continue;
      }

      const researchQuestionStepId = `research_question:${entry.id}`;
      const researchQuestionInput = {
        docIds,
        question: entry.question,
        researchQuestionId: entry.id,
        // A research question uses the live RAG chat path and may append
        // session/long-memory writes before an interrupted step settles.
        ...describeSkillReplayContract({
          effects: SKILL_EFFECTS.workspaceWrite,
          idempotency: SKILL_IDEMPOTENCY.adapterDefined,
          replaySafe: false,
        }),
        sessionId: sessionId ?? null,
        skillId: AGENT_SKILL_IDS.researchBrief,
        skillVersion: BUILT_IN_SKILL_VERSION,
        userId: userId ?? null,
      };

      await stepLifecycle?.startStep?.({
        id: researchQuestionStepId,
        input: researchQuestionInput,
        label: "Research Question",
        type: "research_question",
      });

      try {
        // A research question is text this skill composed around the user's
        // topic, not the user's message: it reads session memory but writes
        // none. The agent records the user's exchange once, after finalizing.
        const value = await ragService.chat(docIds, entry.question, {
          sessionId: sessionId ?? null,
          userId: userId ?? null,
          includeRetrievedContexts: true,
          accessScope,
          memoryWrites: false,
        });
        const citations = value.citations ?? [];
        const result = {
          id: entry.id,
          question: entry.question,
          status: "completed",
          text: value.text,
          citations,
          abstained: Boolean(value.abstained),
          abstainReason: value.abstainReason ?? null,
          resolvedQuery: value.resolvedQuery ?? entry.question,
        };

        await stepLifecycle?.completeStep?.({
          id: researchQuestionStepId,
          output: {
            abstained: result.abstained,
            citationCount: citations.length,
            researchQuestionId: entry.id,
            resolvedQuery: result.resolvedQuery,
            text: result.text ?? "",
          },
        });

        results.push(result);
        evidenceResults.push({
          ...result,
          citations: attachRetrievedEvidence({
            citations,
            retrievedContexts: value.retrievedContexts ?? [],
          }),
        });
      } catch (error) {
        if (isAgentRunInterrupt(error)) {
          await stepLifecycle?.pauseStep?.({
            detail: buildInterruptStepDetail(error),
            id: researchQuestionStepId,
          });
          throw error;
        }

        await stepLifecycle?.failStep?.({
          error,
          id: researchQuestionStepId,
        });

        const outage = toDependencyOutageError(error);

        if (outage) {
          outages.push(outage);
        }

        results.push({
          id: entry.id,
          question: entry.question,
          status: "failed",
          text: "",
          citations: [],
          abstained: false,
          abstainReason: null,
          resolvedQuery: entry.question,
          error: serializeError(error, "Research lookup failed."),
        });
      }
    }

    // Every question that ran failed because a dependency is down: the brief
    // could only say the evidence was missing. The stage fails with the outage
    // instead, and the run ends with it (agent-built-in-skill-runners.js).
    const ran = results.filter((result) => result.status !== "skipped");

    if (ran.length > 0 && outages.length === ran.length) {
      throw outages[0];
    }

    const brief = formatResearchBrief({
      question,
      documents: selectedDocuments,
      plan,
      results,
    });
    const evidenceCitations = rebaseEvidenceResults(evidenceResults).citations;

    return {
      value: {
        ...brief,
        evidenceCitations,
      },
      text: brief.text,
      citations: brief.citations ?? [],
      abstained: brief.findings?.some((finding) => finding.abstained) ?? false,
      traceDetail: {
        questionCount: plan.questions.length,
      },
    };
  },
});

export const createBuiltInSkills = () => [
  createArxivImportSkill(),
  createWorkspaceActionSkill(),
  createDocumentRagSkill(),
  createWebSearchSkill(),
  createInventorySkill(),
  createDocumentDiscoverySkill(),
  createResearchBriefSkill(),
];
