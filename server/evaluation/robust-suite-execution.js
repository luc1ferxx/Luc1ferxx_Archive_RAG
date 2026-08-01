import { hashCanonicalJson } from "./eval-evidence.js";
import { robustEvalSuite } from "./eval-suite.js";

export const ROBUST_SUITE_EXECUTION_CONTRACT_VERSION = "2.0.0";

const SYNTHETIC_ENVIRONMENT_FIELDS = Object.freeze({
  chunkStrategy: "RAG_CHUNK_STRATEGY",
  chunkSize: "RAG_CHUNK_SIZE",
  chunkOverlap: "RAG_CHUNK_OVERLAP",
  retrievalTopK: "RAG_RETRIEVAL_TOP_K",
  compareTopKPerDoc: "RAG_COMPARE_TOP_K_PER_DOC",
  maxComparisonSources: "RAG_MAX_COMPARISON_SOURCES",
  minRelevanceScore: "RAG_MIN_RELEVANCE_SCORE",
  nearDuplicateGuardEnabled: "RAG_NEAR_DUPLICATE_GUARD_ENABLED",
});

const RERANK_ENVIRONMENT_FIELDS = Object.freeze({
  chunkStrategy: "RAG_CHUNK_STRATEGY",
  chunkSize: "RAG_CHUNK_SIZE",
  chunkOverlap: "RAG_CHUNK_OVERLAP",
  vectorStoreProvider: "VECTOR_STORE_PROVIDER",
  hybridEnabled: "RAG_HYBRID_ENABLED",
  retrievalScoringMode: "RAG_RETRIEVAL_SCORING_MODE",
  vectorWeight: "RAG_VECTOR_WEIGHT",
  keywordWeight: "RAG_KEYWORD_WEIGHT",
});

const requireNonEmptyString = (value, path) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }

  return value.trim();
};

const requireFiniteNumber = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }

  return value;
};

const requireBoolean = (value, path) => {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean.`);
  }

  return value;
};

const normalizeOptions = (options = {}) => {
  const syntheticProvider = requireNonEmptyString(
    options.syntheticProvider,
    "options.syntheticProvider"
  );

  if (!new Set(["deterministic", "real"]).has(syntheticProvider)) {
    throw new Error(
      "options.syntheticProvider must be either deterministic or real."
    );
  }

  return {
    syntheticProvider,
  };
};

const normalizeCorpusIntegrity = (report) => {
  if (!report.corpusIntegrity) {
    return null;
  }

  return {
    algorithm: requireNonEmptyString(
      report.corpusIntegrity.algorithm,
      `${report.id}.corpusIntegrity.algorithm`
    ),
    contentHash: requireNonEmptyString(
      report.corpusIntegrity.contentHash,
      `${report.id}.corpusIntegrity.contentHash`
    ),
    id: requireNonEmptyString(
      report.corpusIntegrity.id,
      `${report.id}.corpusIntegrity.id`
    ),
    version: requireNonEmptyString(
      report.corpusIntegrity.version,
      `${report.id}.corpusIntegrity.version`
    ),
  };
};

const normalizeSyntheticConfig = (report) => {
  const config = report.executionConfig ?? {};

  return {
    chunkStrategy: requireNonEmptyString(
      config.chunkStrategy,
      `${report.id}.executionConfig.chunkStrategy`
    ),
    chunkSize: requireFiniteNumber(
      config.chunkSize,
      `${report.id}.executionConfig.chunkSize`
    ),
    chunkOverlap: requireFiniteNumber(
      config.chunkOverlap,
      `${report.id}.executionConfig.chunkOverlap`
    ),
    retrievalTopK: requireFiniteNumber(
      config.retrievalTopK,
      `${report.id}.executionConfig.retrievalTopK`
    ),
    compareTopKPerDoc: requireFiniteNumber(
      config.compareTopKPerDoc,
      `${report.id}.executionConfig.compareTopKPerDoc`
    ),
    maxComparisonSources: requireFiniteNumber(
      config.maxComparisonSources,
      `${report.id}.executionConfig.maxComparisonSources`
    ),
    minRelevanceScore: requireFiniteNumber(
      config.minRelevanceScore,
      `${report.id}.executionConfig.minRelevanceScore`
    ),
    nearDuplicateGuardEnabled: requireBoolean(
      config.nearDuplicateGuardEnabled,
      `${report.id}.executionConfig.nearDuplicateGuardEnabled`
    ),
    uploadChunkSizeBytes: requireFiniteNumber(
      config.uploadChunkSizeBytes,
      `${report.id}.executionConfig.uploadChunkSizeBytes`
    ),
  };
};

const normalizeRerankConfig = (report) => {
  const config = report.rankingConfig ?? {};

  return {
    chunkStrategy: requireNonEmptyString(
      config.chunkStrategy,
      `${report.id}.rankingConfig.chunkStrategy`
    ),
    chunkSize: requireFiniteNumber(
      config.chunkSize,
      `${report.id}.rankingConfig.chunkSize`
    ),
    chunkOverlap: requireFiniteNumber(
      config.chunkOverlap,
      `${report.id}.rankingConfig.chunkOverlap`
    ),
    vectorStoreProvider: requireNonEmptyString(
      config.vectorStoreProvider,
      `${report.id}.rankingConfig.vectorStoreProvider`
    ),
    hybridEnabled: requireBoolean(
      config.hybridEnabled,
      `${report.id}.rankingConfig.hybridEnabled`
    ),
    retrievalScoringMode: requireNonEmptyString(
      config.retrievalScoringMode,
      `${report.id}.rankingConfig.retrievalScoringMode`
    ),
    vectorWeight: requireFiniteNumber(
      config.vectorWeight,
      `${report.id}.rankingConfig.vectorWeight`
    ),
    keywordWeight: requireFiniteNumber(
      config.keywordWeight,
      `${report.id}.rankingConfig.keywordWeight`
    ),
    topK: requireFiniteNumber(
      config.topK,
      `${report.id}.rankingConfig.topK`
    ),
    topKPerDoc: requireFiniteNumber(
      config.topKPerDoc,
      `${report.id}.rankingConfig.topKPerDoc`
    ),
    candidateMultiplier: requireFiniteNumber(
      config.candidateMultiplier,
      `${report.id}.rankingConfig.candidateMultiplier`
    ),
    embeddingProvider: requireNonEmptyString(
      config.embeddingProvider,
      `${report.id}.rankingConfig.embeddingProvider`
    ),
    rerankProvider: requireNonEmptyString(
      report.rerankProvider,
      `${report.id}.rerankProvider`
    ),
    rerankWeight: requireFiniteNumber(
      report.rerankWeight,
      `${report.id}.rerankWeight`
    ),
  };
};

const buildReportContract = ({ options, report }) => {
  const id = requireNonEmptyString(report.id, "report.id");
  const reportType = requireNonEmptyString(
    report.reportType,
    `${id}.reportType`
  );
  if (!new Set(["synthetic", "rerank"]).has(reportType)) {
    throw new Error(`Unsupported robust report type for ${id}: ${reportType}`);
  }

  return {
    id,
    reportType,
    corpusPath: requireNonEmptyString(
      report.corpusPath,
      `${id}.corpusPath`
    ),
    corpusIntegrity: normalizeCorpusIntegrity(report),
    latestName: requireNonEmptyString(
      report.latestName,
      `${id}.latestName`
    ),
    acceptance: {
      minOverallPassRate:
        report.minOverallPassRate === undefined
          ? null
          : requireFiniteNumber(
              report.minOverallPassRate,
              `${id}.minOverallPassRate`
            ),
    },
    provider:
      reportType === "synthetic"
        ? options.syntheticProvider
        : requireNonEmptyString(
            report.rerankProvider,
            `${id}.rerankProvider`
          ),
    config:
      reportType === "synthetic"
        ? normalizeSyntheticConfig(report)
        : normalizeRerankConfig(report),
  };
};

export const buildRobustSuiteExecutionContract = ({
  options,
  suite = robustEvalSuite,
} = {}) => {
  const normalizedOptions = normalizeOptions(options);
  const suiteId = requireNonEmptyString(suite.id, "suite.id");

  if (!Array.isArray(suite.reports) || suite.reports.length === 0) {
    throw new Error("suite.reports must be a non-empty array.");
  }

  return {
    schemaVersion: ROBUST_SUITE_EXECUTION_CONTRACT_VERSION,
    suiteId,
    options: normalizedOptions,
    reports: suite.reports.map((report) =>
      buildReportContract({ options: normalizedOptions, report })
    ),
  };
};

const buildEnvironment = (config, environmentFields) =>
  Object.fromEntries(
    Object.entries(environmentFields).map(
      ([field, environmentName]) => [environmentName, String(config[field])]
    )
  );

const buildReportStep = ({ contractReport, sourceReport }) => {
  if (contractReport.reportType === "synthetic") {
    return {
      args: [
        "evaluation/run-synthetic-eval.mjs",
        contractReport.corpusPath,
        "--latest-name",
        contractReport.latestName,
        "--openai-provider",
        contractReport.provider,
      ],
      environment: buildEnvironment(
        contractReport.config,
        SYNTHETIC_ENVIRONMENT_FIELDS
      ),
      kind: "report",
      label: sourceReport.label,
      reportId: contractReport.id,
    };
  }

  return {
    args: [
      "evaluation/run-rerank-eval.mjs",
      contractReport.corpusPath,
      "--latest-name",
      contractReport.latestName,
      "--rerank-provider",
      contractReport.config.rerankProvider,
      "--top-k",
      String(contractReport.config.topK),
      "--top-k-per-doc",
      String(contractReport.config.topKPerDoc),
      "--candidate-multiplier",
      String(contractReport.config.candidateMultiplier),
      "--embedding-provider",
      contractReport.config.embeddingProvider,
      "--rerank-weight",
      String(contractReport.config.rerankWeight),
    ],
    environment: buildEnvironment(
      contractReport.config,
      RERANK_ENVIRONMENT_FIELDS
    ),
    kind: "report",
    label: sourceReport.label,
    reportId: contractReport.id,
  };
};

export const buildRobustSuiteExecutionPlan = ({
  options,
  suite = robustEvalSuite,
} = {}) => {
  const contract = buildRobustSuiteExecutionContract({ options, suite });
  const sourceReportById = new Map(
    suite.reports.map((report) => [report.id, report])
  );
  const steps = [];

  for (const contractReport of contract.reports) {
    const sourceReport = sourceReportById.get(contractReport.id);

    steps.push(buildReportStep({ contractReport, sourceReport }));
  }

  return {
    configHash: hashCanonicalJson(contract),
    contract,
    steps,
  };
};

export const buildRobustSuiteChildEnvironment = ({
  baseEnvironment = {},
  evidenceEnvironment = {},
  step = {},
} = {}) => ({
  ...baseEnvironment,
  ...evidenceEnvironment,
  ...(step.environment ?? {}),
});
