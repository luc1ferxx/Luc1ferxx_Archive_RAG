import { createHash } from "node:crypto";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const normalizeHash = (value) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/[^a-f0-9]+/g, "");

const stripArxivVersion = (value) => value.replace(/v\d+$/i, "");

const normalizeArxivIdCandidate = (value) =>
  stripArxivVersion(
    normalizeText(value)
      .toLowerCase()
      .replace(/^arxiv:/i, "")
      .replace(/\.pdf$/i, "")
      .replace(/[^a-z0-9./-]+/g, "")
  );

export const normalizeArxivId = (value) => {
  const normalizedValue = normalizeText(value);

  if (!normalizedValue) {
    return "";
  }

  const urlMatch = normalizedValue.match(
    /arxiv\.org\/(?:abs|pdf)\/([^?#\s/]+(?:\/[^?#\s/]+)?)/i
  );

  return normalizeArxivIdCandidate(urlMatch?.[1] ?? normalizedValue);
};

export const normalizeArxivPdfUrl = (value) => {
  const normalizedValue = normalizeText(value);

  if (!normalizedValue) {
    return "";
  }

  try {
    const url = new URL(normalizedValue);
    const arxivPdfMatch = url.pathname.match(/^\/pdf\/(.+?)(?:\.pdf)?\/?$/i);

    if (url.hostname.toLowerCase().endsWith("arxiv.org") && arxivPdfMatch) {
      const arxivId = normalizeArxivId(arxivPdfMatch[1]);
      return arxivId ? `https://arxiv.org/pdf/${arxivId}` : "";
    }

    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/g, "");

    return url.toString();
  } catch {
    return normalizedValue.toLowerCase().replace(/[?#].*$/g, "").replace(/\/+$/g, "");
  }
};

export const normalizeArxivTitle = (value) =>
  normalizeText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();

export const buildArxivTitleHash = (title) => {
  const normalizedTitle = normalizeArxivTitle(title);

  if (!normalizedTitle) {
    return "";
  }

  return createHash("sha256").update(normalizedTitle).digest("hex");
};

export const buildArxivPaperIdentity = (paper = {}) => ({
  arxivId: normalizeArxivId(paper.arxivId || paper.absUrl || paper.pdfUrl),
  pdfUrl: normalizeArxivPdfUrl(paper.pdfUrl),
  titleHash: buildArxivTitleHash(paper.title),
});

const getDocumentSource = (document = {}) =>
  document?.source ?? document?.profile?.source ?? null;

export const buildArxivDocumentIdentity = (document = {}) => {
  const source = getDocumentSource(document);

  if (!source || source.sourceType !== "arxiv") {
    return {
      arxivId: "",
      pdfUrl: "",
      titleHash: "",
    };
  }

  return {
    arxivId: normalizeArxivId(source.arxivId || source.absUrl || source.pdfUrl),
    pdfUrl: normalizeArxivPdfUrl(source.pdfUrl),
    titleHash:
      normalizeHash(source.titleHash) || buildArxivTitleHash(source.title),
  };
};

export const getArxivDuplicateMatch = ({ document = {}, fileName = "", paper = {} }) => {
  if (document.fileName && fileName && document.fileName === fileName) {
    return "fileName";
  }

  const paperIdentity = buildArxivPaperIdentity(paper);
  const documentIdentity = buildArxivDocumentIdentity(document);

  if (
    paperIdentity.arxivId &&
    documentIdentity.arxivId &&
    paperIdentity.arxivId === documentIdentity.arxivId
  ) {
    return "arxivId";
  }

  if (
    paperIdentity.pdfUrl &&
    documentIdentity.pdfUrl &&
    paperIdentity.pdfUrl === documentIdentity.pdfUrl
  ) {
    return "pdfUrl";
  }

  if (
    paperIdentity.titleHash &&
    documentIdentity.titleHash &&
    paperIdentity.titleHash === documentIdentity.titleHash
  ) {
    return "titleHash";
  }

  return null;
};

export const findExistingArxivDocument = ({
  documents = [],
  fileName = "",
  paper = {},
} = {}) => {
  for (const document of documents) {
    const duplicateMatch = getArxivDuplicateMatch({
      document,
      fileName,
      paper,
    });

    if (duplicateMatch) {
      return {
        document,
        duplicateMatch,
      };
    }
  }

  return {
    document: null,
    duplicateMatch: null,
  };
};
