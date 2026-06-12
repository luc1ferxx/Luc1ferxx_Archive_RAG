import {
  DEFAULT_ARXIV_MAX_RESULTS,
  normalizeArxivMaxResults,
} from "./arxiv-client.js";
import { createArxivSelectionTokenService } from "./arxiv-selection-token.js";

const DEFAULT_TOPIC_TAG_LIMIT = 4;
const TOPIC_STOP_TERMS = new Set([
  "confidential",
  "internal",
  "private",
  "draft",
  "document",
  "policy",
  "report",
  "pdf",
]);

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeTopicTerm = (value) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, " ")
    .trim();

const getProfile = (document = {}) =>
  document.profile && typeof document.profile === "object"
    ? document.profile
    : {
        tags: document.tags ?? [],
      };

export const buildArxivTopicFromDocumentProfile = (
  document = {},
  { tagLimit = DEFAULT_TOPIC_TAG_LIMIT } = {}
) => {
  const profile = getProfile(document);
  const entityText = (profile.entities ?? [])
    .map(normalizeTopicTerm)
    .join(" ");
  const terms = [
    ...new Set(
      (profile.tags ?? [])
        .map(normalizeTopicTerm)
        .filter(
          (term) =>
            term &&
            term.length >= 3 &&
            !TOPIC_STOP_TERMS.has(term) &&
            !entityText.includes(term)
        )
    ),
  ].slice(0, tagLimit);

  return terms.join(" ");
};

const getScopedDocument = ({ accessScope, docId, ragService }) => {
  const document = ragService.getDocument?.(docId, accessScope) ?? null;

  if (!document) {
    const error = new Error("Document not found.");
    error.status = 404;
    throw error;
  }

  return document;
};

const buildDocumentSummary = (document = {}) => ({
  docId: document.docId,
  fileName: document.fileName,
});

export const createArxivEnrichmentService = ({
  arxivImportService,
  arxivService,
  ragService,
  selectionTokenService = createArxivSelectionTokenService(),
} = {}) => {
  const resolveTopicForDocument = ({ accessScope = {}, docId }) => {
    const document = getScopedDocument({
      accessScope,
      docId,
      ragService,
    });
    const topic = buildArxivTopicFromDocumentProfile(document);

    return {
      document,
      topic,
    };
  };

  const suggestForDocument = async ({
    accessScope = {},
    docId,
    maxResults = DEFAULT_ARXIV_MAX_RESULTS,
  } = {}) => {
    const { document, topic } = resolveTopicForDocument({
      accessScope,
      docId,
    });
    const requestedMaxResults = normalizeArxivMaxResults(maxResults);

    if (!topic) {
      return {
        document: buildDocumentSummary(document),
        topic: "",
        requestedMaxResults,
        papers: [],
        reason: "no_profile_topic",
      };
    }

    const papers = await arxivService.search({
      topic,
      maxResults: requestedMaxResults,
    });

    return {
      document: buildDocumentSummary(document),
      topic,
      requestedMaxResults,
      papers,
      selectionToken:
        papers.length > 0
          ? selectionTokenService.createSelectionToken({
              docId,
              papers,
              requestedMaxResults,
              topic,
            })
          : null,
      reason: papers.length === 0 ? "no_arxiv_matches" : null,
    };
  };

  const importForDocument = async ({
    accessScope = {},
    docId,
    selectionToken,
  } = {}) => {
    const { document, topic } = resolveTopicForDocument({
      accessScope,
      docId,
    });

    if (!topic) {
      const error = new Error(
        "No arXiv topic could be derived from this document profile."
      );
      error.status = 422;
      throw error;
    }

    if (!selectionToken) {
      const error = new Error("selectionToken is required.");
      error.status = 400;
      throw error;
    }

    const selection = selectionTokenService.verifySelectionToken(selectionToken);

    if (selection.docId !== docId) {
      const error = new Error("arXiv selection token does not match this document.");
      error.status = 400;
      throw error;
    }

    if (selection.topic !== topic) {
      const error = new Error(
        "arXiv selection token no longer matches this document profile."
      );
      error.status = 409;
      throw error;
    }

    return {
      document: buildDocumentSummary(document),
      ...(await arxivImportService.importPapers({
        accessScope,
        maxResults: normalizeArxivMaxResults(
          selection.requestedMaxResults,
          selection.papers.length || DEFAULT_ARXIV_MAX_RESULTS
        ),
        papers: selection.papers,
        topic,
      })),
    };
  };

  return {
    importForDocument,
    resolveTopicForDocument,
    suggestForDocument,
  };
};
