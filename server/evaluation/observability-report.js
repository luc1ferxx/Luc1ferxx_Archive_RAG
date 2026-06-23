import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  getAgentMode,
  getExecutionPlanner,
  getObservedSkills,
  getSkillRuns,
  getTraceSteps,
  hasAgentObservability,
  isPlainObject,
} from "./chat-response-contract.js";
import { getRagDataDirectory } from "../rag/storage.js";

const round = (value, digits = 4) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;

const toNumber = (value, fallbackValue = 0) => {
  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : fallbackValue;
};

const toNonNegativeInteger = (value, fallbackValue = 0) => {
  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) && parsedValue >= 0
    ? Math.floor(parsedValue)
    : fallbackValue;
};

const increment = (counts, key, amount = 1) => {
  const normalizedKey = String(key ?? "unknown").trim() || "unknown";
  counts[normalizedKey] = (counts[normalizedKey] ?? 0) + amount;
};

const toPercent = (value) => `${round(value * 100, 1)}%`;

export const getDefaultObservabilityPath = () =>
  path.join(path.dirname(getRagDataDirectory()), "rag-observability");

const getSkillKey = ({ skillId, skillVersion }) =>
  `${skillId || "unknown"}@${skillVersion || "unknown"}`;

const normalizeSkill = (skill = {}) => {
  const skillId = String(skill.skillId ?? skill.id ?? "unknown").trim() || "unknown";
  const skillVersion =
    String(skill.skillVersion ?? skill.version ?? "unknown").trim() || "unknown";

  return {
    skillKey: getSkillKey({
      skillId,
      skillVersion,
    }),
    skillId,
    skillVersion,
    label: String(skill.label ?? skillId).trim() || skillId,
  };
};

const createSkillStats = (skill = {}) => ({
  ...normalizeSkill(skill),
  selectedCount: 0,
  attempts: 0,
  skippedCount: 0,
  retryCount: 0,
  errorCount: 0,
  abstainCount: 0,
  totalDurationMs: 0,
  citationCount: 0,
  lastBudgetUsed: null,
  lastBudgetLimit: null,
  lastBudgetRemaining: null,
});

const getOrCreateSkillStats = (skillStatsByKey, skill = {}) => {
  const normalizedSkill = normalizeSkill(skill);
  const existing = skillStatsByKey.get(normalizedSkill.skillKey);

  if (existing) {
    return existing;
  }

  const stats = createSkillStats(normalizedSkill);
  skillStatsByKey.set(stats.skillKey, stats);
  return stats;
};

const addSkillSummary = (skillStatsByKey, skill = {}) => {
  const stats = getOrCreateSkillStats(skillStatsByKey, skill);

  stats.selectedCount += skill.selected ? 1 : 0;
  stats.attempts += toNonNegativeInteger(skill.attempts);
  stats.skippedCount += toNonNegativeInteger(skill.skippedCount);
  stats.retryCount += toNonNegativeInteger(skill.retryCount);
  stats.errorCount += toNonNegativeInteger(skill.errorCount);
  stats.abstainCount += skill.abstained ? 1 : 0;
  stats.totalDurationMs += toNumber(skill.totalDurationMs);
  stats.citationCount += toNonNegativeInteger(skill.citationCount);

  if (skill.budgetUsed !== undefined) {
    stats.lastBudgetUsed = toNumber(skill.budgetUsed, null);
  }

  if (skill.budgetLimit !== undefined) {
    stats.lastBudgetLimit = toNumber(skill.budgetLimit, null);
  }

  if (skill.budgetRemaining !== undefined) {
    stats.lastBudgetRemaining = toNumber(skill.budgetRemaining, null);
  }
};

const addSkillRun = (skillStatsByKey, run = {}) => {
  const stats = getOrCreateSkillStats(skillStatsByKey, run);
  const status = String(run.status ?? "").toLowerCase();

  if (status === "skipped") {
    stats.skippedCount += 1;
  } else {
    stats.attempts += 1;
  }

  if (run.phase === "retry" || run.phase === "follow_up") {
    stats.retryCount += 1;
  }

  if (status === "failed" || run.error) {
    stats.errorCount += 1;
  }

  stats.abstainCount += run.abstained ? 1 : 0;
  stats.totalDurationMs += toNumber(run.durationMs);
  stats.citationCount += toNonNegativeInteger(run.citationCount);
};

const finalizeSkillStats = (stats) => {
  const denominator = Math.max(stats.attempts, 1);

  return {
    ...stats,
    totalDurationMs: round(stats.totalDurationMs, 2),
    avgDurationMs: round(stats.totalDurationMs / denominator, 2),
    avgCitations: round(stats.citationCount / denominator, 4),
    retryRate: round(stats.retryCount / denominator, 4),
    failureRate: round(stats.errorCount / denominator, 4),
    abstainRate: round(stats.abstainCount / denominator, 4),
  };
};

const getAgentRetrievalPlan = (event = {}) => {
  if (isPlainObject(event.agentRetrievalPlan)) {
    return event.agentRetrievalPlan;
  }

  const queryPlannerStep = getTraceSteps(event, "query_planner")[0] ?? null;

  return isPlainObject(queryPlannerStep?.detail) ? queryPlannerStep.detail : null;
};

const getCitationCount = (event = {}) =>
  Array.isArray(event.finalSourceBundle?.citations)
    ? event.finalSourceBundle.citations.length
    : 0;

const isRagTraceEvent = (event = {}) =>
  Boolean(
    event.routeMode ||
      event.retrievalResults ||
      event.perDocumentResults ||
      event.finalSourceBundle
  );

const createPlannerStats = () => ({
  eventCount: 0,
  requestedPlannerCounts: {},
  selectedPlannerCounts: {},
  statusCounts: {},
  fallbackCount: 0,
  fallbackRate: 0,
  llmSelectedCount: 0,
  fallbackReasonCounts: {},
  topFallbackReasons: [],
  stepSequences: {},
  agentModeStepSequences: {},
});

const createRecoveryStats = () => ({
  eventCount: 0,
  recoverableRunCount: 0,
  manualRecoveryCount: 0,
  manualRecoveryActionCount: 0,
  manualRecoveryActionFailureCount: 0,
  autoReplayAttemptCount: 0,
  autoReplaySuccessCount: 0,
  autoReplayFailureCount: 0,
  autoReplaySuccessRate: 0,
  stepLifecycleEventCount: 0,
  primaryStepStartedCount: 0,
  primaryStepCompletedCount: 0,
  primaryStepFailedCount: 0,
  stepRetryCount: 0,
  stepResumeCount: 0,
  stepReplayFailureCount: 0,
  plannerFallbackCount: 0,
  actionCounts: {},
  primaryStepLifecycleCounts: {},
  stepLifecycleCounts: {},
  taskRecoveryScheduledCount: 0,
  taskRecoveryResumeActionCount: 0,
  taskRecoveryResumeFailureCount: 0,
  taskRecoveryCompletedCount: 0,
  taskRecoveryActionCounts: {},
});

const getPlannerId = (value, fallbackValue = "unknown") =>
  String(value ?? fallbackValue).trim() || fallbackValue;

const getPlannerStepSequence = (planner = {}) => {
  const stepIds = Array.isArray(planner.stepIds) ? planner.stepIds : [];

  return stepIds.length > 0 ? stepIds.join(" -> ") : "none";
};

const incrementNested = (counts, outerKey, innerKey, amount = 1) => {
  const normalizedOuterKey = String(outerKey ?? "unknown").trim() || "unknown";
  const normalizedInnerKey = String(innerKey ?? "unknown").trim() || "unknown";

  counts[normalizedOuterKey] ??= {};
  increment(counts[normalizedOuterKey], normalizedInnerKey, amount);
};

const formatTopCounts = (counts = {}, limit = 5) =>
  Object.entries(counts)
    .sort(
      ([leftKey, leftCount], [rightKey, rightCount]) =>
        rightCount - leftCount || leftKey.localeCompare(rightKey)
    )
    .slice(0, limit)
    .map(([key, count]) => ({
      count,
      value: key,
    }));

const addPlannerSummary = ({ agentMode, plannerStats, executionPlanner }) => {
  const requestedPlannerId = getPlannerId(
    executionPlanner.requestedPlannerId,
    "not_run"
  );
  const selectedPlannerId = getPlannerId(
    executionPlanner.selectedPlannerId,
    "not_run"
  );
  const status = getPlannerId(executionPlanner.status, "unknown");
  const stepSequence = getPlannerStepSequence(executionPlanner);

  plannerStats.eventCount += 1;
  increment(plannerStats.requestedPlannerCounts, requestedPlannerId);
  increment(plannerStats.selectedPlannerCounts, selectedPlannerId);
  increment(plannerStats.statusCounts, status);
  increment(plannerStats.stepSequences, stepSequence);
  incrementNested(
    plannerStats.agentModeStepSequences,
    agentMode ?? "unknown",
    stepSequence
  );

  if (selectedPlannerId === "llm") {
    plannerStats.llmSelectedCount += 1;
  }

  if (executionPlanner.fallback) {
    plannerStats.fallbackCount += 1;
    increment(
      plannerStats.fallbackReasonCounts,
      executionPlanner.fallbackReason || "unknown"
    );
  }
};

const finalizePlannerStats = (plannerStats) => ({
  ...plannerStats,
  fallbackRate:
    plannerStats.eventCount > 0
      ? round(plannerStats.fallbackCount / plannerStats.eventCount, 4)
      : 0,
  topFallbackReasons: formatTopCounts(plannerStats.fallbackReasonCounts),
});

const isAgentRunRecoveryEvent = (event = {}) =>
  event.traceType === "agent_run_recovery";

const isAgentRunStepReplayEvent = (event = {}) =>
  event.traceType === "agent_run_step_replay";

const isAgentTaskRecoveryEvent = (event = {}) =>
  event.traceType === "agent_task_recovery";

const STEP_LIFECYCLE_EVENT_TYPES = new Set([
  "step_started",
  "step_completed",
  "step_failed",
]);

const getEventType = (event = {}) =>
  String(event.eventType ?? event.type ?? "").trim();

const getTraceType = (event = {}) => String(event.traceType ?? "").trim();

const getEventPayload = (event = {}) =>
  isPlainObject(event.payload) ? event.payload : {};

const getStepId = (event = {}) => {
  const payload = getEventPayload(event);

  return String(event.stepId ?? payload.stepId ?? "").trim();
};

const isAgentRunStepLifecycleEvent = (event = {}) =>
  STEP_LIFECYCLE_EVENT_TYPES.has(getEventType(event)) &&
  Boolean(getStepId(event)) &&
  (getTraceType(event) === "agent_run_step_lifecycle" || !getTraceType(event));

const hasPrimaryStepMarker = (event = {}) => {
  const payload = getEventPayload(event);
  const stepId = getStepId(event);
  const markers = [
    event.primary,
    event.phase,
    event.stepRole,
    payload.primary,
    payload.phase,
    payload.stepRole,
  ];

  return (
    stepId.endsWith(":primary") ||
    markers.some(
      (marker) =>
        marker === true || String(marker ?? "").trim().toLowerCase() === "primary"
    )
  );
};

const addRecoveryEvent = (recovery, event = {}) => {
  recovery.eventCount += 1;

  if (event.eventType === "startup_recovery_completed") {
    recovery.recoverableRunCount += toNonNegativeInteger(
      event.recoverableRunCount
    );
    recovery.manualRecoveryCount += toNonNegativeInteger(
      event.manualRecoveryCount
    );
    recovery.autoReplayAttemptCount += toNonNegativeInteger(
      event.autoReplayAttemptCount
    );
    recovery.autoReplaySuccessCount += toNonNegativeInteger(
      event.autoReplaySuccessCount
    );
    recovery.autoReplayFailureCount += toNonNegativeInteger(
      event.autoReplayFailureCount
    );
  }

  if (event.eventType === "manual_recovery_action") {
    recovery.manualRecoveryActionCount += 1;
    increment(recovery.actionCounts, event.action);

    if (event.status === "failed" || event.error) {
      recovery.manualRecoveryActionFailureCount += 1;
    }
  }
};

const addStepLifecycleEvent = (recovery, event = {}) => {
  const eventType = getEventType(event);

  recovery.eventCount += 1;
  recovery.stepLifecycleEventCount += 1;
  increment(recovery.stepLifecycleCounts, eventType);

  if (!hasPrimaryStepMarker(event)) {
    return;
  }

  increment(recovery.primaryStepLifecycleCounts, eventType);

  if (eventType === "step_started") {
    recovery.primaryStepStartedCount += 1;
  }

  if (eventType === "step_completed") {
    recovery.primaryStepCompletedCount += 1;
  }

  if (eventType === "step_failed") {
    recovery.primaryStepFailedCount += 1;
  }
};

const addStepReplayEvent = (recovery, event = {}) => {
  recovery.eventCount += 1;

  if (event.action === "retry_step") {
    recovery.stepRetryCount += 1;
  }

  if (event.action === "resume_step") {
    recovery.stepResumeCount += 1;
  }

  if (event.status === "failed" || event.error) {
    recovery.stepReplayFailureCount += 1;
  }
};

const addTaskRecoveryEvent = (recovery, event = {}) => {
  const eventType = getEventType(event);

  recovery.eventCount += 1;

  if (eventType === "task_recovery_scheduled") {
    recovery.taskRecoveryScheduledCount += toNonNegativeInteger(
      event.scheduledCount,
      Array.isArray(event.taskRefs) ? event.taskRefs.length : 0
    );
    return;
  }

  if (eventType === "task_resume_action") {
    recovery.taskRecoveryResumeActionCount += 1;
    increment(recovery.taskRecoveryActionCounts, event.action);

    if (event.status === "failed" || event.error || event.errorStatus) {
      recovery.taskRecoveryResumeFailureCount += 1;
    }

    return;
  }

  if (
    eventType === "task_recovery_run" &&
    (event.resultStatus === "completed" || event.status === "completed")
  ) {
    recovery.taskRecoveryCompletedCount += 1;
  }
};

const finalizeRecoveryStats = (recovery) => ({
  ...recovery,
  autoReplaySuccessRate:
    recovery.autoReplayAttemptCount > 0
      ? round(recovery.autoReplaySuccessCount / recovery.autoReplayAttemptCount, 4)
      : 0,
});

export const buildObservabilityReport = ({ events = [] } = {}) => {
  const skillStatsByKey = new Map();
  const queryPlanner = {
    eventCount: 0,
    intentCounts: {},
    topKProfiles: {},
    topKValues: {},
    totalRetrievalQueries: 0,
    avgRetrievalQueries: 0,
  };
  const rag = {
    eventCount: 0,
    routeModes: {},
    totalLatencyMs: 0,
    avgLatencyMs: 0,
    citationCount: 0,
    avgCitations: 0,
    abstainCount: 0,
    abstainRate: 0,
  };
  const plannerStats = createPlannerStats();
  const recovery = createRecoveryStats();

  for (const event of events) {
    if (hasAgentObservability(event)) {
      const executionPlanner = getExecutionPlanner(event);
      const observedSkills = getObservedSkills(event);
      const skillRuns = getSkillRuns(event);

      if (executionPlanner) {
        addPlannerSummary({
          agentMode: getAgentMode(event),
          executionPlanner,
          plannerStats,
        });
      }

      if (observedSkills.length > 0) {
        for (const skill of observedSkills) {
          addSkillSummary(skillStatsByKey, skill);
        }
      } else {
        for (const run of skillRuns) {
          addSkillRun(skillStatsByKey, run);
        }
      }
    }

    if (isAgentRunRecoveryEvent(event)) {
      addRecoveryEvent(recovery, event);
    }

    if (isAgentRunStepReplayEvent(event)) {
      addStepReplayEvent(recovery, event);
    }

    if (isAgentTaskRecoveryEvent(event)) {
      addTaskRecoveryEvent(recovery, event);
    }

    if (isAgentRunStepLifecycleEvent(event)) {
      addStepLifecycleEvent(recovery, event);
    }

    const retrievalPlan = getAgentRetrievalPlan(event);

    if (retrievalPlan) {
      const retrievalQueries = Array.isArray(retrievalPlan.retrievalQueries)
        ? retrievalPlan.retrievalQueries
        : [];

      queryPlanner.eventCount += 1;
      queryPlanner.totalRetrievalQueries += retrievalQueries.length;
      increment(queryPlanner.intentCounts, retrievalPlan.intent);
      increment(queryPlanner.topKProfiles, retrievalPlan.retrievalOptions?.profile);

      if (retrievalPlan.retrievalOptions?.topK !== undefined) {
        increment(queryPlanner.topKValues, retrievalPlan.retrievalOptions.topK);
      }
    }

    if (isRagTraceEvent(event)) {
      rag.eventCount += 1;
      rag.totalLatencyMs += toNumber(event.latencyMs);
      rag.citationCount += getCitationCount(event);
      rag.abstainCount += event.abstained ? 1 : 0;
      increment(rag.routeModes, event.routeMode);
    }
  }

  queryPlanner.avgRetrievalQueries =
    queryPlanner.eventCount > 0
      ? round(queryPlanner.totalRetrievalQueries / queryPlanner.eventCount, 4)
      : 0;
  rag.avgLatencyMs =
    rag.eventCount > 0 ? round(rag.totalLatencyMs / rag.eventCount, 2) : 0;
  rag.avgCitations =
    rag.eventCount > 0 ? round(rag.citationCount / rag.eventCount, 4) : 0;
  rag.abstainRate =
    rag.eventCount > 0 ? round(rag.abstainCount / rag.eventCount, 4) : 0;

  const planner = finalizePlannerStats(plannerStats);

  return {
    eventCount: events.length,
    skills: [...skillStatsByKey.values()]
      .map(finalizeSkillStats)
      .sort(
        (left, right) =>
          right.attempts - left.attempts ||
          left.skillKey.localeCompare(right.skillKey)
      ),
    queryPlanner,
    planner,
    recovery: finalizeRecoveryStats({
      ...recovery,
      plannerFallbackCount: planner.fallbackCount,
    }),
    rag: {
      ...rag,
      totalLatencyMs: round(rag.totalLatencyMs, 2),
    },
  };
};

const formatCountMap = (counts = {}, { indent = "  " } = {}) =>
  Object.entries(counts)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${indent}${key}: ${value}`);

const formatNestedCountMap = (counts = {}, { indent = "  " } = {}) => {
  const lines = [];

  for (const [outerKey, innerCounts] of Object.entries(counts).sort(
    ([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)
  )) {
    lines.push(`${indent}${outerKey}:`);

    const formattedInnerCounts = formatCountMap(innerCounts, {
      indent: `${indent}  `,
    });

    lines.push(...(formattedInnerCounts.length > 0
      ? formattedInnerCounts
      : [`${indent}  none: 0`]));
  }

  return lines;
};

const formatTopCountList = (items = [], { indent = "  " } = {}) =>
  items.map((item) => `${indent}${item.value}: ${item.count}`);

const formatSkill = (skill) =>
  [
    `${skill.skillKey}`,
    `  runs: ${skill.attempts}`,
    `  avg latency: ${round(skill.avgDurationMs, 1)}ms`,
    `  abstain rate: ${toPercent(skill.abstainRate)}`,
    `  avg citations: ${round(skill.avgCitations, 2)}`,
    `  retry rate: ${toPercent(skill.retryRate)}`,
    `  failure rate: ${toPercent(skill.failureRate)}`,
    skill.lastBudgetLimit !== null
      ? `  last budget: ${skill.lastBudgetUsed ?? "n/a"} / ${skill.lastBudgetLimit}`
      : null,
  ].filter(Boolean);

export const formatObservabilityReport = (report) => {
  const lines = [
    "AgentRAG Observability Report",
    "",
    `Events: ${report.eventCount}`,
    "",
    "Skills",
  ];

  if (report.skills.length === 0) {
    lines.push("  No agent skill metrics found.");
  } else {
    for (const skill of report.skills) {
      lines.push(...formatSkill(skill), "");
    }
  }

  lines.push(
    "Execution Planner",
    `  events: ${report.planner.eventCount}`,
    `  llm selected: ${report.planner.llmSelectedCount}`,
    `  fallback count: ${report.planner.fallbackCount}`,
    `  fallback rate: ${toPercent(report.planner.fallbackRate)}`,
    "  requested planners:"
  );
  lines.push(
    ...(formatCountMap(report.planner.requestedPlannerCounts, {
      indent: "    ",
    }).length
      ? formatCountMap(report.planner.requestedPlannerCounts, {
          indent: "    ",
        })
      : ["    none: 0"]),
    "  selected planners:"
  );
  lines.push(
    ...(formatCountMap(report.planner.selectedPlannerCounts, {
      indent: "    ",
    }).length
      ? formatCountMap(report.planner.selectedPlannerCounts, {
          indent: "    ",
        })
      : ["    none: 0"]),
    "  statuses:"
  );
  lines.push(
    ...(formatCountMap(report.planner.statusCounts, {
      indent: "    ",
    }).length
      ? formatCountMap(report.planner.statusCounts, {
          indent: "    ",
        })
      : ["    none: 0"]),
    "  fallback reasons:"
  );
  lines.push(
    ...(formatTopCountList(report.planner.topFallbackReasons, {
      indent: "    ",
    }).length
      ? formatTopCountList(report.planner.topFallbackReasons, {
          indent: "    ",
        })
      : ["    none: 0"]),
    "  agent mode step sequences:"
  );
  lines.push(
    ...(formatNestedCountMap(report.planner.agentModeStepSequences, {
      indent: "    ",
    }).length
      ? formatNestedCountMap(report.planner.agentModeStepSequences, {
          indent: "    ",
        })
      : ["    none: 0"]),
    ""
  );

  lines.push(
    "Recovery / Replay",
    `  events: ${report.recovery.eventCount}`,
    `  recoverable runs: ${report.recovery.recoverableRunCount}`,
    `  manual recovery marked: ${report.recovery.manualRecoveryCount}`,
    `  manual recovery actions: ${report.recovery.manualRecoveryActionCount}`,
    `  manual recovery action failures: ${report.recovery.manualRecoveryActionFailureCount}`,
    `  auto replay attempts: ${report.recovery.autoReplayAttemptCount}`,
    `  auto replay success rate: ${toPercent(report.recovery.autoReplaySuccessRate)}`,
    `  step lifecycle events: ${report.recovery.stepLifecycleEventCount}`,
    `  primary step started: ${report.recovery.primaryStepStartedCount}`,
    `  primary step completed: ${report.recovery.primaryStepCompletedCount}`,
    `  primary step failed: ${report.recovery.primaryStepFailedCount}`,
    `  step retry count: ${report.recovery.stepRetryCount}`,
    `  step resume count: ${report.recovery.stepResumeCount}`,
    `  step replay failures: ${report.recovery.stepReplayFailureCount}`,
    `  planner fallback count: ${report.recovery.plannerFallbackCount}`,
    `  task recovery scheduled: ${report.recovery.taskRecoveryScheduledCount}`,
    `  task recovery resume actions: ${report.recovery.taskRecoveryResumeActionCount}`,
    `  task recovery resume failures: ${report.recovery.taskRecoveryResumeFailureCount}`,
    `  task recovery completed: ${report.recovery.taskRecoveryCompletedCount}`,
    "  manual actions:"
  );
  lines.push(
    ...(formatCountMap(report.recovery.actionCounts, {
      indent: "    ",
    }).length
      ? formatCountMap(report.recovery.actionCounts, {
          indent: "    ",
        })
      : ["    none: 0"]),
    "  task recovery actions:"
  );
  lines.push(
    ...(formatCountMap(report.recovery.taskRecoveryActionCounts, {
      indent: "    ",
    }).length
      ? formatCountMap(report.recovery.taskRecoveryActionCounts, {
          indent: "    ",
        })
      : ["    none: 0"]),
    ""
  );

  lines.push(
    "Query Planner",
    `  events: ${report.queryPlanner.eventCount}`,
    `  avg retrieval queries: ${round(report.queryPlanner.avgRetrievalQueries, 2)}`,
    "  intents:"
  );
  lines.push(
    ...(formatCountMap(report.queryPlanner.intentCounts, {
      indent: "    ",
    }).length
      ? formatCountMap(report.queryPlanner.intentCounts, {
          indent: "    ",
        })
      : ["    none: 0"]),
    "  topK profiles:"
  );
  lines.push(
    ...(formatCountMap(report.queryPlanner.topKProfiles, {
      indent: "    ",
    }).length
      ? formatCountMap(report.queryPlanner.topKProfiles, {
          indent: "    ",
        })
      : ["    none: 0"]),
    "",
    "RAG Traces",
    `  events: ${report.rag.eventCount}`,
    `  avg latency: ${round(report.rag.avgLatencyMs, 1)}ms`,
    `  avg citations: ${round(report.rag.avgCitations, 2)}`,
    `  abstain rate: ${toPercent(report.rag.abstainRate)}`,
    "  route modes:"
  );
  lines.push(
    ...(formatCountMap(report.rag.routeModes, {
      indent: "    ",
    }).length
      ? formatCountMap(report.rag.routeModes, {
          indent: "    ",
        })
      : ["    none: 0"])
  );

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
};

const readJsonlFile = async (filePath) => {
  const content = await readFile(filePath, "utf8");
  const events = [];
  let invalidLineCount = 0;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    try {
      events.push(JSON.parse(trimmed));
    } catch {
      invalidLineCount += 1;
    }
  }

  return {
    events,
    invalidLineCount,
  };
};

const listJsonlFiles = async (inputPath) => {
  let inputStat = null;

  try {
    inputStat = await stat(inputPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  if (inputStat.isFile()) {
    return [inputPath];
  }

  if (!inputStat.isDirectory()) {
    return [];
  }

  const entries = await readdir(inputPath);

  return entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort()
    .map((entry) => path.join(inputPath, entry));
};

export const readObservabilityEventsFromPath = async (
  inputPath = getDefaultObservabilityPath()
) => {
  const inputPaths = await listJsonlFiles(inputPath);
  const events = [];
  let invalidLineCount = 0;

  for (const filePath of inputPaths) {
    const result = await readJsonlFile(filePath);

    events.push(...result.events);
    invalidLineCount += result.invalidLineCount;
  }

  return {
    inputPath,
    inputPaths,
    fileCount: inputPaths.length,
    invalidLineCount,
    events,
  };
};

export const buildObservabilityReportFromPath = async (inputPath) => {
  const readResult = await readObservabilityEventsFromPath(
    inputPath ?? getDefaultObservabilityPath()
  );

  return {
    ...buildObservabilityReport({
      events: readResult.events,
    }),
    inputPath: readResult.inputPath,
    inputPaths: readResult.inputPaths,
    fileCount: readResult.fileCount,
    invalidLineCount: readResult.invalidLineCount,
  };
};
