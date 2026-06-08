import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_FEEDBACK_DIRECTORY = path.join(__dirname, "data", "feedback");
const DEFAULT_FEEDBACK_FILE = "feedback.jsonl";
const ALLOWED_FEEDBACK_TYPES = new Set([
  "helpful",
  "citation_error",
  "incomplete",
  "hallucination",
]);

let feedbackDirectory =
  process.env.FEEDBACK_DIRECTORY?.trim() || DEFAULT_FEEDBACK_DIRECTORY;

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

const getFeedbackPath = () => path.join(feedbackDirectory, DEFAULT_FEEDBACK_FILE);

const hasScopedAccess = (accessScope = {}) =>
  Boolean(normalizeString(accessScope.userId) || normalizeString(accessScope.workspaceId));

const recordMatchesAccessScope = (record = {}, accessScope = {}) => {
  if (!hasScopedAccess(accessScope)) {
    return true;
  }

  const userId = normalizeString(record.userId);
  const workspaceId = normalizeString(record.workspaceId);
  const scopedUserId = normalizeString(accessScope.userId);
  const scopedWorkspaceId = normalizeString(accessScope.workspaceId);

  return (
    userId &&
    workspaceId &&
    userId === scopedUserId &&
    workspaceId === scopedWorkspaceId
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
    skills,
    runs,
    budget: sanitizeBudgetSnapshot(observability.budget),
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

  return {
    feedbackId: randomUUID(),
    createdAt: new Date().toISOString(),
    userId: normalizeString(accessScope.userId) || normalizeString(payload.userId),
    workspaceId:
      normalizeString(accessScope.workspaceId) || normalizeString(payload.workspaceId),
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
      answer.agentObservability ?? payload.agentObservability,
      {
        feedbackType,
      }
    ),
    citations: citations.map(sanitizeCitation).slice(0, 12),
  };
};

export const recordFeedback = async (feedback) => {
  await mkdir(feedbackDirectory, { recursive: true });
  await appendFile(getFeedbackPath(), `${JSON.stringify(feedback)}\n`, "utf8");

  return feedback;
};

export const listFeedback = async ({ accessScope = {}, limit = 25 } = {}) => {
  let content = "";

  try {
    content = await readFile(getFeedbackPath(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 25));

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
    .filter(Boolean)
    .filter((record) => recordMatchesAccessScope(record, accessScope))
    .sort((left, right) =>
      String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""))
    )
    .slice(0, safeLimit);
};
