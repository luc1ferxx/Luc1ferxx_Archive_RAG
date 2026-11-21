import { createTranslator } from "../archiveI18n";
import { getAnswerTraceOverview } from "../chatResponseContract";
import {
  formatDocumentLocation,
  getDocumentFormat,
  getLocationUnit,
  hasInlineDocumentPreview,
} from "../documentLocation";
import {
  formatBudgetCounter,
  formatDetailValue,
  formatGapType,
  formatMissingAnchors,
  formatQueryCopy,
  formatSkillMetricCopy,
  formatSkillRef,
  formatTracePhase,
  getGapCopy,
  getGapTitle,
  isPlainObject,
} from "./AgentTraceDetail";
import { formatStatusLabel } from "./workbenchFormatters";

// English unless the caller hands in its translator (the preview does).
const defaultT = createTranslator("en");

const normalizeArray = (value) => (Array.isArray(value) ? value : []);

const hasNumber = (value) => Number.isFinite(Number(value));

const formatEvidenceScore = (value, t) =>
  typeof value === "number" ? value.toFixed(2) : t("common.notAvailable");

export const formatPlannerLabel = (planner = {}, t) => {
  if (planner.status === "not_run") {
    return t("trace.plannerNotRun");
  }

  if (planner.fallback) {
    return `${planner.requestedPlannerId ?? t("status.unknown")} -> ${
      planner.selectedPlannerId ?? t("status.unknown")
    }`;
  }

  return planner.selectedPlannerId ?? planner.requestedPlannerId ?? t("status.unknown");
};

export const getEvidenceSummaryDetails = (summary, sourceCount, t) => {
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
        label: t("trace.retrieved"),
        value: hasSummary
          ? formatDetailValue(summary.retrievedCount, t)
          : t("common.notAvailable"),
      },
      {
        label: t("trace.usable"),
        value: hasSummary
          ? formatDetailValue(summary.usableCount, t)
          : t("common.notAvailable"),
      },
      {
        label: t("trace.docs"),
        value: formatBudgetCounter(
          docCoverage.coveredDocIds?.length,
          docCoverage.selectedDocIds?.length
        ),
      },
      {
        label: t("common.citations"),
        value: hasSourceCount ? formatDetailValue(sourceCount, t) : null,
      },
      {
        label: t("trace.maxScore"),
        value: hasSummary ? formatEvidenceScore(scoreRange.max, t) : null,
      },
    ].filter(({ value }) => value !== null && value !== undefined),
    reasons,
    requirements,
    statusLabel: t(
      hasSummary
        ? summary.confident
          ? "trace.confident"
          : "trace.limited"
        : "trace.sourceLinked"
    ),
  };
};

const buildSkillItems = (skills = [], t) =>
  skills.map((skill, index) => ({
    id: skill.skillId ?? skill.id ?? `skill-${index}`,
    title: formatSkillRef(skill, t),
    copy: formatSkillMetricCopy(skill, t),
    meta: skill.status ? formatStatusLabel(skill.status, t) : null,
  }));

const buildQueryItems = (queries = [], t) =>
  queries.map((query, index) => ({
    id: query.queryId ?? query.id ?? `query-${index}`,
    title:
      query.label ?? query.queryId ?? query.id ?? t("trace.query", { number: index + 1 }),
    copy: formatQueryCopy(query, t),
    meta: formatTracePhase(query.phase, t),
  }));

const buildGapItems = (gaps = [], t) =>
  gaps.map((gap, index) => ({
    id: gap.id ?? `${gap.type ?? "gap"}-${index}`,
    title: getGapTitle(gap, index, t),
    copy: getGapCopy(gap, t),
    meta: formatGapType(gap, t),
  }));

const buildUnsupportedClaimItems = (claims = [], t) =>
  claims.map((claim, index) => ({
    id: claim.id ?? `unsupported-${index}`,
    title: claim.text ?? t("trace.claim", { number: index + 1 }),
    copy: formatMissingAnchors(claim.missingAnchors, t),
    meta: t("trace.tagUnsupported"),
  }));

const buildRemovedClaimItems = (claims = [], t) =>
  claims.map((claim, index) => ({
    id: `removed-${index}`,
    title: String(claim ?? t("trace.claim", { number: index + 1 })),
    copy: null,
    meta: t("trace.tagRemoved"),
  }));

const buildEvidenceQualityItems = (details, t) => [
  ...details.reasons.map((reason, index) => ({
    id: `reason-${index}`,
    title: reason,
    meta: t("trace.tagReason"),
  })),
  ...details.requirements.map((requirement, index) => ({
    id: requirement.id ?? `requirement-${index}`,
    title:
      requirement.label ??
      requirement.query ??
      t("trace.requirement", { number: index + 1 }),
    copy: requirement.query,
    meta: t("trace.tagRequirement"),
  })),
];

export const buildEvidenceSpineModel = ({
  answer = {},
  evidenceSummary,
  sourceCount,
  stepCount,
  t,
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
  const evidenceDetails = getEvidenceSummaryDetails(evidenceSummary, sourceCount, t);

  const stages = [
    {
      id: "selection",
      label: t("trace.selectedSkills"),
      status: selectedSkills.length > 0 ? "complete" : "muted",
      meta: hasPlanner
        ? formatPlannerLabel(executionPlanner, t)
        : t("trace.plannerNotRecorded"),
      groups: [
        {
          label: t("trace.selectedSkills"),
          items: buildSkillItems(selectedSkills, t),
        },
        {
          label: t("trace.skillChain"),
          items: buildSkillItems(skillChain, t),
        },
      ],
    },
    {
      id: "retrieval",
      label: t("trace.retrievalQueries"),
      status: checkedQueries.length > 0 ? "complete" : "muted",
      meta: t("trace.checkedCount", { count: checkedQueries.length }),
      groups: [
        {
          label: t("trace.retrievalQueries"),
          items: buildQueryItems(checkedQueries, t),
        },
      ],
    },
    {
      id: "quality",
      label: t("trace.evidence"),
      status: evidenceDetails.confident ? "complete" : "warning",
      meta: evidenceDetails.statusLabel,
      groups: [
        {
          label: t("trace.evidenceRequirements"),
          items: buildEvidenceQualityItems(evidenceDetails, t),
        },
      ],
      hasEvidenceSummary: evidenceDetails.hasEvidence,
    },
    {
      id: "gaps",
      label: t("trace.evidenceGaps"),
      status: allGaps.length > 0 ? "warning" : resolvedGaps.length > 0 ? "complete" : "muted",
      meta:
        allGaps.length > 0
          ? t("trace.openCount", { count: allGaps.length })
          : t("trace.resolvedCount", { count: resolvedGaps.length }),
      groups: [
        {
          label: t("trace.evidenceGaps"),
          items: buildGapItems(allGaps, t),
        },
        {
          label: t("trace.resolvedGaps"),
          items: buildGapItems(resolvedGaps, t),
        },
      ],
    },
    {
      id: "review",
      label: t("trace.answerReview"),
      status:
        unsupportedClaims.length > 0 || removedClaims.length > 0
          ? "warning"
          : "complete",
      meta:
        removedClaims.length > 0
          ? t("trace.removedCount", { count: removedClaims.length })
          : t("trace.noRemovals"),
      groups: [
        {
          label: t("trace.unsupportedClaims"),
          items: buildUnsupportedClaimItems(unsupportedClaims, t),
        },
        {
          label: t("trace.removedClaims"),
          items: buildRemovedClaimItems(removedClaims, t),
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
        label: t("common.steps"),
        value: formatDetailValue(stepCount, t),
      },
      {
        label: t("trace.planner"),
        value: hasPlanner ? formatPlannerLabel(executionPlanner, t) : null,
        title: executionPlanner.fallbackReason ?? undefined,
      },
      {
        label: t("trace.queries"),
        value: formatDetailValue(checkedQueries.length, t),
      },
      {
        label: t("trace.followUps"),
        value: formatDetailValue(loop.followUpsRun, t),
      },
      {
        label: t("trace.openGaps"),
        value: formatDetailValue(allGaps.length, t),
      },
      {
        label: t("trace.removed"),
        value: formatDetailValue(removedClaims.length, t),
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

// The Office formats' own type label (DOCX, PPTX, XLSX) when the stored MIME
// type reached the preview; a PDF and an unknown type keep today's label from
// the file name's extension.
const getOfficeFileType = (source) => {
  const format = getDocumentFormat(source.mimeType);

  return format && format.id !== "pdf" ? format.label : null;
};

/**
 * The evidence object the preview renders for one source. `t` localizes its
 * labels and the location ("Page 4", "Slide 3 · Revenue"); without it they are
 * English, as they always were. Only a page the PDF viewer can open defaults
 * to page 1, as before: a slide, sheet or section, or a file the browser
 * cannot show, keeps whatever number the citation gave it, or none.
 */
export const buildSourceEvidenceObject = (source = {}, { t = defaultT } = {}) => {
  const fileName = source.fileName ?? t("preview.untitledSource");
  const fileType =
    getOfficeFileType(source) ??
    fileName.split(".").pop()?.toUpperCase() ??
    "DOC";
  const locationUnit = getLocationUnit(source);
  const hasInlinePreview = hasInlineDocumentPreview(source);
  const sourcePageNumber = source.pageNumber ?? source.page ?? source.loc?.pageNumber;
  const pageNumber = hasInlinePreview ? sourcePageNumber ?? 1 : sourcePageNumber ?? null;
  const locationText = formatDocumentLocation({ ...source, pageNumber }, t);
  const chunkIndex = source.chunkIndex ?? source.metadata?.chunkIndex ?? null;
  const excerpt = source.excerpt ?? source.text ?? source.pageContent ?? "";
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
            label: Number.isFinite(chunkIndex)
              ? t("common.chunkNumber", { number: chunkIndex })
              : t("preview.selectedChunk"),
            excerpt,
            pageNumber,
            score: sourceScore,
          },
        ].filter((chunk) => chunk.excerpt);
  const metadataRows = [
    { label: t("preview.document"), value: fileName },
    locationUnit
      ? { label: t("preview.location"), value: locationText || null }
      : { label: t("preview.page"), value: pageNumber ? locationText : null },
    {
      label: t("preview.chunk"),
      value: chunkIndex !== null && chunkIndex !== undefined ? String(chunkIndex) : null,
    },
    {
      label: t("preview.rank"),
      value: hasNumber(source.rank) ? `#${Number(source.rank)}` : null,
    },
    { label: t("preview.score"), value: sourceScore },
    { label: t("preview.docId"), value: source.docId },
    { label: t("preview.type"), value: fileType },
  ].filter(({ value }) => value !== null && value !== undefined && value !== "");

  return {
    chunkIndex,
    citations: relatedCitations,
    excerpt,
    fileName,
    filePath: source.filePath ?? "",
    fileType,
    hasInlinePreview,
    locationText,
    locationUnit,
    metadataRows,
    pageNumber,
    pageRange: pageNumber ? String(pageNumber) : hasInlinePreview ? "1" : null,
    previewDescription: excerpt || t("preview.selectedEvidence"),
    rank: source.rank,
    score: sourceScore,
    source,
    title: `${fileName}${locationText ? ` · ${locationText}` : ""}`,
    chunks: relatedChunks,
  };
};
