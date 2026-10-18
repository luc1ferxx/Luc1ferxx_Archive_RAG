import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFeedbackPostgresTable, getFeedbackStoreConfigStatus } from "./rag/config.js";
import {
  createPostgresFeedbackStore,
  FEEDBACK_LIST_DEFAULT_LIMIT,
  normalizeFeedbackListLimit,
  resolveFeedbackReadScope,
} from "./rag/postgres-feedback-store.js";
import { runAsDatabaseSystem } from "./rag/postgres-tenant.js";
import { summarizeTenantRecords, tenantSelectorMatches } from "./rag/tenant-records.js";
import { resolveDataDirectory } from "./runtime-paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_FEEDBACK_DIRECTORY = path.join(__dirname, "data", "feedback");
const DEFAULT_FEEDBACK_FILE = "feedback.jsonl";
export const FEEDBACK_TYPES = Object.freeze([
  "helpful",
  "citation_error",
  "incomplete",
  "hallucination",
]);
const ALLOWED_FEEDBACK_TYPES = new Set(FEEDBACK_TYPES);

let feedbackDirectory = resolveDataDirectory({
  explicitPath: process.env.FEEDBACK_DIRECTORY,
  derivedPath: DEFAULT_FEEDBACK_DIRECTORY,
  fallbackSegments: ["feedback"],
  sourceDirectory: __dirname,
});

const normalizeString = (value) => String(value ?? "").trim();

const isPlainObject = (value) => value && typeof value === "object" && !Array.isArray(value);

const sanitizeNumber = (value, fallbackValue = 0) => {
  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? Number(parsedValue) : fallbackValue;
};

const normalizeDocIds = (docIds) => {
  if (Array.isArray(docIds)) {
    return [...new Set(docIds.map((docId) => normalizeString(docId)).filter(Boolean))];
  }

  if (typeof docIds === "string") {
    return [
      ...new Set(
        docIds
          .split(",")
          .map((docId) => normalizeString(docId))
          .filter(Boolean)
      ),
    ];
  }

  return [];
};

const createFeedbackError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

/** The JSONL file the file store writes: FEEDBACK_DIRECTORY/feedback.jsonl. */
export const getFeedbackFilePath = () => path.join(feedbackDirectory, DEFAULT_FEEDBACK_FILE);

// resolveFeedbackReadScope (rag/postgres-feedback-store.js) is the one
// decision for both stores: the exact (user, workspace) pair for a tenant,
// everything for a scope naming neither (the single-tenant setup; requireApiAuth
// refuses every other such scope). Before, a scope naming only a user (or only
// a workspace) saw none of its own records.
export const recordMatchesAccessScope = (record = {}, accessScope = {}) => {
  const scope = resolveFeedbackReadScope(accessScope);

  if (scope.mode !== "tenant") {
    return true;
  }

  return (
    normalizeString(record.userId) === scope.userId &&
    normalizeString(record.workspaceId) === scope.workspaceId
  );
};

const sanitizeCitation = (citation = {}) => ({
  docId: normalizeString(citation.docId),
  fileName: normalizeString(citation.fileName),
  pageNumber: Number.isFinite(Number(citation.pageNumber))
    ? Number(citation.pageNumber)
    : null,
  chunkIndex: Number.isFinite(Number(citation.chunkIndex))
    ? Number(citation.chunkIndex)
    : null,
  excerpt: normalizeString(citation.excerpt).slice(0, 500),
});

const sanitizeSkill = (skill = {}) => ({
  skillId: normalizeString(skill.skillId ?? skill.id),
  skillVersion: normalizeString(skill.skillVersion ?? skill.version),
  label: normalizeString(skill.label),
  status: normalizeString(skill.status),
});

const sanitizeBudgetSnapshot = (budget = {}) => ({
  limits: isPlainObject(budget.limits) ? budget.limits : {},
  used: isPlainObject(budget.used) ? budget.used : {},
  traceTruncated: Boolean(budget.traceTruncated),
});

const sanitizeBudgetEvent = (budget = {}) => ({
  ok: Boolean(budget.ok),
  key: normalizeString(budget.key),
  label: normalizeString(budget.label),
  limit: Number.isFinite(Number(budget.limit)) ? Number(budget.limit) : null,
  used: Number.isFinite(Number(budget.used)) ? Number(budget.used) : null,
  remaining: Number.isFinite(Number(budget.remaining))
    ? Number(budget.remaining)
    : null,
  reason: normalizeString(budget.reason).slice(0, 500),
});

const sanitizeBudgetDelta = (budgetDelta = {}) =>
  isPlainObject(budgetDelta)
    ? Object.fromEntries(
        Object.entries(budgetDelta)
          .map(([key, value]) => [normalizeString(key), sanitizeNumber(value)])
          .filter(([key, value]) => key && value !== 0)
          .slice(0, 12)
      )
    : {};

const sanitizeObservabilitySkill = (skill = {}) => ({
  skillId: normalizeString(skill.skillId ?? skill.id),
  skillVersion: normalizeString(skill.skillVersion ?? skill.version),
  label: normalizeString(skill.label),
  budgetKey: normalizeString(skill.budgetKey),
  selected: Boolean(skill.selected),
  status: normalizeString(skill.status),
  attempts: sanitizeNumber(skill.attempts),
  skippedCount: sanitizeNumber(skill.skippedCount),
  retryCount: sanitizeNumber(skill.retryCount),
  totalDurationMs: sanitizeNumber(skill.totalDurationMs),
  citationCount: sanitizeNumber(skill.citationCount),
  lastCitationCount: sanitizeNumber(skill.lastCitationCount),
  abstained: Boolean(skill.abstained),
  errorCount: sanitizeNumber(skill.errorCount),
  errors: Array.isArray(skill.errors)
    ? skill.errors.map(normalizeString).filter(Boolean).slice(0, 5)
    : [],
  budgetUsed: Number.isFinite(Number(skill.budgetUsed))
    ? Number(skill.budgetUsed)
    : null,
  budgetLimit: Number.isFinite(Number(skill.budgetLimit))
    ? Number(skill.budgetLimit)
    : null,
  budgetRemaining: Number.isFinite(Number(skill.budgetRemaining))
    ? Number(skill.budgetRemaining)
    : null,
  budgetDelta: sanitizeBudgetDelta(skill.budgetDelta),
});

const sanitizeObservabilityRun = (run = {}) => ({
  skillId: normalizeString(run.skillId),
  skillVersion: normalizeString(run.skillVersion),
  label: normalizeString(run.label),
  phase: normalizeString(run.phase),
  status: normalizeString(run.status),
  durationMs: sanitizeNumber(run.durationMs),
  citationCount: sanitizeNumber(run.citationCount),
  abstained: Boolean(run.abstained),
  error: normalizeString(run.error).slice(0, 500),
  budget: isPlainObject(run.budget) ? sanitizeBudgetEvent(run.budget) : null,
  budgetDelta: sanitizeBudgetDelta(run.budgetDelta),
});

const sanitizeWorkingMemoryQuery = (query = {}) => ({
  skillId: normalizeString(query.skillId),
  skillVersion: normalizeString(query.skillVersion),
  phase: normalizeString(query.phase),
  queryId: normalizeString(query.queryId),
  label: normalizeString(query.label).slice(0, 200),
  query: normalizeString(query.query).slice(0, 1000),
  primary: Boolean(query.primary),
});

const sanitizeWorkingMemoryClaim = (claim = {}) => ({
  skillId: normalizeString(claim.skillId),
  skillVersion: normalizeString(claim.skillVersion),
  phase: normalizeString(claim.phase),
  text: normalizeString(claim.text).slice(0, 1000),
  tokenOverlap: Number.isFinite(Number(claim.tokenOverlap))
    ? Number(claim.tokenOverlap)
    : null,
  anchors: Array.isArray(claim.anchors)
    ? claim.anchors.map(normalizeString).filter(Boolean).slice(0, 12)
    : [],
  missingAnchors: Array.isArray(claim.missingAnchors)
    ? claim.missingAnchors.map(normalizeString).filter(Boolean).slice(0, 12)
    : [],
});

const sanitizeWorkingMemoryGap = (gap = {}) => ({
  skillId: normalizeString(gap.skillId),
  skillVersion: normalizeString(gap.skillVersion),
  phase: normalizeString(gap.phase),
  resolvedPhase: normalizeString(gap.resolvedPhase),
  type: normalizeString(gap.type),
  severity: normalizeString(gap.severity),
  message: normalizeString(gap.message).slice(0, 1000),
  claim: normalizeString(gap.claim).slice(0, 1000),
  missingAnchors: Array.isArray(gap.missingAnchors)
    ? gap.missingAnchors.map(normalizeString).filter(Boolean).slice(0, 12)
    : [],
});

const sanitizeWorkingMemory = (workingMemory = {}) => {
  if (!isPlainObject(workingMemory)) {
    return null;
  }

  return {
    version: normalizeString(workingMemory.version),
    goal: normalizeString(workingMemory.goal).slice(0, 1000),
    docIds: normalizeDocIds(workingMemory.docIds).slice(0, 50),
    checkedQueries: Array.isArray(workingMemory.checkedQueries)
      ? workingMemory.checkedQueries
          .map(sanitizeWorkingMemoryQuery)
          .filter((query) => query.query)
          .slice(0, 20)
      : [],
    supportedClaims: Array.isArray(workingMemory.supportedClaims)
      ? workingMemory.supportedClaims
          .map(sanitizeWorkingMemoryClaim)
          .filter((claim) => claim.text)
          .slice(0, 20)
      : [],
    unsupportedClaims: Array.isArray(workingMemory.unsupportedClaims)
      ? workingMemory.unsupportedClaims
          .map(sanitizeWorkingMemoryClaim)
          .filter((claim) => claim.text)
          .slice(0, 20)
      : [],
    unresolvedGaps: Array.isArray(workingMemory.unresolvedGaps)
      ? workingMemory.unresolvedGaps
          .map(sanitizeWorkingMemoryGap)
          .filter((gap) => gap.type || gap.message || gap.claim)
          .slice(0, 20)
      : [],
    resolvedGaps: Array.isArray(workingMemory.resolvedGaps)
      ? workingMemory.resolvedGaps
          .map(sanitizeWorkingMemoryGap)
          .filter((gap) => gap.type || gap.message || gap.claim)
          .slice(0, 20)
      : [],
  };
};

const sanitizeAgentObservability = (observability = {}, { feedbackType } = {}) => {
  if (!isPlainObject(observability)) {
    return null;
  }

  const skills = Array.isArray(observability.skills)
    ? observability.skills
        .map(sanitizeObservabilitySkill)
        .filter((skill) => skill.skillId)
        .slice(0, 20)
    : [];
  const runs = Array.isArray(observability.runs)
    ? observability.runs
        .map(sanitizeObservabilityRun)
        .filter((run) => run.skillId)
        .slice(0, 40)
    : [];

  if (skills.length === 0 && runs.length === 0) {
    return null;
  }

  return {
    feedbackType: normalizeString(feedbackType),
    agentMode: normalizeString(observability.agentMode),
    planMode: normalizeString(observability.planMode),
    selectedSkills: Array.isArray(observability.selectedSkills)
      ? observability.selectedSkills
          .map(sanitizeSkill)
          .filter((skill) => skill.skillId)
          .slice(0, 20)
      : [],
    skillChain: Array.isArray(observability.skillChain)
      ? observability.skillChain
          .map(sanitizeSkill)
          .filter((skill) => skill.skillId)
          .slice(0, 10)
      : [],
    skills,
    runs,
    budget: sanitizeBudgetSnapshot(observability.budget),
    workingMemory: sanitizeWorkingMemory(observability.workingMemory),
  };
};

const sanitizeClaimSupport = (claimSupport = {}) => ({
  checked: Boolean(claimSupport.checked),
  supportedClaimCount: Number.isFinite(Number(claimSupport.supportedClaimCount))
    ? Number(claimSupport.supportedClaimCount)
    : 0,
  unsupportedClaimCount: Number.isFinite(Number(claimSupport.unsupportedClaimCount))
    ? Number(claimSupport.unsupportedClaimCount)
    : 0,
  claims: Array.isArray(claimSupport.claims)
    ? claimSupport.claims.slice(0, 12).map((claim) => ({
        text: normalizeString(claim.text).slice(0, 500),
        supported: Boolean(claim.supported),
        tokenOverlap: Number.isFinite(claim.tokenOverlap)
          ? claim.tokenOverlap
          : null,
        anchors: Array.isArray(claim.anchors)
          ? claim.anchors.map(normalizeString).filter(Boolean).slice(0, 12)
          : [],
        missingAnchors: Array.isArray(claim.missingAnchors)
          ? claim.missingAnchors.map(normalizeString).filter(Boolean).slice(0, 12)
          : [],
      }))
    : [],
});

const extractClaimChecks = (answer = {}) =>
  Array.isArray(answer.agentTrace)
    ? answer.agentTrace
        .filter((step) => step?.type === "self_check" && step.detail?.claimSupport)
        .map((step) => sanitizeClaimSupport(step.detail.claimSupport))
        .slice(0, 4)
    : [];

const getAnswerText = (payload = {}) => {
  if (typeof payload.answerText === "string") {
    return payload.answerText.trim();
  }

  const answer = payload.answer && typeof payload.answer === "object"
    ? payload.answer
    : {};

  return normalizeString(
    answer.agentAnswer ?? answer.ragAnswer ?? answer.mcpAnswer ?? ""
  );
};

export const configureFeedbackDirectory = (nextDirectory) => {
  feedbackDirectory = path.resolve(nextDirectory);
};

export const buildFeedbackRecord = ({ payload = {}, accessScope = {} }) => {
  const feedbackType = normalizeString(payload.feedbackType);

  if (!ALLOWED_FEEDBACK_TYPES.has(feedbackType)) {
    throw createFeedbackError(
      "feedbackType must be one of: helpful, citation_error, incomplete, hallucination."
    );
  }

  const question = normalizeString(payload.question);

  if (!question) {
    throw createFeedbackError("question is required.");
  }

  const answerText = getAnswerText(payload);

  if (!answerText) {
    throw createFeedbackError("answer text is required.");
  }

  const answer = payload.answer && typeof payload.answer === "object"
    ? payload.answer
    : {};
  const citations = Array.isArray(payload.citations)
    ? payload.citations
    : Array.isArray(answer.ragSources)
      ? answer.ragSources
      : [];
  const skills = Array.isArray(payload.skills)
    ? payload.skills
    : Array.isArray(answer.agentSkills)
      ? answer.agentSkills
      : [];

  const rawAgentObservability =
    answer.agentObservability ?? payload.agentObservability;
  const rawWorkingMemory =
    answer.agentWorkingMemory ?? payload.agentWorkingMemory;
  const agentObservability =
    isPlainObject(rawAgentObservability) &&
    rawWorkingMemory &&
    !rawAgentObservability.workingMemory
      ? {
          ...rawAgentObservability,
          workingMemory: rawWorkingMemory,
        }
      : rawAgentObservability;

  // Whose record this is comes from the access scope alone (the route
  // resolves the user through resolveScopedUserId), never from the payload: a
  // payload userId or workspaceId used to fill in whatever the scope left
  // empty, so a record could be filed under a tenant the caller is not.
  return {
    feedbackId: randomUUID(),
    createdAt: new Date().toISOString(),
    userId: normalizeString(accessScope?.userId),
    workspaceId: normalizeString(accessScope?.workspaceId),
    sessionId: normalizeString(payload.sessionId),
    turnIndex: Number.isInteger(Number(payload.turnIndex))
      ? Number(payload.turnIndex)
      : null,
    question,
    docIds: normalizeDocIds(payload.docIds),
    feedbackType,
    note: normalizeString(payload.note).slice(0, 1000),
    answerText: answerText.slice(0, 8000),
    agentMode: normalizeString(answer.agentMode ?? payload.agentMode),
    skills: skills
      .map(sanitizeSkill)
      .filter((skill) => skill.skillId)
      .slice(0, 20),
    claimChecks: extractClaimChecks(answer),
    agentObservability: sanitizeAgentObservability(
      agentObservability,
      {
        feedbackType,
      }
    ),
    citations: citations.map(sanitizeCitation).slice(0, 12),
  };
};

const readFeedbackFile = async (filePath) => {
  let content = "";

  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

// Appends and the redaction rewrite of one file run one at a time in this
// process (the file store serves a single-process profile), so a rewrite never
// drops a record appended while it ran.
const feedbackFileLocks = new Map();

const withFeedbackFileLock = (filePath, work) => {
  const previous = feedbackFileLocks.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  const settled = next.catch(() => {});

  feedbackFileLocks.set(filePath, settled);
  settled.then(() => {
    if (feedbackFileLocks.get(filePath) === settled) {
      feedbackFileLocks.delete(filePath);
    }
  });

  return next;
};

/**
 * The JSONL store: one file every tenant writes into, filtered in the
 * application only. It serves the profile without a database (standalone,
 * local development); with PostgreSQL configured the default store is the
 * table (createPostgresFeedbackStore). Without `directory` it follows
 * configureFeedbackDirectory at call time.
 */
export const createFileFeedbackStore = ({ directory } = {}) => {
  const resolveDirectory = () => (directory ? path.resolve(directory) : feedbackDirectory);
  const resolvePath = () => path.join(resolveDirectory(), DEFAULT_FEEDBACK_FILE);

  return {
    backend: "file",

    describe() {
      return { backend: "file", path: resolvePath() };
    },

    async initialize() {
      return true;
    },

    async recordFeedback(feedback) {
      await mkdir(resolveDirectory(), { recursive: true });
      await withFeedbackFileLock(resolvePath(), () =>
        appendFile(resolvePath(), `${JSON.stringify(feedback)}\n`, "utf8")
      );

      return feedback;
    },

    // The PostgreSQL store's contract (rag/postgres-feedback-store.js): the
    // citations of the scope's records that name a deleted document, written
    // back by rewriting the file (a temporary file renamed over it). Lines
    // that do not parse, and every other record, are kept byte for byte.
    async redactDocumentReferences({ accessScope = {}, needles = [], redactCitations } = {}) {
      const values = (Array.isArray(needles) ? needles : []).map(String).filter(Boolean);
      const filePath = resolvePath();

      if (values.length === 0 || typeof redactCitations !== "function") {
        return { redacted: 0 };
      }

      return withFeedbackFileLock(filePath, async () => {
        let content;

        try {
          content = await readFile(filePath, "utf8");
        } catch (error) {
          if (error.code === "ENOENT") {
            return { redacted: 0 };
          }

          throw error;
        }

        let redacted = 0;
        const lines = content.split("\n").map((line) => {
          if (!values.some((needle) => line.includes(needle))) {
            return line;
          }

          let record;

          try {
            record = JSON.parse(line);
          } catch {
            return line;
          }

          if (!isPlainObject(record) || !recordMatchesAccessScope(record, accessScope)) {
            return line;
          }

          const outcome = redactCitations(Array.isArray(record.citations) ? record.citations : []);

          if (!outcome?.changed) {
            return line;
          }

          redacted += 1;
          return JSON.stringify({ ...record, citations: outcome.value ?? [] });
        });

        if (redacted > 0) {
          const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

          await writeFile(temporaryPath, lines.join("\n"), "utf8");
          await rename(temporaryPath, filePath);
        }

        return { redacted };
      });
    },

    async listFeedback({ accessScope = {}, limit = FEEDBACK_LIST_DEFAULT_LIMIT } = {}) {
      // Newest first. Array.prototype.sort is stable, so records with the same
      // timestamp keep the order of their lines.
      return (await readFeedbackFile(resolvePath()))
        .filter((record) => recordMatchesAccessScope(record, accessScope))
        .sort((left, right) =>
          String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""))
        )
        .slice(0, normalizeFeedbackListLimit(limit));
    },

    // Every record in line order. The file has no tenants of its own, so this
    // is every tenant's.
    async listAllFeedback() {
      return readFeedbackFile(resolvePath());
    },

    // The tenant erase and export (rag/tenant-records.js).
    async countTenantRecords(selector) {
      return summarizeTenantRecords(await this.listTenantRecords(selector), ["feedback"]);
    },

    async listTenantRecords(selector) {
      return (await readFeedbackFile(resolvePath()))
        .filter((record) => tenantSelectorMatches(selector, record))
        .map((record) => ({ record, table: "feedback" }));
    },

    // Rewrites the file without the selector's records (temp file + rename,
    // so a reader sees the old or the new file); every other line is kept
    // byte for byte, unreadable ones included. The file has one writer per
    // process and no lock: a record another process appends while the file is
    // rewritten can be lost, which is acceptable only because this store
    // serves the single-process profile without a database.
    async deleteTenantRecords(selector) {
      let content = "";

      try {
        content = await readFile(resolvePath(), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") {
          return { feedback: { deleted: 0 } };
        }

        throw error;
      }

      const kept = [];
      let deleted = 0;

      for (const line of content.split("\n")) {
        if (!line.trim()) {
          continue;
        }

        let record = null;

        try {
          record = JSON.parse(line);
        } catch {
          record = null;
        }

        if (record && typeof record === "object" && tenantSelectorMatches(selector, record)) {
          deleted += 1;
        } else {
          kept.push(line);
        }
      }

      if (deleted > 0) {
        const temporaryPath = `${resolvePath()}.${randomBytes(6).toString("hex")}.tmp`;

        try {
          await writeFile(temporaryPath, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
          await rename(temporaryPath, resolvePath());
        } catch (error) {
          await rm(temporaryPath, { force: true });
          throw error;
        }
      }

      return { feedback: { deleted } };
    },
  };
};

const defaultFeedbackStores = new Map();

/**
 * PostgreSQL whenever a database is configured, the JSONL file otherwise
 * (getFeedbackStoreConfigStatus). Created on first use, so a process that
 * never touches feedback opens no connection.
 */
export const getDefaultFeedbackStore = () => {
  const { backend } = getFeedbackStoreConfigStatus();
  const key = backend === "postgres" ? `postgres:${getFeedbackPostgresTable()}` : backend;
  let store = defaultFeedbackStores.get(key);

  if (!store) {
    store = backend === "postgres" ? createPostgresFeedbackStore() : createFileFeedbackStore();
    defaultFeedbackStores.set(key, store);
  }

  return store;
};

/** The routes' feedback service (app-services.js) over one store. */
export const createFeedbackService = ({ store = getDefaultFeedbackStore() } = {}) => ({
  backend: store.backend,
  // Retention (rag/retention.js): one batch of expired records, or null when
  // the store has no retention delete (the JSONL file store has none: it is
  // never rewritten, so FEEDBACK_RETENTION_DAYS applies to PostgreSQL only).
  deleteExpiredFeedback: async (options) =>
    typeof store.deleteExpired === "function" ? store.deleteExpired(options) : null,
  listFeedback: (options) => store.listFeedback(options),
  recordFeedback: (feedback) => store.recordFeedback(feedback),
});

export const recordFeedback = async (feedback) =>
  getDefaultFeedbackStore().recordFeedback(feedback);

export const listFeedback = async (options = {}) =>
  getDefaultFeedbackStore().listFeedback(options);

/**
 * Every tenant's records, oldest first, for operator tools
 * (npm run feedback:corpus). PostgreSQL is read on the owner path: the tool
 * runs outside any request and writes a local evaluation file, as reading the
 * shared JSONL file always did.
 */
export const listAllFeedbackAcrossTenants = ({ store = getDefaultFeedbackStore() } = {}) =>
  runAsDatabaseSystem(() => store.listAllFeedback());
