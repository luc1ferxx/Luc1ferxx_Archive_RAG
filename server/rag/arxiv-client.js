import { XMLParser } from "fast-xml-parser";

export const DEFAULT_ARXIV_API_URL = "https://export.arxiv.org/api/query";
export const DEFAULT_ARXIV_MAX_RESULTS = 3;
export const MAX_ARXIV_RESULTS = 10;

const ARXIV_RAW_QUERY_PATTERN = /\b(?:all|ti|au|abs|co|jr|cat|rn|id):/i;

const parser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
});

const asArray = (value) => {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

const normalizeText = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

export const normalizeArxivMaxResults = (
  value,
  fallbackValue = DEFAULT_ARXIV_MAX_RESULTS
) => {
  const parsedValue = Number.parseInt(value ?? fallbackValue, 10);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return Math.min(parsedValue, MAX_ARXIV_RESULTS);
};

const buildSearchQuery = (topic) => {
  const normalizedTopic = normalizeText(topic);

  if (!normalizedTopic) {
    throw new Error("An arXiv topic is required.");
  }

  if (ARXIV_RAW_QUERY_PATTERN.test(normalizedTopic)) {
    return normalizedTopic;
  }

  const terms = normalizedTopic
    .split(/[^A-Za-z0-9._-]+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 8);

  if (terms.length === 0) {
    throw new Error("An arXiv topic must contain at least one searchable term.");
  }

  return terms.map((term) => `all:${term}`).join(" AND ");
};

export const buildArxivSearchUrl = ({
  apiUrl = DEFAULT_ARXIV_API_URL,
  maxResults = DEFAULT_ARXIV_MAX_RESULTS,
  sortBy = "submittedDate",
  sortOrder = "descending",
  start = 0,
  topic,
} = {}) => {
  const url = new URL(apiUrl);

  url.searchParams.set("search_query", buildSearchQuery(topic));
  url.searchParams.set("start", String(Math.max(0, Number.parseInt(start, 10) || 0)));
  url.searchParams.set("max_results", String(normalizeArxivMaxResults(maxResults)));
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", sortOrder);

  return url;
};

const getLinkUrl = (entry, predicate) => {
  const link = asArray(entry.link).find(predicate);

  return normalizeText(link?.href);
};

const extractArxivId = (entry = {}) => {
  const id = normalizeText(entry.id);
  const match = id.match(/arxiv\.org\/abs\/([^?#]+)/i);

  return normalizeText(match?.[1] ?? id.replace(/^.*\//, ""));
};

const normalizeAuthors = (entry = {}) =>
  asArray(entry.author)
    .map((author) => normalizeText(author?.name ?? author))
    .filter(Boolean);

const normalizeCategories = (entry = {}) =>
  [
    entry.primary_category?.term,
    ...asArray(entry.category).map((category) => category?.term),
  ]
    .map(normalizeText)
    .filter(Boolean)
    .filter((term, index, values) => values.indexOf(term) === index);

export const parseArxivFeed = (xml) => {
  const payload = parser.parse(xml);
  const entries = asArray(payload?.feed?.entry);

  return entries.map((entry) => {
    const absUrl =
      getLinkUrl(
        entry,
        (link) => link?.rel === "alternate" || link?.type === "text/html"
      ) || normalizeText(entry.id);
    const pdfUrl = getLinkUrl(
      entry,
      (link) => link?.title === "pdf" || link?.type === "application/pdf"
    );
    const arxivId = extractArxivId(entry);

    return {
      arxivId,
      title: normalizeText(entry.title),
      summary: normalizeText(entry.summary),
      authors: normalizeAuthors(entry),
      published: normalizeText(entry.published),
      updated: normalizeText(entry.updated),
      absUrl,
      pdfUrl: pdfUrl || (arxivId ? `https://arxiv.org/pdf/${arxivId}` : ""),
      primaryCategory: normalizeText(entry.primary_category?.term),
      categories: normalizeCategories(entry),
    };
  });
};

export const createArxivService = ({
  apiUrl = DEFAULT_ARXIV_API_URL,
  fetchImpl = fetch,
  userAgent = "Luc1ferxx-Archive-RAG arXiv importer (local research)",
} = {}) => {
  const search = async ({
    maxResults = DEFAULT_ARXIV_MAX_RESULTS,
    sortBy = "submittedDate",
    sortOrder = "descending",
    start = 0,
    topic,
  } = {}) => {
    const url = buildArxivSearchUrl({
      apiUrl,
      maxResults,
      sortBy,
      sortOrder,
      start,
      topic,
    });
    const response = await fetchImpl(url, {
      headers: {
        "accept": "application/atom+xml,application/xml,text/xml,*/*;q=0.8",
        "user-agent": userAgent,
      },
    });

    if (!response.ok) {
      const error = new Error(`arXiv search failed with HTTP ${response.status}.`);
      error.status = 502;
      throw error;
    }

    return parseArxivFeed(await response.text());
  };

  const downloadPdf = async (paper = {}) => {
    const pdfUrl = normalizeText(paper.pdfUrl);

    if (!pdfUrl) {
      throw new Error(`Missing arXiv PDF URL for ${paper.arxivId ?? "paper"}.`);
    }

    const response = await fetchImpl(pdfUrl, {
      headers: {
        "accept": "application/pdf,*/*;q=0.8",
        "user-agent": userAgent,
      },
    });

    if (!response.ok) {
      const error = new Error(
        `Failed to download arXiv PDF ${paper.arxivId ?? pdfUrl}: HTTP ${response.status}.`
      );
      error.status = 502;
      throw error;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new Error(
        `Downloaded content for arXiv paper ${paper.arxivId ?? pdfUrl} is not a PDF.`
      );
    }

    return buffer;
  };

  return {
    downloadPdf,
    search,
  };
};
