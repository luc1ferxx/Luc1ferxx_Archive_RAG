import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import {
  buildComparisonStructuredResponseFormat,
  getActiveAnswerPromptDescriptors,
  prepareComparisonSourceBundle,
  renderStructuredComparisonAnswer,
  writeComparisonAnswer,
} from "../rag/answer-writer.js";
import { analyzeComparison } from "../rag/comparison-engine.js";
import { alignComparisonEvidence } from "../rag/evidence-aligner.js";

// RAG_COMPARISON_STRUCTURED_OUTPUT: the model returns verbatim quotes with
// their Source numbers, the server renders the grounded template's lines from
// the evidence sentences those quotes lie in, and the unchanged comparison gate
// checks the rendered text. Off, the comparison call is what it was.

const QUERY = "Compare the remote work policy.";
const ENV_KEYS = [
  "RAG_COMPARISON_STRUCTURED_OUTPUT",
  "RAG_NEAR_DUPLICATE_GUARD_ENABLED",
  "RAG_STRUCTURED_OUTPUT_ENABLED",
];
const originalDataDirectory = getRagDataDirectory();
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let tempRoot = null;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "comparison-structured-"));
  configureRagDataDirectory(path.join(tempRoot, "rag-data"));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  process.env.RAG_COMPARISON_STRUCTURED_OUTPUT = "true";
});

afterEach(async () => {
  resetOpenAIProvider();
  configureRagDataDirectory(originalDataDirectory);

  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
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

const ALPHA_SENTENCE = "Employees may work remotely 2 days per week with manager approval.";
const GAMMA_SENTENCE = "Employees may work remotely 3 days per week with manager approval.";
const NUMERIC_CONFLICT = [
  { docId: "alpha", fileName: "handbook-alpha.pdf", pageContent: ALPHA_SENTENCE },
  { docId: "gamma", fileName: "handbook-gamma.pdf", pageContent: GAMMA_SENTENCE },
];

const rankOf = ({ bundle }, docId) =>
  bundle.citations.find((citation) => citation.docId === docId).rank;

const writeWithModelReply = async ({ analysis, bundle }, reply) => {
  const calls = [];

  configureOpenAIProvider({
    embedTexts: async (texts) => texts.map(() => [1]),
    embedQuery: async () => [1],
    completeText: async (prompt, options) => {
      calls.push({ options, prompt });
      return typeof reply === "string" ? reply : JSON.stringify(reply);
    },
  });

  const response = await writeComparisonAnswer({
    query: QUERY,
    resolvedQuery: QUERY,
    bundle,
    analysis,
  });

  return { calls, response };
};

const differenceReply = (comparison, { alphaQuote, gammaQuote, alphaSource } = {}) => ({
  differences: [
    {
      aspect: "Remote work days",
      entries: [
        {
          quote: alphaQuote ?? "work remotely 2 days per week",
          source: alphaSource ?? rankOf(comparison, "alpha"),
        },
        { quote: gammaQuote ?? GAMMA_SENTENCE, source: rankOf(comparison, "gamma") },
      ],
    },
  ],
});

const boundLine = (label, sentence, rank) => `- ${label} states ${sentence} [Source ${rank}]`;

const assertIntegerCounts = (counts) => {
  for (const [key, value] of Object.entries(counts)) {
    assert.equal(Number.isInteger(value), true, `${key} is an integer`);
  }
};

test("structured comparison sends a strict response format that names only the shown ranks", async () => {
  const comparison = buildComparison(NUMERIC_CONFLICT);
  const ranks = comparison.bundle.rankedResults.map((result) => result.rank);
  const { calls } = await writeWithModelReply(comparison, differenceReply(comparison));

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.responseFormat, buildComparisonStructuredResponseFormat(ranks));
  assert.deepEqual(
    calls[0].options.responseFormat.json_schema.schema.properties.differences.items.properties
      .entries.items.properties.source,
    { enum: ranks, type: "integer" }
  );
  assert.equal(calls[0].options.responseFormat.json_schema.strict, true);
  assert.match(calls[0].prompt, /Reply with one JSON object and nothing else/);
  assert.match(calls[0].prompt, /copied verbatim from the cited Source block/);
  assert.equal(getActiveAnswerPromptDescriptors()[1].id, "comparison_answer_structured");
});

test("verbatim quotes render as the grounded template's lines and pass the comparison gate", async () => {
  const comparison = buildComparison(NUMERIC_CONFLICT);
  const alphaRank = rankOf(comparison, "alpha");
  const gammaRank = rankOf(comparison, "gamma");
  const { response } = await writeWithModelReply(comparison, differenceReply(comparison));
  const alphaLine = boundLine("handbook-alpha", ALPHA_SENTENCE, alphaRank);
  const gammaLine = boundLine("handbook-gamma", GAMMA_SENTENCE, gammaRank);
  const perDocument = alphaRank < gammaRank ? [alphaLine, gammaLine] : [gammaLine, alphaLine];

  assert.equal(
    response.text,
    [
      "Summary:",
      "Per document:",
      ...perDocument,
      "Differences:",
      alphaLine,
      gammaLine,
      "Gaps or uncertainty:",
    ].join("\n")
  );
  assert.equal(response.abstained, undefined);
  assert.equal(response.modelRejectReason, undefined);
  assert.deepEqual(response.structuredOutput, {
    parsed: 1,
    aspectCount: 1,
    entryCount: 2,
    resolvedEntryCount: 2,
    droppedEntryCount: 0,
    droppedAspectCount: 0,
    filledEntryCount: 0,
    renderedLineCount: 2,
  });
});

test("a quote with a value the evidence does not state is dropped and the answer falls back", async () => {
  const comparison = buildComparison(NUMERIC_CONFLICT);
  const { response } = await writeWithModelReply(
    comparison,
    differenceReply(comparison, { alphaQuote: "work remotely 4 days per week" })
  );

  // alpha's entry is gone, so the aspect holds one document and is no difference.
  assert.deepEqual(response.modelRejectReason, {
    code: "structured_no_differences",
    fallback: "grounded_template",
  });
  assert.deepEqual(response.structuredOutput, {
    parsed: 1,
    aspectCount: 1,
    entryCount: 2,
    resolvedEntryCount: 1,
    droppedEntryCount: 1,
    droppedAspectCount: 1,
    filledEntryCount: 0,
    renderedLineCount: 0,
  });
  assert.doesNotMatch(response.text, /4 days/);
  assert.match(response.text, /2 days per week/);
  assert.match(response.text, /3 days per week/);
  assert.match(response.text, /^Differences:$/m);
});

test("a quote citing a rank the model was not shown is dropped", async () => {
  const comparison = buildComparison(NUMERIC_CONFLICT);
  const { response } = await writeWithModelReply(
    comparison,
    differenceReply(comparison, { alphaSource: 9 })
  );

  assert.equal(response.modelRejectReason.code, "structured_no_differences");
  assert.equal(response.structuredOutput.droppedEntryCount, 1);
  assert.equal(response.structuredOutput.renderedLineCount, 0);
});

test("a reply that is not JSON falls back as unparsable", async () => {
  const comparison = buildComparison(NUMERIC_CONFLICT);
  const { response } = await writeWithModelReply(
    comparison,
    "Summary:\n- handbook-alpha allows 2 days per week. [Source 1]"
  );

  assert.deepEqual(response.modelRejectReason, {
    code: "structured_output_unparsable",
    fallback: "grounded_template",
  });
  assert.equal(response.structuredOutput.parsed, 0);
  assert.equal(response.structuredOutput.entryCount, 0);
  assertIntegerCounts(response.structuredOutput);
  assert.match(response.text, /^Differences:$/m);
});

test("an empty differences list falls back as no differences", async () => {
  const comparison = buildComparison(NUMERIC_CONFLICT);
  const { response } = await writeWithModelReply(comparison, { differences: [] });

  assert.deepEqual(response.modelRejectReason, {
    code: "structured_no_differences",
    fallback: "grounded_template",
  });
  assert.deepEqual(response.structuredOutput, {
    parsed: 1,
    aspectCount: 0,
    entryCount: 0,
    resolvedEntryCount: 0,
    droppedEntryCount: 0,
    droppedAspectCount: 0,
    filledEntryCount: 0,
    renderedLineCount: 0,
  });
});

test("the rendered answer still goes through the gate: a document the reply never binds is refused", async () => {
  const comparison = buildComparison([
    ...NUMERIC_CONFLICT,
    {
      docId: "beta",
      fileName: "handbook-beta.pdf",
      pageContent: "Travel expenses are reimbursed within 30 days of filing.",
    },
  ]);
  // Two documents differ, but the third (not a near-duplicate of either, so
  // nothing fills it in) is never bound: the existing gate rule refuses the
  // rendered answer like a prose one.
  assert.ok(
    comparison.analysis.nearDuplicatePairs.every(
      (pair) => pair.leftDocId !== "beta" && pair.rightDocId !== "beta"
    )
  );
  const { response } = await writeWithModelReply(comparison, differenceReply(comparison));

  assert.equal(response.modelRejectReason.code, "differences_not_bound_to_every_document");
  assert.equal(response.modelRejectReason.documentCount, 3);
  assert.equal(response.modelRejectReason.coveredDocumentCount, 2);
  assert.equal(response.structuredOutput.renderedLineCount, 2);
});

test("a quote across soft-wrapped PDF lines resolves to the whole sentence", () => {
  const comparison = buildComparison([
    {
      docId: "alpha",
      fileName: "handbook-alpha.pdf",
      pageContent: [
        "Remote Work Policy",
        "Employees may work remotely 2 days per week",
        "with written approval from their",
        "direct manager.",
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
      ].join("\n"),
    },
  ]);
  const alphaRank = rankOf(comparison, "alpha");
  const gammaRank = rankOf(comparison, "gamma");
  const rendered = renderStructuredComparisonAnswer({
    bundle: comparison.bundle,
    parsed: {
      differences: [
        {
          aspect: "Days",
          entries: [
            { quote: "2 days per week with written approval", source: alphaRank },
            { quote: "“3 days per week” with written approval—", source: gammaRank },
          ],
        },
      ],
    },
  });

  assert.equal(rendered.counts.renderedLineCount, 2);
  assert.ok(
    rendered.text.includes(
      boundLine(
        "handbook-alpha",
        "Employees may work remotely 2 days per week with written approval from their direct manager.",
        alphaRank
      )
    )
  );
  assert.ok(
    rendered.text.includes(
      boundLine(
        "handbook-gamma",
        "Employees may work remotely 3 days per week with written approval from their direct manager.",
        gammaRank
      )
    )
  );
  assert.doesNotMatch(rendered.text, /Remote Work Policy/);
});

test("a quote that spans two sentences resolves to the sentence holding most of it", () => {
  const comparison = buildComparison([
    {
      docId: "alpha",
      fileName: "handbook-alpha.pdf",
      pageContent:
        "Employees may work remotely 2 days per week. Approval comes from the direct manager.",
    },
    {
      docId: "gamma",
      fileName: "handbook-gamma.pdf",
      pageContent:
        "Employees may work remotely 3 days per week. Approval comes from the department head.",
    },
  ]);
  const alphaRank = rankOf(comparison, "alpha");
  const gammaRank = rankOf(comparison, "gamma");
  const rendered = renderStructuredComparisonAnswer({
    bundle: comparison.bundle,
    parsed: {
      differences: [
        {
          aspect: "Days and approval",
          entries: [
            { quote: "2 days per week. Approval comes from the direct manager", source: alphaRank },
            { quote: "3 days per week", source: gammaRank },
            // A second entry for a document already in the aspect is dropped.
            { quote: "Approval comes from the department head.", source: gammaRank },
          ],
        },
        {
          aspect: "Approval",
          entries: [
            { quote: "Approval comes from the direct manager.", source: alphaRank },
            { quote: "Approval comes from the department head.", source: gammaRank },
          ],
        },
      ],
    },
  });
  const bulletLines = rendered.text.split("\n").filter((line) => line.startsWith("- "));

  assert.deepEqual(rendered.counts, {
    parsed: 1,
    aspectCount: 2,
    entryCount: 5,
    resolvedEntryCount: 4,
    droppedEntryCount: 1,
    droppedAspectCount: 0,
    filledEntryCount: 0,
    renderedLineCount: 4,
  });
  // Per document (one line each) plus two contrast pairs.
  assert.deepEqual(bulletLines, [
    boundLine("handbook-alpha", "Approval comes from the direct manager.", alphaRank),
    boundLine("handbook-gamma", "Employees may work remotely 3 days per week.", gammaRank),
    boundLine("handbook-alpha", "Approval comes from the direct manager.", alphaRank),
    boundLine("handbook-gamma", "Employees may work remotely 3 days per week.", gammaRank),
    boundLine("handbook-alpha", "Approval comes from the direct manager.", alphaRank),
    boundLine("handbook-gamma", "Approval comes from the department head.", gammaRank),
  ]);
});

const THREE_DOCUMENTS = [
  ...NUMERIC_CONFLICT,
  { docId: "beta", fileName: "handbook-beta.pdf", pageContent: ALPHA_SENTENCE },
];

test("near-duplicate documents form one group and are each paired with the document that differs", async () => {
  const comparison = buildComparison(THREE_DOCUMENTS);
  const alphaRank = rankOf(comparison, "alpha");
  const betaRank = rankOf(comparison, "beta");
  const gammaRank = rankOf(comparison, "gamma");
  const { response } = await writeWithModelReply(comparison, {
    differences: [
      {
        aspect: "Remote work days",
        entries: [
          { quote: "work remotely 2 days per week", source: alphaRank },
          { quote: "work remotely 2 days per week", source: betaRank },
          { quote: "work remotely 3 days per week", source: gammaRank },
        ],
      },
    ],
  });
  const alphaLine = boundLine("handbook-alpha", ALPHA_SENTENCE, alphaRank);
  const betaLine = boundLine("handbook-beta", ALPHA_SENTENCE, betaRank);
  const gammaLine = boundLine("handbook-gamma", GAMMA_SENTENCE, gammaRank);

  // The gate accepts the rendered answer: every document is bound, and the
  // Differences section pairs alpha with gamma and beta with gamma (so the
  // gamma line is written twice), which is the pairing the claim check wants.
  assert.equal(response.modelRejectReason, undefined);
  assert.deepEqual(
    response.text.split("Differences:\n")[1].split("\nGaps or uncertainty:")[0].split("\n"),
    [alphaLine, gammaLine, betaLine, gammaLine]
  );
  assert.equal(response.structuredOutput.renderedLineCount, 4);
  assert.equal(response.structuredOutput.droppedAspectCount, 0);
});

test("a near-duplicate document the reply left out is filled in with the sentence its partner quoted", async () => {
  const comparison = buildComparison(THREE_DOCUMENTS);
  const alphaRank = rankOf(comparison, "alpha");
  const betaRank = rankOf(comparison, "beta");
  const gammaRank = rankOf(comparison, "gamma");

  // alpha and beta are twins; the engine may also pair each with gamma as a
  // near-duplicate with an explicit conflict, which the fill never uses
  // because gamma's sentence is not in their evidence.
  assert.ok(
    comparison.analysis.nearDuplicatePairs.some(
      (pair) => [pair.leftDocId, pair.rightDocId].sort().join() === "alpha,beta"
    )
  );

  // The model quoted alpha and gamma only, as qwen2.5:7b does with twins.
  const { response } = await writeWithModelReply(comparison, differenceReply(comparison));
  const alphaLine = boundLine("handbook-alpha", ALPHA_SENTENCE, alphaRank);
  const betaLine = boundLine("handbook-beta", ALPHA_SENTENCE, betaRank);
  const gammaLine = boundLine("handbook-gamma", GAMMA_SENTENCE, gammaRank);

  assert.equal(response.modelRejectReason, undefined);
  assert.deepEqual(
    response.text.split("Differences:\n")[1].split("\nGaps or uncertainty:")[0].split("\n"),
    [alphaLine, gammaLine, betaLine, gammaLine]
  );
  assert.deepEqual(response.structuredOutput, {
    parsed: 1,
    aspectCount: 1,
    entryCount: 2,
    resolvedEntryCount: 2,
    droppedEntryCount: 0,
    droppedAspectCount: 0,
    filledEntryCount: 1,
    renderedLineCount: 4,
  });
});

test("a near-duplicate partner is not filled in when its evidence lacks the quoted sentence", () => {
  const comparison = buildComparison([
    ...NUMERIC_CONFLICT,
    {
      docId: "beta",
      fileName: "handbook-beta.pdf",
      pageContent: "Employees may work remotely 2 days per week with manager approval. Badges renew yearly.",
    },
  ]);
  const alphaRank = rankOf(comparison, "alpha");
  const betaRank = rankOf(comparison, "beta");
  const rendered = renderStructuredComparisonAnswer({
    analysis: {
      nearDuplicatePairs: [{ leftDocId: "alpha", rightDocId: "beta" }],
    },
    bundle: comparison.bundle,
    parsed: {
      differences: [
        {
          aspect: "Badges",
          entries: [
            { quote: "Badges renew yearly.", source: betaRank },
            { quote: GAMMA_SENTENCE, source: rankOf(comparison, "gamma") },
          ],
        },
      ],
    },
  });

  // alpha is beta's twin but never says "Badges renew yearly", so it stays
  // out; the aspect renders beta against gamma only.
  assert.equal(rendered.counts.filledEntryCount, 0);
  assert.equal(rendered.counts.renderedLineCount, 2);
  assert.doesNotMatch(rendered.text, new RegExp(`\\[Source ${alphaRank}\\]`));
});

test("an aspect on which every quoted document says the same thing is no difference", async () => {
  const comparison = buildComparison(THREE_DOCUMENTS);
  const alphaRank = rankOf(comparison, "alpha");
  const betaRank = rankOf(comparison, "beta");
  const gammaRank = rankOf(comparison, "gamma");
  const { response } = await writeWithModelReply(comparison, {
    differences: [
      {
        aspect: "Approval",
        entries: [
          { quote: "with manager approval", source: alphaRank },
          { quote: "with manager approval", source: betaRank },
        ],
      },
      {
        aspect: "Remote work days",
        entries: [
          { quote: ALPHA_SENTENCE, source: alphaRank },
          { quote: ALPHA_SENTENCE, source: betaRank },
          { quote: GAMMA_SENTENCE, source: gammaRank },
        ],
      },
    ],
  });

  assert.equal(response.modelRejectReason, undefined);
  assert.deepEqual(response.structuredOutput, {
    parsed: 1,
    aspectCount: 2,
    entryCount: 5,
    resolvedEntryCount: 5,
    droppedEntryCount: 0,
    droppedAspectCount: 1,
    filledEntryCount: 0,
    renderedLineCount: 4,
  });
});

test("malformed replies render nothing and count as unparsable", () => {
  const comparison = buildComparison(NUMERIC_CONFLICT);

  for (const parsed of [undefined, null, "text", [], { differences: "none" }, { other: [] }]) {
    const rendered = renderStructuredComparisonAnswer({ bundle: comparison.bundle, parsed });

    assert.equal(rendered.text, null);
    assert.equal(rendered.counts.parsed, 0);
  }

  const partlyMalformed = renderStructuredComparisonAnswer({
    bundle: comparison.bundle,
    parsed: { differences: [null, 7, { entries: "no" }, { entries: [null, { source: "x" }] }] },
  });

  // Non-object aspects and entries are ignored; the rest count as dropped.
  assert.equal(partlyMalformed.text, null);
  assert.equal(partlyMalformed.counts.parsed, 1);
  assert.equal(partlyMalformed.counts.aspectCount, 2);
  assert.equal(partlyMalformed.counts.entryCount, 1);
  assert.equal(partlyMalformed.counts.droppedEntryCount, 1);
  assert.equal(partlyMalformed.counts.droppedAspectCount, 2);
});

test("without RAG_STRUCTURED_OUTPUT_ENABLED no response format is sent, and JSON is still read", async () => {
  process.env.RAG_STRUCTURED_OUTPUT_ENABLED = "false";
  const comparison = buildComparison(NUMERIC_CONFLICT);
  const { calls, response } = await writeWithModelReply(
    comparison,
    `Here is the selection:\n${JSON.stringify(differenceReply(comparison))}\nDone.`
  );

  assert.equal(calls[0].options.responseFormat ?? null, null);
  assert.equal(response.modelRejectReason, undefined);
  assert.equal(response.structuredOutput.renderedLineCount, 2);
});

test("with the flag off the comparison call and its result are unchanged", async () => {
  delete process.env.RAG_COMPARISON_STRUCTURED_OUTPUT;
  const comparison = buildComparison(NUMERIC_CONFLICT);
  const proseAnswer = [
    "Differences:",
    boundLine("handbook-alpha", ALPHA_SENTENCE, rankOf(comparison, "alpha")),
    boundLine("handbook-gamma", GAMMA_SENTENCE, rankOf(comparison, "gamma")),
  ].join("\n");
  const { calls, response } = await writeWithModelReply(comparison, proseAnswer);

  assert.equal(calls[0].options.responseFormat ?? null, null);
  assert.doesNotMatch(calls[0].prompt, /JSON/);
  assert.equal(response.text, proseAnswer);
  assert.equal("structuredOutput" in response, false);
  assert.equal(getActiveAnswerPromptDescriptors()[1].id, "guarded_comparison_answer");
});
