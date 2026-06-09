import { consumeBudget } from "../agent-budget.js";
import {
  buildResearchPlan,
  formatResearchBrief,
} from "../research-brief.js";
import { extractMeaningfulTokens, normalizeSearchText } from "../text-utils.js";

export const AGENT_SKILL_IDS = {
  documentRag: "document_rag",
  webSearch: "web_search",
  inventory: "inventory",
  documentDiscovery: "document_discovery",
  researchBrief: "research_brief",
};

export const BUILT_IN_SKILL_VERSION = "1.0.0";

const normalizeText = (value) => String(value ?? "").trim();

const getDocumentLabel = (document) => {
  const pageCount = Number.parseInt(document?.pageCount ?? "0", 10);
  const chunkCount = Number.parseInt(document?.chunkCount ?? "0", 10);
  const stats = [
    Number.isFinite(pageCount) && pageCount > 0 ? `${pageCount} pages` : null,
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

const getProfile = (document = {}) =>
  document.profile && typeof document.profile === "object"
    ? document.profile
    : {
        summary: document.summary ?? "",
        tags: document.tags ?? [],
        entities: document.entities ?? [],
      };

const getProfileSearchText = (document = {}) => {
  const profile = getProfile(document);

  return [
    document.fileName,
    profile.summary,
    ...(profile.tags ?? []),
    ...(profile.entities ?? []),
  ]
    .filter(Boolean)
    .join(" ");
};

const scoreDocumentForQuery = ({ document, queryTerms }) => {
  const normalizedProfileText = normalizeSearchText(getProfileSearchText(document));
  let score = 0;

  for (const term of queryTerms) {
    if (normalizedProfileText.includes(term)) {
      score += 1;
    }
  }

  return score;
};

const discoverDocuments = ({ documents, question, docIds }) => {
  const docIdFilter = new Set(docIds);
  const candidateDocuments = docIdFilter.size > 0
    ? documents.filter((document) => docIdFilter.has(document.docId))
    : documents;
  const queryTerms = [...new Set(extractMeaningfulTokens(question))];

  return candidateDocuments
    .map((document) => ({
      document,
      score: scoreDocumentForQuery({
        document,
        queryTerms,
      }),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        String(left.document.fileName).localeCompare(String(right.document.fileName))
    )
    .slice(0, 5);
};

const buildDiscoveryAnswer = (matches) => {
  if (matches.length === 0) {
    return "I could not find a strong matching document from the current workspace metadata.";
  }

  return [
    `I found ${matches.length} likely matching document${
      matches.length === 1 ? "" : "s"
    }:`,
    ...matches.map(({ document }) => {
      const profile = getProfile(document);
      const tags = (profile.tags ?? []).slice(0, 4);
      const tagText = tags.length > 0 ? ` Tags: ${tags.join(", ")}.` : "";
      const summaryText = profile.summary ? ` ${profile.summary}` : "";

      return `- ${document.fileName}.${tagText}${summaryText}`;
    }),
  ].join("\n");
};

const createDocumentRagSkill = () => ({
  id: AGENT_SKILL_IDS.documentRag,
  version: BUILT_IN_SKILL_VERSION,
  label: "Document RAG",
  kind: "built_in",
  budgetKey: "documentRagCalls",
  requiresAccessScope: true,
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
      accessScope,
      retrievalPlan,
    });

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

const createWebSearchSkill = () => ({
  id: AGENT_SKILL_IDS.webSearch,
  version: BUILT_IN_SKILL_VERSION,
  label: "Web Search",
  kind: "built_in",
  budgetKey: "webSearchCalls",
  requiresAccessScope: false,
  match: ({ plan }) => Boolean(plan.wantsWeb),
  plannerActions: () => [
    {
      id: "web_search",
      label: "Use web fallback",
      summary: "Use web context only after document evidence is checked.",
    },
  ],
  execute: async ({ webChatService, question }) => {
    const value = await webChatService(question);

    return {
      value,
      text: value.text,
      citations: value.citations ?? [],
      abstained: false,
    };
  },
});

const createInventorySkill = () => ({
  id: AGENT_SKILL_IDS.inventory,
  version: BUILT_IN_SKILL_VERSION,
  label: "Workspace Inventory",
  kind: "built_in",
  budgetKey: null,
  requiresAccessScope: true,
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

    return {
      value: {
        text: buildInventoryAnswer(documents),
        documents,
      },
      text: buildInventoryAnswer(documents),
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
  match: ({ plan }) => Boolean(plan.wantsDiscovery),
  plannerActions: () => [
    {
      id: "workspace_metadata",
      label: "Inspect workspace metadata",
      summary: "Use indexed document metadata without running document RAG.",
    },
  ],
  execute: async ({ ragService, question, docIds, accessScope }) => {
    const documents = ragService.listDocuments?.(accessScope) ?? [];
    const matches = discoverDocuments({
      documents,
      question,
      docIds,
    });

    return {
      value: {
        text: buildDiscoveryAnswer(matches),
        matches,
      },
      text: buildDiscoveryAnswer(matches),
      traceDetail: {
        matchCount: matches.length,
      },
    };
  },
});

const createResearchBriefSkill = () => ({
  id: AGENT_SKILL_IDS.researchBrief,
  version: BUILT_IN_SKILL_VERSION,
  label: "Research Brief",
  kind: "built_in",
  budgetKey: "researchQuestions",
  requiresAccessScope: true,
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
    budgetState,
    ragService,
    question,
    docIds,
    accessScope,
    researchPlan,
  }) => {
    const documents = ragService.listDocuments?.(accessScope) ?? [];
    const selectedDocuments = documents.filter((document) => docIds.includes(document.docId));
    const plan = researchPlan ?? buildResearchPlan({
      question,
      documents: selectedDocuments,
    });
    const results = [];

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

      try {
        const value = await ragService.chat(docIds, entry.question, {
          sessionId: null,
          userId: null,
          accessScope,
        });

        results.push({
          id: entry.id,
          question: entry.question,
          status: "completed",
          text: value.text,
          citations: value.citations ?? [],
          abstained: Boolean(value.abstained),
          abstainReason: value.abstainReason ?? null,
          resolvedQuery: value.resolvedQuery ?? entry.question,
        });
      } catch (error) {
        results.push({
          id: entry.id,
          question: entry.question,
          status: "failed",
          text: "",
          citations: [],
          abstained: false,
          abstainReason: null,
          resolvedQuery: entry.question,
          error: error instanceof Error ? error.message : "Research lookup failed.",
        });
      }
    }

    const brief = formatResearchBrief({
      question,
      documents: selectedDocuments,
      plan,
      results,
    });

    return {
      value: brief,
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
  createDocumentRagSkill(),
  createWebSearchSkill(),
  createInventorySkill(),
  createDocumentDiscoverySkill(),
  createResearchBriefSkill(),
];
