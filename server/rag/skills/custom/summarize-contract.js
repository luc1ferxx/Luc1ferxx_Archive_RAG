export const SUMMARIZE_CONTRACT_SKILL_ID = "summarize_contract";

export const CONTRACT_SUMMARY_SIGNAL_PATTERN =
  /\b(summarize|summary|summarise|contract summary|agreement summary|key terms?|parties|obligations?|deadlines?|effective date|renewal|termination)\b.*\b(contract|agreement|policy|terms|msa|sow|nda)\b|\b(contract|agreement|msa|sow|nda)\b.*\b(summarize|summary|summarise|key terms?|parties|obligations?|deadlines?|renewal|termination)\b|合同摘要|协议摘要|合同总结|关键条款|合同义务|协议义务|合同期限|续约|终止/i;

const CUSTOM_SKILL_VERSION = "1.0.0";

const normalizeText = (value) => String(value ?? "").trim();

const getSelectedDocuments = ({ ragService, docIds = [], accessScope }) => {
  const selectedDocIds = new Set(docIds);
  const documents = ragService.listDocuments?.(accessScope) ?? [];

  return documents.filter((document) => selectedDocIds.has(document.docId));
};

const buildSummaryQuestion = ({ question, documents = [] }) => {
  const documentList = documents
    .map((document) => `- ${document.fileName ?? document.docId}`)
    .join("\n");

  return [
    "Create a concise citation-backed contract summary from the selected documents.",
    "Use only document evidence. Do not infer missing terms.",
    "Cover Parties, Key Terms, Obligations, Deadlines, Risks, and Unknowns when supported by citations.",
    "Every evidence-backed bullet must include source citations. If a section is not specified, say it is not specified.",
    documentList ? `Selected documents:\n${documentList}` : "",
    `Original request: ${normalizeText(question)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

export const createSummarizeContractSkill = () => ({
  id: SUMMARIZE_CONTRACT_SKILL_ID,
  version: CUSTOM_SKILL_VERSION,
  label: "Summarize Contract",
  kind: "custom",
  budgetKey: "customSkillCalls",
  requiresAccessScope: true,
  match: ({ plan }) => Boolean(plan.wantsContractSummary),
  plannerActions: ({ docIds }) => [
    {
      id: "summarize_contract",
      label: "Summarize contract",
      summary: `Summarize key contract terms across ${docIds.length} selected document${
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
    const summaryQuestion = buildSummaryQuestion({
      question,
      documents: selectedDocuments,
    });
    const value = await ragService.chat(docIds, summaryQuestion, {
      sessionId: null,
      userId: null,
      accessScope,
      retrievalPlan,
    });

    return {
      value: {
        ...value,
        summaryQuestion,
        selectedDocumentCount: selectedDocuments.length,
      },
      text: value.text,
      citations: value.citations ?? [],
      abstained: Boolean(value.abstained),
      traceDetail: {
        selectedDocumentCount: selectedDocuments.length,
        citations: value.citations?.length ?? 0,
        abstained: Boolean(value.abstained),
        summaryQuestion,
        retrievalPlan,
      },
    };
  },
});
