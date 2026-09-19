import test from "node:test";
import assert from "node:assert/strict";

import {
  RETRIEVAL_ROUTE_NAMES,
  assertRetrievalEvidenceConsistent,
  buildCaseRetrievalEvidence,
  buildRetrievalEvidence,
} from "../evaluation/synthetic-retrieval-evidence.js";

// The retrieval block is what the quality gates check, so its aggregation and
// its refusal rules are pinned here independently of any runner.

const architecture = {
  hybridEnabled: true,
  hybridFusion: "rrf",
  vectorStoreProvider: "pgvector",
};

const caseWith = (overrides = {}) => ({
  id: "case",
  retrieval: buildCaseRetrievalEvidence(overrides),
});

test("route names are dense and sparse, in that order", () => {
  assert.deepEqual([...RETRIEVAL_ROUTE_NAMES], ["dense", "sparse"]);
});

test("case evidence mirrors the seam's shape for hybrid and dense-only runs", () => {
  const hybrid = buildCaseRetrievalEvidence({ denseCandidateCount: 4, sparseCandidateCount: 1 });

  assert.equal(hybrid.vectorStoreProvider, "pgvector");
  assert.equal(hybrid.denseBackend, "pgvector_cosine");
  assert.equal(hybrid.sparseBackend, "postgres_fts_ts_rank_cd");
  assert.equal(hybrid.hybridFusion, "rrf");
  assert.equal(hybrid.fallback, null);
  assert.deepEqual(hybrid.routes.dense, { candidateCount: 4, executed: true, queryCount: 1 });
  assert.deepEqual(hybrid.routes.sparse, { candidateCount: 1, executed: true, queryCount: 1 });

  const denseOnly = buildCaseRetrievalEvidence({ hybridEnabled: false, vectorStoreProvider: "local" });

  assert.equal(denseOnly.hybridFusion, null);
  assert.equal(denseOnly.sparseBackend, null);
  assert.equal(denseOnly.denseBackend, "local_dense");
  assert.deepEqual(denseOnly.routes.sparse, { candidateCount: 0, executed: false, queryCount: 0 });
});

test("the summary is a pure aggregation of the per-case evidence", () => {
  const cases = [
    caseWith({ denseCandidateCount: 3, sparseCandidateCount: 2 }),
    caseWith({ denseCandidateCount: 2, sparseCandidateCount: 0 }),
    { id: "no-evidence" },
  ];
  const summary = buildRetrievalEvidence({
    caseResults: cases,
    embeddingDimensions: 64,
    retrievalArchitecture: architecture,
  });

  assert.deepEqual(summary, {
    vectorStoreProvider: "pgvector",
    hybridEnabled: true,
    hybridFusion: "rrf",
    embeddingDimensions: 64,
    caseCount: 3,
    casesWithRetrieval: 2,
    observedProviders: ["pgvector"],
    observedFusionMethods: ["rrf"],
    fallbackCount: 0,
    routes: {
      dense: { candidateCount: 5, casesWithCandidates: 2, executedCaseCount: 2 },
      sparse: { candidateCount: 2, casesWithCandidates: 1, executedCaseCount: 2 },
    },
  });

  const denseOnlySummary = buildRetrievalEvidence({
    caseResults: [caseWith({ hybridEnabled: false })],
    retrievalArchitecture: { ...architecture, hybridEnabled: false },
  });

  assert.equal(denseOnlySummary.hybridFusion, null);
  assert.equal(denseOnlySummary.embeddingDimensions, null);
  assert.deepEqual(denseOnlySummary.observedFusionMethods, ["none"]);
});

test("a consistent hybrid summary is accepted", () => {
  const summary = buildRetrievalEvidence({
    caseResults: [caseWith(), caseWith()],
    retrievalArchitecture: architecture,
  });

  assert.equal(assertRetrievalEvidenceConsistent(summary), summary);
});

test("the runner refuses to write evidence that contradicts the configured architecture", () => {
  const missingCase = buildRetrievalEvidence({
    caseResults: [caseWith(), { id: "silent" }],
    retrievalArchitecture: architecture,
  });

  assert.throws(() => assertRetrievalEvidenceConsistent(missingCase), /1 case\(s\) produced no retrieval evidence/);

  const wrongProvider = buildRetrievalEvidence({
    caseResults: [caseWith({ vectorStoreProvider: "local" })],
    retrievalArchitecture: architecture,
  });

  assert.throws(
    () => assertRetrievalEvidenceConsistent(wrongProvider),
    /cases ran on local but VECTOR_STORE_PROVIDER resolves to pgvector/
  );

  const fallback = buildRetrievalEvidence({
    caseResults: [{ id: "f", retrieval: { ...buildCaseRetrievalEvidence(), fallback: "v1" } }],
    retrievalArchitecture: architecture,
  });

  assert.throws(() => assertRetrievalEvidenceConsistent(fallback), /1 case\(s\) reported a retrieval fallback/);

  const sparseSkipped = buildRetrievalEvidence({
    caseResults: [
      caseWith(),
      {
        id: "half",
        retrieval: {
          ...buildCaseRetrievalEvidence(),
          routes: {
            dense: { candidateCount: 1, executed: true, queryCount: 1 },
            sparse: { candidateCount: 0, executed: false, queryCount: 0 },
          },
        },
      },
    ],
    retrievalArchitecture: architecture,
  });

  assert.throws(
    () => assertRetrievalEvidenceConsistent(sparseSkipped),
    /the sparse route did not execute for every case/
  );

  // Dense-only is only a contradiction when hybrid was supposed to be on.
  const denseOnly = buildRetrievalEvidence({
    caseResults: [caseWith({ hybridEnabled: false })],
    retrievalArchitecture: { ...architecture, hybridEnabled: false },
  });

  assert.doesNotThrow(() => assertRetrievalEvidenceConsistent(denseOnly));
});
