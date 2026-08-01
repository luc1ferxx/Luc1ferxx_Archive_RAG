import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateSyntheticCaseResponse,
} from "../evaluation/synthetic-case-evaluator.js";

test("synthetic cases retain finalization diagnostics but fail closed on raw unsupported claims", () => {
  const rawAnswer = [
    "Remote work requires manager approval. [Source 1]",
    "A satellite stipend is provided. [Source 1]",
  ].join("\n");
  const result = evaluateSyntheticCaseResponse({
    docKeyByDocId: new Map([["doc-alpha", "handbook_alpha"]]),
    pagesByDocKey: new Map([
      ["handbook_alpha", ["Remote work requires manager approval."]],
    ]),
    response: {
      text: rawAnswer,
      citations: [
        {
          rank: 1,
          docId: "doc-alpha",
          fileName: "handbook-alpha.pdf",
          pageNumber: 1,
        },
      ],
      retrievedContexts: [
        {
          rank: 1,
          docId: "doc-alpha",
          fileName: "handbook-alpha.pdf",
          pageNumber: 1,
          text: "Remote work requires manager approval.",
        },
      ],
    },
    responseTimeMs: 12,
    testCase: {
      docKeys: ["handbook_alpha"],
      expectedAnswerIncludes: ["manager approval"],
      expectedEvidence: [{ docKey: "handbook_alpha", pages: [1] }],
      id: "qa_remote_policy",
      question: "What approval is required?",
      shouldAbstain: false,
      type: "qa",
    },
  });

  assert.equal(result.rawAnswer, rawAnswer);
  assert.deepEqual(result.rawCitations, [
    {
      rank: 1,
      docId: "doc-alpha",
      docKey: "handbook_alpha",
      fileName: "handbook-alpha.pdf",
      pageNumber: 1,
      score: undefined,
      sectionHeading: undefined,
      chunkIndex: undefined,
    },
  ]);
  assert.deepEqual(result.rawRetrievedContexts, [
    {
      rank: 1,
      score: null,
      docId: "doc-alpha",
      docKey: "handbook_alpha",
      fileName: "handbook-alpha.pdf",
      pageNumber: 1,
      chunkIndex: null,
      sectionHeading: null,
      text: "Remote work requires manager approval.",
    },
  ]);
  assert.equal(result.comparisonAnalysisSummary, null);
  assert.equal(result.rawClaimSupport.unsupportedClaimCount, 1);
  assert.equal(
    result.answer,
    "Remote work requires manager approval. [Source 1]"
  );
  assert.equal(result.claimSupport.unsupportedClaimCount, 0);
  assert.deepEqual(result.finalization, {
    applied: true,
    changed: true,
    abstained: false,
    removedClaimCount: 1,
    removedClaims: ["A satellite stipend is provided"],
  });
  assert.equal(result.answerExpectationHit, true);
  assert.equal(result.claimSupportHit, true);
  assert.equal(result.rawClaimSupportHit, false);
  assert.equal(result.passed, false);
});

test("synthetic cases cannot satisfy answer expectations with a removed raw claim", () => {
  const result = evaluateSyntheticCaseResponse({
    docKeyByDocId: new Map([["doc-alpha", "handbook_alpha"]]),
    pagesByDocKey: new Map([
      ["handbook_alpha", ["Remote work requires manager approval."]],
    ]),
    response: {
      text: [
        "Remote work requires manager approval. [Source 1]",
        "A satellite stipend is provided. [Source 1]",
      ].join("\n"),
      citations: [
        {
          rank: 1,
          docId: "doc-alpha",
          fileName: "handbook-alpha.pdf",
          pageNumber: 1,
        },
      ],
      retrievedContexts: [
        {
          rank: 1,
          docId: "doc-alpha",
          fileName: "handbook-alpha.pdf",
          pageNumber: 1,
          text: "Remote work requires manager approval.",
        },
      ],
    },
    testCase: {
      docKeys: ["handbook_alpha"],
      expectedAnswerIncludes: ["satellite stipend"],
      expectedEvidence: [{ docKey: "handbook_alpha", pages: [1] }],
      id: "qa_unsupported_expected_phrase",
      question: "What benefits are provided?",
      shouldAbstain: false,
      type: "qa",
    },
  });

  assert.match(result.rawAnswer, /satellite stipend/i);
  assert.doesNotMatch(result.answer, /satellite stipend/i);
  assert.equal(result.answerExpectationHit, false);
  assert.equal(result.passed, false);
});

test("synthetic comparison verdicts cannot use raw unsupported differences", () => {
  const citations = ["alpha", "beta"].map((name, index) => ({
    rank: index + 1,
    docId: `doc-${name}`,
    fileName: `handbook-${name}.pdf`,
    pageNumber: 1,
  }));
  const retrievedContexts = citations.map((citation) => ({
    ...citation,
    text: "Employees may work remotely 2 days per week with manager approval.",
  }));
  const result = evaluateSyntheticCaseResponse({
    docKeyByDocId: new Map([
      ["doc-alpha", "handbook_alpha"],
      ["doc-beta", "handbook_beta"],
    ]),
    pagesByDocKey: new Map([
      [
        "handbook_alpha",
        ["Employees may work remotely 2 days per week with manager approval."],
      ],
      [
        "handbook_beta",
        ["Employees may work remotely 2 days per week with manager approval."],
      ],
    ]),
    response: {
      text: [
        "Differences:",
        "- handbook-alpha: Employees may work remotely 2 days per week with manager approval. [Source 1]",
        "- handbook-beta: Employees may work remotely 3 days per week with manager approval. [Source 2]",
      ].join("\n"),
      citations,
      retrievedContexts,
    },
    testCase: {
      compareExpectation: "difference",
      docKeys: ["handbook_alpha", "handbook_beta"],
      expectedAnswerIncludes: ["2 days", "3 days"],
      expectedEvidence: [
        { docKey: "handbook_alpha", pages: [1] },
        { docKey: "handbook_beta", pages: [1] },
      ],
      id: "compare_unsupported_raw_difference",
      question: "Compare the policies.",
      shouldAbstain: false,
      type: "compare",
    },
  });

  assert.ok(result.rawClaimSupport.unsupportedClaimCount > 0);
  assert.equal(result.comparisonExpectationHit, false);
  assert.notEqual(result.comparisonVerdict.actual, "difference");
  assert.equal(result.passed, false);

  const supportedResult = evaluateSyntheticCaseResponse({
    docKeyByDocId: new Map([
      ["doc-alpha", "handbook_alpha"],
      ["doc-beta", "handbook_beta"],
    ]),
    pagesByDocKey: new Map([
      [
        "handbook_alpha",
        ["Employees may work remotely 2 days per week with manager approval."],
      ],
      [
        "handbook_beta",
        ["Employees may work remotely 3 days per week with manager approval."],
      ],
    ]),
    response: {
      text: [
        "Differences:",
        "- handbook-alpha: Employees may work remotely 2 days per week with manager approval. [Source 1]",
        "- handbook-beta: Employees may work remotely 3 days per week with manager approval. [Source 2]",
      ].join("\n"),
      citations,
      comparisonAnalysisSummary: { trace: "preserved-for-replay" },
      retrievedContexts: retrievedContexts.map((context, index) => ({
        ...context,
        text:
          index === 0
            ? "Employees may work remotely 2 days per week with manager approval."
            : "Employees may work remotely 3 days per week with manager approval.",
      })),
    },
    testCase: {
      compareExpectation: "difference",
      docKeys: ["handbook_alpha", "handbook_beta"],
      expectedAnswerIncludes: ["2 days", "3 days"],
      expectedEvidence: [
        { docKey: "handbook_alpha", pages: [1] },
        { docKey: "handbook_beta", pages: [1] },
      ],
      id: "compare_supported_difference",
      question: "Compare the policies.",
      shouldAbstain: false,
      type: "compare",
    },
  });

  assert.equal(supportedResult.comparisonVerdict.actual, "difference");
  assert.deepEqual(supportedResult.comparisonAnalysisSummary, {
    trace: "preserved-for-replay",
  });
  assert.equal(supportedResult.comparisonExpectationHit, true);
  assert.equal(supportedResult.passed, true);
});

test("synthetic finalized output continuously rebases the retained evidence projection", () => {
  const result = evaluateSyntheticCaseResponse({
    docKeyByDocId: new Map([
      ["doc-removed", "handbook_removed"],
      ["doc-kept", "handbook_kept"],
    ]),
    pagesByDocKey: new Map([
      ["handbook_kept", ["Remote work requires manager approval."]],
    ]),
    response: {
      text: [
        "A satellite stipend is provided. [Source 1]",
        "Remote work requires manager approval. [Source 2]",
      ].join("\n"),
      citations: [
        {
          rank: 1,
          docId: "doc-removed",
          fileName: "handbook-removed.pdf",
          pageNumber: 1,
        },
        {
          rank: 2,
          docId: "doc-kept",
          fileName: "handbook-kept.pdf",
          pageNumber: 1,
        },
      ],
      retrievedContexts: [
        {
          rank: 1,
          docId: "doc-removed",
          fileName: "handbook-removed.pdf",
          pageNumber: 1,
          text: "Parking is available.",
        },
        {
          rank: 2,
          docId: "doc-kept",
          fileName: "handbook-kept.pdf",
          pageNumber: 1,
          text: "Remote work requires manager approval.",
        },
      ],
    },
    testCase: {
      docKeys: ["handbook_kept"],
      expectedAnswerIncludes: ["manager approval"],
      expectedEvidence: [{ docKey: "handbook_kept", pages: [1] }],
      id: "qa_rebased_projection",
      question: "What approval is required?",
      shouldAbstain: false,
      type: "qa",
    },
  });

  assert.equal(
    result.answer,
    "Remote work requires manager approval. [Source 1]"
  );
  assert.deepEqual(
    result.citations.map(({ rank, docId }) => ({ rank, docId })),
    [{ rank: 1, docId: "doc-kept" }]
  );
  assert.deepEqual(
    result.retrievedContexts.map(({ rank, docId }) => ({ rank, docId })),
    [{ rank: 1, docId: "doc-kept" }]
  );
  assert.deepEqual(result.claimSupport.claims[0].supportedSourceRanks, [1]);
  assert.equal(result.rawClaimSupportHit, false);
  assert.equal(result.passed, false);
});

test("synthetic abstention cases still require their declared evidence coverage", () => {
  const result = evaluateSyntheticCaseResponse({
    docKeyByDocId: new Map(),
    pagesByDocKey: new Map([
      ["handbook_alpha", ["Remote work requires manager approval."]],
    ]),
    response: {
      text: "I could not find enough grounded evidence in the selected documents to compare them.",
      abstained: true,
      citations: [],
      retrievedContexts: [],
    },
    testCase: {
      compareExpectation: "abstain",
      docKeys: ["handbook_alpha", "travel_manual"],
      expectedEvidence: [{ docKey: "handbook_alpha", pages: [1] }],
      id: "compare_remote_unrelated_abstain",
      question: "Compare the remote work policy.",
      shouldAbstain: true,
      type: "compare",
    },
  });

  assert.equal(result.abstained, true);
  assert.equal(result.docCoverageHit, false);
  assert.equal(result.pageCoverageHit, false);
  assert.equal(result.comparisonExpectationHit, true);
  assert.equal(result.passed, false);
});

test("synthetic evaluation does not trust an abstained flag on a factual answer", () => {
  const answer = "Employees may work remotely 5 days per week. [Source 1]";
  const result = evaluateSyntheticCaseResponse({
    docKeyByDocId: new Map([["doc-alpha", "handbook_alpha"]]),
    pagesByDocKey: new Map([
      ["handbook_alpha", ["Employees may work remotely 5 days per week."]],
    ]),
    response: {
      text: answer,
      abstained: true,
      citations: [
        {
          rank: 1,
          docId: "doc-alpha",
          chunkIndex: 0,
          pageNumber: 1,
        },
      ],
      retrievedContexts: [
        {
          rank: 1,
          docId: "doc-alpha",
          chunkIndex: 0,
          pageNumber: 1,
          text: "Employees may work remotely 5 days per week.",
        },
      ],
    },
    testCase: {
      docKeys: ["handbook_alpha"],
      expectedEvidence: [{ docKey: "handbook_alpha", pages: [1] }],
      id: "qa_factual_answer_mislabeled_abstain",
      question: "How many remote days are allowed?",
      shouldAbstain: true,
      type: "qa",
    },
  });

  assert.equal(result.abstained, false);
  assert.equal(result.docCoverageHit, true);
  assert.equal(result.pageCoverageHit, true);
  assert.equal(result.passed, false);
});

test("synthetic evaluation accepts a complete explicit safe abstention", () => {
  const answer =
    "I do not have enough citation-backed evidence to answer reliably.";
  const response = {
    text: answer,
    abstained: true,
    citations: [
      {
        rank: 1,
        docId: "doc-alpha",
        chunkIndex: 0,
        pageNumber: 1,
      },
    ],
    retrievedContexts: [
      {
        rank: 1,
        docId: "doc-alpha",
        chunkIndex: 0,
        pageNumber: 1,
        text: "Parking is available.",
      },
    ],
  };
  const result = evaluateSyntheticCaseResponse({
    docKeyByDocId: new Map([["doc-alpha", "handbook_alpha"]]),
    pagesByDocKey: new Map([["handbook_alpha", ["Parking is available."]]]),
    response,
    testCase: {
      docKeys: ["handbook_alpha"],
      expectedEvidence: [{ docKey: "handbook_alpha", pages: [1] }],
      id: "qa_explicit_safe_abstain",
      question: "Is there a satellite stipend?",
      shouldAbstain: true,
      type: "qa",
    },
  });

  assert.equal(result.abstained, true);
  assert.equal(result.docCoverageHit, true);
  assert.equal(result.pageCoverageHit, true);
  assert.equal(result.passed, true);
});

test("synthetic evaluation rejects an empty non-abstain answer", () => {
  const result = evaluateSyntheticCaseResponse({
    docKeyByDocId: new Map([["doc-alpha", "handbook_alpha"]]),
    pagesByDocKey: new Map([["handbook_alpha", ["Parking is available."]]]),
    response: {
      text: "",
      abstained: false,
      citations: [
        {
          rank: 1,
          docId: "doc-alpha",
          chunkIndex: 0,
          pageNumber: 1,
        },
      ],
      retrievedContexts: [
        {
          rank: 1,
          docId: "doc-alpha",
          chunkIndex: 0,
          pageNumber: 1,
          text: "Parking is available.",
        },
      ],
    },
    testCase: {
      docKeys: ["handbook_alpha"],
      expectedEvidence: [{ docKey: "handbook_alpha", pages: [1] }],
      id: "qa_empty_non_abstain",
      question: "What is available?",
      shouldAbstain: false,
      type: "qa",
    },
  });

  assert.equal(result.rawClaimSupport.checked, false);
  assert.equal(result.claimSupport.checked, false);
  assert.equal(result.passed, false);
});

test("synthetic evaluation cannot bind a conflicting context through an equal source rank", () => {
  const result = evaluateSyntheticCaseResponse({
    docKeyByDocId: new Map([["doc-alpha", "handbook_alpha"]]),
    pagesByDocKey: new Map([
      ["handbook_alpha", ["Only manager approval is documented."]],
    ]),
    response: {
      text: "Remote work requires CFO approval. [Source 1]",
      citations: [
        {
          rank: 1,
          docId: "doc-alpha",
          chunkIndex: 0,
          pageNumber: 1,
          excerpt: "Only manager approval is documented.",
        },
      ],
      retrievedContexts: [
        {
          rank: 1,
          docId: "doc-beta",
          chunkIndex: 0,
          pageNumber: 1,
          text: "Remote work requires CFO approval.",
        },
      ],
    },
    testCase: {
      docKeys: ["handbook_alpha"],
      expectedAnswerIncludes: ["CFO approval"],
      expectedEvidence: [{ docKey: "handbook_alpha", pages: [1] }],
      id: "qa_conflicting_context_identity",
      question: "What approval is required?",
      shouldAbstain: false,
      type: "qa",
    },
  });

  assert.equal(result.rawClaimSupportHit, false);
  assert.equal(result.passed, false);
});
