import { buildEvidenceGaps } from "./agent-self-check.js";

const normalizeText = (value) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : "";

const getSkillKey = ({ skillId, id }) => skillId ?? id ?? "unknown";

const getSkillDescriptor = (skill = {}) => ({
  skillId: getSkillKey(skill),
  skillVersion: skill.skillVersion ?? skill.version ?? "unknown",
});

const getClaimKey = (claimText = "") => normalizeText(claimText).toLowerCase();

const getGapKey = (gap = {}) =>
  [
    gap.skillId ?? "unknown",
    gap.type ?? "evidence_gap",
    normalizeText(gap.claim ?? gap.message),
  ].join(":").toLowerCase();

export const createAgentWorkingMemory = ({
  docIds = [],
  maxFollowUps,
  question = "",
} = {}) => {
  const workingMemory = {
    version: "1.0",
    goal: question,
    docIds,
    checkedQueries: [],
    supportedClaims: [],
    unsupportedClaims: [],
    unresolvedGaps: [],
    resolvedGaps: [],
  };
  const workingMemoryState = {
    checkedQueryKeys: new Set(),
    supportedClaimKeys: new Set(),
    unsupportedClaimKeys: new Set(),
    unresolvedGapKeys: new Set(),
    resolvedGapKeys: new Set(),
  };
  const executionLoop = {
    version: "1.0",
    maxFollowUps,
    followUpsRun: 0,
    gapsIdentified: 0,
    gaps: [],
    stoppedReason: "not_needed",
  };

  const recordWorkingMemoryQueries = ({ skill, phase, retrievalPlan }) => {
    if (!retrievalPlan?.retrievalQueries?.length) {
      return;
    }

    const descriptor = getSkillDescriptor(skill);

    for (const retrievalQuery of retrievalPlan.retrievalQueries) {
      const query = normalizeText(retrievalQuery.query);
      const key = query.toLowerCase();

      if (!query || workingMemoryState.checkedQueryKeys.has(key)) {
        continue;
      }

      workingMemoryState.checkedQueryKeys.add(key);
      workingMemory.checkedQueries.push({
        skillId: descriptor.skillId,
        skillVersion: descriptor.skillVersion,
        phase,
        queryId: retrievalQuery.id ?? null,
        label: retrievalQuery.label ?? null,
        query,
        primary: Boolean(retrievalQuery.primary),
      });
    }
  };

  const recordWorkingMemoryClaimSupport = ({ skill, phase, check }) => {
    const claims = check?.claimSupport?.claims ?? [];

    if (claims.length === 0) {
      return;
    }

    const descriptor = getSkillDescriptor(skill);

    for (const claim of claims) {
      const text = normalizeText(claim.text);
      const key = getClaimKey(text);

      if (!text || claim.heading) {
        continue;
      }

      const entry = {
        skillId: descriptor.skillId,
        skillVersion: descriptor.skillVersion,
        phase,
        text,
        tokenOverlap: claim.tokenOverlap ?? null,
        anchors: claim.anchors ?? [],
        missingAnchors: claim.missingAnchors ?? [],
      };

      if (claim.supported) {
        if (!workingMemoryState.supportedClaimKeys.has(key)) {
          workingMemoryState.supportedClaimKeys.add(key);
          workingMemory.supportedClaims.push(entry);
        }

        if (workingMemoryState.unsupportedClaimKeys.has(key)) {
          workingMemoryState.unsupportedClaimKeys.delete(key);
          workingMemory.unsupportedClaims = workingMemory.unsupportedClaims.filter(
            (unsupportedClaim) => getClaimKey(unsupportedClaim.text) !== key
          );
        }

        continue;
      }

      if (
        !workingMemoryState.supportedClaimKeys.has(key) &&
        !workingMemoryState.unsupportedClaimKeys.has(key)
      ) {
        workingMemoryState.unsupportedClaimKeys.add(key);
        workingMemory.unsupportedClaims.push(entry);
      }
    }
  };

  const recordWorkingMemoryGaps = ({ gaps = [], phase }) => {
    for (const gap of gaps) {
      const key = getGapKey(gap);

      if (workingMemoryState.unresolvedGapKeys.has(key)) {
        continue;
      }

      workingMemoryState.unresolvedGapKeys.add(key);
      workingMemory.unresolvedGaps.push({
        ...gap,
        phase,
      });
    }
  };

  const recordExecutionGaps = ({ skill, check }) => {
    const descriptor = getSkillDescriptor(skill);
    const gaps = check.gaps?.length ? check.gaps : buildEvidenceGaps(check);
    const normalizedGaps = gaps.map((gap) => ({
      ...gap,
      skillId: descriptor.skillId,
      skillVersion: descriptor.skillVersion,
    }));

    executionLoop.gaps.push(...normalizedGaps);
    executionLoop.gapsIdentified = executionLoop.gaps.length;
    recordWorkingMemoryGaps({
      gaps: normalizedGaps,
      phase: "gap_analysis",
    });

    return normalizedGaps;
  };

  const resolveWorkingMemoryGaps = ({ skill, phase }) => {
    const descriptor = getSkillDescriptor(skill);
    const resolvedGaps = workingMemory.unresolvedGaps.filter(
      (gap) => gap.skillId === descriptor.skillId
    );

    for (const gap of resolvedGaps) {
      const key = getGapKey(gap);

      if (workingMemoryState.resolvedGapKeys.has(key)) {
        continue;
      }

      workingMemoryState.resolvedGapKeys.add(key);
      workingMemory.resolvedGaps.push({
        ...gap,
        resolvedPhase: phase,
      });
    }

    workingMemory.unresolvedGaps = workingMemory.unresolvedGaps.filter(
      (gap) => gap.skillId !== descriptor.skillId
    );
    workingMemoryState.unresolvedGapKeys = new Set(
      workingMemory.unresolvedGaps.map((gap) => getGapKey(gap))
    );
  };

  return {
    executionLoop,
    recordExecutionGaps,
    recordWorkingMemoryClaimSupport,
    recordWorkingMemoryGaps,
    recordWorkingMemoryQueries,
    resolveWorkingMemoryGaps,
    workingMemory,
  };
};
