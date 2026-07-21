export const RISK_REVIEW_SKILL_ID = "risk_review";

export const RISK_REVIEW_SIGNAL_PATTERN =
  /\b(risk review|review risks?|risk analysis|gaps?|exceptions?|conflicts?|contradictions?|uncertaint(?:y|ies)|red flags?|missing terms?)\b|风险审查|风险|缺口|例外|冲突|矛盾|不确定|遗漏/i;

const CUSTOM_SKILL_VERSION = "1.0.0";

const normalizeText = (value) => String(value ?? "").trim();

const getSelectedDocuments = ({ ragService, docIds = [], accessScope }) => {
  const selectedDocIds = new Set(docIds);
  const documents = ragService.listDocuments?.(accessScope) ?? [];

  return documents.filter((document) => selectedDocIds.has(document.docId));
};

const buildRiskQuestion = ({ question, documents = [] }) => {
  const documentList = documents
    .map((document) => `- ${document.fileName ?? document.docId}`)
    .join("\n");

  return [
    "Perform a concise citation-backed risk review from the selected documents.",
    "Identify risks, gaps, contradictions, exceptions, missing terms, and uncertainty. Use only document evidence.",
    "Do not guess. If a risk, gap, or exception is not supported by the selected documents, say it is not specified.",
    "Return concise bullets grouped as Risks, Gaps, Conflicts Or Exceptions, and Evidence Limits. Put source citations on every evidence-backed bullet.",
    documentList ? `Selected documents:\n${documentList}` : "",
    `Original request: ${normalizeText(question)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

export const createRiskReviewSkill = () => ({
  id: RISK_REVIEW_SKILL_ID,
  version: CUSTOM_SKILL_VERSION,
  label: "Risk Review",
  kind: "custom",
  budgetKey: "customSkillCalls",
  requiresAccessScope: true,
  match: ({ plan }) => Boolean(plan.wantsRiskReview),
  plannerActions: ({ docIds }) => [
    {
      id: "risk_review",
      label: "Review risks",
      summary: `Review risks, gaps, and exceptions across ${docIds.length} selected document${
        docIds.length === 1 ? "" : "s"
      }.`,
    },
  ],
  execute: async ({ ragService, question, docIds, accessScope, retrievalPlan }) => {
    const selectedDocuments = getSelectedDocuments({
      ragService,
      docIds,
      accessScope,
    });
    const riskQuestion = buildRiskQuestion({
      question,
      documents: selectedDocuments,
    });
    const value = await ragService.chat(docIds, riskQuestion, {
      sessionId: null,
      userId: null,
      includeRetrievedContexts: true,
      accessScope,
      retrievalPlan,
    });

    return {
      value: {
        ...value,
        riskQuestion,
        selectedDocumentCount: selectedDocuments.length,
      },
      text: value.text,
      citations: value.citations ?? [],
      abstained: Boolean(value.abstained),
      traceDetail: {
        selectedDocumentCount: selectedDocuments.length,
        citations: value.citations?.length ?? 0,
        abstained: Boolean(value.abstained),
        riskQuestion,
        retrievalPlan,
      },
    };
  },
});
