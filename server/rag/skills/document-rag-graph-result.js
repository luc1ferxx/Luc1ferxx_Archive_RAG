import { isDeepStrictEqual } from "node:util";

// The Skill registry normalizes result text by trimming it only
// (normalizeSkillResult); a multi-line RAG answer keeps its line breaks. The
// consistency check must use the same normalizer, or every real multi-line
// answer would be refused as inconsistent with its own raw value.
import { normalizeTrimmedText as normalizeText } from "../../lib/normalize-text.js";

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const EVIDENCE_FIELDS = [
  "abstained",
  "citations",
  "comparisonAnalysisSummary",
  "retrievedContexts",
  "text",
];

// The typed graph output is what dependent nodes read; the raw value is what
// legacy answer synthesis and evidence checks read. Both must describe the
// same RAG call before either can be trusted, including on checkpoint reuse.
export const hasConsistentDocumentRagGraphResult = (result) => {
  const value = result?.value;
  const output = result?.graphOutput;
  const evidence = output?.evidence;

  if (
    !isRecord(value) ||
    !isRecord(output) ||
    !isRecord(evidence) ||
    typeof value.text !== "string" ||
    !Array.isArray(value.citations ?? []) ||
    !(value.citations ?? []).every(isRecord) ||
    typeof (value.abstained ?? false) !== "boolean" ||
    !Array.isArray(value.retrievedContexts ?? []) ||
    !(value.retrievedContexts ?? []).every(isRecord) ||
    (value.comparisonAnalysisSummary != null &&
      !isRecord(value.comparisonAnalysisSummary)) ||
    !isDeepStrictEqual(Object.keys(evidence).sort(), EVIDENCE_FIELDS) ||
    result.text !== normalizeText(value.text) ||
    !isDeepStrictEqual(result.citations, value.citations ?? []) ||
    result.abstained !== (value.abstained ?? false)
  ) {
    return false;
  }

  return (
    output.text === result.text &&
    isDeepStrictEqual(output.citations, result.citations) &&
    output.abstained === result.abstained &&
    evidence.text === value.text &&
    isDeepStrictEqual(evidence.citations, value.citations ?? []) &&
    evidence.abstained === (value.abstained ?? false) &&
    isDeepStrictEqual(evidence.retrievedContexts, value.retrievedContexts ?? []) &&
    isDeepStrictEqual(
      evidence.comparisonAnalysisSummary,
      value.comparisonAnalysisSummary ?? null
    )
  );
};
