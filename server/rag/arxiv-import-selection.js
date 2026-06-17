import { isExternalQueryPolicyAllowed } from "./external-query-policy.js";
import { filterRelevantArxivPapers } from "./arxiv-query-policy.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const assertSelectionError = (message) => {
  const error = new Error(message);
  error.status = 400;
  throw error;
};

export const normalizeSelectedArxivIds = (selectedArxivIds) => {
  if (selectedArxivIds === undefined || selectedArxivIds === null) {
    return null;
  }

  if (!Array.isArray(selectedArxivIds)) {
    assertSelectionError("selectedArxivIds must be an array.");
  }

  const ids = [
    ...new Set(selectedArxivIds.map(normalizeText).filter(Boolean)),
  ];

  if (ids.length === 0) {
    assertSelectionError("Select at least one arXiv paper to import.");
  }

  return ids;
};

export const getSelectedArxivPapers = ({ papers = [], selectedArxivIds }) => {
  const normalizedIds = normalizeSelectedArxivIds(selectedArxivIds);

  if (!normalizedIds) {
    return papers;
  }

  const papersById = new Map(
    papers
      .map((paper) => [normalizeText(paper.arxivId), paper])
      .filter(([arxivId]) => arxivId)
  );
  const missingIds = normalizedIds.filter((arxivId) => !papersById.has(arxivId));

  if (missingIds.length > 0) {
    assertSelectionError("Selected arXiv papers are not in this recommendation set.");
  }

  return normalizedIds.map((arxivId) => papersById.get(arxivId));
};

export const prepareArxivImportForDocument = ({
  accessScope = {},
  docId,
  resolveTopicForDocument,
  selectedArxivIds,
  selectionToken,
  selectionTokenService,
} = {}) => {
  const { document, queryPolicy, topic } = resolveTopicForDocument({
    accessScope,
    docId,
  });

  if (!isExternalQueryPolicyAllowed(queryPolicy)) {
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

  const selectedPapers = getSelectedArxivPapers({
    papers: selection.papers,
    selectedArxivIds,
  });
  const relevantSelectedPapers = filterRelevantArxivPapers({
    document,
    papers: selectedPapers,
    topic,
  });

  if (relevantSelectedPapers.length !== selectedPapers.length) {
    const error = new Error(
      "Selected arXiv papers no longer pass relevance checks."
    );
    error.status = 409;
    throw error;
  }

  return {
    docId,
    document,
    queryPolicy,
    relevantSelectedPapers,
    topic,
  };
};
