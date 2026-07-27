export { CHECKABLE_CITATION_FIELDS } from "./self-check/patterns.js";
export { getCitationDocIds, hasCheckableCitationText } from "./self-check/attribution.js";
export {
  evaluateClaimSupport,
  evaluateAnswerEvidence,
  evaluateDocumentEvidence,
  selectBetterRagResult,
} from "./self-check/evaluate.js";
export { buildEvidenceGaps, buildEvidenceRetryQuestion } from "./self-check/gaps.js";
