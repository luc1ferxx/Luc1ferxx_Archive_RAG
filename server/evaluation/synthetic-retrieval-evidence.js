// The retrieval block of a synthetic report, derived from per-case evidence.
//
// Shared by the runner that writes reports, the fixtures that build passing
// ones for gate tests, and (through recomputation) the gates that check them.
// One implementation means a report cannot pass the gate with a block the
// runner could not have produced.

export const RETRIEVAL_ROUTE_NAMES = Object.freeze(["dense", "sparse"]);

const toCount = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export const buildRetrievalEvidence = ({
  caseResults = [],
  embeddingDimensions = null,
  retrievalArchitecture = {},
} = {}) => {
  const routes = Object.fromEntries(
    RETRIEVAL_ROUTE_NAMES.map((route) => [
      route,
      { candidateCount: 0, casesWithCandidates: 0, executedCaseCount: 0 },
    ])
  );
  const observedProviders = new Set();
  const observedFusionMethods = new Set();
  let casesWithRetrieval = 0;
  let fallbackCount = 0;

  for (const caseResult of caseResults) {
    const retrieval = caseResult?.retrieval;

    if (!retrieval || typeof retrieval !== "object") {
      continue;
    }

    casesWithRetrieval += 1;
    observedProviders.add(String(retrieval.vectorStoreProvider ?? ""));
    observedFusionMethods.add(String(retrieval.hybridFusion ?? "none"));

    if (retrieval.fallback) {
      fallbackCount += 1;
    }

    for (const route of RETRIEVAL_ROUTE_NAMES) {
      const routeSummary = retrieval.routes?.[route];

      if (!routeSummary) {
        continue;
      }

      if (routeSummary.executed === true) {
        routes[route].executedCaseCount += 1;
      }

      const candidateCount = toCount(routeSummary.candidateCount);

      routes[route].candidateCount += candidateCount;

      if (candidateCount > 0) {
        routes[route].casesWithCandidates += 1;
      }
    }
  }

  return {
    vectorStoreProvider: retrievalArchitecture.vectorStoreProvider ?? null,
    hybridEnabled: Boolean(retrievalArchitecture.hybridEnabled),
    hybridFusion: retrievalArchitecture.hybridEnabled
      ? retrievalArchitecture.hybridFusion ?? null
      : null,
    embeddingDimensions,
    caseCount: caseResults.length,
    casesWithRetrieval,
    observedProviders: [...observedProviders].sort(),
    observedFusionMethods: [...observedFusionMethods].sort(),
    fallbackCount,
    routes,
  };
};

/**
 * Throws when the evidence contradicts the architecture the runner believed
 * it was using. The runner calls this before writing anything, so a report
 * that claims pgvector + hybrid while its cases say otherwise never exists.
 */
export const assertRetrievalEvidenceConsistent = (retrieval) => {
  const problems = [];

  if (retrieval.casesWithRetrieval !== retrieval.caseCount) {
    problems.push(
      `${retrieval.caseCount - retrieval.casesWithRetrieval} case(s) produced no retrieval evidence`
    );
  }

  if (
    retrieval.observedProviders.length !== 1 ||
    retrieval.observedProviders[0] !== retrieval.vectorStoreProvider
  ) {
    problems.push(
      `cases ran on ${retrieval.observedProviders.join(", ") || "no provider"} but VECTOR_STORE_PROVIDER resolves to ${retrieval.vectorStoreProvider}`
    );
  }

  if (retrieval.fallbackCount > 0) {
    problems.push(`${retrieval.fallbackCount} case(s) reported a retrieval fallback`);
  }

  if (retrieval.hybridEnabled) {
    for (const route of RETRIEVAL_ROUTE_NAMES) {
      if (retrieval.routes[route].executedCaseCount !== retrieval.caseCount) {
        problems.push(`the ${route} route did not execute for every case`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to write a synthetic report whose retrieval evidence contradicts the configured architecture: ${problems.join(
        "; "
      )}.`
    );
  }

  return retrieval;
};

/**
 * A per-case retrieval block shaped exactly like the one the retrieval seam
 * returns, for fixtures that need a passing report without running retrieval.
 */
export const buildCaseRetrievalEvidence = ({
  denseCandidateCount = 3,
  hybridEnabled = true,
  hybridFusion = "rrf",
  sparseCandidateCount = 2,
  vectorStoreProvider = "pgvector",
} = {}) => ({
  denseBackend: vectorStoreProvider === "pgvector" ? "pgvector_cosine" : `${vectorStoreProvider}_dense`,
  fallback: null,
  hybridEnabled,
  hybridFusion: hybridEnabled ? hybridFusion : null,
  queryCount: 1,
  routes: {
    dense: { candidateCount: denseCandidateCount, executed: true, queryCount: 1 },
    sparse: hybridEnabled
      ? { candidateCount: sparseCandidateCount, executed: true, queryCount: 1 }
      : { candidateCount: 0, executed: false, queryCount: 0 },
  },
  sparseBackend: hybridEnabled
    ? vectorStoreProvider === "pgvector"
      ? "postgres_fts_ts_rank_cd"
      : `${vectorStoreProvider}_sparse`
    : null,
  vectorStoreProvider,
});
