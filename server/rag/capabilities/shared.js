export const CAPABILITY_IDS = Object.freeze({
  arxivImportTopic: "arxiv.import_topic",
  citationVerify: "citation.verify",
  documentCompareBatch: "document.compare_batch",
  documentDiscovery: "workspace.document_discovery",
  recommendationImportSelected: "recommendation.import_selected",
  reportExport: "report.export",
  workspaceSearchDocuments: "workspace.search_documents",
  webSearch: "web.search",
});

export const BUILT_IN_CAPABILITY_VERSION = "1.0.0";

export const normalizeText = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

export const toArray = (value) => (Array.isArray(value) ? value : []);

export const normalizeTextList = (value) =>
  toArray(value).map(normalizeText).filter(Boolean);

export const normalizeLimit = (value, fallback = 5, { max = 25 } = {}) => {
  const parsed = Number.parseInt(value ?? fallback, 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;

  return Math.min(limit, max);
};
