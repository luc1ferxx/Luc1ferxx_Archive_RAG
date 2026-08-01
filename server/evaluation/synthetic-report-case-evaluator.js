import { isDeepStrictEqual } from "node:util";
import {
  evaluateClaimSupport,
  evaluateDocumentEvidence,
} from "../rag/agent-self-check.js";
import { attachRetrievedEvidence } from "../rag/citations.js";
import {
  buildComparisonAnalysisFromContexts,
} from "../rag/comparison-analysis-summary.js";
import { finalizeGroundedAnswer } from "../rag/grounded-answer-finalizer.js";
import { projectGroundedAnswer } from "../rag/grounded-answer-projection.js";
import { evaluateAnswerExpectation } from "./answer-match.js";
import { isExplicitAbstainAnswer } from "./explicit-abstain-answer.js";
import { evaluateExpectedCoverage } from "./eval-case-helpers.js";
import { buildSyntheticDocumentId } from "./synthetic-document-identity.js";
import {
  evaluateSyntheticComparisonExpectation,
} from "./synthetic-case-verdict.js";
import {
  validateSyntheticEvidenceContract,
} from "./synthetic-report-evidence-validation.js";

const buildUncheckedClaimSupport = () => ({
  checked: false,
  supportedClaimCount: 0,
  unsupportedClaimCount: 0,
  claims: [],
});

const evaluateSupport = ({
  abstained,
  answerText,
  citations,
  comparisonAnalysisSummary,
}) =>
  abstained
    ? buildUncheckedClaimSupport()
    : evaluateClaimSupport({
        answerText,
        citations,
        comparisonAnalysisSummary,
      });

const isSupportHit = ({ abstained, claimSupport }) =>
  abstained ||
  (claimSupport.checked === true &&
    claimSupport.unsupportedClaimCount === 0);

const valuesMatch = (actual, expected) => isDeepStrictEqual(actual, expected);

const buildExpectedFinalProjection = ({
  comparisonAnalysisSummary,
  rawAbstained,
  rawAnswer,
  rawCitations,
  rawClaimSupport,
  rawEvidenceCitations,
  rawRetrievedContexts,
}) => {
  const finalized = rawAbstained
    ? {
        text: rawAnswer,
        changed: false,
        abstained: true,
        removedClaims: [],
      }
    : finalizeGroundedAnswer({
        answerText: rawAnswer,
        citations: rawCitations,
        evidenceCitations: rawEvidenceCitations,
        comparisonAnalysisSummary,
      });
  const projection = projectGroundedAnswer({
    text: finalized.text,
    citations: rawCitations,
    retrievedContexts: rawRetrievedContexts,
    claimSupport: finalized.claimSupport ?? rawClaimSupport,
  });

  return {
    abstained: rawAbstained || Boolean(finalized.abstained),
    answer: projection.text,
    citations: projection.citations,
    retrievedContexts: projection.retrievedContexts,
  };
};

const buildExpectedDocIdByKey = (caseContract = {}) =>
  new Map(
    (Array.isArray(caseContract.docKeys) ? caseContract.docKeys : []).map(
      (docKey) => [
        docKey,
        buildSyntheticDocumentId({
          corpusId: caseContract.corpusId,
          corpusVersion: caseContract.corpusVersion,
          docKey,
        }),
      ]
    )
  );

const buildExpectedComparisonSummary = ({
  caseContract,
  documentContracts,
  rawRetrievedContexts,
}) => {
  if (caseContract.type !== "compare") {
    return {
      error: null,
      summary: null,
    };
  }

  try {
    const question = String(caseContract.question ?? "").trim();

    if (!question) {
      throw new Error("comparison case question is missing");
    }

    const documentByKey = new Map(
      (Array.isArray(documentContracts) ? documentContracts : []).map(
        (document) => [document?.key, document]
      )
    );
    const expectedDocIdByKey = buildExpectedDocIdByKey(caseContract);
    const documents = caseContract.docKeys.map((docKey) => {
      const document = documentByKey.get(docKey);
      const docId = expectedDocIdByKey.get(docKey);

      if (!document || !docId) {
        throw new Error(`comparison document contract is missing for ${docKey}`);
      }

      return {
        docId,
        fileName: document.fileName,
      };
    });
    rawRetrievedContexts.forEach((context) => {
      const expectedDocId = expectedDocIdByKey.get(context?.docKey);

      if (!expectedDocId || context?.docId !== expectedDocId) {
        throw new Error(
          `comparison context identity is invalid for ${context?.docKey ?? "unknown"}`
        );
      }
    });

    return {
      error: null,
      summary: buildComparisonAnalysisFromContexts({
        query: question,
        documents,
        retrievedContexts: rawRetrievedContexts,
      }).summary,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      summary: null,
    };
  }
};

export const recomputeSyntheticCaseOutcome = ({
  caseContract = {},
  caseResult = {},
  documentContracts = [],
} = {}) => {
  const rawAnswer = String(caseResult.rawAnswer ?? "");
  const answer = String(caseResult.answer ?? "");
  const rawCitations = Array.isArray(caseResult.rawCitations)
    ? caseResult.rawCitations
    : [];
  const rawRetrievedContexts = Array.isArray(caseResult.rawRetrievedContexts)
    ? caseResult.rawRetrievedContexts
    : [];
  const citations = Array.isArray(caseResult.citations)
    ? caseResult.citations
    : [];
  const retrievedContexts = Array.isArray(caseResult.retrievedContexts)
    ? caseResult.retrievedContexts
    : [];
  const reportedComparisonAnalysisSummary =
    caseResult.comparisonAnalysisSummary ?? null;
  const comparisonSummaryContract = buildExpectedComparisonSummary({
    caseContract,
    documentContracts,
    rawRetrievedContexts,
  });
  const comparisonAnalysisSummary = comparisonSummaryContract.summary;
  const comparisonSummaryMatches =
    comparisonSummaryContract.error === null &&
    valuesMatch(
      reportedComparisonAnalysisSummary,
      comparisonSummaryContract.summary
    );
  const rawAbstained = isExplicitAbstainAnswer(rawAnswer);
  const rawEvidenceCitations = attachRetrievedEvidence({
    citations: rawCitations,
    retrievedContexts: rawRetrievedContexts,
  });
  const rawClaimSupport = evaluateSupport({
    abstained: rawAbstained,
    answerText: rawAnswer,
    citations: rawEvidenceCitations,
    comparisonAnalysisSummary,
  });
  const expectedFinalProjection = buildExpectedFinalProjection({
    comparisonAnalysisSummary,
    rawAbstained,
    rawAnswer,
    rawCitations,
    rawClaimSupport,
    rawEvidenceCitations,
    rawRetrievedContexts,
  });
  const projectionMismatches = [
    ["answer", answer, expectedFinalProjection.answer],
    ["citations", citations, expectedFinalProjection.citations],
    [
      "retrievedContexts",
      retrievedContexts,
      expectedFinalProjection.retrievedContexts,
    ],
  ].filter(([, actual, expected]) => !valuesMatch(actual, expected));
  const projectionMatches = projectionMismatches.length === 0;
  const projectedEvidenceCitations = attachRetrievedEvidence({
    citations: expectedFinalProjection.citations,
    retrievedContexts: expectedFinalProjection.retrievedContexts,
  });
  const claimSupport = evaluateSupport({
    abstained: expectedFinalProjection.abstained,
    answerText: expectedFinalProjection.answer,
    citations: projectedEvidenceCitations,
    comparisonAnalysisSummary,
  });
  const rawClaimSupportHit = isSupportHit({
    abstained: rawAbstained,
    claimSupport: rawClaimSupport,
  });
  const claimSupportHit = isSupportHit({
    abstained: expectedFinalProjection.abstained,
    claimSupport,
  });
  const coverage = evaluateExpectedCoverage({
    citations: expectedFinalProjection.citations,
    expectedEvidence: caseContract.expectedEvidence,
  });
  const answerExpectationHit = evaluateAnswerExpectation({
    answer: expectedFinalProjection.answer,
    expectedAnswerIncludes: caseContract.expectedAnswerIncludes,
  });
  const attemptCheckPassed =
    rawAbstained ||
    evaluateDocumentEvidence({
      ragResult: {
        ok: true,
        value: {
          text: rawAnswer,
          citations: rawCitations,
          retrievedContexts: rawRetrievedContexts,
          comparisonAnalysisSummary,
          abstained: false,
        },
      },
      docIds: caseContract.docKeys,
    }).passed;
  const comparisonVerdict = evaluateSyntheticComparisonExpectation({
    abstained: expectedFinalProjection.abstained,
    compareExpectation: caseContract.compareExpectation ?? null,
    claimSupport,
  });
  const hasNonEmptyAnswer = expectedFinalProjection.answer.trim().length > 0;
  const basePassed = caseContract.shouldAbstain === true
    ? expectedFinalProjection.abstained &&
      hasNonEmptyAnswer &&
      coverage.docCoverageHit &&
      coverage.pageCoverageHit &&
      rawClaimSupportHit &&
      attemptCheckPassed
    : caseContract.shouldAbstain === false &&
      !expectedFinalProjection.abstained &&
      hasNonEmptyAnswer &&
      coverage.docCoverageHit &&
      coverage.pageCoverageHit &&
      answerExpectationHit &&
      claimSupportHit &&
      rawClaimSupportHit &&
      attemptCheckPassed;

  return {
    id: caseContract.id ?? caseResult.id ?? null,
    shouldAbstain: caseContract.shouldAbstain,
    rawAbstained,
    abstained: expectedFinalProjection.abstained,
    docCoverageHit: coverage.docCoverageHit,
    pageCoverageHit: coverage.pageCoverageHit,
    answerExpectationHit,
    rawClaimSupport,
    rawClaimSupportHit,
    claimSupport,
    claimSupportHit,
    attemptCheckPassed,
    comparisonAnalysisSummary,
    comparisonSummaryError: comparisonSummaryContract.error,
    comparisonSummaryMatches,
    projectionMatches,
    projectionMismatches,
    comparisonVerdict,
    comparisonExpectationHit: comparisonVerdict.passed,
    passed:
      basePassed &&
      comparisonVerdict.passed &&
      projectionMatches &&
      comparisonSummaryMatches,
  };
};

export const SYNTHETIC_CASE_OUTCOME_REASON_CODES = Object.freeze({
  ok: "ok",
  invalid: "synthetic_case_outcome_contract_invalid",
  caseContractMissing: "synthetic_case_contract_missing",
  docKeysMismatch: "synthetic_case_doc_keys_mismatch",
  comparisonSummaryInvalid: "synthetic_comparison_summary_invalid",
  comparisonSummaryMismatch: "synthetic_comparison_summary_mismatch",
  finalProjectionMismatch: "synthetic_final_projection_mismatch",
  rawFactInvalid: "synthetic_case_raw_fact_invalid",
  derivedBooleanInvalid: "synthetic_case_derived_boolean_invalid",
  derivedBooleanMismatch: "synthetic_case_derived_boolean_mismatch",
});

const REQUIRED_ARRAY_FACTS = Object.freeze([
  "rawCitations",
  "rawRetrievedContexts",
  "citations",
  "retrievedContexts",
]);

const REQUIRED_STRING_FACTS = Object.freeze(["rawAnswer", "answer"]);

const DERIVED_BOOLEAN_FIELDS = Object.freeze([
  "shouldAbstain",
  "abstained",
  "docCoverageHit",
  "pageCoverageHit",
  "answerExpectationHit",
  "claimSupportHit",
  "rawClaimSupportHit",
  "comparisonExpectationHit",
  "passed",
]);

const buildIssue = ({ actual, caseId, expected, field, reasonCode }) => ({
  reasonCode,
  caseId: caseId ?? null,
  field,
  expected: expected ?? null,
  actual: actual ?? null,
});

const hasExactDocumentOrder = (actual, expected) =>
  Array.isArray(actual) &&
  Array.isArray(expected) &&
  actual.length === expected.length &&
  actual.every((docKey, index) => docKey === expected[index]);

export const validateSyntheticCaseOutcomes = ({
  caseContracts = [],
  documentContracts = [],
  executionConfig = null,
  payload = {},
} = {}) => {
  const contractById = new Map(
    caseContracts.map((caseContract) => [caseContract?.id, caseContract])
  );
  const cases = Array.isArray(payload.cases) ? payload.cases : [];
  const issues = [];
  const outcomes = [];

  cases.forEach((caseResult, caseIndex) => {
    const caseId = caseResult?.id ?? null;
    const caseContract = contractById.get(caseId);

    if (!caseContract) {
      issues.push(
        buildIssue({
          actual: caseId,
          caseId,
          expected: "case id from checked-in corpus contract",
          field: `cases[${caseIndex}].id`,
          reasonCode:
            SYNTHETIC_CASE_OUTCOME_REASON_CODES.caseContractMissing,
        })
      );
      return;
    }

    if (!hasExactDocumentOrder(caseResult?.docKeys, caseContract.docKeys)) {
      issues.push(
        buildIssue({
          actual: caseResult?.docKeys,
          caseId,
          expected: caseContract.docKeys,
          field: "docKeys",
          reasonCode: SYNTHETIC_CASE_OUTCOME_REASON_CODES.docKeysMismatch,
        })
      );
    }

    for (const field of REQUIRED_STRING_FACTS) {
      if (typeof caseResult?.[field] !== "string") {
        issues.push(
          buildIssue({
            actual: caseResult?.[field],
            caseId,
            expected: "string",
            field,
            reasonCode: SYNTHETIC_CASE_OUTCOME_REASON_CODES.rawFactInvalid,
          })
        );
      }
    }

    for (const field of REQUIRED_ARRAY_FACTS) {
      if (!Array.isArray(caseResult?.[field])) {
        issues.push(
          buildIssue({
            actual: caseResult?.[field],
            caseId,
            expected: "array",
            field,
            reasonCode: SYNTHETIC_CASE_OUTCOME_REASON_CODES.rawFactInvalid,
          })
        );
      }
    }

    if (!Object.hasOwn(caseResult, "comparisonAnalysisSummary")) {
      issues.push(
        buildIssue({
          actual: undefined,
          caseId,
          expected: "persisted comparison analysis summary or null",
          field: "comparisonAnalysisSummary",
          reasonCode: SYNTHETIC_CASE_OUTCOME_REASON_CODES.rawFactInvalid,
        })
      );
    }

    let expectedDocIdByKey = null;

    try {
      expectedDocIdByKey = buildExpectedDocIdByKey(caseContract);
    } catch (error) {
      issues.push(
        buildIssue({
          actual: {
            corpusId: caseContract.corpusId,
            corpusVersion: caseContract.corpusVersion,
          },
          caseId,
          expected: "stable corpus id and version",
          field: "corpusIdentity",
          reasonCode: SYNTHETIC_CASE_OUTCOME_REASON_CODES.rawFactInvalid,
        })
      );
    }

    const evidenceContract = validateSyntheticEvidenceContract({
      allowedDocKeys: caseContract.docKeys,
      caseId,
      caseResult,
      documentContracts,
      executionConfig,
      expectedDocIdByKey,
    });
    issues.push(...evidenceContract.issues);
    const recomputedOutcome = recomputeSyntheticCaseOutcome({
      caseContract,
      caseResult,
      documentContracts,
    });
    const outcome = {
      ...recomputedOutcome,
      evidenceContractPassed: evidenceContract.status === "pass",
      passed:
        recomputedOutcome.passed && evidenceContract.status === "pass",
    };
    outcomes.push({
      ...outcome,
      caseContract,
      caseResult,
      evidenceContract,
    });

    if (!outcome.comparisonSummaryMatches) {
      issues.push(
        buildIssue({
          actual: caseResult.comparisonAnalysisSummary ?? null,
          caseId,
          expected:
            outcome.comparisonSummaryError ?? outcome.comparisonAnalysisSummary,
          field: "comparisonAnalysisSummary",
          reasonCode: outcome.comparisonSummaryError
            ? SYNTHETIC_CASE_OUTCOME_REASON_CODES.comparisonSummaryInvalid
            : SYNTHETIC_CASE_OUTCOME_REASON_CODES.comparisonSummaryMismatch,
        })
      );
    }

    for (const [field, actual, expected] of outcome.projectionMismatches) {
      issues.push(
        buildIssue({
          actual,
          caseId,
          expected,
          field,
          reasonCode:
            SYNTHETIC_CASE_OUTCOME_REASON_CODES.finalProjectionMismatch,
        })
      );
    }

    for (const field of DERIVED_BOOLEAN_FIELDS) {
      const reported = caseResult?.[field];
      const expected = outcome[field];

      if (typeof reported !== "boolean") {
        issues.push(
          buildIssue({
            actual: reported,
            caseId,
            expected: "boolean",
            field,
            reasonCode:
              SYNTHETIC_CASE_OUTCOME_REASON_CODES.derivedBooleanInvalid,
          })
        );
      } else if (reported !== expected) {
        issues.push(
          buildIssue({
            actual: reported,
            caseId,
            expected,
            field,
            reasonCode:
              SYNTHETIC_CASE_OUTCOME_REASON_CODES.derivedBooleanMismatch,
          })
        );
      }
    }
  });

  return {
    status: issues.length === 0 ? "pass" : "fail",
    reasonCode:
      issues.length === 0
        ? SYNTHETIC_CASE_OUTCOME_REASON_CODES.ok
        : SYNTHETIC_CASE_OUTCOME_REASON_CODES.invalid,
    outcomes,
    issues,
  };
};
