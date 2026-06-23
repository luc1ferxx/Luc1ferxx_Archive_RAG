import { getAnswerTraceOverview } from "../chatResponseContract";
import {
  formatBudgetCounter,
  formatDetailValue,
  formatGapType,
  formatMaybeVersion,
  formatSkillMetricCopy,
  formatSkillRef,
  getGapCopy,
  getGapTitle,
  isPlainObject,
} from "./AgentTraceDetail";

const normalizeArray = (value) => (Array.isArray(value) ? value : []);

const hasNumber = (value) => Number.isFinite(Number(value));

const formatEvidenceScore = (value) =>
  typeof value === "number" ? value.toFixed(2) : "N/A";

export const formatPlannerLabel = (planner = {}) => {
  if (planner.status === "not_run") {
    return "Not run";
  }

  if (planner.fallback) {
    return `${planner.requestedPlannerId ?? "unknown"} -> ${
      planner.selectedPlannerId ?? "unknown"
    }`;
  }

  return planner.selectedPlannerId ?? planner.requestedPlannerId ?? "Unknown";
};

export const getEvidenceSummaryDetails = (summary, sourceCount) => {
  const hasSummary = isPlainObject(summary);
  const docCoverage =
    hasSummary && isPlainObject(summary.docCoverage) ? summary.docCoverage : {};
  const scoreRange =
    hasSummary && isPlainObject(summary.scoreRange) ? summary.scoreRange : {};
  const requirements = hasSummary ? normalizeArray(summary.requirements) : [];
  const reasons = hasSummary ? normalizeArray(summary.reasons) : [];
  const hasSourceCount = Number.isFinite(sourceCount);
  const hasSourceEvidence = hasSourceCount && sourceCount > 0;

  return {
    confident: hasSummary ? Boolean(summary.confident) : hasSourceEvidence,
    hasEvidence: hasSummary || hasSourceEvidence,
    metrics: [
      {
        label: "Retrieved",
        value: hasSummary ? formatDetailValue(summary.retrievedCount) : "N/A",
      },
      {
        label: "Usable",
        value: hasSummary ? formatDetailValue(summary.usableCount) : "N/A",
      },
      {
        label: "Docs",
        value: formatBudgetCounter(
          docCoverage.coveredDocIds?.length,
          docCoverage.selectedDocIds?.length
        ),
      },
      {
        label: "Citations",
        value: hasSourceCount ? formatDetailValue(sourceCount) : null,
      },
      {
        label: "Max score",
        value: hasSummary ? formatEvidenceScore(scoreRange.max) : null,
      },
    ].filter(({ value }) => value !== null && value !== undefined),
    reasons,
    requirements,
    statusLabel: hasSummary
      ? summary.confident
        ? "Confident"
        : "Limited"
      : "Source-linked",
  };
};

const buildSkillItems = (skills = []) =>
  skills.map((skill, index) => ({
    id: skill.skillId ?? skill.id ?? `skill-${index}`,
    title: formatSkillRef(skill),
    copy: formatSkillMetricCopy(skill),
    meta: skill.status ? skill.status.replace(/_/g, " ") : null,
  }));

const buildQueryItems = (queries = []) =>
  queries.map((query, index) => ({
    id: query.queryId ?? query.id ?? `query-${index}`,
    title: query.label ?? query.queryId ?? query.id ?? `Query ${index + 1}`,
    copy: [
      query.query,
      query.skillId
        ? `${query.skillId}${formatMaybeVersion(query.skillVersion)}`
        : null,
      query.phase ? `phase: ${String(query.phase).replace(/_/g, " ")}` : null,
      query.primary ? "primary" : null,
    ]
      .filter(Boolean)
      .join(" · "),
    meta: query.phase ? String(query.phase).replace(/_/g, " ") : null,
  }));

const buildGapItems = (gaps = []) =>
  gaps.map((gap, index) => ({
    id: gap.id ?? `${gap.type ?? "gap"}-${index}`,
    title: getGapTitle(gap, index),
    copy: getGapCopy(gap),
    meta: formatGapType(gap),
  }));

const buildUnsupportedClaimItems = (claims = []) =>
  claims.map((claim, index) => ({
    id: claim.id ?? `unsupported-${index}`,
    title: claim.text ?? `Claim ${index + 1}`,
    copy:
      Array.isArray(claim.missingAnchors) && claim.missingAnchors.length > 0
        ? `Missing anchors: ${claim.missingAnchors.join(", ")}`
        : null,
    meta: "unsupported",
  }));

const buildRemovedClaimItems = (claims = []) =>
  claims.map((claim, index) => ({
    id: `removed-${index}`,
    title: String(claim ?? `Claim ${index + 1}`),
    copy: null,
    meta: "removed",
  }));

const buildEvidenceQualityItems = (details) => [
  ...details.reasons.map((reason, index) => ({
    id: `reason-${index}`,
    title: reason,
    meta: "reason",
  })),
  ...details.requirements.map((requirement, index) => ({
    id: requirement.id ?? `requirement-${index}`,
    title: requirement.label ?? requirement.query ?? `Requirement ${index + 1}`,
    copy: requirement.query,
    meta: "requirement",
  })),
];

export const buildEvidenceSpineModel = ({
  answer = {},
  evidenceSummary,
  sourceCount,
  stepCount,
} = {}) => {
  const {
    allGaps,
    checkedQueries,
    executionPlanner,
    loop,
    removedClaims,
    resolvedGaps,
    selectedSkills,
    skillChain,
    unsupportedClaims,
  } = getAnswerTraceOverview(answer);
  const hasPlanner = Boolean(executionPlanner.status);
  const evidenceDetails = getEvidenceSummaryDetails(evidenceSummary, sourceCount);

  const stages = [
    {
      id: "selection",
      label: "Selected skills",
      status: selectedSkills.length > 0 ? "complete" : "muted",
      meta: hasPlanner ? formatPlannerLabel(executionPlanner) : "Planner not recorded",
      groups: [
        {
          label: "Selected skills",
          items: buildSkillItems(selectedSkills),
        },
        {
          label: "Skill chain",
          items: buildSkillItems(skillChain),
        },
      ],
    },
    {
      id: "retrieval",
      label: "Retrieval queries",
      status: checkedQueries.length > 0 ? "complete" : "muted",
      meta: `${checkedQueries.length} checked`,
      groups: [
        {
          label: "Retrieval queries",
          items: buildQueryItems(checkedQueries),
        },
      ],
    },
    {
      id: "quality",
      label: "Evidence",
      status: evidenceDetails.confident ? "complete" : "warning",
      meta: evidenceDetails.statusLabel,
      groups: [
        {
          label: "Evidence requirements",
          items: buildEvidenceQualityItems(evidenceDetails),
        },
      ],
      hasEvidenceSummary: evidenceDetails.hasEvidence,
    },
    {
      id: "gaps",
      label: "Evidence gaps",
      status: allGaps.length > 0 ? "warning" : resolvedGaps.length > 0 ? "complete" : "muted",
      meta:
        allGaps.length > 0
          ? `${allGaps.length} open`
          : `${resolvedGaps.length} resolved`,
      groups: [
        {
          label: "Evidence gaps",
          items: buildGapItems(allGaps),
        },
        {
          label: "Resolved gaps",
          items: buildGapItems(resolvedGaps),
        },
      ],
    },
    {
      id: "review",
      label: "Answer review",
      status:
        unsupportedClaims.length > 0 || removedClaims.length > 0
          ? "warning"
          : "complete",
      meta:
        removedClaims.length > 0
          ? `${removedClaims.length} removed`
          : "No removals",
      groups: [
        {
          label: "Unsupported claims",
          items: buildUnsupportedClaimItems(unsupportedClaims),
        },
        {
          label: "Finalizer removed claims",
          items: buildRemovedClaimItems(removedClaims),
        },
      ],
    },
  ].filter(
    (stage) =>
      stage.hasEvidenceSummary ||
      stage.groups.some((group) => group.items.length > 0) ||
      (stage.id === "selection" && hasPlanner)
  );

  return {
    hasContent:
      stages.length > 0 ||
      hasPlanner ||
      Number.isFinite(loop.followUpsRun) ||
      Number.isFinite(stepCount),
    metrics: [
      {
        label: "Steps",
        value: formatDetailValue(stepCount),
      },
      {
        label: "Planner",
        value: hasPlanner ? formatPlannerLabel(executionPlanner) : null,
        title: executionPlanner.fallbackReason ?? undefined,
      },
      {
        label: "Queries",
        value: formatDetailValue(checkedQueries.length),
      },
      {
        label: "Follow-ups",
        value: formatDetailValue(loop.followUpsRun),
      },
      {
        label: "Open gaps",
        value: formatDetailValue(allGaps.length),
      },
      {
        label: "Removed",
        value: formatDetailValue(removedClaims.length),
      },
    ].filter(({ value }) => value !== null && value !== undefined),
    stages,
    selectedSkillCount: selectedSkills.length,
  };
};

const formatSourceScore = (value) => {
  const score = Number(value);

  return Number.isFinite(score) ? score.toFixed(2) : null;
};

export const buildSourceEvidenceObject = (source = {}) => {
  const previewMeta = isPlainObject(source.demoPreview) ? source.demoPreview : {};
  const fileName = source.fileName ?? "Untitled source";
  const fileType =
    previewMeta.type ?? fileName.split(".").pop()?.toUpperCase() ?? "DOC";
  const pageNumber = source.pageNumber ?? source.page ?? source.loc?.pageNumber ?? 1;
  const chunkIndex = source.chunkIndex ?? source.metadata?.chunkIndex ?? null;
  const excerpt =
    source.excerpt ?? source.text ?? source.pageContent ?? previewMeta.description ?? "";
  const sourceScore = formatSourceScore(source.score ?? source.metadata?.score);
  const citations = normalizeArray(source.citations);
  const chunks = normalizeArray(source.chunks);
  const relatedCitations =
    citations.length > 0 ? citations : excerpt || fileName ? [source] : [];
  const relatedChunks =
    chunks.length > 0
      ? chunks
      : [
          {
            id: `${source.docId ?? fileName}:${chunkIndex ?? "selected"}`,
            label: Number.isFinite(chunkIndex) ? `Chunk ${chunkIndex}` : "Selected chunk",
            excerpt,
            pageNumber,
            score: sourceScore,
          },
        ].filter((chunk) => chunk.excerpt);
  const metadataRows = [
    { label: "Document", value: fileName },
    { label: "Page", value: pageNumber ? `Page ${pageNumber}` : null },
    {
      label: "Chunk",
      value: chunkIndex !== null && chunkIndex !== undefined ? String(chunkIndex) : null,
    },
    {
      label: "Rank",
      value: hasNumber(source.rank) ? `#${Number(source.rank)}` : null,
    },
    { label: "Score", value: sourceScore },
    { label: "Doc ID", value: source.docId },
    { label: "Type", value: fileType },
  ].filter(({ value }) => value !== null && value !== undefined && value !== "");

  return {
    chunkIndex,
    citations: relatedCitations,
    excerpt,
    fileName,
    filePath: source.filePath ?? "",
    fileType,
    isDemoPreview: Boolean(source.demoPreview || !source.filePath),
    metadataRows,
    pageNumber,
    pageRange: previewMeta.pageRange ?? (pageNumber ? String(pageNumber) : "1"),
    previewDescription:
      previewMeta.description || excerpt || "Selected evidence from the answer source.",
    previewTags: normalizeArray(previewMeta.tags),
    rank: source.rank,
    score: sourceScore,
    source,
    title: `${fileName}${pageNumber ? ` · Page ${pageNumber}` : ""}`,
    chunks: relatedChunks,
  };
};
