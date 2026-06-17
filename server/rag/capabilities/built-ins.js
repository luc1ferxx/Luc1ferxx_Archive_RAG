import {
  DEFAULT_ARXIV_MAX_RESULTS,
  normalizeArxivMaxResults,
} from "../arxiv-client.js";
import { extractMeaningfulTokens, normalizeSearchText } from "../text-utils.js";
import { createCapabilityRegistry } from "./registry.js";

export const CAPABILITY_IDS = Object.freeze({
  arxivImportTopic: "arxiv.import_topic",
  documentDiscovery: "workspace.document_discovery",
  webSearch: "web.search",
});

export const BUILT_IN_CAPABILITY_VERSION = "1.0.0";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

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

export const createArxivImportTopicCapability = ({ arxivImportService } = {}) => ({
  id: CAPABILITY_IDS.arxivImportTopic,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "arXiv Topic Import",
  inputSchema: {
    type: "object",
    required: ["topic"],
    properties: {
      maxResults: {
        type: "integer",
      },
      topic: {
        type: "string",
      },
    },
  },
  accessScope: {
    required: true,
  },
  approvalPolicy: {
    mode: "user_confirmation",
    writesWorkspace: true,
    userConfirmationRequired: true,
  },
  privacyPolicy: {
    externalCall: true,
    sanitizedInputFields: ["topic", "maxResults"],
    storesResult: true,
  },
  execute: async ({ accessScope, input }) =>
    arxivImportService.importTopic({
      accessScope,
      maxResults: normalizeArxivMaxResults(
        input.maxResults,
        DEFAULT_ARXIV_MAX_RESULTS
      ),
      topic: normalizeText(input.topic),
    }),
});

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

export const createWebSearchCapability = ({ webChatService } = {}) => ({
  id: CAPABILITY_IDS.webSearch,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "Web Search",
  inputSchema: {
    type: "object",
    required: ["question"],
    properties: {
      question: {
        type: "string",
      },
    },
  },
  accessScope: {
    required: false,
  },
  approvalPolicy: {
    mode: "user_confirmation",
    writesWorkspace: false,
    userConfirmationRequired: true,
  },
  privacyPolicy: {
    externalCall: true,
    sanitizedInputFields: ["question"],
    storesResult: false,
  },
  execute: async ({ input }) => webChatService(input.question),
});

export const createBuiltInCapabilities = ({
  arxivImportService,
  ragService,
  webChatService,
} = {}) => [
  createArxivImportTopicCapability({
    arxivImportService,
  }),
  createDocumentDiscoveryCapability({
    ragService,
  }),
  createWebSearchCapability({
    webChatService,
  }),
];

export const createDefaultCapabilityRegistry = (services = {}) =>
  createCapabilityRegistry(createBuiltInCapabilities(services));
