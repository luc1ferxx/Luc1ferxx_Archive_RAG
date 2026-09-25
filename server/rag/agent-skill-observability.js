import { performance } from "node:perf_hooks";
import { getBudgetSnapshot } from "./agent-budget.js";
import { executeAgentSkill } from "./skills/registry.js";
import {
  GEN_AI_ATTRIBUTES,
  GEN_AI_OPERATIONS,
  markSpanFailed,
  setSpanAttributes,
  withSpan,
} from "./tracing.js";

const serializeError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error.message;
  }

  return fallbackMessage;
};

const roundDurationMs = (durationMs) =>
  Number.isFinite(durationMs) ? Number(durationMs.toFixed(2)) : 0;

const getSkillKey = ({ skillId, id }) => skillId ?? id ?? "unknown";

export const getSkillDescriptor = (skill = {}) => ({
  skillId: getSkillKey(skill),
  skillVersion: skill.skillVersion ?? skill.version ?? "unknown",
  label: skill.label ?? skill.skillId ?? skill.id ?? "Unknown skill",
  budgetKey: skill.budgetKey ?? null,
});

const getSkillCitationCount = (result = {}) =>
  result.citations?.length ?? result.value?.citations?.length ?? 0;

const getBudgetUsageDelta = (before = {}, after = {}) => {
  const beforeUsed = before.used ?? {};
  const afterUsed = after.used ?? {};
  const keys = new Set([...Object.keys(beforeUsed), ...Object.keys(afterUsed)]);

  return Object.fromEntries(
    [...keys]
      .map((key) => [key, (afterUsed[key] ?? 0) - (beforeUsed[key] ?? 0)])
      .filter(([, delta]) => delta !== 0)
  );
};

const sanitizeBudgetEvent = (budget = null) => {
  if (!budget) {
    return null;
  }

  return {
    ok: Boolean(budget.ok),
    key: budget.key ?? null,
    label: budget.label ?? null,
    limit: Number.isFinite(Number(budget.limit)) ? Number(budget.limit) : null,
    used: Number.isFinite(Number(budget.used)) ? Number(budget.used) : null,
    remaining: Number.isFinite(Number(budget.remaining))
      ? Number(budget.remaining)
      : null,
    reason: budget.reason ?? null,
  };
};

export const createAgentSkillTracker = ({
  budgetState,
  recordWorkingMemoryQueries = () => {},
  selectedSkills = [],
} = {}) => {
  const skillExecutions = new Map();
  const skillObservations = new Map();
  const skillRuns = [];
  const selectedSkillKeys = new Set(selectedSkills.map((skill) => skill.id));
  const selectedSkillById = new Map(selectedSkills.map((skill) => [skill.id, skill]));

  const markSkillSelected = (skill) => {
    if (!skill?.id) {
      return;
    }

    selectedSkillKeys.add(skill.id);
    selectedSkillById.set(skill.id, skill);

    const observation = skillObservations.get(skill.id);

    if (observation) {
      observation.selected = true;
    }
  };

  const recordSkillResult = (result) => {
    if (!result?.skillId) {
      return;
    }

    const status = result.ok ? "completed" : "failed";
    const existing = skillExecutions.get(result.skillId);

    if (!existing || (existing.status !== "completed" && status === "completed")) {
      skillExecutions.set(result.skillId, {
        skillId: result.skillId,
        skillVersion: result.skillVersion,
        label: result.label,
        status,
      });
    }
  };

  const getAgentSkills = () => [...skillExecutions.values()];

  const buildSkillTraceDetail = (result, detail = {}) => ({
    skillId: result.skillId,
    skillVersion: result.skillVersion,
    durationMs: result.durationMs ?? null,
    ...detail,
  });

  const getOrCreateSkillObservation = (skill) => {
    const descriptor = getSkillDescriptor(skill);
    const existing = skillObservations.get(descriptor.skillId);

    if (existing) {
      return existing;
    }

    const observation = {
      ...descriptor,
      selected: selectedSkillKeys.has(descriptor.skillId),
      status: "not_run",
      attempts: 0,
      skippedCount: 0,
      retryCount: 0,
      followUpCount: 0,
      totalDurationMs: 0,
      citationCount: 0,
      lastCitationCount: 0,
      abstained: false,
      errorCount: 0,
      errors: [],
      budgetUsed: null,
      budgetLimit: null,
      budgetRemaining: null,
      budgetDelta: {},
    };

    skillObservations.set(descriptor.skillId, observation);
    return observation;
  };

  const recordSkillObservation = ({
    skill,
    result,
    phase = "primary",
    status,
    durationMs = 0,
    budget = null,
    budgetDelta = {},
    budgetAfter = null,
  }) => {
    const descriptor = getSkillDescriptor(skill ?? result);
    const observation = getOrCreateSkillObservation({
      ...descriptor,
      budgetKey: descriptor.budgetKey ?? skill?.budgetKey ?? null,
    });
    const finalStatus = status ?? (result?.ok ? "completed" : "failed");
    const roundedDurationMs = roundDurationMs(durationMs);
    const citationCount = getSkillCitationCount(result);
    const error = result?.ok === false
      ? serializeError(result.error, `${observation.label} failed.`)
      : budget?.ok === false
        ? budget.reason ?? null
        : null;
    const budgetEvent = sanitizeBudgetEvent(budget);
    const run = {
      skillId: observation.skillId,
      skillVersion: observation.skillVersion,
      label: observation.label,
      phase,
      status: finalStatus,
      durationMs: roundedDurationMs,
      citationCount,
      abstained: Boolean(result?.abstained ?? result?.value?.abstained),
      error,
      budget: budgetEvent,
      budgetDelta,
    };

    skillRuns.push(run);

    if (finalStatus === "completed") {
      observation.status = "completed";
    } else if (observation.status !== "completed") {
      observation.status = finalStatus;
    }

    if (finalStatus === "skipped") {
      observation.skippedCount += 1;
    } else {
      observation.attempts += 1;
    }

    if (phase === "retry" || phase === "follow_up") {
      observation.retryCount += 1;
    }

    if (phase === "follow_up") {
      observation.followUpCount += 1;
    }

    observation.totalDurationMs = roundDurationMs(
      observation.totalDurationMs + roundedDurationMs
    );
    observation.citationCount += citationCount;
    observation.lastCitationCount = citationCount;
    observation.abstained = observation.abstained || run.abstained;
    observation.budgetDelta = Object.fromEntries(
      Object.entries({
        ...observation.budgetDelta,
        ...budgetDelta,
      }).map(([key, value]) => [
        key,
        (observation.budgetDelta[key] ?? 0) + (budgetDelta[key] ?? 0),
      ])
    );

    if (error) {
      observation.errorCount += 1;
      observation.errors.push(error);
      observation.errors = observation.errors.slice(0, 5);
    }

    const budgetKey = observation.budgetKey;
    const budgetSnapshot = budgetAfter ?? getBudgetSnapshot(budgetState);

    if (budgetKey && budgetSnapshot.limits?.[budgetKey] === undefined) {
      observation.budgetUsed = budgetEvent?.used ?? observation.budgetUsed;
      observation.budgetLimit = budgetEvent?.limit ?? observation.budgetLimit;
      observation.budgetRemaining =
        budgetEvent?.remaining ?? observation.budgetRemaining;
    } else if (budgetKey) {
      observation.budgetUsed = budgetSnapshot.used?.[budgetKey] ?? null;
      observation.budgetLimit = budgetSnapshot.limits?.[
        `max${budgetKey[0].toUpperCase()}${budgetKey.slice(1)}`
      ] ?? budgetEvent?.limit ?? null;
      observation.budgetRemaining =
        observation.budgetLimit === null || observation.budgetUsed === null
          ? budgetEvent?.remaining ?? null
          : Math.max(0, observation.budgetLimit - observation.budgetUsed);
    }
  };

  const executeObservedSkill = async (
    skill,
    context,
    { phase = "primary", budget = null, validateInput, validateOutput } = {}
  ) => {
    recordWorkingMemoryQueries({
      skill,
      phase,
      retrievalPlan: context?.retrievalPlan,
    });

    const budgetBefore = getBudgetSnapshot(budgetState);
    const startedAt = performance.now();
    // Every Skill -- document RAG, follow-up retrieval, custom Skills, web,
    // built-ins -- runs here, so this one span puts each model call a Skill
    // makes under the Skill that made it.
    const result = await withSpan(
      `${GEN_AI_OPERATIONS.executeTool} ${skill.id}`,
      {
        [GEN_AI_ATTRIBUTES.operationName]: GEN_AI_OPERATIONS.executeTool,
        [GEN_AI_ATTRIBUTES.toolName]: skill.id,
        "agent.skill.phase": phase,
        "agent.skill.version": skill.version,
      },
      async (span) => {
        const skillResult = await executeAgentSkill(skill, context, {
          validateInput,
          validateOutput,
        });

        setSpanAttributes(span, {
          "agent.skill.abstained": Boolean(skillResult?.abstained),
          "agent.skill.citation_count": Array.isArray(skillResult?.citations)
            ? skillResult.citations.length
            : undefined,
          "agent.skill.ok": Boolean(skillResult?.ok),
        });

        if (!skillResult?.ok) {
          markSpanFailed(span, skillResult?.error?.message ?? "skill failed");
        }

        return skillResult;
      }
    );
    const durationMs = performance.now() - startedAt;
    const budgetAfter = getBudgetSnapshot(budgetState);

    result.durationMs = roundDurationMs(durationMs);
    recordSkillObservation({
      skill,
      result,
      phase,
      durationMs,
      budget,
      budgetDelta: getBudgetUsageDelta(budgetBefore, budgetAfter),
      budgetAfter,
    });

    return result;
  };

  const recordSkippedSkill = ({ skill, result, phase, budget, status = "skipped" }) => {
    recordSkillObservation({
      skill,
      result,
      phase,
      status,
      budget,
      budgetAfter: getBudgetSnapshot(budgetState),
    });
  };

  return {
    buildSkillTraceDetail,
    executeObservedSkill,
    getAgentSkills,
    getOrCreateSkillObservation,
    getSkillObservations: () =>
      [...skillObservations.values()].sort((left, right) =>
        left.skillId.localeCompare(right.skillId)
      ),
    getSkillRuns: () => skillRuns,
    getSelectedSkills: () => [...selectedSkillById.values()],
    markSkillSelected,
    recordSkillObservation,
    recordSkillResult,
    recordSkippedSkill,
  };
};
