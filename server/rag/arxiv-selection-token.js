import { normalizeText } from "../lib/normalize-text.js";

const DEFAULT_SELECTION_TTL_MS = 15 * 60 * 1000;
const TOKEN_VERSION = "v1";
const TOKEN_PURPOSE = "arxiv_document_selection";

const toArray = (value) => (Array.isArray(value) ? value : []);

const encodeJson = (value) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const decodeJson = (value) =>
  JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

const assertTokenError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  throw error;
};

export const normalizeArxivSelectionPaper = (paper = {}) => ({
  arxivId: normalizeText(paper.arxivId),
  title: normalizeText(paper.title),
  summary: normalizeText(paper.summary),
  authors: toArray(paper.authors).map(normalizeText).filter(Boolean),
  absUrl: normalizeText(paper.absUrl),
  pdfUrl: normalizeText(paper.pdfUrl),
  published: normalizeText(paper.published),
  updated: normalizeText(paper.updated),
  primaryCategory: normalizeText(paper.primaryCategory),
  categories: toArray(paper.categories).map(normalizeText).filter(Boolean),
});

// The offer a token holds, or null when it is not a selection token.
const decodeSelectionToken = (token) => {
  const [versionPart, payloadPart, ...extraParts] = normalizeText(token).split(".");

  if (versionPart !== TOKEN_VERSION || !payloadPart || extraParts.length > 0) {
    return null;
  }

  try {
    const payload = decodeJson(payloadPart);

    return payload?.version === TOKEN_VERSION && payload?.purpose === TOKEN_PURPOSE
      ? payload
      : null;
  } catch {
    return null;
  }
};

const toSelection = (payload) => ({
  docId: normalizeText(payload.docId),
  topic: normalizeText(payload.topic),
  requestedMaxResults: payload.requestedMaxResults,
  papers: toArray(payload.papers).map(normalizeArxivSelectionPaper),
});

// A selection token is the offer one search made for one document: the
// papers as arXiv returned them, and when the offer expires. It is not
// signed. The server stores the token with the offer (on the document's
// recommendation task and in its saved suggestion), and a confirmation is
// checked against that stored token, never against what the client sends
// alone: a client cannot name a paper URL the server did not get from arXiv,
// and any process that reads the stored task can check a confirmation (a
// split deployment searches on the api tier and confirms on the agent tier).
export const createArxivSelectionTokenService = ({
  now = () => Date.now(),
  ttlMs = DEFAULT_SELECTION_TTL_MS,
} = {}) => {
  const createSelectionToken = ({
    docId,
    papers = [],
    requestedMaxResults,
    topic,
  } = {}) => {
    const normalizedPapers = papers.map(normalizeArxivSelectionPaper).filter(
      (paper) => paper.arxivId && paper.pdfUrl
    );
    const payload = {
      version: TOKEN_VERSION,
      purpose: TOKEN_PURPOSE,
      docId: normalizeText(docId),
      topic: normalizeText(topic),
      requestedMaxResults,
      papers: normalizedPapers,
      expiresAt: Number(now()) + ttlMs,
    };

    return `${TOKEN_VERSION}.${encodeJson(payload)}`;
  };

  // `issuedToken`: the token stored with the offer being confirmed.
  const verifySelectionToken = (token, issuedToken) => {
    const payload = decodeSelectionToken(token);

    if (!payload) {
      assertTokenError("Invalid arXiv selection token.");
    }

    // A token, but not the stored offer: a newer search, or an import's offer
    // of the papers it left, replaced it (or the client altered it). Without a
    // signature these look the same, and none of them is downloaded.
    if (normalizeText(token) !== normalizeText(issuedToken)) {
      assertTokenError("These arXiv recommendations are no longer current; search again.", 409);
    }

    if (Number(payload.expiresAt) < Number(now())) {
      assertTokenError("Expired arXiv selection token.", 410);
    }

    return toSelection(payload);
  };

  // The offer in a token the server stored itself (a task's or a saved
  // suggestion's), so without the checks a client's token gets.
  const readSelectionToken = (token) => {
    const payload = decodeSelectionToken(token);

    return payload ? toSelection(payload) : null;
  };

  return {
    createSelectionToken,
    readSelectionToken,
    verifySelectionToken,
  };
};
