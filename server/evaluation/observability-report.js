import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
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

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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

  if (run.phase === "retry") {
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

const getAgentObservability = (event = {}) =>
  isPlainObject(event.agentObservability) ? event.agentObservability : null;

const getAgentRetrievalPlan = (event = {}) => {
  if (isPlainObject(event.agentRetrievalPlan)) {
    return event.agentRetrievalPlan;
  }

  const queryPlannerStep = Array.isArray(event.agentTrace)
    ? event.agentTrace.find((step) => step?.type === "query_planner")
    : null;

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

  for (const event of events) {
    const agentObservability = getAgentObservability(event);

    if (agentObservability) {
      if (
        Array.isArray(agentObservability.skills) &&
        agentObservability.skills.length > 0
      ) {
        for (const skill of agentObservability.skills) {
          addSkillSummary(skillStatsByKey, skill);
        }
      } else if (Array.isArray(agentObservability.runs)) {
        for (const run of agentObservability.runs) {
          addSkillRun(skillStatsByKey, run);
        }
      }
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
