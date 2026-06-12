import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const DEFAULT_SELECTION_TTL_MS = 15 * 60 * 1000;
const TOKEN_VERSION = "v1";
const TOKEN_PURPOSE = "arxiv_document_selection";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const encodeJson = (value) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const decodeJson = (value) =>
  JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

const signPayload = ({ payloadPart, secret }) =>
  createHmac("sha256", secret).update(payloadPart).digest("base64url");

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

export const createArxivSelectionTokenService = ({
  now = () => Date.now(),
  secret = randomUUID(),
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
    const payloadPart = encodeJson(payload);
    const signaturePart = signPayload({
      payloadPart,
      secret,
    });

    return `${TOKEN_VERSION}.${payloadPart}.${signaturePart}`;
  };

  const verifySelectionToken = (token) => {
    const normalizedToken = normalizeText(token);
    const [versionPart, payloadPart, signaturePart, ...extraParts] =
      normalizedToken.split(".");

    if (
      versionPart !== TOKEN_VERSION ||
      !payloadPart ||
      !signaturePart ||
      extraParts.length > 0
    ) {
      assertTokenError("Invalid arXiv selection token.");
    }

    const expectedSignature = signPayload({
      payloadPart,
      secret,
    });
    const receivedSignatureBuffer = Buffer.from(signaturePart, "base64url");
    const expectedSignatureBuffer = Buffer.from(expectedSignature, "base64url");

    if (
      receivedSignatureBuffer.length !== expectedSignatureBuffer.length ||
      !timingSafeEqual(receivedSignatureBuffer, expectedSignatureBuffer)
    ) {
      assertTokenError("Invalid arXiv selection token.");
    }

    let payload;

    try {
      payload = decodeJson(payloadPart);
    } catch {
      assertTokenError("Invalid arXiv selection token.");
    }

    if (payload?.version !== TOKEN_VERSION || payload?.purpose !== TOKEN_PURPOSE) {
      assertTokenError("Invalid arXiv selection token.");
    }

    if (Number(payload.expiresAt) < Number(now())) {
      assertTokenError("Expired arXiv selection token.", 410);
    }

    return {
      docId: normalizeText(payload.docId),
      topic: normalizeText(payload.topic),
      requestedMaxResults: payload.requestedMaxResults,
      papers: toArray(payload.papers).map(normalizeArxivSelectionPaper),
    };
  };

  return {
    createSelectionToken,
    verifySelectionToken,
  };
};
