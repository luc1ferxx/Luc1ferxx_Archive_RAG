import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const evaluationRepositoryRoot = path.resolve(__dirname, "..", "..");
export const EVAL_EVIDENCE_SCHEMA_VERSION = "1.0.0";
export const EVAL_EVIDENCE_GENERATOR_VERSION = "1.0.0";
const execFileAsync = promisify(execFile);

const canonicalizeValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalizeValue(value[key])])
    );
  }

  return value;
};

export const canonicalJson = (value) =>
  JSON.stringify(canonicalizeValue(value));

export const hashCanonicalJson = (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const toStableCorpusContent = (value, parentKey = "") => {
  if (Array.isArray(value)) {
    return value.map((item) => toStableCorpusContent(item, parentKey));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "buildReport")
        .filter(
          ([key]) =>
            parentKey !== "metadata" ||
            !["casesSource", "generatedAt"].includes(key)
        )
        .map(([key, item]) => [key, toStableCorpusContent(item, key)])
    );
  }

  return value;
};

export const hashCorpusContent = async (filePath) =>
  hashCanonicalJson(
    toStableCorpusContent(JSON.parse(await readFile(filePath, "utf8")))
  );

const normalizeRelativePath = (value) => String(value).replaceAll("\\", "/");

const SECRET_LIKE_KEY =
  /(?:api[_-]?key|auth(?:orization)?[_-]?header|cookie|credential|environment|^env$|envvars?|model|password|prompt|raw[_-]?document|document[_-]?(?:content|text)|secret|token)/i;

export const toRepoRelativePath = (
  filePath,
  { repoRoot = evaluationRepositoryRoot } = {}
) => {
  const normalizedInput = String(filePath ?? "").trim();

  if (!normalizedInput) {
    return "unknown";
  }

  const isNativeAbsolute = path.isAbsolute(normalizedInput);
  const isWindowsAbsolute = path.win32.isAbsolute(normalizedInput);

  if (isWindowsAbsolute && !isNativeAbsolute) {
    return "unknown";
  }

  if (!isNativeAbsolute && !isWindowsAbsolute) {
    const relativeInput = normalizeRelativePath(path.normalize(normalizedInput));
    return relativeInput === ".." || relativeInput.startsWith("../")
      ? "unknown"
      : relativeInput;
  }

  const relativePath = path.relative(path.resolve(repoRoot), path.resolve(normalizedInput));
  const normalizedRelativePath = normalizeRelativePath(relativePath);

  return relativePath === "" ||
    (!path.isAbsolute(relativePath) &&
      normalizedRelativePath !== ".." &&
      !normalizedRelativePath.startsWith("../"))
    ? normalizedRelativePath || "."
    : "unknown";
};

export const sanitizeEvidenceConfig = (value) => {
  if (Array.isArray(value)) {
    return value.map(sanitizeEvidenceConfig);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, item]) => !SECRET_LIKE_KEY.test(key) && item !== undefined)
        .map(([key, item]) => [key, sanitizeEvidenceConfig(item)])
    );
  }

  return value;
};

const CONTROLLED_EVALUATION_OUTPUT_PREFIXES = Object.freeze([
  "server/evaluation/generated/",
  "server/evaluation/results/",
]);

const getGitStatusPath = (line) => {
  const statusPath = String(line ?? "").slice(3).trim();
  const renamedPath = statusPath.includes(" -> ")
    ? statusPath.split(" -> ").at(-1)
    : statusPath;

  return normalizeRelativePath(renamedPath.replace(/^"|"$/g, ""));
};

const isControlledEvaluationOutput = (filePath) =>
  CONTROLLED_EVALUATION_OUTPUT_PREFIXES.some((prefix) =>
    filePath.startsWith(prefix)
  );

export const resolveEvaluationGitState = async ({
  repoRoot = evaluationRepositoryRoot,
  runGit,
  targetCommit = "",
} = {}) => {
  const executeGit =
    runGit ??
    (async (args) => {
      const { stdout } = await execFileAsync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
      });
      return stdout;
    });

  try {
    const commitSha = String(await executeGit(["rev-parse", "HEAD"])).trim();
    const normalizedTargetCommit = String(targetCommit ?? "").trim();

    if (normalizedTargetCommit && commitSha !== normalizedTargetCommit) {
      throw new Error(
        `Evaluation target commit ${normalizedTargetCommit} does not match HEAD ${commitSha}.`
      );
    }

    const status = String(
      await executeGit(["status", "--porcelain", "--untracked-files=all"])
    );
    const dirty = status
      .split(/\r?\n/)
      .filter(Boolean)
      .map(getGitStatusPath)
      .some((filePath) => !isControlledEvaluationOutput(filePath));

    return {
      commitSha: commitSha || "unknown",
      dirty,
    };
  } catch (error) {
    if (String(error?.message ?? "").startsWith("Evaluation target commit ")) {
      throw error;
    }

    return {
      commitSha: "unknown",
      dirty: "unknown",
    };
  }
};

const normalizeText = (value, fallback = "unknown") =>
  String(value ?? "").replace(/\s+/g, " ").trim() || fallback;

export const resolveEvaluationProfile = (
  fallback = "default",
  environment = process.env
) =>
  normalizeText(
    environment.EVAL_EVIDENCE_PROFILE,
    normalizeText(fallback, "default")
  );

export const getEvaluationSuiteContext = (environment = process.env) => {
  const configHash = String(
    environment.EVAL_EVIDENCE_SUITE_CONFIG_HASH ?? ""
  ).trim();
  const id = String(environment.EVAL_EVIDENCE_SUITE_ID ?? "").trim();
  const runId = String(environment.EVAL_EVIDENCE_SUITE_RUN_ID ?? "").trim();

  return configHash && id && runId
    ? {
        configHash,
        id,
        runId,
      }
    : null;
};

export const getCorpusIdentity = ({ corpus = {}, corpusPath = "" } = {}) => {
  const fileName = path.posix.basename(normalizeRelativePath(corpusPath));

  return {
    id: normalizeText(
      corpus.id ??
        corpus.metadata?.manifestName ??
        fileName.replace(/\.json$/i, "")
    ),
    version: normalizeText(
      corpus.version ?? corpus.metadata?.manifestVersion ?? "unknown"
    ),
  };
};

export const buildSourceReportReference = (report = {}) => {
  const evidence = report?.evidence ?? {};

  return {
    reportType: normalizeText(evidence.reportType),
    reportId: normalizeText(evidence.reportId),
    runId: normalizeText(evidence.runId),
    commitSha: normalizeText(evidence.git?.commitSha),
    generatedAt: normalizeText(evidence.generatedAt),
    configHash: normalizeText(evidence.configHash),
    corpusId: normalizeText(evidence.corpus?.id),
    providerMode: normalizeText(evidence.provider?.mode),
  };
};

export const buildEvaluationEvidence = async ({
  command,
  corpus = {},
  generatedAt = new Date().toISOString(),
  gitState = null,
  modelRouteId = null,
  profile = "default",
  provider = {},
  publicConfig = {},
  repoRoot = evaluationRepositoryRoot,
  reportId,
  reportType,
  runId,
  sourceReports = [],
  suite = null,
  targetCommit = process.env.EVAL_TARGET_COMMIT_SHA ?? "",
} = {}) => {
  const sanitizedConfig = sanitizeEvidenceConfig(publicConfig);
  const corpusPath = corpus.path ?? null;
  const resolvedGitState =
    gitState ??
    (await resolveEvaluationGitState({
      repoRoot,
      targetCommit,
    }));

  return {
    schemaVersion: EVAL_EVIDENCE_SCHEMA_VERSION,
    reportType: normalizeText(reportType),
    reportId: normalizeText(reportId),
    runId: normalizeText(runId),
    generatedAt: normalizeText(generatedAt),
    git: {
      commitSha: normalizeText(resolvedGitState.commitSha),
      dirty:
        typeof resolvedGitState.dirty === "boolean"
          ? resolvedGitState.dirty
          : "unknown",
    },
    command: normalizeText(command),
    profile: normalizeText(profile, "default"),
    corpus: {
      id: normalizeText(corpus.id),
      relativePath: corpusPath
        ? toRepoRelativePath(corpusPath, { repoRoot })
        : "unknown",
      contentHash: corpusPath ? await hashCorpusContent(corpusPath) : "unknown",
      version: normalizeText(corpus.version),
    },
    configHash: hashCanonicalJson(sanitizedConfig),
    provider: {
      id: normalizeText(provider.id),
      mode: normalizeText(provider.mode),
    },
    modelRouteId: modelRouteId ? normalizeText(modelRouteId) : null,
    sourceReports: Array.isArray(sourceReports) ? sourceReports : [],
    suite: suite?.id
      ? {
          configHash: normalizeText(suite.configHash),
          id: normalizeText(suite.id),
          runId: normalizeText(suite.runId),
        }
      : null,
    generatorVersion: EVAL_EVIDENCE_GENERATOR_VERSION,
  };
};

export const getPublicEvaluationConfig = ({ report = {}, reportType } = {}) => {
  const pickPublicFields = (value, fields) =>
    Object.fromEntries(
      fields
        .filter((field) => value?.[field] !== undefined)
        .map((field) => [field, value[field]])
    );

  if (reportType === "synthetic") {
    return sanitizeEvidenceConfig(
      pickPublicFields(report.summary?.config, [
        "chunkStrategy",
        "chunkSize",
        "chunkOverlap",
        "retrievalTopK",
        "compareTopKPerDoc",
        "maxComparisonSources",
        "minRelevanceScore",
        "nearDuplicateGuardEnabled",
        "uploadChunkSizeBytes",
      ])
    );
  }

  if (reportType === "rerank") {
    return sanitizeEvidenceConfig(
      pickPublicFields(report.summary?.config, [
        "topK",
        "topKPerDoc",
        "candidateMultiplier",
        "embeddingProvider",
        "rerankProvider",
        "rerankWeight",
      ])
    );
  }

  if (["planner", "trajectory", "recovery_observability"].includes(reportType)) {
    return sanitizeEvidenceConfig({
      caseIds: (report.cases ?? []).map((caseResult) => caseResult.id).filter(Boolean),
      provider: report.summary?.provider ?? undefined,
      version: report.summary?.version ?? "unknown",
    });
  }

  if (reportType === "runtime_smoke") {
    return sanitizeEvidenceConfig({
      planners: report.checks?.planners ?? {},
      version: report.version ?? "1.0.0",
    });
  }

  if (reportType === "rollout_readiness") {
    return sanitizeEvidenceConfig({
      checkIds: (report.checks ?? []).map((check) => check.id).filter(Boolean),
      requiredRuntime: report.signals?.runtime?.required ?? {},
      version: report.summary?.version ?? "unknown",
    });
  }

  return sanitizeEvidenceConfig(report.summary?.config ?? {});
};

export const attachEvaluationEvidence = async (
  report = {},
  {
    generatedAt =
      report.summary?.createdAt ?? report.completedAt ?? new Date().toISOString(),
    publicConfig,
    reportType,
    runId = report.summary?.runId ?? report.runId ?? "unknown",
    ...options
  } = {}
) => ({
  ...report,
  evidence: await buildEvaluationEvidence({
    ...options,
    generatedAt,
    publicConfig:
      publicConfig ?? getPublicEvaluationConfig({ report, reportType }),
    reportType,
    runId,
  }),
});
