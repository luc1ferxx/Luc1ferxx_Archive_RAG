import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import {
  prepareComparisonSourceBundle,
  writeComparisonAnswer,
} from "../rag/answer-writer.js";
import { analyzeComparison } from "../rag/comparison-engine.js";
import { alignComparisonEvidence } from "../rag/evidence-aligner.js";
import { evaluateClaimSupport } from "../rag/agent-self-check.js";
import { attachRetrievedEvidence } from "../rag/citations.js";

const QUERY = "Compare the remote work policy.";
const originalDataDirectory = getRagDataDirectory();
const originalNearDuplicateGuard = process.env.RAG_NEAR_DUPLICATE_GUARD_ENABLED;
let tempRoot = null;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "comparison-answer-gate-"));
  configureRagDataDirectory(path.join(tempRoot, "rag-data"));
  delete process.env.RAG_NEAR_DUPLICATE_GUARD_ENABLED;
});

afterEach(async () => {
  resetOpenAIProvider();
  configureRagDataDirectory(originalDataDirectory);

  if (originalNearDuplicateGuard === undefined) {
    delete process.env.RAG_NEAR_DUPLICATE_GUARD_ENABLED;
  } else {
    process.env.RAG_NEAR_DUPLICATE_GUARD_ENABLED = originalNearDuplicateGuard;
  }

  await rm(tempRoot, { recursive: true, force: true });
});

const buildComparison = (pagesByDoc) => {
  const documents = pagesByDoc.map(({ docId, fileName }) => ({ docId, fileName }));
  const alignment = alignComparisonEvidence({
    query: QUERY,
    documents,
    perDocumentResults: new Map(
      pagesByDoc.map(({ docId, fileName, pageContent }) => [
        docId,
        [
          {
            document: {
              id: `${docId}:0`,
              pageContent,
              metadata: { docId, fileName, pageNumber: 1, chunkIndex: 0 },
            },
            score: 0.99,
          },
        ],
      ])
    ),
  });

  return {
    analysis: analyzeComparison({ alignment }),
    bundle: prepareComparisonSourceBundle({ alignment }),
  };
};

const NUMERIC_CONFLICT = [
  {
    docId: "alpha",
    fileName: "handbook-alpha.pdf",
    pageContent: "Employees may work remotely 2 days per week with manager approval.",
  },
  {
    docId: "gamma",
    fileName: "handbook-gamma.pdf",
    pageContent: "Employees may work remotely 3 days per week with manager approval.",
  },
];

const writeWithModelAnswer = async ({ analysis, bundle }, modelAnswer) => {
  configureOpenAIProvider({
    embedTexts: async (texts) => texts.map(() => [1]),
    embedQuery: async () => [1],
    completeText: async () => modelAnswer,
  });

  return writeComparisonAnswer({
    query: QUERY,
    resolvedQuery: QUERY,
    bundle,
    analysis,
  });
};

const buildDifferenceAnswer = (heading, { alphaDays = 2 } = {}) =>
  [
    heading,
    `- handbook-alpha states employees may work remotely ${alphaDays} days per week with manager approval. [Source 1]`,
    "- handbook-gamma states employees may work remotely 3 days per week with manager approval. [Source 2]",
  ].join("\n");

// A reject reason is written to the trace, so it may carry codes and counts
// only: never the question, the answer or the evidence.
const assertCodesAndCountsOnly = (reason) => {
  assert.ok(reason && typeof reason === "object");

  for (const [key, value] of Object.entries(reason)) {
    if (key === "code" || key === "fallback") {
      assert.match(value, /^[a-z_]+$/, `${key} is a code`);
    } else {
      assert.equal(Number.isInteger(value), true, `${key} is a count`);
    }
  }

  assert.doesNotMatch(JSON.stringify(reason), /remote|employees|manager|alpha|gamma/i);
};

for (const heading of ["## Differences", "**Differences**", "差异："]) {
  test(`comparison gate accepts a ${JSON.stringify(heading)} section and claim-checks it`, async () => {
    const comparison = buildComparison(NUMERIC_CONFLICT);

    assert.equal(comparison.analysis.shouldShortCircuitNoMaterialDifference, false);

    const accepted = await writeWithModelAnswer(comparison, buildDifferenceAnswer(heading));

    assert.equal(accepted.text, buildDifferenceAnswer(heading));
    assert.equal(accepted.abstained, undefined);
    assert.equal(accepted.modelRejectReason, undefined);

    // The same heading with a number the evidence does not state is still
    // claim-checked: the model answer is replaced and the reason recorded.
    const wrong = await writeWithModelAnswer(
      comparison,
      buildDifferenceAnswer(heading, { alphaDays: 4 })
    );

    assert.doesNotMatch(wrong.text, /\b4 days\b/);
    assert.equal(wrong.modelRejectReason.code, "unsupported_claims");
    assert.ok(wrong.modelRejectReason.unsupportedClaimCount >= 1);
    assert.equal(wrong.modelRejectReason.differenceClaimCount, 2);
    assert.equal(wrong.modelRejectReason.fallback, "grounded_template");
    assertCodesAndCountsOnly(wrong.modelRejectReason);
    assert.match(wrong.text, /2 days per week/);
    assert.match(wrong.text, /3 days per week/);
  });
}

test("comparison gate records why an answer without a differences section was replaced", async () => {
  const response = await writeWithModelAnswer(
    buildComparison(NUMERIC_CONFLICT),
    [
      "Summary:",
      "- handbook-alpha states employees may work remotely 2 days per week with manager approval. [Source 1]",
    ].join("\n")
  );

  assert.deepEqual(response.modelRejectReason, {
    code: "no_differences_section",
    fallback: "grounded_template",
  });
  assert.match(response.text, /^Differences:$/m);
});

test("comparison gate records an empty model answer and an abstaining fallback", async () => {
  const response = await writeWithModelAnswer(
    buildComparison([
      { docId: "alpha", fileName: "handbook-alpha.pdf", pageContent: "Remote Work Policy" },
      { docId: "gamma", fileName: "handbook-gamma.pdf", pageContent: "Travel Policy" },
    ]),
    ""
  );

  assert.equal(response.abstained, true);
  assert.deepEqual(response.modelRejectReason, {
    code: "empty_answer",
    fallback: "abstained",
  });
});

test("comparison gate requires the differences section to bind every document", async () => {
  const comparison = buildComparison([
    ...NUMERIC_CONFLICT,
    {
      docId: "beta",
      fileName: "handbook-beta.pdf",
      pageContent: "Employees may work remotely 2 days per week with manager approval.",
    },
  ]);
  const betaRank = comparison.bundle.citations.find(
    (citation) => citation.docId === "beta"
  ).rank;
  const gammaRank = comparison.bundle.citations.find(
    (citation) => citation.docId === "gamma"
  ).rank;
  const alphaRank = comparison.bundle.citations.find(
    (citation) => citation.docId === "alpha"
  ).rank;
  // Every claim is supported, but the section never names handbook-beta.
  const response = await writeWithModelAnswer(
    comparison,
    [
      "## Differences",
      `- handbook-alpha states employees may work remotely 2 days per week with manager approval. [Source ${alphaRank}]`,
      `- handbook-gamma states employees may work remotely 3 days per week with manager approval. [Source ${gammaRank}]`,
    ].join("\n")
  );

  assert.notEqual(betaRank, undefined);
  assert.equal(
    response.modelRejectReason.code,
    "differences_not_bound_to_every_document"
  );
  assert.equal(response.modelRejectReason.unsupportedClaimCount, 0);
  assert.equal(response.modelRejectReason.documentCount, 3);
  assert.equal(response.modelRejectReason.coveredDocumentCount, 2);
  assertCodesAndCountsOnly(response.modelRejectReason);
});

const SOFT_WRAPPED_CONFLICT = [
  {
    docId: "alpha",
    fileName: "handbook-alpha.pdf",
    pageContent: [
      "Remote Work Policy",
      "Employees may work remotely 2 days per week",
      "with written approval from their",
      "direct manager.",
      "Eligibility:",
      "- Full-time staff only.",
    ].join("\n"),
  },
  {
    docId: "gamma",
    fileName: "handbook-gamma.pdf",
    pageContent: [
      "Remote Work Policy",
      "Employees may work remotely 3 days per week",
      "with written approval from their",
      "direct manager.",
      "Eligibility:",
      "- Full-time staff only.",
    ].join("\n"),
  },
];

test("comparison fallback quotes whole sentences from a soft-wrapped PDF paragraph", async () => {
  const comparison = buildComparison(SOFT_WRAPPED_CONFLICT);
  const response = await writeWithModelAnswer(comparison, "Summary:\n- Not structured.");
  const bulletLines = response.text
    .split("\n")
    .filter((line) => line.startsWith("- "));

  assert.equal(response.modelRejectReason.code, "no_differences_section");
  assert.equal(response.modelRejectReason.fallback, "grounded_template");
  assert.ok(
    bulletLines.some((line) =>
      line.includes(
        "Employees may work remotely 2 days per week with written approval from their direct manager."
      )
    )
  );
  assert.ok(
    bulletLines.some((line) =>
      line.includes(
        "Employees may work remotely 3 days per week with written approval from their direct manager."
      )
    )
  );

  for (const line of bulletLines) {
    // Every quoted sentence is whole: no line ends mid-sentence before its
    // source label, and no wrapped continuation or bare heading is quoted.
    assert.match(line, /[.!?] \[Source \d+\]$/, line);
    assert.doesNotMatch(line, /states (?:with written|direct manager|Remote Work Policy|Eligibility)/, line);
  }

  // The rebuilt answer passes the same claim check the gate applies.
  const claimSupport = evaluateClaimSupport({
    answerText: response.text,
    citations: attachRetrievedEvidence({
      citations: comparison.bundle.citations,
      retrievedContexts: comparison.bundle.retrievedContexts,
    }),
    comparisonAnalysisSummary: comparison.analysis,
  });

  assert.equal(claimSupport.unsupportedClaimCount, 0);
});

test("no-material-difference fallback rejoins soft wraps and drops bare headings", async () => {
  const sameText = SOFT_WRAPPED_CONFLICT[0].pageContent;
  const comparison = buildComparison([
    { docId: "alpha", fileName: "handbook-alpha.pdf", pageContent: sameText },
    { docId: "beta", fileName: "handbook-beta.pdf", pageContent: sameText },
  ]);

  assert.equal(comparison.analysis.shouldShortCircuitNoMaterialDifference, true);

  const response = await writeWithModelAnswer(comparison, "unused");
  const bulletLines = response.text
    .split("\n")
    .filter((line) => line.startsWith("- "));

  assert.equal(response.modelRejectReason, undefined);
  assert.ok(
    bulletLines.some((line) =>
      line.startsWith(
        "- Employees may work remotely 2 days per week with written approval from their direct manager."
      )
    )
  );
  // The list item stays its own sentence and is never merged into the label.
  assert.ok(bulletLines.some((line) => line.startsWith("- - Full-time staff only.") || line.startsWith("- Full-time staff only.")));

  for (const line of bulletLines) {
    assert.doesNotMatch(line, /^- (?:Remote Work Policy|Eligibility:?|with written|direct manager)\b/, line);
  }
});

// A table row read out of a PDF ("Notice Period 30 Days") is Title Case with
// no predicate, like a heading, but its number is the fact being compared.
test("comparison fallback keeps a Title Case evidence line that states a number", async () => {
  const response = await writeWithModelAnswer(
    buildComparison([
      { docId: "alpha", fileName: "vendor-alpha.pdf", pageContent: "Notice Period 30 Days" },
      { docId: "gamma", fileName: "vendor-gamma.pdf", pageContent: "Notice Period 60 Days" },
    ]),
    "Summary:\n- Not structured."
  );

  assert.equal(response.abstained, undefined);
  assert.equal(response.modelRejectReason.fallback, "grounded_template");
  assert.match(response.text, /vendor-alpha states Notice Period 30 Days \[Source \d+\]/);
  assert.match(response.text, /vendor-gamma states Notice Period 60 Days \[Source \d+\]/);
});

// joinWrappedLines joins any line that starts in lowercase onto a previous line
// without final punctuation, a heading included. The fallback must not glue a
// heading onto the sentence under it, nor drop that sentence with the heading.
for (const heading of ["Notice Period", "## Notice Period"]) {
  test(`comparison fallback keeps the ${JSON.stringify(heading)} heading off the sentence under it`, async () => {
    const response = await writeWithModelAnswer(
      buildComparison([
        {
          docId: "alpha",
          fileName: "vendor-alpha.pdf",
          pageContent: `${heading}\nthe supplier must give 30 days written notice.`,
        },
        {
          docId: "gamma",
          fileName: "vendor-gamma.pdf",
          pageContent: `${heading}\nthe supplier must give 60 days written notice.`,
        },
      ]),
      "Summary:\n- Not structured."
    );

    assert.equal(response.abstained, undefined);
    assert.equal(response.modelRejectReason.fallback, "grounded_template");
    assert.match(
      response.text,
      /vendor-alpha states the supplier must give 30 days written notice\. \[Source \d+\]/
    );
    assert.match(
      response.text,
      /vendor-gamma states the supplier must give 60 days written notice\. \[Source \d+\]/
    );
    assert.doesNotMatch(response.text, /Notice Period/);
  });
}
