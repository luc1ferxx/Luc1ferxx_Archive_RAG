import { evaluateClaimSupport } from "../rag/agent-self-check.js";
import { attachRetrievedEvidence } from "../rag/citations.js";
import { finalizeGroundedAnswer } from "../rag/grounded-answer-finalizer.js";
import { projectGroundedAnswer } from "../rag/grounded-answer-projection.js";
import { evaluateAnswerExpectation } from "./answer-match.js";
import { isExplicitAbstainAnswer } from "./explicit-abstain-answer.js";
import {
  evaluateExpectedCoverage,
  getResponseAbstained,
  summarizeCitations,
} from "./eval-case-helpers.js";
import {
  buildRagasSample,
  buildReferenceContextsFromPages,
  summarizeRetrievedContexts,
} from "./ragas-sample.js";
import { evaluateSyntheticComparisonExpectation } from "./synthetic-case-verdict.js";

const buildUncheckedClaimSupport = () => ({
  checked: false,
  supportedClaimCount: 0,
  unsupportedClaimCount: 0,
  claims: [],
});

const evaluateSupport = ({
  abstained,
  answerText,
  comparisonAnalysisSummary,
  evidenceCitations,
}) =>
  abstained
    ? buildUncheckedClaimSupport()
    : evaluateClaimSupport({
        answerText,
        citations: evidenceCitations,
        comparisonAnalysisSummary,
      });

export const evaluateSyntheticCaseResponse = ({
  testCase,
  response,
  responseTimeMs = 0,
  docKeyByDocId = new Map(),
  pagesByDocKey = new Map(),
}) => {
  const rawAnswer = String(response?.text ?? "");
  const rawAbstained =
    getResponseAbstained(response) && isExplicitAbstainAnswer(rawAnswer);
  const responseCitations = response?.citations ?? [];
  const rawCitations = summarizeCitations(responseCitations, docKeyByDocId);
  const rawRetrievedContexts = summarizeRetrievedContexts(
    response?.retrievedContexts ?? [],
    docKeyByDocId
  );
  const evidenceCitations = attachRetrievedEvidence({
    citations: rawCitations,
    retrievedContexts: rawRetrievedContexts,
  });
  const rawClaimSupport = evaluateSupport({
    abstained: rawAbstained,
    answerText: rawAnswer,
    comparisonAnalysisSummary: response?.comparisonAnalysisSummary,
    evidenceCitations,
  });
  const rawClaimSupportHit =
    rawAbstained ||
    (rawClaimSupport.checked === true &&
      rawClaimSupport.unsupportedClaimCount === 0);
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
        evidenceCitations,
        comparisonAnalysisSummary: response?.comparisonAnalysisSummary,
      });
  const projection = projectGroundedAnswer({
    text: finalized.text,
    citations: rawCitations,
    retrievedContexts: rawRetrievedContexts,
    claimSupport: finalized.claimSupport ?? rawClaimSupport,
  });
  const answer = projection.text;
  const abstained = rawAbstained || finalized.abstained;
  const finalizedEvidenceCitations = attachRetrievedEvidence({
    citations: projection.citations,
    retrievedContexts: projection.retrievedContexts,
  });
  const claimSupport = evaluateSupport({
    abstained,
    answerText: answer,
    comparisonAnalysisSummary: response?.comparisonAnalysisSummary,
    evidenceCitations: finalizedEvidenceCitations,
  });
  const claimSupportHit =
    abstained ||
    (claimSupport.checked === true && claimSupport.unsupportedClaimCount === 0);
  const citations = summarizeCitations(projection.citations, docKeyByDocId);
  const coverage = evaluateExpectedCoverage({
    citations,
    expectedEvidence: testCase.expectedEvidence,
  });
  const answerExpectationHit = evaluateAnswerExpectation({
    answer,
    expectedAnswerIncludes: testCase.expectedAnswerIncludes,
  });
  const comparisonVerdict = evaluateSyntheticComparisonExpectation({
    abstained,
    compareExpectation: testCase.compareExpectation,
    claimSupport,
  });
  const hasNonEmptyAnswer = answer.trim().length > 0;
  const basePassed = testCase.shouldAbstain
    ? abstained &&
      hasNonEmptyAnswer &&
      coverage.docCoverageHit &&
      coverage.pageCoverageHit &&
      rawClaimSupportHit
    : !abstained &&
      hasNonEmptyAnswer &&
      coverage.docCoverageHit &&
      coverage.pageCoverageHit &&
      answerExpectationHit &&
      claimSupportHit &&
      rawClaimSupportHit;
  const referenceContexts = buildReferenceContextsFromPages({
    expectedEvidence: testCase.expectedEvidence,
    pagesByDocKey,
  });
  const retrievedContexts = summarizeRetrievedContexts(
    projection.retrievedContexts,
    docKeyByDocId
  );

  return {
    id: testCase.id,
    type: testCase.type,
    question: testCase.question,
    docKeys: testCase.docKeys,
    shouldAbstain: testCase.shouldAbstain,
    compareExpectation: testCase.compareExpectation ?? null,
    abstained,
    abstainReason:
      response?.abstainReason ?? (abstained ? answer : null),
    docCoverageHit: coverage.docCoverageHit,
    pageCoverageHit: coverage.pageCoverageHit,
    answerExpectationHit,
    claimSupportHit,
    rawClaimSupportHit,
    comparisonExpectationHit: comparisonVerdict.passed,
    passed: basePassed && comparisonVerdict.passed,
    responseTimeMs,
    citationCount: citations.length,
    resolvedQuery: response?.resolvedQuery ?? testCase.question,
    reference: testCase.referenceAnswer ?? null,
    metadata: testCase.metadata ?? null,
    rawAnswer,
    rawCitations,
    rawRetrievedContexts,
    comparisonAnalysisSummary: response?.comparisonAnalysisSummary ?? null,
    answer,
    rawClaimSupport,
    claimSupport,
    finalization: {
      applied: !rawAbstained,
      changed: Boolean(finalized.changed),
      abstained: Boolean(finalized.abstained),
      removedClaimCount: finalized.removedClaims?.length ?? 0,
      removedClaims: finalized.removedClaims ?? [],
    },
    comparisonVerdict,
    citations,
    retrievedContexts,
    referenceContexts,
    ragasSample: buildRagasSample({
      testCase,
      response: {
        ...response,
        text: answer,
        abstained,
        citations: projection.citations,
        retrievedContexts: projection.retrievedContexts,
      },
      docKeyByDocId,
      referenceContexts,
    }),
  };
};
