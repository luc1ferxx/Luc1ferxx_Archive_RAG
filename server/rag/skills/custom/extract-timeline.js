export const EXTRACT_TIMELINE_SKILL_ID = "extract_timeline";

export const TIMELINE_SIGNAL_PATTERN =
  /\b(timeline|chronology|chronological|sequence|milestones?|key dates?|event order|date order)\b|时间线|时间顺序|按时间|大事记|里程碑|事件顺序|关键日期/i;

const CUSTOM_SKILL_VERSION = "1.0.0";

const normalizeText = (value) => String(value ?? "").trim();

const getSelectedDocuments = ({ ragService, docIds = [], accessScope }) => {
  const selectedDocIds = new Set(docIds);
  const documents = ragService.listDocuments?.(accessScope) ?? [];

  return documents.filter((document) => selectedDocIds.has(document.docId));
};

const buildTimelineQuestion = ({ question, documents = [] }) => {
  const documentList = documents
    .map((document) => `- ${document.fileName ?? document.docId}`)
    .join("\n");

  return [
    "Extract a concise chronological timeline from the selected documents.",
    "Use only cited document evidence. Preserve dates, deadlines, effective periods, milestones, and event ordering.",
    "If the documents do not support a date or sequence, say it is not specified instead of guessing.",
    "Return bullet points ordered earliest to latest, and include source citations on each supported bullet.",
    documentList ? `Selected documents:\n${documentList}` : "",
    `Original request: ${normalizeText(question)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

export const createExtractTimelineSkill = () => ({
  id: EXTRACT_TIMELINE_SKILL_ID,
  version: CUSTOM_SKILL_VERSION,
  label: "Extract Timeline",
  kind: "custom",
  budgetKey: "customSkillCalls",
  requiresAccessScope: true,
  match: ({ plan }) => Boolean(plan.wantsTimeline),
  plannerActions: ({ docIds }) => [
    {
      id: "extract_timeline",
      label: "Extract timeline",
      summary: `Build a cited chronology from ${docIds.length} selected document${
        docIds.length === 1 ? "" : "s"
      }.`,
    },
  ],
  execute: async ({ ragService, question, docIds, accessScope }) => {
    const selectedDocuments = getSelectedDocuments({
      ragService,
      docIds,
      accessScope,
    });
    const timelineQuestion = buildTimelineQuestion({
      question,
      documents: selectedDocuments,
    });
    const value = await ragService.chat(docIds, timelineQuestion, {
      sessionId: null,
      userId: null,
      accessScope,
    });

    return {
      value: {
        ...value,
        timelineQuestion,
        selectedDocumentCount: selectedDocuments.length,
      },
      text: value.text,
      citations: value.citations ?? [],
      abstained: Boolean(value.abstained),
      traceDetail: {
        selectedDocumentCount: selectedDocuments.length,
        citations: value.citations?.length ?? 0,
        abstained: Boolean(value.abstained),
        timelineQuestion,
      },
    };
  },
});
