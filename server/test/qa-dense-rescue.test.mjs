import assert from "node:assert/strict";
import test from "node:test";
import { getQaDenseRescue, QA_DENSE_RESCUE_MODES } from "../rag/config.js";
import { assessQaConfidence } from "../rag/confidence.js";
import { describeRetrievalConfig, describeRunConfigDifferences } from "../evaluation/eval-run-config.js";

const RESCUE_VARIABLES = ["RAG_QA_DENSE_RESCUE", "RAG_QA_DENSE_RESCUE_THRESHOLD", "RAG_QA_DENSE_RESCUE_FLOOR"];

// Runs `callback` with the rescue variables (and any others) set as given and
// every rescue variable not given unset, then restores the environment.
const withEnv = async (values, callback) => {
  const names = [...new Set([...RESCUE_VARIABLES, ...Object.keys(values)])];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  for (const name of names) {
    if (values[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = values[name];
    }
  }

  try {
    return await callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  }
};

const rescue = (mode, threshold, floor) => ({
  RAG_QA_DENSE_RESCUE: mode,
  RAG_QA_DENSE_RESCUE_THRESHOLD: threshold === undefined ? undefined : String(threshold),
  RAG_QA_DENSE_RESCUE_FLOOR: floor === undefined ? undefined : String(floor),
});

const chunk = (index, pageContent, { keywordScore, vectorScore, sectionHeading = "Evaluation", ...rest }) => ({
  document: {
    id: `paper:${index}`,
    metadata: { chunkIndex: index, docId: "paper", fileName: "paper.pdf", pageNumber: index + 1, sectionHeading },
    pageContent,
  },
  keywordScore,
  score: 1 - index / 10,
  vectorScore,
  ...rest,
});

// A question worded differently from its evidence: no chunk reaches the 0.51
// coverage floor, and the first one stands out on the dense route.
const reworded = () => [
  chunk(0, "We evaluate on SQuAD and NewsQA.", { keywordScore: 0, vectorScore: 0.82 }),
  chunk(1, "Our encoder uses six layers.", { keywordScore: 0.33, vectorScore: 0.7 }),
  chunk(2, "Training took two days on one GPU.", { keywordScore: 0, vectorScore: 0.68 }),
];
const question = "Which corpora are used for evaluation?";

test("the dense rescue is off unless set, and a bad setting refuses instead of guessing", async () => {
  assert.deepEqual(QA_DENSE_RESCUE_MODES, ["off", "absolute", "margin"]);

  await withEnv({}, () => assert.equal(getQaDenseRescue(), null));
  await withEnv(rescue("off", 0.5), () => assert.equal(getQaDenseRescue(), null));
  await withEnv(rescue("  ", 0.5), () => assert.equal(getQaDenseRescue(), null));
  await withEnv(rescue(" MARGIN ", 0.05), () =>
    assert.deepEqual(getQaDenseRescue(), { floor: 0, mode: "margin", threshold: 0.05 })
  );
  await withEnv(rescue("absolute", 0.8, 0.3), () =>
    assert.deepEqual(getQaDenseRescue(), { floor: 0.3, mode: "absolute", threshold: 0.8 })
  );

  for (const [values, message] of [
    [rescue("dense", 0.5), /RAG_QA_DENSE_RESCUE must be one of off, absolute, margin/],
    [rescue("absolute"), /RAG_QA_DENSE_RESCUE_THRESHOLD must be set/],
    [rescue("absolute", 0), /RAG_QA_DENSE_RESCUE_THRESHOLD must be a number above 0 up to 1/],
    [rescue("absolute", 1.5), /RAG_QA_DENSE_RESCUE_THRESHOLD must be a number/],
    [rescue("margin", "abc"), /RAG_QA_DENSE_RESCUE_THRESHOLD must be a number/],
    [rescue("margin", 0.05, -0.1), /RAG_QA_DENSE_RESCUE_FLOOR must be a number from 0 up to 1/],
  ]) {
    await withEnv(values, () => assert.throws(() => getQaDenseRescue(), message));
  }
});

test("off, a question worded differently from its evidence is refused, and the trace keeps its shape", async () => {
  await withEnv({}, () => {
    const confidence = assessQaConfidence({ queryText: question, results: reworded() });

    assert.equal(confidence.confident, false);
    assert.equal("denseRescueResultCount" in confidence, false);
  });
});

test("absolute mode admits a chunk whose cosine reaches the threshold, above the coverage floor it is given", async () => {
  await withEnv(rescue("absolute", 0.8), () => {
    const confidence = assessQaConfidence({ queryText: question, results: reworded() });

    assert.equal(confidence.confident, true);
    assert.deepEqual(
      confidence.usableResults.map((result) => result.document.metadata.chunkIndex),
      [0]
    );
    assert.equal(confidence.denseRescueResultCount, 1);
    assert.equal(confidence.partialCoverageResultCount, 1);
  });

  await withEnv(rescue("absolute", 0.83), () =>
    assert.equal(assessQaConfidence({ queryText: question, results: reworded() }).confident, false)
  );

  // The best chunk shares no query term, so a floor of 0.3 keeps it out.
  await withEnv(rescue("absolute", 0.8, 0.3), () => {
    const confidence = assessQaConfidence({ queryText: question, results: reworded() });

    assert.equal(confidence.confident, false);
    assert.equal(confidence.denseRescueResultCount, 0);
  });
});

test("margin mode measures a chunk against the mean of the question's dense candidates", async () => {
  // Mean cosine (0.82 + 0.7 + 0.68) / 3 = 0.7333; the first chunk is 0.0867 above it.
  await withEnv(rescue("margin", 0.08), () => {
    const confidence = assessQaConfidence({ queryText: question, results: reworded() });

    assert.equal(confidence.confident, true);
    assert.equal(confidence.denseRescueResultCount, 1);
  });
  await withEnv(rescue("margin", 0.09), () =>
    assert.equal(assessQaConfidence({ queryText: question, results: reworded() }).confident, false)
  );

  // With one dense candidate nothing can stand out from the rest.
  await withEnv(rescue("margin", 0.01), () =>
    assert.equal(assessQaConfidence({ queryText: question, results: [reworded()[0]] }).confident, false)
  );

  // Candidates the dense route did not return (no cosine) are not in the mean.
  await withEnv(rescue("margin", 0.08), () => {
    const results = [...reworded(), chunk(3, "Appendix tables.", { keywordScore: 0, vectorScore: 0 })];

    assert.equal(assessQaConfidence({ queryText: question, results }).confident, true);
  });
});

test("a rescued chunk still may not swap a query word for a rival, nor leave out an anchor", async () => {
  // The adjacent-policy case the 0.51 floor exists for: "parental leave"
  // asked, "annual leave" found, however similar the two read.
  const leave = [
    chunk(0, "Annual leave policy: employees receive 10 paid annual leave days each year.", {
      keywordScore: 0.5,
      sectionHeading: "Annual Leave",
      vectorScore: 0.95,
    }),
    // Below the thresholds used here: whether an unrelated policy reads close
    // enough to be rescued is the threshold's business, measured on QASPER;
    // this case is about the veto.
    chunk(1, "Remote work policy: employees may work remotely 2 days per week.", {
      keywordScore: 0.33,
      sectionHeading: "Remote Work",
      vectorScore: 0.3,
    }),
  ];

  await withEnv(rescue("absolute", 0.5), () =>
    assert.equal(assessQaConfidence({ queryText: "What is the parental leave policy?", results: leave }).confident, false)
  );
  await withEnv(rescue("margin", 0.05), () =>
    assert.equal(assessQaConfidence({ queryText: "What is the parental leave policy?", results: leave }).confident, false)
  );

  // A quoted phrase must appear in what the gate admits.
  const anchored = 'What does the "ZX-12" clause require?';
  const results = [
    chunk(0, "The vendor clause requires thirty days of notice.", { keywordScore: 0.25, vectorScore: 0.9 }),
    chunk(1, "Fees are invoiced monthly.", { keywordScore: 0, vectorScore: 0.6 }),
  ];

  await withEnv(rescue("absolute", 0.8), () => {
    const confidence = assessQaConfidence({ queryText: anchored, results });

    assert.equal(confidence.confident, false);
    assert.ok(confidence.missingAnchorGroups.length > 0);
  });
});

test("the rescue leaves multi-part questions and the reranker gate alone", async () => {
  await withEnv(rescue("absolute", 0.8), () => {
    const multiPart = assessQaConfidence({ evidenceRequirementCount: 2, queryText: question, results: reworded() });

    assert.equal(multiPart.confident, false);
    assert.equal(multiPart.denseRescueResultCount, 0);

    // Every candidate scored by a cross-encoder: the reranker's probability
    // decides, as before, and the rescue is not consulted.
    const reranked = reworded().map((result, index) => ({ ...result, crossEncoderScore: index === 0 ? 4 : -4 }));
    const rerankGate = assessQaConfidence({ queryText: question, results: reranked });

    assert.equal(rerankGate.gate, "rerank");
    assert.equal("denseRescueResultCount" in rerankGate, false);
  });
});

test("a bad rescue setting fails the gate, not only the getter", async () => {
  await withEnv(rescue("absolute"), () =>
    assert.throws(
      () => assessQaConfidence({ queryText: question, results: reworded() }),
      /RAG_QA_DENSE_RESCUE_THRESHOLD must be set/
    )
  );
});

test("reports record the rescue only when it is on, so default reports compare equal with older ones", async () => {
  const off = await withEnv({}, () => describeRetrievalConfig());

  assert.equal("qaDenseRescue" in off, false);
  assert.equal("qaDenseRescueThreshold" in off, false);

  const on = await withEnv(rescue("margin", 0.05, 0.3), () => describeRetrievalConfig());

  assert.equal(on.qaDenseRescue, "margin");
  assert.equal(on.qaDenseRescueThreshold, 0.05);
  assert.equal(on.qaDenseRescueFloor, 0.3);

  const { qaDenseRescue: _mode, qaDenseRescueFloor: _floor, qaDenseRescueThreshold: _threshold, ...rest } = on;
  const git = { changedPaths: 0, dirty: false, sha: "abc" };

  assert.deepEqual(describeRunConfigDifferences({ git, retrieval: off }, { git, retrieval: rest }), []);
  assert.deepEqual(
    describeRunConfigDifferences({ git, retrieval: on }, { git, retrieval: off }).map((difference) => difference.field),
    ["retrieval.qaDenseRescue", "retrieval.qaDenseRescueThreshold", "retrieval.qaDenseRescueFloor"]
  );
});
