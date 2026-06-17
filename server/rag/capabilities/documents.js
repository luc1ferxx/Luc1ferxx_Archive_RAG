import { extractMeaningfulTokens, normalizeSearchText } from "../text-utils.js";
import {
  BUILT_IN_CAPABILITY_VERSION,
  CAPABILITY_IDS,
  normalizeLimit,
  normalizeText,
  normalizeTextList,
  toArray,
} from "./shared.js";

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
    ...toArray(profile.tags),
    ...toArray(profile.entities),
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

const discoverDocuments = ({
  documents,
  docIds = [],
  limit = 5,
  question,
}) => {
  const docIdFilter = new Set(docIds);
  const candidateDocuments =
    docIdFilter.size > 0
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
    .slice(0, limit);
};

const compactDocument = (document = {}) => {
  const profile = getProfile(document);

  return {
    docId: normalizeText(document.docId),
    fileName: normalizeText(document.fileName),
    pageCount: Number.parseInt(document.pageCount ?? "0", 10) || 0,
    chunkCount: Number.parseInt(document.chunkCount ?? "0", 10) || 0,
    profile: {
      summary: normalizeText(profile.summary),
      tags: toArray(profile.tags).map(normalizeText).filter(Boolean).slice(0, 12),
      entities: toArray(profile.entities)
        .map(normalizeText)
        .filter(Boolean)
        .slice(0, 12),
    },
  };
};

const buildSearchDocumentsText = ({ matches = [], query = "" } = {}) => {
  if (matches.length === 0) {
    return `No workspace documents matched "${normalizeText(query)}".`;
  }

  return [
    `Found ${matches.length} workspace document${
      matches.length === 1 ? "" : "s"
    } matching "${normalizeText(query)}":`,
    ...matches.map(
      (match, index) =>
        `${index + 1}. ${match.document.fileName || match.document.docId} (score ${match.score})`
    ),
  ].join("\n");
};

const buildDiscoveryMatch = ({ document, score }) => ({
  document: compactDocument(document),
  score,
});

const normalizeCompareBatches = (input = {}) => {
  const explicitBatches = toArray(input.batches)
    .filter((batch) => batch && typeof batch === "object" && !Array.isArray(batch))
    .map((batch, index) => ({
      id: normalizeText(batch.id) || `batch-${index + 1}`,
      docIds: normalizeTextList(batch.docIds),
      question: normalizeText(batch.question) || normalizeText(input.question),
    }))
    .filter((batch) => batch.docIds.length >= 2);

  if (explicitBatches.length > 0) {
    return explicitBatches.slice(0, 5);
  }

  const docIds = normalizeTextList(input.docIds);

  return docIds.length >= 2
    ? [
        {
          id: "batch-1",
          docIds,
          question: normalizeText(input.question),
        },
      ]
    : [];
};

const buildCompareBatchQuestion = ({ batch = {}, documents = [], question }) => {
  const documentList = documents
    .map((document) => `- ${document.fileName ?? document.docId}`)
    .join("\n");

  return [
    "Compare the selected documents using only citation-backed document evidence.",
    "Call out common ground, differences, conflicts, missing terms, and evidence limits.",
    "Do not infer unsupported claims. Every substantive comparison point needs citations.",
    documentList ? `Selected documents:\n${documentList}` : "",
    `Batch: ${batch.id}`,
    `Original request: ${normalizeText(batch.question) || normalizeText(question)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

const formatCompareBatchText = (comparisons = []) => {
  if (comparisons.length === 0) {
    return "No document comparison batches were completed.";
  }

  return comparisons
    .map((comparison, index) =>
      [
        `Batch ${index + 1}: ${comparison.id}`,
        comparison.text,
      ].join("\n")
    )
    .join("\n\n");
};

export const createDocumentDiscoveryCapability = ({ ragService } = {}) => ({
  id: CAPABILITY_IDS.documentDiscovery,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "Workspace Document Discovery",
  inputSchema: {
    type: "object",
    required: ["question"],
    properties: {
      docIds: {
        items: {
          type: "string",
        },
        type: "array",
      },
      limit: {
        type: "integer",
      },
      question: {
        type: "string",
      },
    },
  },
  accessScope: {
    required: true,
  },
  approvalPolicy: {
    mode: "user_confirmation",
    writesWorkspace: false,
    userConfirmationRequired: true,
  },
  privacyPolicy: {
    externalCall: false,
    sanitizedInputFields: ["question", "docIds", "limit"],
    storesResult: false,
  },
  execute: async ({ accessScope, input }) => {
    const documents = ragService.listDocuments?.(accessScope) ?? [];

    return {
      documents,
      matches: discoverDocuments({
        documents,
        docIds: toArray(input.docIds),
        limit: Number.parseInt(input.limit ?? "5", 10) || 5,
        question: input.question,
      }),
    };
  },
});

export const createWorkspaceSearchDocumentsCapability = ({ ragService } = {}) => ({
  id: CAPABILITY_IDS.workspaceSearchDocuments,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "Workspace Document Search",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      docIds: {
        items: {
          type: "string",
        },
        type: "array",
      },
      limit: {
        type: "integer",
      },
      query: {
        type: "string",
      },
    },
  },
  accessScope: {
    required: true,
  },
  approvalPolicy: {
    mode: "user_confirmation",
    writesWorkspace: false,
    userConfirmationRequired: true,
  },
  privacyPolicy: {
    externalCall: false,
    sanitizedInputFields: ["query", "docIds", "limit"],
    storesResult: false,
  },
  execute: async ({ accessScope, input }) => {
    const documents = ragService.listDocuments?.(accessScope) ?? [];
    const matches = discoverDocuments({
      documents,
      docIds: normalizeTextList(input.docIds),
      limit: normalizeLimit(input.limit, 8, {
        max: 25,
      }),
      question: input.query,
    }).map(buildDiscoveryMatch);

    return {
      documentCount: documents.length,
      matches,
      text: buildSearchDocumentsText({
        matches,
        query: input.query,
      }),
    };
  },
});

export const createDocumentCompareBatchCapability = ({ ragService } = {}) => ({
  id: CAPABILITY_IDS.documentCompareBatch,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "Document Compare Batch",
  inputSchema: {
    type: "object",
    required: ["question"],
    properties: {
      batches: {
        type: "array",
      },
      docIds: {
        items: {
          type: "string",
        },
        type: "array",
      },
      question: {
        type: "string",
      },
      retrievalPlan: {
        type: "object",
      },
    },
  },
  accessScope: {
    required: true,
  },
  approvalPolicy: {
    mode: "user_confirmation",
    writesWorkspace: false,
    userConfirmationRequired: true,
  },
  privacyPolicy: {
    externalCall: true,
    sanitizedInputFields: ["question", "docIds"],
    storesResult: false,
  },
  execute: async ({ accessScope, input }) => {
    const batches = normalizeCompareBatches(input);

    if (batches.length === 0) {
      const error = new Error(
        "document.compare_batch requires at least one batch with two or more docIds."
      );
      error.status = 400;
      throw error;
    }

    const documents = ragService.listDocuments?.(accessScope) ?? [];
    const documentsById = new Map(
      documents.map((document) => [normalizeText(document.docId), document])
    );
    const comparisons = [];

    for (const batch of batches) {
      const selectedDocuments = batch.docIds
        .map((docId) => documentsById.get(docId))
        .filter(Boolean);
      const compareQuestion = buildCompareBatchQuestion({
        batch,
        documents: selectedDocuments,
        question: input.question,
      });
      const value = await ragService.chat(batch.docIds, compareQuestion, {
        accessScope,
        retrievalPlan: input.retrievalPlan ?? null,
      });

      comparisons.push({
        id: batch.id,
        docIds: batch.docIds,
        text: value.text,
        citations: value.citations ?? [],
        abstained: Boolean(value.abstained),
        compareQuestion,
      });
    }

    return {
      comparisons,
      citations: comparisons.flatMap((comparison) => comparison.citations),
      text: formatCompareBatchText(comparisons),
    };
  },
});
