import assert from "node:assert/strict";
import test from "node:test";

import {
  recomputeSyntheticCaseOutcome,
  validateSyntheticCaseOutcomes as validateSyntheticCaseOutcomesWithConfig,
} from "../evaluation/synthetic-report-case-evaluator.js";
import {
  validateSyntheticEvidenceContract as validateSyntheticEvidenceContractWithConfig,
} from "../evaluation/synthetic-report-evidence-validation.js";
import {
  loadRobustReportCaseContracts,
} from "../evaluation/robust-report-corpus-validation.js";
import {
  buildSyntheticDocumentId,
} from "../evaluation/synthetic-document-identity.js";
import {
  buildComparisonAnalysisFromEvidence,
} from "../rag/comparison-analysis-summary.js";
import { chunkDocumentWithConfig } from "../rag/chunker.js";

const executionConfig = Object.freeze({
  chunkStrategy: "structured",
  chunkSize: 900,
  chunkOverlap: 180,
});

const validateSyntheticCaseOutcomes = (input) =>
  validateSyntheticCaseOutcomesWithConfig({
    ...input,
    executionConfig,
  });

const validateSyntheticEvidenceContract = (input) =>
  validateSyntheticEvidenceContractWithConfig({
    ...input,
    executionConfig,
  });

const qaCorpusId = "synthetic-corpus-qa-test";
const qaCorpusVersion = "1";
const qaDocumentId = buildSyntheticDocumentId({
  corpusId: qaCorpusId,
  corpusVersion: qaCorpusVersion,
  docKey: "handbook_alpha",
});

const qaContract = {
  id: "qa_remote_policy",
  type: "qa",
  question: "What is the remote work policy?",
  corpusId: qaCorpusId,
  corpusVersion: qaCorpusVersion,
  shouldAbstain: false,
  docKeys: ["handbook_alpha"],
  expectedEvidence: [{ docKey: "handbook_alpha", pages: [1] }],
  expectedAnswerIncludes: ["manager approval"],
};

const citation = {
  rank: 1,
  docId: qaDocumentId,
  docKey: "handbook_alpha",
  fileName: "handbook-alpha.pdf",
  pageNumber: 1,
  chunkIndex: 0,
};

const context = {
  ...citation,
  text: "Remote work requires manager approval.",
};

const documentContracts = [
  {
    key: "handbook_alpha",
    fileName: "handbook-alpha.pdf",
    pages: [context.text],
  },
];

test("synthetic report outcomes reject raw unsupported claims despite forged derived fields", () => {
  const outcome = recomputeSyntheticCaseOutcome({
    caseContract: qaContract,
    caseResult: {
      id: qaContract.id,
      rawAnswer: [
        "Remote work requires manager approval. [Source 1]",
        "A satellite stipend is provided. [Source 1]",
      ].join("\n"),
      rawCitations: [citation],
      rawRetrievedContexts: [context],
      answer: "Remote work requires manager approval. [Source 1]",
      citations: [citation],
      retrievedContexts: [context],
      rawClaimSupport: { checked: false, claims: [] },
      rawClaimSupportHit: true,
      claimSupport: { checked: false, claims: [] },
      claimSupportHit: true,
      docCoverageHit: true,
      pageCoverageHit: true,
      answerExpectationHit: true,
      abstained: false,
      passed: true,
    },
  });

  assert.equal(outcome.rawClaimSupport.unsupportedClaimCount, 1);
  assert.equal(outcome.rawClaimSupportHit, false);
  assert.equal(outcome.claimSupportHit, true);
  assert.equal(outcome.passed, false);
});

test("synthetic report outcomes reject citation and context identity conflicts", () => {
  const conflictingContext = {
    ...context,
    docId: "doc-beta",
    docKey: "handbook_beta",
  };
  const outcome = recomputeSyntheticCaseOutcome({
    caseContract: qaContract,
    caseResult: {
      id: qaContract.id,
      rawAnswer: "Remote work requires manager approval. [Source 1]",
      rawCitations: [citation],
      rawRetrievedContexts: [conflictingContext],
      answer: "Remote work requires manager approval. [Source 1]",
      citations: [citation],
      retrievedContexts: [conflictingContext],
      rawClaimSupportHit: true,
      claimSupportHit: true,
      passed: true,
    },
  });

  assert.equal(outcome.rawClaimSupport.unsupportedClaimCount, 1);
  assert.equal(outcome.rawClaimSupportHit, false);
  assert.equal(outcome.projectionMatches, false);
  assert.equal(outcome.passed, false);
});

test("synthetic report validation checks every QA case against recomputed outcomes", () => {
  const validation = validateSyntheticCaseOutcomes({
    caseContracts: [qaContract],
    documentContracts,
    payload: {
      cases: [
        {
          id: qaContract.id,
          rawAnswer: "A satellite stipend is provided. [Source 1]",
          rawCitations: [citation],
          rawRetrievedContexts: [context],
          answer: "A satellite stipend is provided. [Source 1]",
          citations: [citation],
          retrievedContexts: [context],
          comparisonAnalysisSummary: null,
          shouldAbstain: false,
          abstained: false,
          docCoverageHit: true,
          pageCoverageHit: true,
          answerExpectationHit: true,
          claimSupportHit: true,
          rawClaimSupportHit: true,
          comparisonExpectationHit: true,
          passed: true,
        },
      ],
    },
  });

  assert.equal(validation.status, "fail");
  assert.equal(validation.outcomes[0].passed, false);
  assert.ok(
    validation.issues.some(
      (issue) =>
        issue.reasonCode === "synthetic_case_derived_boolean_mismatch" &&
        issue.field === "passed"
    )
  );
});

test("synthetic report validation rejects corpus-identity contexts with forged text", () => {
  const forgedText = [
    "Remote work requires manager approval.",
    "A satellite stipend is provided.",
  ].join(" ");
  const forgedContext = { ...context, text: forgedText };
  const answer = [
    "Remote work requires manager approval. [Source 1]",
    "A satellite stipend is provided. [Source 1]",
  ].join("\n");
  const validation = validateSyntheticCaseOutcomes({
    caseContracts: [qaContract],
    documentContracts,
    payload: {
      cases: [
        {
          id: qaContract.id,
          rawAnswer: answer,
          rawCitations: [citation],
          rawRetrievedContexts: [forgedContext],
          answer,
          citations: [citation],
          retrievedContexts: [forgedContext],
          comparisonAnalysisSummary: null,
          shouldAbstain: false,
          abstained: false,
          docCoverageHit: true,
          pageCoverageHit: true,
          answerExpectationHit: true,
          claimSupportHit: true,
          rawClaimSupportHit: true,
          comparisonExpectationHit: true,
          passed: true,
        },
      ],
    },
  });

  assert.equal(validation.status, "fail");
  assert.equal(validation.outcomes[0].passed, false);
  assert.ok(
    validation.issues.some(
      (issue) =>
        issue.reasonCode === "synthetic_context_corpus_mismatch" &&
        issue.field === "rawRetrievedContexts[0].text"
    )
  );
});

test("synthetic report validation tolerates PDF extraction whitespace only", () => {
  const pageText = [
    "Remote Work Policy",
    "Remote work requires manager approval.",
  ].join("\n");
  const extractedText = [
    "Remote Work Policy",
    "",
    "Remote work requires manager approval.",
  ].join("\n");
  const extractedContext = {
    ...context,
    sectionHeading: "Remote Work Policy",
    text: extractedText,
  };
  const extractedCitation = {
    ...citation,
    sectionHeading: "Remote Work Policy",
  };
  const answer = "Remote work requires manager approval. [Source 1]";
  const validation = validateSyntheticCaseOutcomes({
    caseContracts: [qaContract],
    documentContracts: [
      {
        ...documentContracts[0],
        pages: [pageText],
      },
    ],
    payload: {
      cases: [
        {
          id: qaContract.id,
          type: qaContract.type,
          docKeys: qaContract.docKeys,
          rawAnswer: answer,
          rawCitations: [extractedCitation],
          rawRetrievedContexts: [extractedContext],
          answer,
          citations: [extractedCitation],
          retrievedContexts: [extractedContext],
          comparisonAnalysisSummary: null,
          shouldAbstain: false,
          abstained: false,
          docCoverageHit: true,
          pageCoverageHit: true,
          answerExpectationHit: true,
          claimSupportHit: true,
          rawClaimSupportHit: true,
          comparisonExpectationHit: true,
          passed: true,
        },
      ],
    },
  });

  assert.deepEqual(validation.issues, []);
  assert.equal(validation.status, "pass");
});

test("synthetic evidence accepts an exact reconstructed chunk from a long corpus page", () => {
  const longPageText = [
    "Remote Work Policy",
    ...Array.from(
      { length: 24 },
      (_, index) =>
        `Policy paragraph ${index + 1} explains remote work approval, scheduling, and audit evidence requirements for employees.`
    ),
  ].join("\n\n");
  const longDocumentContract = {
    key: "handbook_alpha",
    fileName: "handbook-alpha.pdf",
    pages: [longPageText],
  };
  const reconstructedChunks = chunkDocumentWithConfig({
    docId: qaDocumentId,
    fileName: longDocumentContract.fileName,
    publicFilePath: "",
    pages: [{ pageNumber: 1, text: longPageText }],
    ...executionConfig,
  });

  assert.ok(reconstructedChunks.length > 1);

  const expectedChunk = reconstructedChunks[1];
  const longCitation = {
    ...citation,
    pageNumber: expectedChunk.metadata.pageNumber,
    chunkIndex: expectedChunk.metadata.chunkIndex,
    sectionHeading: expectedChunk.metadata.sectionHeading,
  };
  const longContext = {
    ...longCitation,
    text: expectedChunk.pageContent,
  };
  const validation = validateSyntheticEvidenceContract({
    allowedDocKeys: qaContract.docKeys,
    caseId: qaContract.id,
    documentContracts: [longDocumentContract],
    expectedDocIdByKey: new Map([["handbook_alpha", qaDocumentId]]),
    caseResult: {
      rawCitations: [longCitation],
      rawRetrievedContexts: [longContext],
      citations: [longCitation],
      retrievedContexts: [longContext],
    },
  });

  assert.equal(validation.status, "pass");
  assert.deepEqual(validation.issues, []);
});

test("synthetic evidence rejects a proper substring of a reconstructed chunk", () => {
  const truncatedContext = {
    ...context,
    text: "Remote work requires manager",
  };
  const validation = validateSyntheticEvidenceContract({
    allowedDocKeys: qaContract.docKeys,
    caseId: qaContract.id,
    documentContracts,
    expectedDocIdByKey: new Map([["handbook_alpha", qaDocumentId]]),
    caseResult: {
      rawCitations: [citation],
      rawRetrievedContexts: [truncatedContext],
      citations: [citation],
      retrievedContexts: [truncatedContext],
    },
  });

  assert.equal(validation.status, "fail");
  assert.ok(
    validation.issues.some(
      (issue) =>
        issue.reasonCode === "synthetic_context_corpus_mismatch" &&
        issue.field === "rawRetrievedContexts[0].text"
    )
  );
});

test("synthetic evidence rejects an unbound chunk execution config", () => {
  const validation = validateSyntheticEvidenceContractWithConfig({
    caseId: qaContract.id,
    documentContracts,
    executionConfig: {
      chunkStrategy: "structured",
      chunkSize: 900,
      chunkOverlap: 900,
    },
    caseResult: {
      rawCitations: [],
      rawRetrievedContexts: [],
      citations: [],
      retrievedContexts: [],
    },
  });

  assert.equal(validation.status, "fail");
  assert.ok(
    validation.issues.some(
      (issue) => issue.reasonCode === "synthetic_chunk_config_invalid"
    )
  );
});

test("synthetic report validation rejects evidence outside the case document scope", () => {
  const betaCitation = {
    ...citation,
    rank: 2,
    docId: "doc-beta",
    docKey: "handbook_beta",
    fileName: "handbook-beta.pdf",
  };
  const betaContext = {
    ...betaCitation,
    text: "Remote work requires manager approval.",
  };
  const answer = "Remote work requires manager approval. [Source 2]";
  const validation = validateSyntheticCaseOutcomes({
    caseContracts: [qaContract],
    documentContracts: [
      ...documentContracts,
      {
        key: "handbook_beta",
        fileName: "handbook-beta.pdf",
        pages: [betaContext.text],
      },
    ],
    payload: {
      cases: [
        {
          id: qaContract.id,
          type: qaContract.type,
          docKeys: qaContract.docKeys,
          rawAnswer: answer,
          rawCitations: [citation, betaCitation],
          rawRetrievedContexts: [context, betaContext],
          answer,
          citations: [citation, betaCitation],
          retrievedContexts: [context, betaContext],
          comparisonAnalysisSummary: null,
          shouldAbstain: false,
          abstained: false,
          docCoverageHit: true,
          pageCoverageHit: true,
          answerExpectationHit: true,
          claimSupportHit: true,
          rawClaimSupportHit: true,
          comparisonExpectationHit: true,
          passed: true,
        },
      ],
    },
  });

  assert.equal(validation.status, "fail");
  assert.equal(validation.outcomes[0].passed, false);
  assert.ok(
    validation.issues.some(
      (issue) =>
        issue.reasonCode === "synthetic_evidence_doc_key_out_of_scope" &&
        issue.actual === "handbook_beta"
    )
  );
});

test("synthetic report validation binds evidence to the deterministic corpus document id", () => {
  const forgedCitation = { ...citation, docId: "forged-runtime-id" };
  const forgedContext = { ...context, docId: "forged-runtime-id" };
  const answer = "Remote work requires manager approval. [Source 1]";
  const validation = validateSyntheticCaseOutcomes({
    caseContracts: [qaContract],
    documentContracts,
    payload: {
      cases: [
        {
          id: qaContract.id,
          type: qaContract.type,
          docKeys: qaContract.docKeys,
          rawAnswer: answer,
          rawCitations: [forgedCitation],
          rawRetrievedContexts: [forgedContext],
          answer,
          citations: [forgedCitation],
          retrievedContexts: [forgedContext],
          comparisonAnalysisSummary: null,
          shouldAbstain: false,
          abstained: false,
          docCoverageHit: true,
          pageCoverageHit: true,
          answerExpectationHit: true,
          claimSupportHit: true,
          rawClaimSupportHit: true,
          comparisonExpectationHit: true,
          passed: true,
        },
      ],
    },
  });

  assert.equal(validation.status, "fail");
  assert.ok(
    validation.issues.some(
      (issue) =>
        issue.reasonCode === "synthetic_evidence_doc_id_mismatch" &&
        issue.actual === "forged-runtime-id"
    )
  );
});

test("synthetic report validation binds the reported document order to the case contract", () => {
  const answer = "Remote work requires manager approval. [Source 1]";
  const validation = validateSyntheticCaseOutcomes({
    caseContracts: [qaContract],
    documentContracts,
    payload: {
      cases: [
        {
          id: qaContract.id,
          type: qaContract.type,
          docKeys: ["handbook_beta", "handbook_alpha"],
          rawAnswer: answer,
          rawCitations: [citation],
          rawRetrievedContexts: [context],
          answer,
          citations: [citation],
          retrievedContexts: [context],
          comparisonAnalysisSummary: null,
          shouldAbstain: false,
          abstained: false,
          docCoverageHit: true,
          pageCoverageHit: true,
          answerExpectationHit: true,
          claimSupportHit: true,
          rawClaimSupportHit: true,
          comparisonExpectationHit: true,
          passed: true,
        },
      ],
    },
  });

  assert.equal(validation.status, "fail");
  assert.ok(
    validation.issues.some(
      (issue) =>
        issue.reasonCode === "synthetic_case_doc_keys_mismatch" &&
        issue.field === "docKeys"
    )
  );
});

test("synthetic report validation rejects final answers that add content to the raw answer", () => {
  const evidenceText =
    "Employees may work remotely 2 days per week with manager approval.";
  const rawAnswer = "Employees may work remotely 2 days per week. [Source 1]";
  const injectedAnswer = `${evidenceText} [Source 1]`;
  const scopedContext = { ...context, text: evidenceText };
  const validation = validateSyntheticCaseOutcomes({
    caseContracts: [qaContract],
    documentContracts: [
      {
        ...documentContracts[0],
        pages: [evidenceText],
      },
    ],
    payload: {
      cases: [
        {
          id: qaContract.id,
          type: qaContract.type,
          docKeys: qaContract.docKeys,
          rawAnswer,
          rawCitations: [citation],
          rawRetrievedContexts: [scopedContext],
          answer: injectedAnswer,
          citations: [citation],
          retrievedContexts: [scopedContext],
          comparisonAnalysisSummary: null,
          shouldAbstain: false,
          abstained: false,
          docCoverageHit: true,
          pageCoverageHit: true,
          answerExpectationHit: true,
          claimSupportHit: true,
          rawClaimSupportHit: true,
          comparisonExpectationHit: true,
          passed: true,
        },
      ],
    },
  });

  assert.equal(validation.status, "fail");
  assert.equal(validation.outcomes[0].passed, false);
  assert.ok(
    validation.issues.some(
      (issue) =>
        issue.reasonCode === "synthetic_final_projection_mismatch" &&
        issue.field === "answer"
    )
  );
});

test("synthetic report validation rejects unprojected final citations and contexts", () => {
  const unusedCitation = {
    ...citation,
    rank: 2,
    chunkIndex: 1,
  };
  const unusedContext = {
    ...unusedCitation,
    text: context.text,
  };
  const answer = "Remote work requires manager approval. [Source 1]";
  const validation = validateSyntheticCaseOutcomes({
    caseContracts: [qaContract],
    documentContracts,
    payload: {
      cases: [
        {
          id: qaContract.id,
          type: qaContract.type,
          docKeys: qaContract.docKeys,
          rawAnswer: answer,
          rawCitations: [citation, unusedCitation],
          rawRetrievedContexts: [context, unusedContext],
          answer,
          citations: [citation, unusedCitation],
          retrievedContexts: [context, unusedContext],
          comparisonAnalysisSummary: null,
          shouldAbstain: false,
          abstained: false,
          docCoverageHit: true,
          pageCoverageHit: true,
          answerExpectationHit: true,
          claimSupportHit: true,
          rawClaimSupportHit: true,
          comparisonExpectationHit: true,
          passed: true,
        },
      ],
    },
  });

  assert.equal(validation.status, "fail");
  assert.deepEqual(
    validation.issues
      .filter(
        (issue) =>
          issue.reasonCode === "synthetic_final_projection_mismatch"
      )
      .map((issue) => issue.field),
    ["citations", "retrievedContexts"]
  );
});

test("synthetic report corpus loader exposes only immutable document evidence", () => {
  const contract = loadRobustReportCaseContracts({
    corpusPath: "evaluation/synthetic-corpus-compare-hard.json",
  });
  const firstCase = contract.caseContracts[0];
  const alpha = contract.documentContracts.find(
    (document) => document.key === "handbook_alpha"
  );

  assert.equal(contract.issue, null);
  assert.equal(firstCase.corpusId, "synthetic-corpus-compare-hard");
  assert.equal(firstCase.corpusVersion, "1");
  assert.match(firstCase.question, /remote work policy/u);
  assert.deepEqual(Object.keys(alpha).sort(), ["fileName", "key", "pages"]);
  assert.equal(alpha.fileName, "handbook-alpha.pdf");
  assert.match(alpha.pages[0], /2 days per week with manager approval/);
});

test("synthetic evidence requires a one-to-one citation/context binding", () => {
  const validation = validateSyntheticEvidenceContract({
    caseId: qaContract.id,
    documentContracts,
    caseResult: {
      rawCitations: [citation],
      rawRetrievedContexts: [],
      citations: [],
      retrievedContexts: [],
    },
  });

  assert.equal(validation.status, "fail");
  assert.ok(
    validation.issues.some(
      (issue) =>
        issue.reasonCode === "synthetic_citation_context_mismatch" &&
        issue.field === "rawCitations[0]"
    )
  );
});

test("synthetic final evidence must be a subset of raw evidence", () => {
  const finalCitation = { ...citation, chunkIndex: 1 };
  const finalContext = { ...context, chunkIndex: 1 };
  const validation = validateSyntheticEvidenceContract({
    caseId: qaContract.id,
    documentContracts,
    caseResult: {
      rawCitations: [citation],
      rawRetrievedContexts: [context],
      citations: [finalCitation],
      retrievedContexts: [finalContext],
    },
  });

  assert.equal(validation.status, "fail");
  assert.ok(
    validation.issues.some(
      (issue) =>
        issue.reasonCode === "synthetic_final_evidence_not_raw_subset"
    )
  );
});

test("synthetic report outcomes accept only explicit abstention with declared coverage", () => {
  const outcome = recomputeSyntheticCaseOutcome({
    caseContract: {
      ...qaContract,
      shouldAbstain: true,
      expectedAnswerIncludes: null,
    },
    caseResult: {
      rawAnswer:
        "I do not have enough citation-backed evidence to answer reliably.",
      rawCitations: [citation],
      rawRetrievedContexts: [context],
      answer:
        "I do not have enough citation-backed evidence to answer reliably.",
      citations: [citation],
      retrievedContexts: [context],
      comparisonAnalysisSummary: null,
    },
  });

  assert.equal(outcome.rawAbstained, true);
  assert.equal(outcome.abstained, true);
  assert.equal(outcome.docCoverageHit, true);
  assert.equal(outcome.pageCoverageHit, true);
  assert.equal(outcome.passed, true);
});

test("synthetic report outcomes reject an empty finalized answer", () => {
  const outcome = recomputeSyntheticCaseOutcome({
    caseContract: qaContract,
    caseResult: {
      rawAnswer: "Remote work requires manager approval. [Source 1]",
      rawCitations: [citation],
      rawRetrievedContexts: [context],
      answer: "",
      citations: [citation],
      retrievedContexts: [context],
      comparisonAnalysisSummary: null,
    },
  });

  assert.equal(outcome.rawClaimSupportHit, true);
  assert.equal(outcome.passed, false);
});

test("synthetic comparison verdicts are recomputed from final answer evidence", () => {
  const corpusId = "synthetic-corpus-comparison-test";
  const corpusVersion = "1";
  const alphaDocId = buildSyntheticDocumentId({
    corpusId,
    corpusVersion,
    docKey: "handbook_alpha",
  });
  const betaDocId = buildSyntheticDocumentId({
    corpusId,
    corpusVersion,
    docKey: "handbook_beta",
  });
  const alphaCitation = {
    ...citation,
    docId: alphaDocId,
  };
  const betaCitation = {
    ...citation,
    rank: 2,
    docId: betaDocId,
    docKey: "handbook_beta",
    fileName: "handbook-beta.pdf",
  };
  const alphaText =
    "Employees may work remotely 2 days per week with manager approval.";
  const betaText =
    "Employees may work remotely 3 days per week with manager approval.";
  const answer = [
    "Differences:",
    `- handbook-alpha: ${alphaText} [Source 1]`,
    `- handbook-beta: ${betaText} [Source 2]`,
  ].join("\n");
  const comparisonAnalysisSummary = buildComparisonAnalysisFromEvidence({
    query: "Compare the remote work policies.",
    documents: [
      { docId: alphaDocId, fileName: "handbook-alpha.pdf" },
      { docId: betaDocId, fileName: "handbook-beta.pdf" },
    ],
    perDocumentResults: new Map([
      [
        alphaDocId,
        [
          {
            score: 1,
            document: {
              pageContent: alphaText,
              metadata: {
                docId: alphaDocId,
                fileName: "handbook-alpha.pdf",
              },
            },
          },
        ],
      ],
      [
        betaDocId,
        [
          {
            score: 1,
            document: {
              pageContent: betaText,
              metadata: {
                docId: betaDocId,
                fileName: "handbook-beta.pdf",
              },
            },
          },
        ],
      ],
    ]),
  }).summary;
  const documentContracts = [
    {
      key: "handbook_alpha",
      fileName: "handbook-alpha.pdf",
      pages: [alphaText],
    },
    {
      key: "handbook_beta",
      fileName: "handbook-beta.pdf",
      pages: [betaText],
    },
  ];
  const outcome = recomputeSyntheticCaseOutcome({
    caseContract: {
      id: "compare_remote_policy",
      type: "compare",
      question: "Compare the remote work policies.",
      corpusId,
      corpusVersion,
      shouldAbstain: false,
      compareExpectation: "difference",
      docKeys: ["handbook_alpha", "handbook_beta"],
      expectedEvidence: [
        { docKey: "handbook_alpha", pages: [1] },
        { docKey: "handbook_beta", pages: [1] },
      ],
      expectedAnswerIncludes: ["2 days", "3 days"],
    },
    caseResult: {
      rawAnswer: answer,
      rawCitations: [alphaCitation, betaCitation],
      rawRetrievedContexts: [
        { ...alphaCitation, text: alphaText },
        { ...betaCitation, text: betaText },
      ],
      answer,
      citations: [alphaCitation, betaCitation],
      retrievedContexts: [
        { ...alphaCitation, text: alphaText },
        { ...betaCitation, text: betaText },
      ],
      comparisonAnalysisSummary,
      claimSupport: { checked: false, claims: [] },
      comparisonVerdict: { passed: false },
    },
    documentContracts,
  });

  assert.equal(outcome.claimSupport.unsupportedClaimCount, 0);
  assert.equal(outcome.comparisonVerdict.actual, "difference");
  assert.equal(outcome.comparisonVerdict.passed, true);
  assert.equal(outcome.passed, true);
});

test("synthetic report validation rejects a forged no-difference analysis summary", () => {
  const corpusId = "synthetic-corpus-summary-adversary";
  const corpusVersion = "1";
  const alphaDocId = buildSyntheticDocumentId({
    corpusId,
    corpusVersion,
    docKey: "handbook_alpha",
  });
  const betaDocId = buildSyntheticDocumentId({
    corpusId,
    corpusVersion,
    docKey: "handbook_beta",
  });
  const alphaText =
    "Employees may work remotely 2 days per week with manager approval.";
  const betaText =
    "Employees may work remotely 3 days per week with manager approval.";
  const alphaCitation = {
    ...citation,
    docId: alphaDocId,
  };
  const betaCitation = {
    ...citation,
    rank: 2,
    docId: betaDocId,
    docKey: "handbook_beta",
    fileName: "handbook-beta.pdf",
  };
  const answer =
    "No evidence-backed material differences were found across the selected documents based on the retrieved evidence. [Source 1] [Source 2]";
  const forgedSummary = {
    comparedDocIds: [alphaDocId, betaDocId],
    evidenceBalance: "balanced",
    nearDuplicatePairs: [],
    explicitConflictPairs: [],
    likelyNoMaterialDifferencePairs: [],
    shouldShortCircuitNoMaterialDifference: true,
  };
  const validation = validateSyntheticCaseOutcomes({
    caseContracts: [
      {
        id: "compare_forged_summary",
        type: "compare",
        question: "Compare the remote work policies.",
        corpusId,
        corpusVersion,
        shouldAbstain: false,
        compareExpectation: "no_difference",
        docKeys: ["handbook_alpha", "handbook_beta"],
        expectedEvidence: [
          { docKey: "handbook_alpha", pages: [1] },
          { docKey: "handbook_beta", pages: [1] },
        ],
        expectedAnswerIncludes: ["No evidence-backed material differences"],
      },
    ],
    documentContracts: [
      {
        key: "handbook_alpha",
        fileName: "handbook-alpha.pdf",
        pages: [alphaText],
      },
      {
        key: "handbook_beta",
        fileName: "handbook-beta.pdf",
        pages: [betaText],
      },
    ],
    payload: {
      cases: [
        {
          id: "compare_forged_summary",
          type: "compare",
          docKeys: ["handbook_alpha", "handbook_beta"],
          rawAnswer: answer,
          rawCitations: [alphaCitation, betaCitation],
          rawRetrievedContexts: [
            { ...alphaCitation, text: alphaText },
            { ...betaCitation, text: betaText },
          ],
          answer,
          citations: [alphaCitation, betaCitation],
          retrievedContexts: [
            { ...alphaCitation, text: alphaText },
            { ...betaCitation, text: betaText },
          ],
          comparisonAnalysisSummary: forgedSummary,
          shouldAbstain: false,
          abstained: false,
          docCoverageHit: true,
          pageCoverageHit: true,
          answerExpectationHit: true,
          claimSupportHit: true,
          rawClaimSupportHit: true,
          comparisonExpectationHit: true,
          comparisonVerdict: {
            checked: true,
            expected: "no_difference",
            actual: "no_difference",
            passed: true,
            reasonCode: "ok",
          },
          passed: true,
        },
      ],
    },
  });

  assert.equal(validation.status, "fail");
  assert.equal(validation.outcomes[0].passed, false);
  assert.ok(
    validation.issues.some(
      (issue) =>
        issue.reasonCode === "synthetic_comparison_summary_mismatch"
    )
  );
});

test("synthetic report validation rejects comparison analysis on a QA case", () => {
  const answer = "Remote work requires manager approval. [Source 1]";
  const validation = validateSyntheticCaseOutcomes({
    caseContracts: [qaContract],
    documentContracts,
    payload: {
      cases: [
        {
          id: qaContract.id,
          type: qaContract.type,
          docKeys: qaContract.docKeys,
          rawAnswer: answer,
          rawCitations: [citation],
          rawRetrievedContexts: [context],
          answer,
          citations: [citation],
          retrievedContexts: [context],
          comparisonAnalysisSummary: {
            comparedDocIds: [qaDocumentId],
            evidenceBalance: "balanced",
            nearDuplicatePairs: [],
            explicitConflictPairs: [],
            likelyNoMaterialDifferencePairs: [],
            shouldShortCircuitNoMaterialDifference: false,
          },
          shouldAbstain: false,
          abstained: false,
          docCoverageHit: true,
          pageCoverageHit: true,
          answerExpectationHit: true,
          claimSupportHit: true,
          rawClaimSupportHit: true,
          comparisonExpectationHit: true,
          passed: true,
        },
      ],
    },
  });

  assert.equal(validation.status, "fail");
  assert.ok(
    validation.issues.some(
      (issue) =>
        issue.reasonCode === "synthetic_comparison_summary_mismatch" &&
        issue.expected === null
    )
  );
});

test("synthetic comparison abstention rebuilds the missing document identity", () => {
  const corpusId = "synthetic-corpus-missing-comparison-evidence";
  const corpusVersion = "1";
  const alphaDocId = buildSyntheticDocumentId({
    corpusId,
    corpusVersion,
    docKey: "handbook_alpha",
  });
  const travelDocId = buildSyntheticDocumentId({
    corpusId,
    corpusVersion,
    docKey: "travel_policy",
  });
  const alphaText =
    "Employees may work remotely 2 days per week with manager approval.";
  const alphaCitation = {
    rank: 1,
    docId: alphaDocId,
    docKey: "handbook_alpha",
    fileName: "handbook-alpha.pdf",
    pageNumber: 1,
    chunkIndex: 0,
  };
  const alphaContext = { ...alphaCitation, text: alphaText };
  const documents = [
    { docId: alphaDocId, fileName: "handbook-alpha.pdf" },
    { docId: travelDocId, fileName: "travel-policy.pdf" },
  ];
  const comparisonAnalysisSummary = buildComparisonAnalysisFromEvidence({
    query: "Compare the remote work policies.",
    documents,
    perDocumentResults: new Map([
      [
        alphaDocId,
        [
          {
            score: 1,
            document: {
              pageContent: alphaText,
              metadata: {
                docId: alphaDocId,
                fileName: "handbook-alpha.pdf",
                pageNumber: 1,
                chunkIndex: 0,
              },
            },
          },
        ],
      ],
      [travelDocId, []],
    ]),
  }).summary;
  const answer =
    "I only found strong evidence in 1 of the 2 selected documents, so the comparison would be unreliable.";
  const validation = validateSyntheticCaseOutcomes({
    caseContracts: [
      {
        id: "compare_missing_document_evidence",
        type: "compare",
        question: "Compare the remote work policies.",
        corpusId,
        corpusVersion,
        shouldAbstain: true,
        compareExpectation: "abstain",
        docKeys: ["handbook_alpha", "travel_policy"],
        expectedEvidence: [{ docKey: "handbook_alpha", pages: [1] }],
        expectedAnswerIncludes: null,
      },
    ],
    documentContracts: [
      {
        key: "handbook_alpha",
        fileName: "handbook-alpha.pdf",
        pages: [alphaText],
      },
      {
        key: "travel_policy",
        fileName: "travel-policy.pdf",
        pages: ["Travel expenses require itemized receipts."],
      },
    ],
    payload: {
      cases: [
        {
          id: "compare_missing_document_evidence",
          type: "compare",
          docKeys: ["handbook_alpha", "travel_policy"],
          rawAnswer: answer,
          rawCitations: [alphaCitation],
          rawRetrievedContexts: [alphaContext],
          answer,
          citations: [alphaCitation],
          retrievedContexts: [alphaContext],
          comparisonAnalysisSummary,
          shouldAbstain: true,
          abstained: true,
          docCoverageHit: true,
          pageCoverageHit: true,
          answerExpectationHit: true,
          claimSupportHit: true,
          rawClaimSupportHit: true,
          comparisonExpectationHit: true,
          passed: true,
        },
      ],
    },
  });

  assert.equal(validation.status, "pass");
  assert.deepEqual(validation.issues, []);
  assert.deepEqual(validation.outcomes[0].comparisonAnalysisSummary.comparedDocIds, [
    alphaDocId,
    travelDocId,
  ]);
});
