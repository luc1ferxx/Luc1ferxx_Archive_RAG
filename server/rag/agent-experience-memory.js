import {
  getAgentExperienceMemoryConfigStatus,
  isAgentExperienceMemoryEnabled,
} from "./config.js";
import {
  deleteLongMemory,
  listLongMemories,
  rememberLongMemory,
} from "./long-memory.js";
import { AGENT_INTENT_IDS } from "./agent-intent-planner.js";
import { SKILL_CHAIN_MODE } from "./agent-planner.js";
import { CUSTOM_SKILL_IDS } from "./skills/registry.js";
import { extractMeaningfulTokens, normalizeWhitespace } from "./text-utils.js";

export const AGENT_EXPERIENCE_MEMORY_CATEGORY = "agent_experience";

const DEFAULT_LIST_LIMIT = 50;
const MAX_PLANNING_HINTS = 6;
const MAX_STORED_EXPERIENCE_MEMORIES_PER_SCOPE = 40;
const RETENTION_SCAN_LIMIT = 500;
const RETENTION_MAX_PASSES = 10;
const MIN_CONFIDENCE = 0.45;
const NEGATIVE_FEEDBACK_TYPES = new Set([
  "citation_error",
  "hallucination",
  "incomplete",
]);
const WRITE_STATUSES = Object.freeze({
  error: "error",
  skipped: "skipped",
  stored: "stored",
});
export const AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS = Object.freeze({
  approvalPending: "approval_pending",
  clarificationPending: "clarification_pending",
  disabled: "disabled",
  feedbackNotNegative: "feedback_not_negative",
  missingQuestion: "missing_question",
  missingUser: "missing_user",
  noEvidence: "no_evidence",
  noRecords: "no_records",
  responseError: "response_error",
  storeRejected: "store_rejected",
});

let configuredAgentExperienceMemoryStore = null;

const createExperienceMemoryContext = ({
  enabled = false,
  error = null,
  hitCount = null,
  memories = [],
  memoryApplied = false,
  plannerBlock = "",
  planningHints = [],
  reason = null,
  status = "disabled",
} = {}) => ({
  enabled,
  error,
  hitCount: Number.isFinite(Number(hitCount))
    ? Number(hitCount)
    : planningHints.length,
  memories,
  memoryApplied,
  plannerBlock,
  planningHints,
  reason,
  status,
});

export const createAgentExperienceMemoryUnavailableContext = ({
  error = null,
  reason = null,
  status = "disabled",
} = {}) => {
  const configStatus = getAgentExperienceMemoryConfigStatus();

  return createExperienceMemoryContext({
    enabled: Boolean(configStatus.enabled),
    error,
    reason: reason ?? configStatus.reason,
    status,
  });
};

const sanitizePlanningHint = (hint = {}) => ({
  confidence: hint.confidence,
  gapTypes: hint.gapTypes ?? [],
  intentId: hint.intentId ?? "",
  memoryId: hint.memoryId ?? "",
  mode: hint.mode ?? "",
  retrievalProfile: hint.retrievalProfile ?? "",
  score: hint.score,
  skillChain: hint.skillChain ?? [],
  suggestedActions: hint.suggestedActions ?? [],
  type: hint.type ?? "",
});

const sanitizeStoredRecord = (record = {}) => ({
  confidence: record.confidence,
  gapTypes: record.gapTypes ?? [],
  intentId: record.intentId ?? "",
  memoryId: record.memoryId ?? "",
  mode: record.mode ?? "",
  retrievalProfile: record.retrievalProfile ?? "",
  skillChain: record.skillChain ?? [],
  suggestedActions: record.suggestedActions ?? [],
  type: record.type ?? "",
});

const createWriteResult = ({
  enabled = false,
  error = null,
  prunedCount = 0,
  recordCount = 0,
  records = [],
  skippedReason = null,
  status = WRITE_STATUSES.skipped,
  storedCount = 0,
  storedRecords = [],
  writeAttempted = false,
} = {}) => {
  const normalizedStoredRecords = toArray(storedRecords).map(
    normalizeExperienceRecord
  );
  const normalizedRecords = toArray(records);
  const safeRecordCount = Number.isFinite(Number(recordCount))
    ? Number(recordCount)
    : normalizedRecords.length;
  const safeStoredCount = Number.isFinite(Number(storedCount))
    ? Number(storedCount)
    : normalizedStoredRecords.length;

  const result = {
    enabled: Boolean(enabled),
    error,
    prunedCount: Math.max(0, Number(prunedCount) || 0),
    recordCount: safeRecordCount,
    records: normalizedRecords,
    skippedReason,
    status,
    storedCount: safeStoredCount,
    storedRecords: normalizedStoredRecords,
    writeAttempted: Boolean(writeAttempted),
  };

  return {
    ...result,
    observability: buildAgentExperienceMemoryWriteObservability(result),
  };
};

export const buildAgentExperienceMemoryWriteObservability = (result = {}) => {
  const safeResult = result ?? {};
  const storedRecords = toArray(safeResult.storedRecords).map(sanitizeStoredRecord);
  const recordTypes = [
    ...new Set(
      [
        ...toArray(safeResult.records).map((record) => record.type),
        ...storedRecords.map((record) => record.type),
      ]
        .map(normalizeText)
        .filter(Boolean)
    ),
  ];
  const skippedReason =
    safeResult.skippedReason ??
    (safeResult.writeAttempted ? null : "not_attempted");

  return {
    enabled: Boolean(safeResult.enabled),
    error: safeResult.error ?? null,
    prunedCount: Math.max(0, Number(safeResult.prunedCount) || 0),
    recordCount: Number.isFinite(Number(safeResult.recordCount))
      ? Number(safeResult.recordCount)
      : toArray(safeResult.records).length,
    recordTypes,
    skippedReason,
    status: safeResult.status ?? WRITE_STATUSES.skipped,
    storedCount: Number.isFinite(Number(safeResult.storedCount))
      ? Number(safeResult.storedCount)
      : storedRecords.length,
    storedRecords,
    writeAttempted: Boolean(safeResult.writeAttempted),
  };
};

export const buildAgentExperienceMemoryObservability = (context = {}) => {
  const safeContext = context ?? {};
  const sanitizedHints = toArray(safeContext.planningHints).map(
    sanitizePlanningHint
  );
  const write = buildAgentExperienceMemoryWriteObservability(safeContext.write);

  return {
    applied: Boolean(safeContext.memoryApplied),
    enabled: Boolean(safeContext.enabled),
    error: safeContext.error ?? null,
    hintCount: sanitizedHints.length,
    hints: sanitizedHints,
    hitCount: Number.isFinite(Number(safeContext.hitCount))
      ? Number(safeContext.hitCount)
      : sanitizedHints.length,
    planningHints: sanitizedHints,
    reason: safeContext.reason ?? null,
    status: safeContext.status ?? (safeContext.enabled ? "ready" : "disabled"),
    storedCount: write.storedCount,
    write,
    writeAttempted: write.writeAttempted,
    writeSkippedReason: write.skippedReason,
  };
};

export const createAgentExperienceMemoryWriteErrorResult = (error) =>
  createWriteResult({
    enabled: getAgentExperienceMemoryConfigStatus().enabled,
    error: error instanceof Error ? error.message : "write_failed",
    status: WRITE_STATUSES.error,
    writeAttempted: true,
  });

const normalizeText = (value = "") =>
  normalizeWhitespace(String(value ?? "")).replace(/\s+/g, " ").trim();

const normalizeId = (value = "") => normalizeText(value).toLowerCase();

const toArray = (value) => (Array.isArray(value) ? value : []);

const parseJsonRecord = (value, fallback = {}) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);

    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
};

const getScopedUserId = ({ accessScope = {}, userId } = {}) =>
  normalizeText(userId) || normalizeText(accessScope.userId);

const getScopedWorkspaceId = ({ accessScope = {}, workspaceId } = {}) =>
  normalizeText(workspaceId) || normalizeText(accessScope.workspaceId);

const getSkillIds = (skills = []) =>
  toArray(skills)
    .map((skill) => normalizeText(skill.skillId ?? skill.id))
    .filter(Boolean);

const getAgentModeIntentId = ({ agentMode, skillChain = [] } = {}) => {
  const chainIds = getSkillIds(skillChain);

  if (
    agentMode === SKILL_CHAIN_MODE &&
    chainIds[0] === CUSTOM_SKILL_IDS.summarizeContract &&
    chainIds[1] === CUSTOM_SKILL_IDS.riskReview
  ) {
    return AGENT_INTENT_IDS.contractReviewChain;
  }

  if (
    agentMode === SKILL_CHAIN_MODE &&
    chainIds[0] === CUSTOM_SKILL_IDS.compareDocuments &&
    chainIds[1] === CUSTOM_SKILL_IDS.riskReview
  ) {
    return AGENT_INTENT_IDS.compareRiskChain;
  }

  if (
    agentMode === SKILL_CHAIN_MODE &&
    chainIds[0] === CUSTOM_SKILL_IDS.extractTimeline &&
    chainIds[1] === CUSTOM_SKILL_IDS.compareDocuments
  ) {
    return AGENT_INTENT_IDS.projectChangeChain;
  }

  if (Object.values(AGENT_INTENT_IDS).includes(agentMode)) {
    return agentMode;
  }

  return "";
};

const getQuestionSignatureTerms = (question = "") =>
  extractMeaningfulTokens(question).slice(0, 10);

const getHintKey = ({
  intentId,
  question,
  type,
  workspaceId,
} = {}) => {
  const signature = getQuestionSignatureTerms(question).slice(0, 6).join("-");

  return [
    "agent_experience",
    normalizeId(workspaceId) || "global",
    normalizeId(type),
    normalizeId(intentId) || "planning",
    signature || "general",
  ].join(":");
};

const formatSkillChain = (skillChain = []) =>
  getSkillIds(skillChain).join(" -> ");

const buildPlanningHintText = ({
  gapTypes = [],
  intentId,
  question,
  skillChain = [],
  type,
} = {}) => {
  const terms = getQuestionSignatureTerms(question).slice(0, 5).join(", ");
  const chainText = formatSkillChain(skillChain);

  if (type === "resolved_gap") {
    return [
      "For similar requests, plan focused follow-up retrieval when citation gaps appear before final synthesis.",
      gapTypes.length ? `Resolved gap types: ${gapTypes.join(", ")}.` : "",
      terms ? `Observed request terms: ${terms}.` : "",
      "Planning hint only; never treat this memory as document evidence.",
    ].filter(Boolean).join(" ");
  }

  if (type === "negative_feedback") {
    return [
      "For similar requests, tighten claim-level support checks before returning the final answer.",
      chainText ? `Prior skill path: ${chainText}.` : "",
      terms ? `Feedback request terms: ${terms}.` : "",
      "Planning hint only; never treat this memory as document evidence.",
    ].filter(Boolean).join(" ");
  }

  return [
    "For similar successful requests, consider the same whitelisted agent plan.",
    intentId ? `Suggested intent: ${intentId}.` : "",
    chainText ? `Skill path: ${chainText}.` : "",
    terms ? `Observed request terms: ${terms}.` : "",
    "Planning hint only; never treat this memory as document evidence.",
  ].filter(Boolean).join(" ");
};

const normalizeExperienceRecord = (record = {}) => {
  const value = parseJsonRecord(record.memoryValue ?? record.value);

  return {
    memoryId: normalizeText(record.memoryId ?? record.id),
    userId: normalizeText(record.userId),
    workspaceId: normalizeText(value.workspaceId ?? record.workspaceId),
    type: normalizeText(value.type ?? record.type),
    intentId: normalizeText(value.intentId ?? record.intentId),
    mode: normalizeText(value.mode ?? record.mode),
    skillChain: toArray(value.skillChain ?? record.skillChain),
    suggestedActions: toArray(value.suggestedActions ?? record.suggestedActions)
      .map(normalizeText)
      .filter(Boolean),
    retrievalProfile: normalizeText(value.retrievalProfile ?? record.retrievalProfile),
    gapTypes: toArray(value.gapTypes ?? record.gapTypes)
      .map(normalizeText)
      .filter(Boolean),
    signatureTerms: toArray(value.signatureTerms ?? record.signatureTerms)
      .map(normalizeText)
      .filter(Boolean),
    text: normalizeText(record.text ?? value.text),
    source: normalizeText(record.source ?? value.source),
    confidence: Number.isFinite(Number(record.confidence ?? value.confidence))
      ? Number(record.confidence ?? value.confidence)
      : 1,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
    lastUsedAt: record.lastUsedAt ?? null,
  };
};

const createLongMemoryBackedAgentExperienceStore = () => ({
  async list({ userId, limit = DEFAULT_LIST_LIMIT } = {}) {
    if (!isAgentExperienceMemoryEnabled() || !normalizeText(userId)) {
      return [];
    }

    return listLongMemories({
      categories: [AGENT_EXPERIENCE_MEMORY_CATEGORY],
      limit,
      userId,
    });
  },

  async remember(record = {}) {
    if (!isAgentExperienceMemoryEnabled() || !normalizeText(record.userId)) {
      return null;
    }

    const value = {
      gapTypes: record.gapTypes ?? [],
      intentId: record.intentId ?? "",
      mode: record.mode ?? "",
      retrievalProfile: record.retrievalProfile ?? "",
      signatureTerms: record.signatureTerms ?? [],
      skillChain: record.skillChain ?? [],
      suggestedActions: record.suggestedActions ?? [],
      type: record.type ?? "planning_hint",
      workspaceId: record.workspaceId ?? "",
    };

    return rememberLongMemory({
      category: AGENT_EXPERIENCE_MEMORY_CATEGORY,
      confidence: record.confidence ?? 1,
      memoryKey: record.memoryKey,
      memoryValue: JSON.stringify(value),
      source: "agent_experience",
      text: record.text,
      userId: record.userId,
    });
  },

  async delete({ memoryId, userId } = {}) {
    if (
      !isAgentExperienceMemoryEnabled() ||
      !normalizeText(userId) ||
      !normalizeText(memoryId)
    ) {
      return null;
    }

    return deleteLongMemory({
      memoryId,
      userId,
    });
  },
});

export const createInMemoryAgentExperienceStore = ({
  now = () => new Date().toISOString(),
} = {}) => {
  const records = [];

  return {
    async list({ userId, workspaceId = "", limit = DEFAULT_LIST_LIMIT } = {}) {
      const normalizedUserId = normalizeText(userId);
      const normalizedWorkspaceId = normalizeText(workspaceId);

      return records
        .filter(
          (record) =>
            record.userId === normalizedUserId &&
            (!normalizedWorkspaceId || record.workspaceId === normalizedWorkspaceId)
        )
        .sort((left, right) =>
          String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
        )
        .slice(0, Math.max(1, Math.min(DEFAULT_LIST_LIMIT, Number(limit) || DEFAULT_LIST_LIMIT)));
    },

    async remember(record = {}) {
      const normalizedUserId = normalizeText(record.userId);
      const normalizedText = normalizeText(record.text);

      if (!normalizedUserId || !normalizedText) {
        return null;
      }

      const timestamp = now();
      const normalizedRecord = normalizeExperienceRecord({
        ...record,
        confidence: record.confidence ?? 1,
        memoryId: record.memoryId ?? record.memoryKey,
        source: record.source ?? "agent_experience",
        text: normalizedText,
        updatedAt: timestamp,
      });
      const existingIndex = records.findIndex(
        (entry) =>
          entry.userId === normalizedRecord.userId &&
          entry.workspaceId === normalizedRecord.workspaceId &&
          entry.memoryId === normalizedRecord.memoryId
      );
      const storedRecord = {
        ...normalizedRecord,
        createdAt: existingIndex === -1
          ? timestamp
          : records[existingIndex].createdAt,
        updatedAt: timestamp,
      };

      if (existingIndex === -1) {
        records.push(storedRecord);
      } else {
        records[existingIndex] = storedRecord;
      }

      return storedRecord;
    },

    async delete({ memoryId, userId } = {}) {
      const normalizedUserId = normalizeText(userId);
      const normalizedMemoryId = normalizeText(memoryId);
      const index = records.findIndex(
        (record) =>
          record.userId === normalizedUserId &&
          record.memoryId === normalizedMemoryId
      );

      if (index === -1) {
        return null;
      }

      const [deleted] = records.splice(index, 1);
      return deleted;
    },

    snapshot() {
      return [...records];
    },
  };
};

const getAgentExperienceMemoryStore = () =>
  configuredAgentExperienceMemoryStore ??
  createLongMemoryBackedAgentExperienceStore();

export const configureAgentExperienceMemoryStore = (store) => {
  configuredAgentExperienceMemoryStore = store ?? null;
};

export const resetAgentExperienceMemoryStore = () => {
  configuredAgentExperienceMemoryStore = null;
};

const recordAgentExperience = async (record = {}) => {
  const store = getAgentExperienceMemoryStore();

  return store.remember ? store.remember(record) : null;
};

const hasPendingApprovalGate = (body = {}) => {
  const approvalGates = [
    ...toArray(body.approvalGates),
    ...toArray(body.clarification?.detail?.approvalGates),
  ];

  return approvalGates.some((gate) => gate?.status === "pending");
};

const getWorkingMemory = (body = {}, agentObservability = {}) =>
  body.agentWorkingMemory ?? agentObservability.workingMemory ?? {};

const hasEvidenceSupport = (body = {}, agentObservability = {}) => {
  if (
    [
      body.ragSources,
      body.citations,
      body.sources,
    ].some((sources) => toArray(sources).length > 0)
  ) {
    return true;
  }

  if (
    [...toArray(agentObservability.runs), ...toArray(agentObservability.skills)]
      .some((entry) => Number(entry?.citationCount ?? 0) > 0)
  ) {
    return true;
  }

  const workingMemory = getWorkingMemory(body, agentObservability);

  return (
    toArray(workingMemory.supportedClaims).length > 0 ||
    toArray(workingMemory.resolvedGaps).length > 0
  );
};

const buildRunWritePolicy = (input = {}) => {
  const configStatus = getAgentExperienceMemoryConfigStatus();
  const response = input.response ?? {};
  const body = response.body ?? {};
  const agentObservability = body.agentObservability ?? {};
  const effectiveUserId = getScopedUserId(input);

  if (!configStatus.enabled) {
    return {
      allowed: false,
      enabled: false,
      reason: configStatus.reason ?? AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.disabled,
      records: [],
    };
  }

  if (!effectiveUserId) {
    return {
      allowed: false,
      enabled: true,
      reason: AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.missingUser,
      records: [],
    };
  }

  if (response.status >= 400) {
    return {
      allowed: false,
      enabled: true,
      reason: AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.responseError,
      records: [],
    };
  }

  if (hasPendingApprovalGate(body)) {
    return {
      allowed: false,
      enabled: true,
      reason: AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.approvalPending,
      records: [],
    };
  }

  if (body.clarification?.needed) {
    return {
      allowed: false,
      enabled: true,
      reason: AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.clarificationPending,
      records: [],
    };
  }

  const records = buildPositiveRunRecords(input);

  if (records.length === 0) {
    return {
      allowed: false,
      enabled: true,
      reason: AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.noRecords,
      records,
    };
  }

  if (!hasEvidenceSupport(body, agentObservability)) {
    return {
      allowed: false,
      enabled: true,
      reason: AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.noEvidence,
      records,
    };
  }

  return {
    allowed: true,
    enabled: true,
    reason: null,
    records,
  };
};

const pruneExperienceMemoryScope = async ({
  userId,
  workspaceId,
  limit = MAX_STORED_EXPERIENCE_MEMORIES_PER_SCOPE,
} = {}) => {
  const store = getAgentExperienceMemoryStore();

  if (!store.list || !store.delete || !normalizeText(userId)) {
    return 0;
  }

  let prunedCount = 0;
  const normalizedLimit = Math.max(
    1,
    Number(limit) || MAX_STORED_EXPERIENCE_MEMORIES_PER_SCOPE
  );
  const scanLimit = Math.max(normalizedLimit + 1, RETENTION_SCAN_LIMIT);

  for (let pass = 0; pass < RETENTION_MAX_PASSES; pass += 1) {
    const records = (await store.list({
      limit: scanLimit,
      userId,
      workspaceId,
    }))
      .map(normalizeExperienceRecord)
      .filter(
        (record) =>
          !normalizeText(workspaceId) ||
          !record.workspaceId ||
          record.workspaceId === normalizeText(workspaceId)
      )
      .sort((left, right) =>
        String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
      );
    const extras = records.slice(normalizedLimit);

    if (extras.length === 0) {
      break;
    }

    for (const record of extras) {
      if (!record.memoryId) {
        continue;
      }

      const deleted = await store.delete({
        memoryId: record.memoryId,
        userId,
      });

      if (deleted) {
        prunedCount += 1;
      }
    }
  }

  return prunedCount;
};

const buildPositiveRunRecords = ({
  accessScope = {},
  question,
  response = {},
  userId,
} = {}) => {
  const body = response.body ?? {};
  const agentObservability = body.agentObservability ?? {};
  const effectiveUserId = getScopedUserId({
    accessScope,
    userId,
  });
  const workspaceId = getScopedWorkspaceId({
    accessScope,
  });
  const agentMode = normalizeText(body.agentMode);
  const skillChain = toArray(agentObservability.skillChain);
  const intentId = getAgentModeIntentId({
    agentMode,
    skillChain,
  });
  const records = [];

  if (!effectiveUserId || response.status >= 400 || body.clarification?.needed) {
    return [];
  }

  if (agentMode === SKILL_CHAIN_MODE && intentId) {
    const type = "successful_plan";
    const text = buildPlanningHintText({
      intentId,
      question,
      skillChain,
      type,
    });

    records.push({
      confidence: 0.78,
      intentId,
      memoryKey: getHintKey({
        intentId,
        question,
        type,
        workspaceId,
      }),
      mode: agentMode,
      question,
      signatureTerms: getQuestionSignatureTerms(question),
      skillChain,
      text,
      type,
      userId: effectiveUserId,
      workspaceId,
    });
  }

  const resolvedGaps = toArray(
    body.agentWorkingMemory?.resolvedGaps ??
      agentObservability.workingMemory?.resolvedGaps
  );

  if (resolvedGaps.length > 0) {
    const gapTypes = [
      ...new Set(resolvedGaps.map((gap) => normalizeText(gap.type)).filter(Boolean)),
    ];
    const type = "resolved_gap";
    const text = buildPlanningHintText({
      gapTypes,
      intentId,
      question,
      skillChain,
      type,
    });

    records.push({
      confidence: 0.68,
      gapTypes,
      intentId,
      memoryKey: getHintKey({
        intentId: intentId || "resolved_gap",
        question,
        type,
        workspaceId,
      }),
      mode: agentMode,
      question,
      retrievalProfile: "focused_follow_up",
      signatureTerms: getQuestionSignatureTerms(question),
      skillChain,
      suggestedActions: ["follow_up_retrieval", "claim_support_check"],
      text,
      type,
      userId: effectiveUserId,
      workspaceId,
    });
  }

  return records;
};

export const recordAgentExperienceFromRun = async (input = {}) => {
  const policy = buildRunWritePolicy(input);

  if (!policy.allowed) {
    return createWriteResult({
      enabled: policy.enabled,
      recordCount: policy.records.length,
      records: policy.records,
      skippedReason: policy.reason,
      status: WRITE_STATUSES.skipped,
      writeAttempted: false,
    });
  }

  const records = policy.records;
  const storedRecords = [];

  for (const record of records) {
    const storedRecord = await recordAgentExperience(record);

    if (storedRecord) {
      storedRecords.push(normalizeExperienceRecord(storedRecord));
    }
  }

  const workspaceId = getScopedWorkspaceId(input);
  const userId = getScopedUserId(input);
  const prunedCount =
    storedRecords.length > 0
      ? await pruneExperienceMemoryScope({
          userId,
          workspaceId,
        })
      : 0;

  return createWriteResult({
    enabled: true,
    prunedCount,
    recordCount: records.length,
    records,
    skippedReason:
      storedRecords.length > 0
        ? null
        : AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.storeRejected,
    status:
      storedRecords.length > 0
        ? WRITE_STATUSES.stored
        : WRITE_STATUSES.skipped,
    storedCount: storedRecords.length,
    storedRecords,
    writeAttempted: true,
  });
};

const buildNegativeFeedbackRecord = ({ feedback } = {}) => {
  const feedbackType = normalizeText(feedback?.feedbackType);

  if (!NEGATIVE_FEEDBACK_TYPES.has(feedbackType)) {
    return null;
  }

  const userId = normalizeText(feedback.userId);
  const workspaceId = normalizeText(feedback.workspaceId);

  if (!userId) {
    return null;
  }

  const agentObservability = feedback.agentObservability ?? {};
  const skillChain = toArray(agentObservability.skillChain);
  const agentMode = normalizeText(feedback.agentMode || agentObservability.agentMode);
  const intentId = getAgentModeIntentId({
    agentMode,
    skillChain,
  });
  const claimChecks = toArray(feedback.claimChecks);
  const gapTypes = [
    ...new Set(
      claimChecks
        .flatMap((check) => toArray(check.claims))
        .filter((claim) => claim && claim.supported === false)
        .map(() => "unsupported_claim")
    ),
  ];
  const type = "negative_feedback";
  const text = buildPlanningHintText({
    gapTypes,
    intentId,
    question: feedback.question,
    skillChain,
    type,
  });
  return {
    confidence: 0.6,
    gapTypes,
    intentId,
    memoryKey: getHintKey({
      intentId: intentId || "negative_feedback",
      question: feedback.question,
      type,
      workspaceId,
    }),
    mode: agentMode,
    question: feedback.question,
    retrievalProfile: "strict_claim_support",
    signatureTerms: getQuestionSignatureTerms(feedback.question),
    skillChain,
    suggestedActions: ["claim_support_check", "gap_analysis"],
    text,
    type,
    userId,
    workspaceId,
  };
};

const buildFeedbackWritePolicy = ({ feedback } = {}) => {
  const configStatus = getAgentExperienceMemoryConfigStatus();
  const feedbackType = normalizeText(feedback?.feedbackType);
  const userId = normalizeText(feedback?.userId);
  const question = normalizeText(feedback?.question);

  if (!configStatus.enabled) {
    return {
      allowed: false,
      enabled: false,
      reason: configStatus.reason ?? AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.disabled,
      records: [],
    };
  }

  if (!NEGATIVE_FEEDBACK_TYPES.has(feedbackType)) {
    return {
      allowed: false,
      enabled: true,
      reason: AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.feedbackNotNegative,
      records: [],
    };
  }

  if (!userId) {
    return {
      allowed: false,
      enabled: true,
      reason: AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.missingUser,
      records: [],
    };
  }

  if (!question) {
    return {
      allowed: false,
      enabled: true,
      reason: AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.missingQuestion,
      records: [],
    };
  }

  const record = buildNegativeFeedbackRecord({ feedback });

  return record
    ? {
        allowed: true,
        enabled: true,
        reason: null,
        records: [record],
      }
    : {
        allowed: false,
        enabled: true,
        reason: AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.noRecords,
        records: [],
      };
};

export const recordAgentExperienceFromFeedback = async ({ feedback } = {}) => {
  const policy = buildFeedbackWritePolicy({ feedback });

  if (!policy.allowed) {
    return createWriteResult({
      enabled: policy.enabled,
      recordCount: policy.records.length,
      records: policy.records,
      skippedReason: policy.reason,
      status: WRITE_STATUSES.skipped,
      writeAttempted: false,
    });
  }

  const storedRecords = [];

  for (const record of policy.records) {
    const storedRecord = await recordAgentExperience(record);

    if (storedRecord) {
      storedRecords.push(normalizeExperienceRecord(storedRecord));
    }
  }

  const prunedCount =
    storedRecords.length > 0
      ? await pruneExperienceMemoryScope({
          userId: normalizeText(feedback.userId),
          workspaceId: normalizeText(feedback.workspaceId),
        })
      : 0;

  return createWriteResult({
    enabled: true,
    prunedCount,
    recordCount: policy.records.length,
    records: policy.records,
    skippedReason:
      storedRecords.length > 0
        ? null
        : AGENT_EXPERIENCE_MEMORY_WRITE_SKIP_REASONS.storeRejected,
    status:
      storedRecords.length > 0
        ? WRITE_STATUSES.stored
        : WRITE_STATUSES.skipped,
    storedCount: storedRecords.length,
    storedRecords,
    writeAttempted: true,
  });
};

const scoreExperience = (experience, queryTerms) => {
  if (experience.confidence < MIN_CONFIDENCE) {
    return 0;
  }

  const memoryTerms = new Set([
    ...extractMeaningfulTokens(experience.text),
    ...toArray(experience.signatureTerms).flatMap((term) =>
      extractMeaningfulTokens(term)
    ),
  ]);
  let overlapCount = 0;

  for (const term of queryTerms) {
    if (memoryTerms.has(term)) {
      overlapCount += 1;
    }
  }

  return overlapCount + experience.confidence;
};

const buildPlannerBlock = (planningHints = []) => {
  if (planningHints.length === 0) {
    return "";
  }

  return [
    "Agent experience memory (planning hints only; never use as document evidence):",
    ...planningHints.map((hint) => `- ${hint.text}`),
  ].join("\n");
};

export const getAgentExperienceMemoryContext = async ({
  accessScope = {},
  docIds = [],
  question,
  userId,
} = {}) => {
  const configStatus = getAgentExperienceMemoryConfigStatus();

  if (!configStatus.enabled) {
    return createExperienceMemoryContext({
      enabled: false,
      reason: configStatus.reason,
      status: "disabled",
    });
  }

  const effectiveUserId = getScopedUserId({
    accessScope,
    userId,
  });
  const workspaceId = getScopedWorkspaceId({
    accessScope,
  });

  if (!effectiveUserId) {
    return createExperienceMemoryContext({
      enabled: true,
      reason: "missing_user",
      status: "skipped",
    });
  }

  const store = getAgentExperienceMemoryStore();
  const records = store.list
    ? await store.list({
        docIds,
        limit: DEFAULT_LIST_LIMIT,
        question,
        userId: effectiveUserId,
        workspaceId,
      })
    : [];
  const queryTerms = new Set(extractMeaningfulTokens(question));
  const ranked = records
    .map(normalizeExperienceRecord)
    .filter(
      (experience) =>
        !experience.workspaceId || !workspaceId || experience.workspaceId === workspaceId
    )
    .map((experience, index) => ({
      experience,
      index,
      score: scoreExperience(experience, queryTerms),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.experience.confidence - left.experience.confidence ||
        left.index - right.index
    )
    .slice(0, MAX_PLANNING_HINTS)
    .map(({ experience, score }) => ({
      ...experience,
      score: Number(score.toFixed(4)),
    }));

  const planningHints = ranked.map((experience) => ({
    confidence: experience.confidence,
    gapTypes: experience.gapTypes,
    intentId: experience.intentId,
    memoryId: experience.memoryId,
    mode: experience.mode,
    retrievalProfile: experience.retrievalProfile,
    score: experience.score,
    signatureTerms: experience.signatureTerms,
    skillChain: experience.skillChain,
    suggestedActions: experience.suggestedActions,
    text: experience.text,
    type: experience.type,
  }));

  return createExperienceMemoryContext({
    enabled: true,
    hitCount: ranked.length,
    memories: ranked,
    memoryApplied: ranked.length > 0,
    plannerBlock: buildPlannerBlock(ranked),
    planningHints,
    reason: ranked.length > 0 ? "matched_planning_hints" : "no_matching_hints",
    status: "ready",
  });
};
