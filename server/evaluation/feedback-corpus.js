import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const NEGATIVE_FEEDBACK_TYPES = new Set([
  "citation_error",
  "incomplete",
  "hallucination",
]);

const normalizeText = (value) => String(value ?? "").trim();

const toIdentifier = (value, fallbackValue = "item") => {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || fallbackValue;
};

const normalizeDocIds = (docIds) => {
  if (Array.isArray(docIds)) {
    return [...new Set(docIds.map((docId) => normalizeText(docId)).filter(Boolean))];
  }

  if (typeof docIds === "string") {
    return [
      ...new Set(
        docIds
          .split(",")
          .map((docId) => normalizeText(docId))
          .filter(Boolean)
      ),
    ];
  }

  return [];
};

const normalizePageNumber = (pageNumber) => {
  const parsedPageNumber = Number.parseInt(pageNumber ?? "1", 10);

  return Number.isInteger(parsedPageNumber) && parsedPageNumber > 0
    ? parsedPageNumber
    : 1;
};

const normalizeCitation = (citation = {}) => ({
  docId: normalizeText(citation.docId),
  fileName: normalizeText(citation.fileName),
  pageNumber: normalizePageNumber(citation.pageNumber),
  excerpt: normalizeText(citation.excerpt),
});

const normalizeSkill = (skill = {}) => ({
  skillId: normalizeText(skill.skillId ?? skill.id),
  skillVersion: normalizeText(skill.skillVersion ?? skill.version),
  label: normalizeText(skill.label),
  status: normalizeText(skill.status),
});

const normalizeSkills = (skills) =>
  Array.isArray(skills)
    ? skills
        .map(normalizeSkill)
        .filter((skill) => skill.skillId)
    : [];

const normalizeClaimCheck = (claimCheck = {}) => ({
  checked: Boolean(claimCheck.checked),
  supportedClaimCount: Number.isFinite(Number(claimCheck.supportedClaimCount))
    ? Number(claimCheck.supportedClaimCount)
    : 0,
  unsupportedClaimCount: Number.isFinite(Number(claimCheck.unsupportedClaimCount))
    ? Number(claimCheck.unsupportedClaimCount)
    : 0,
  claims: Array.isArray(claimCheck.claims)
    ? claimCheck.claims.slice(0, 12).map((claim) => ({
        text: normalizeText(claim.text),
        supported: Boolean(claim.supported),
        tokenOverlap: Number.isFinite(claim.tokenOverlap)
          ? claim.tokenOverlap
          : null,
        anchors: Array.isArray(claim.anchors)
          ? claim.anchors.map(normalizeText).filter(Boolean).slice(0, 12)
          : [],
        missingAnchors: Array.isArray(claim.missingAnchors)
          ? claim.missingAnchors.map(normalizeText).filter(Boolean).slice(0, 12)
          : [],
      }))
    : [],
});

const normalizeClaimChecks = (claimChecks) =>
  Array.isArray(claimChecks) ? claimChecks.map(normalizeClaimCheck).slice(0, 4) : [];

const getFeedbackId = (record, index) =>
  normalizeText(record.feedbackId) || `feedback-${index + 1}`;

const inferCaseType = ({ question, docKeys }) => {
  if (docKeys.length > 1) {
    return "compare";
  }

  return /\b(compare|difference|different|contrast)\b|对比|比较|差异/i.test(question)
    ? "compare"
    : "qa";
};

const buildFallbackPage = (record) =>
  [
    "Feedback sample",
    `Question: ${normalizeText(record.question)}`,
    `Previous answer: ${normalizeText(record.answerText)}`,
    normalizeText(record.note) ? `User note: ${normalizeText(record.note)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

const ensurePage = (pages, pageNumber, fallbackPage) => {
  while (pages.length < pageNumber) {
    pages.push(fallbackPage);
  }
};

const getDocumentKey = ({ feedbackId, docId }) =>
  `${toIdentifier(feedbackId, "feedback")}_${toIdentifier(docId, "doc")}`;

const getDocumentFileName = ({ docId, citation }) =>
  citation?.fileName || `${toIdentifier(docId, "document")}.pdf`;

const buildDocumentsForRecord = ({ record, feedbackId }) => {
  const citations = (record.citations ?? [])
    .map(normalizeCitation)
    .filter((citation) => citation.docId);
  const citationDocIds = [...new Set(citations.map((citation) => citation.docId))];
  const docIds = citationDocIds.length > 0
    ? citationDocIds
    : normalizeDocIds(record.docIds);
  const fallbackPage = buildFallbackPage(record);

  return docIds.map((docId) => {
    const documentCitations = citations.filter((citation) => citation.docId === docId);
    const maxPageNumber = Math.max(
      1,
      ...documentCitations.map((citation) => citation.pageNumber)
    );
    const pages = [];

    ensurePage(pages, maxPageNumber, fallbackPage);

    for (const citation of documentCitations) {
      pages[citation.pageNumber - 1] = citation.excerpt || fallbackPage;
    }

    return {
      key: getDocumentKey({
        feedbackId,
        docId,
      }),
      fileName: getDocumentFileName({
        docId,
        citation: documentCitations[0],
      }),
      pages,
    };
  });
};

const buildExpectedEvidence = ({ record, feedbackId, documents }) => {
  const citations = (record.citations ?? [])
    .map(normalizeCitation)
    .filter((citation) => citation.docId && citation.excerpt);

  if (citations.length === 0) {
    return [];
  }

  const documentKeys = new Set(documents.map((document) => document.key));
  const pagesByDocKey = new Map();

  for (const citation of citations) {
    const docKey = getDocumentKey({
      feedbackId,
      docId: citation.docId,
    });

    if (!documentKeys.has(docKey)) {
      continue;
    }

    const pages = pagesByDocKey.get(docKey) ?? new Set();
    pages.add(citation.pageNumber);
    pagesByDocKey.set(docKey, pages);
  }

  return [...pagesByDocKey.entries()].map(([docKey, pages]) => ({
    docKey,
    pages: [...pages].sort((left, right) => left - right),
  }));
};

const shouldAbstainForFeedback = ({ feedbackType, expectedEvidence }) =>
  feedbackType === "hallucination" && expectedEvidence.length === 0;

const buildFeedbackMetadata = ({ record, feedbackType }) => ({
  feedbackId: normalizeText(record.feedbackId),
  feedbackType,
  createdAt: normalizeText(record.createdAt),
  userId: normalizeText(record.userId),
  workspaceId: normalizeText(record.workspaceId),
  note: normalizeText(record.note),
  originalDocIds: normalizeDocIds(record.docIds),
  skills: normalizeSkills(record.skills),
  claimChecks: normalizeClaimChecks(record.claimChecks),
  ...(feedbackType === "citation_error" ? { reviewRequired: true } : {}),
});

export const buildFeedbackCorpusFromRecords = (records = []) => {
  const documentsByKey = new Map();
  const cases = [];

  records.forEach((record, index) => {
    const feedbackType = normalizeText(record.feedbackType);

    if (!NEGATIVE_FEEDBACK_TYPES.has(feedbackType)) {
      return;
    }

    const question = normalizeText(record.question);

    if (!question) {
      return;
    }

    const feedbackId = getFeedbackId(record, index);
    const documents = buildDocumentsForRecord({
      record,
      feedbackId,
    });

    for (const document of documents) {
      documentsByKey.set(document.key, document);
    }

    const expectedEvidence = buildExpectedEvidence({
      record,
      feedbackId,
      documents,
    });
    const docKeys = documents.map((document) => document.key);

    cases.push({
      id: `feedback_${toIdentifier(feedbackType, "type")}_${toIdentifier(feedbackId, "case")}`,
      type: inferCaseType({
        question,
        docKeys,
      }),
      docKeys,
      question,
      shouldAbstain: shouldAbstainForFeedback({
        feedbackType,
        expectedEvidence,
      }),
      referenceAnswer: normalizeText(record.note) || normalizeText(record.answerText),
      expectedEvidence,
      metadata: {
        feedback: buildFeedbackMetadata({
          record,
          feedbackType,
        }),
      },
    });
  });

  return {
    documents: [...documentsByKey.values()].sort((left, right) =>
      left.key.localeCompare(right.key)
    ),
    cases: cases.sort((left, right) => left.id.localeCompare(right.id)),
  };
};

export const readFeedbackJsonl = async (inputPath) => {
  let content = "";

  try {
    content = await readFile(inputPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

export const buildFeedbackCorpusFromJsonlFile = async ({
  inputPath,
  outputPath,
}) => {
  const records = await readFeedbackJsonl(inputPath);
  const corpus = buildFeedbackCorpusFromRecords(records);

  if (outputPath) {
    await mkdir(path.dirname(outputPath), {
      recursive: true,
    });
    await writeFile(outputPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
  }

  return corpus;
};
