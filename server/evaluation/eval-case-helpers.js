import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTermSet } from "../rag/text-utils.js";
import { robustEvalSuite } from "./eval-suite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const deterministicEmbeddingDimensions = 64;

export const abstainPatterns = [
  "couldn't find enough grounded evidence",
  "comparison would be unreliable",
  "selected documents, so the comparison would be unreliable",
  "uploaded documents to answer reliably",
];

export const detectAbstain = (text) => {
  const normalizedText = String(text ?? "").toLowerCase();

  return abstainPatterns.some((pattern) => normalizedText.includes(pattern));
};

export const getResponseAbstained = (response) =>
  typeof response?.abstained === "boolean"
    ? response.abstained
    : detectAbstain(response?.text);

export const summarizeCitations = (citations, docKeyByDocId) =>
  citations.map((citation) => ({
    rank: citation.rank,
    docId: citation.docId,
    docKey: docKeyByDocId.get(citation.docId) ?? null,
    fileName: citation.fileName,
    pageNumber: citation.pageNumber,
    score: citation.score,
    sectionHeading: citation.sectionHeading,
  }));

export const evaluateExpectedCoverage = ({ citations, expectedEvidence }) => {
  if (!expectedEvidence || expectedEvidence.length === 0) {
    return {
      docCoverageHit: citations.length === 0,
      pageCoverageHit: citations.length === 0,
    };
  }

  return {
    docCoverageHit: expectedEvidence.every((expected) =>
      citations.some((citation) => citation.docKey === expected.docKey)
    ),
    pageCoverageHit: expectedEvidence.every((expected) =>
      expected.pages.length === 0
        ? citations.some((citation) => citation.docKey === expected.docKey)
        : citations.some(
            (citation) =>
              citation.docKey === expected.docKey &&
              expected.pages.includes(citation.pageNumber)
          )
    ),
  };
};

export const hashToken = (token) => {
  let hash = 0;

  for (const character of token) {
    hash = (hash * 31 + character.codePointAt(0)) % deterministicEmbeddingDimensions;
  }

  return hash;
};

export const toDeterministicEmbedding = (text) => {
  const vector = new Array(deterministicEmbeddingDimensions).fill(0);

  for (const term of buildTermSet(text)) {
    vector[hashToken(term)] += 1;
  }

  return vector;
};

export const findRobustReport = ({ corpusPath, latestName, reportType }) =>
  robustEvalSuite.reports.find(
    (report) =>
      report.reportType === reportType &&
      report.latestName === latestName &&
      path.resolve(__dirname, "..", report.corpusPath) === corpusPath
  ) ?? null;
