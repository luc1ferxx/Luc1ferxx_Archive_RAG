import { evaluateClaimSupport } from "../agent-self-check.js";
import {
  BUILT_IN_CAPABILITY_VERSION,
  CAPABILITY_IDS,
  normalizeText,
  toArray,
} from "./shared.js";

const getCitationText = (citation = {}) =>
  normalizeText(
    [
      citation.excerpt,
      citation.text,
      citation.pageContent,
      citation.content,
    ]
      .filter(Boolean)
      .join(" ")
  );

const hasCitationLocation = (citation = {}) =>
  Boolean(
    normalizeText(citation.docId) ||
      normalizeText(citation.fileName) ||
      normalizeText(citation.url)
  );

const verifyCitations = ({ answerText = "", citations = [] } = {}) => {
  const normalizedCitations = toArray(citations);
  const citationChecks = normalizedCitations.map((citation, index) => ({
    index,
    hasEvidenceText: Boolean(getCitationText(citation)),
    hasLocation: hasCitationLocation(citation),
    pageNumber: citation?.pageNumber ?? null,
    docId: normalizeText(citation?.docId),
    fileName: normalizeText(citation?.fileName),
  }));
  const claimSupport = evaluateClaimSupport({
    answerText,
    citations: normalizedCitations,
  });
  const reasons = [];

  if (!normalizeText(answerText)) {
    reasons.push("answerText is empty");
  }

  if (normalizedCitations.length === 0) {
    reasons.push("citations are empty");
  }

  if (citationChecks.some((check) => !check.hasEvidenceText)) {
    reasons.push("one or more citations lack checkable evidence text");
  }

  if (citationChecks.some((check) => !check.hasLocation)) {
    reasons.push("one or more citations lack a document, file, or URL location");
  }

  if (claimSupport.unsupportedClaimCount > 0) {
    reasons.push(
      `${claimSupport.unsupportedClaimCount} claim${
        claimSupport.unsupportedClaimCount === 1 ? "" : "s"
      } lacked citation support`
    );
  }

  return {
    citationChecks,
    claimSupport,
    passed: reasons.length === 0,
    reasons,
  };
};

export const createCitationVerifyCapability = () => ({
  id: CAPABILITY_IDS.citationVerify,
  version: BUILT_IN_CAPABILITY_VERSION,
  label: "Citation Verification",
  inputSchema: {
    type: "object",
    required: ["answerText", "citations"],
    properties: {
      answerText: {
        type: "string",
      },
      citations: {
        type: "array",
      },
    },
  },
  accessScope: {
    required: false,
  },
  approvalPolicy: {
    mode: "direct",
    writesWorkspace: false,
    userConfirmationRequired: false,
  },
  privacyPolicy: {
    externalCall: false,
    sanitizedInputFields: [],
    storesResult: false,
  },
  execute: async ({ input }) => {
    const result = verifyCitations({
      answerText: input.answerText,
      citations: input.citations,
    });

    return {
      ...result,
      text: result.passed
        ? "Citation verification passed."
        : `Citation verification failed: ${result.reasons.join("; ")}.`,
    };
  },
});
