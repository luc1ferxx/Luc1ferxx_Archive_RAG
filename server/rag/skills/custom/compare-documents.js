import { normalizeTrimmedText as normalizeText } from "../../../lib/normalize-text.js";
import {
  CUSTOM_RAG_SKILL_CONTRACT,
  buildPriorFindingsSection,
} from "./custom-skill-contract.js";

export const COMPARE_DOCUMENTS_SKILL_ID = "compare_documents";

export const COMPARE_DOCUMENTS_SIGNAL_PATTERN =
  /\b(compare|comparison|differences?|different|versus|vs|same|similar|contrast|common ground|missing terms?|across|between)\b|对比|比较|差异|不同|相同|一致|共同点|缺失条款|遗漏条款|之间/i;

const CUSTOM_SKILL_VERSION = "1.0.0";

const getSelectedDocuments = ({ ragService, docIds = [], accessScope }) => {
  const selectedDocIds = new Set(docIds);
  const documents = ragService.listDocuments?.(accessScope) ?? [];

  return documents.filter((document) => selectedDocIds.has(document.docId));
};

const buildCompareQuestion = ({ question, documents = [], priorFindings }) => {
  const documentList = documents
    .map((document) => `- ${document.fileName ?? document.docId}`)
    .join("\n");

  return [
    "Create a concise citation-backed document comparison across the selected documents.",
    "Use only document evidence. Do not infer common ground, differences, conflicts, or missing terms.",
    "Organize the answer as Document Comparison, Common Ground, Differences, Conflicts, Missing Terms, and Evidence Limits.",
    "Every evidence-backed bullet must include source citations from the relevant documents. If a category is not supported, say it is not specified.",
    documentList ? `Selected documents:\n${documentList}` : "",
    buildPriorFindingsSection(priorFindings),
    `Original request: ${normalizeText(question)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

export const createCompareDocumentsSkill = () => ({
  id: COMPARE_DOCUMENTS_SKILL_ID,
  version: CUSTOM_SKILL_VERSION,
  label: "Compare Documents",
  kind: "custom",
  budgetKey: "customSkillCalls",
  requiresAccessScope: true,
  ...CUSTOM_RAG_SKILL_CONTRACT,
  plannerSummary:
    "Compares the selected documents and reports common ground, differences, conflicts, and missing terms with per-document citations.",
  match: ({ plan }) => Boolean(plan.wantsCompareDocuments),
  plannerActions: ({ docIds }) => [
    {
      id: "compare_documents",
      label: "Compare documents",
      summary: `Compare common ground, differences, conflicts, and missing terms across ${docIds.length} selected document${
        docIds.length === 1 ? "" : "s"
      }.`,
    },
  ],
  execute: async ({
    ragService,
    question,
    docIds,
    accessScope,
    retrievalPlan,
    priorFindings,
  }) => {
    const selectedDocuments = getSelectedDocuments({
      ragService,
      docIds,
      accessScope,
    });
    const compareQuestion = buildCompareQuestion({
      question,
      documents: selectedDocuments,
      priorFindings,
    });
    const value = await ragService.chat(docIds, compareQuestion, {
      sessionId: null,
      userId: null,
      // A composed Skill prompt, not the user's message: never memory.
      memoryWrites: false,
      includeRetrievedContexts: true,
      accessScope,
      retrievalPlan,
    });

    return {
      value: {
        ...value,
        compareQuestion,
        selectedDocumentCount: selectedDocuments.length,
      },
      text: value.text,
      citations: value.citations ?? [],
      abstained: Boolean(value.abstained),
      traceDetail: {
        selectedDocumentCount: selectedDocuments.length,
        citations: value.citations?.length ?? 0,
        abstained: Boolean(value.abstained),
        compareQuestion,
        retrievalPlan,
        usedPriorFindings: Boolean(normalizeText(priorFindings)),
      },
    };
  },
});
