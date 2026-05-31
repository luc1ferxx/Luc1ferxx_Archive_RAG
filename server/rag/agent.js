import { extractMeaningfulTokens, normalizeSearchText } from "./text-utils.js";
import {
  buildResearchPlan,
  formatResearchBrief,
} from "./research-brief.js";

const WEB_SIGNAL_PATTERN =
  /\b(latest|current|currently|today|now|recent|news|live|online|internet|web|search the web|real[-\s]?time)\b|最新|当前|现在|今天|近日|实时|联网|网页|网络|新闻/i;

const INVENTORY_SIGNAL_PATTERN =
  /\b(what documents|which documents|list documents|show documents|workspace documents|uploaded documents|what files|which files|list files)\b|有哪些(?:文档|资料|文件)|列出.*(?:文档|资料|文件)|当前.*(?:文档|资料|文件)|上传.*(?:文档|资料|文件)/i;

const DISCOVERY_SIGNAL_PATTERN =
  /\b(which document|which file|what document|what file|find document|find file|document covers|file covers|covers .*document|about)\b|哪份(?:文档|资料|文件)|哪个(?:文档|资料|文件)|(?:文档|资料|文件).*?(讲|包含|关于|提到)/i;

const RESEARCH_SIGNAL_PATTERN =
  /\b(research|brief|report|analy[sz]e|analysis|investigate|study|risk|risks|key findings|executive summary)\b|研究|简报|报告|分析|调研|风险|结论|发现|梳理/i;

const serializeError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error.message;
  }

  return fallbackMessage;
};

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

const normalizeText = (value) => (hasText(value) ? value.trim() : "");

const buildStep = ({ index, type, label, status = "completed", summary, detail }) => ({
  id: `${index}-${type}`,
  type,
  label,
  status,
  summary,
  detail: detail ?? null,
});

const getDocumentLabel = (document) => {
  const pageCount = Number.parseInt(document?.pageCount ?? "0", 10);
  const chunkCount = Number.parseInt(document?.chunkCount ?? "0", 10);
  const stats = [
    Number.isFinite(pageCount) && pageCount > 0 ? `${pageCount} pages` : null,
    Number.isFinite(chunkCount) && chunkCount > 0 ? `${chunkCount} chunks` : null,
  ].filter(Boolean);

  return `${document.fileName ?? "Untitled document"}${
    stats.length > 0 ? ` (${stats.join(", ")})` : ""
  }`;
};

const buildInventoryAnswer = (documents) => {
  if (!documents.length) {
    return "No documents are currently indexed in this workspace.";
  }

  return [
    `The workspace currently has ${documents.length} indexed document${
      documents.length === 1 ? "" : "s"
    }:`,
    ...documents.map((document, index) => `${index + 1}. ${getDocumentLabel(document)}`),
  ].join("\n");
};

const getProfile = (document = {}) =>
  document.profile && typeof document.profile === "object"
    ? document.profile
    : {
        summary: document.summary ?? "",
        tags: document.tags ?? [],
        entities: document.entities ?? [],
      };

const getProfileSearchText = (document = {}) => {
  const profile = getProfile(document);

  return [
    document.fileName,
    profile.summary,
    ...(profile.tags ?? []),
    ...(profile.entities ?? []),
  ]
    .filter(Boolean)
    .join(" ");
};

const scoreDocumentForQuery = ({ document, queryTerms }) => {
  const normalizedProfileText = normalizeSearchText(getProfileSearchText(document));
  let score = 0;

  for (const term of queryTerms) {
    if (normalizedProfileText.includes(term)) {
      score += 1;
    }
  }

  return score;
};

const discoverDocuments = ({ documents, question, docIds }) => {
  const docIdFilter = new Set(docIds);
  const candidateDocuments = docIdFilter.size > 0
    ? documents.filter((document) => docIdFilter.has(document.docId))
    : documents;
  const queryTerms = [...new Set(extractMeaningfulTokens(question))];

  return candidateDocuments
    .map((document) => ({
      document,
      score: scoreDocumentForQuery({
        document,
        queryTerms,
      }),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        String(left.document.fileName).localeCompare(String(right.document.fileName))
    )
    .slice(0, 5);
};

const buildDiscoveryAnswer = (matches) => {
  if (matches.length === 0) {
    return "I could not find a strong matching document from the current workspace metadata.";
  }

  return [
    `I found ${matches.length} likely matching document${
      matches.length === 1 ? "" : "s"
    }:`,
    ...matches.map(({ document }) => {
      const profile = getProfile(document);
      const tags = (profile.tags ?? []).slice(0, 4);
      const tagText = tags.length > 0 ? ` Tags: ${tags.join(", ")}.` : "";
      const summaryText = profile.summary ? ` ${profile.summary}` : "";

      return `- ${document.fileName}.${tagText}${summaryText}`;
    }),
  ].join("\n");
};

const buildPlan = ({ question, docIds }) => {
  const wantsResearch = RESEARCH_SIGNAL_PATTERN.test(question);
  const wantsInventory = INVENTORY_SIGNAL_PATTERN.test(question);
  const wantsDiscovery = DISCOVERY_SIGNAL_PATTERN.test(question);
  const wantsWeb = WEB_SIGNAL_PATTERN.test(question);
  const hasDocuments = docIds.length > 0;

  if (wantsResearch) {
    return {
      mode: "research_brief",
      wantsResearch: true,
      wantsInventory: false,
      wantsDiscovery: false,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: true,
      summary: "Create a structured research brief from selected documents.",
    };
  }

  if (wantsInventory && !hasDocuments) {
    return {
      mode: "inventory",
      wantsResearch: false,
      wantsInventory: true,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: false,
      summary: "List the indexed workspace documents.",
    };
  }

  if (wantsDiscovery && !hasDocuments) {
    return {
      mode: "document_discovery",
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: true,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: false,
      summary: "Search workspace document profiles for likely matching files.",
    };
  }

  if (!hasDocuments && wantsWeb) {
    return {
      mode: "web",
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: false,
      wantsDocumentRag: false,
      wantsWeb: true,
      requiresDocuments: false,
      summary: "Search the web because no document context is selected.",
    };
  }

  return {
    mode: wantsWeb ? "document_web" : "document",
    wantsResearch: false,
    wantsInventory,
    wantsDiscovery: false,
    wantsDocumentRag: true,
    wantsWeb,
    requiresDocuments: true,
    summary: wantsWeb
      ? "Use selected documents first, then web search for current context."
      : "Use selected documents and synthesize a grounded answer.",
  };
};

const buildSynthesisAnswer = ({
  plan,
  ragResult,
  webResult,
  inventoryAnswer,
  discoveryAnswer,
  researchBrief,
}) => {
  if (plan.mode === "research_brief") {
    return researchBrief?.text ?? "The research brief could not be generated.";
  }

  if (plan.mode === "inventory") {
    return inventoryAnswer;
  }

  if (plan.mode === "document_discovery") {
    return discoveryAnswer;
  }

  if (ragResult?.ok && webResult?.ok) {
    return [
      "Document evidence:",
      normalizeText(ragResult.value.text),
      "",
      "Web context:",
      normalizeText(webResult.value.text),
    ].join("\n");
  }

  if (ragResult?.ok) {
    return normalizeText(ragResult.value.text);
  }

  if (webResult?.ok) {
    return normalizeText(webResult.value.text);
  }

  return "The agent could not complete the request because all selected tools failed.";
};

const callDocumentRag = async ({ ragService, docIds, question, sessionId, userId }) => {
  try {
    const value = await ragService.chat(docIds, question, {
      sessionId,
      userId,
    });

    return {
      ok: true,
      value,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      value: null,
      error,
    };
  }
};

const callWebSearch = async ({ webChatService, question }) => {
  try {
    const value = await webChatService(question);

    return {
      ok: true,
      value,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      value: null,
      error,
    };
  }
};

const runResearchBrief = async ({ ragService, question, docIds }) => {
  const documents = ragService.listDocuments?.() ?? [];
  const selectedDocuments = documents.filter((document) => docIds.includes(document.docId));
  const plan = buildResearchPlan({
    question,
    documents: selectedDocuments,
  });
  const results = [];

  for (const entry of plan.questions) {
    try {
      const value = await ragService.chat(docIds, entry.question, {
        sessionId: null,
        userId: null,
      });

      results.push({
        id: entry.id,
        question: entry.question,
        status: "completed",
        text: value.text,
        citations: value.citations ?? [],
        abstained: Boolean(value.abstained),
        abstainReason: value.abstainReason ?? null,
        resolvedQuery: value.resolvedQuery ?? entry.question,
      });
    } catch (error) {
      results.push({
        id: entry.id,
        question: entry.question,
        status: "failed",
        text: "",
        citations: [],
        abstained: false,
        abstainReason: null,
        resolvedQuery: entry.question,
        error: serializeError(error, "Research lookup failed."),
      });
    }
  }

  return formatResearchBrief({
    question,
    documents: selectedDocuments,
    plan,
    results,
  });
};

export const runAgentRag = async ({
  ragService,
  webChatService,
  question,
  docIds,
  sessionId,
  userId,
}) => {
  const trace = [];
  const plan = buildPlan({
    question,
    docIds,
  });

  trace.push(
    buildStep({
      index: trace.length + 1,
      type: "plan",
      label: "Plan",
      summary: plan.summary,
      detail: {
        mode: plan.mode,
        docIds,
      },
    })
  );

  if (plan.requiresDocuments && docIds.length === 0) {
    const error = new Error(
      "At least one docId is required for document-grounded questions. Upload a PDF or ask what documents are indexed."
    );
    error.status = 400;
    throw error;
  }

  let inventoryAnswer = null;
  let discoveryAnswer = null;
  let researchBrief = null;
  let ragResult = null;
  let webResult = null;

  if (plan.wantsResearch) {
    const selectedDocuments = ragService
      .listDocuments?.()
      ?.filter((document) => docIds.includes(document.docId)) ?? [];
    const researchPlan = buildResearchPlan({
      question,
      documents: selectedDocuments,
    });

    trace.push(
      buildStep({
        index: trace.length + 1,
        type: "research_plan",
        label: "Research Plan",
        summary: `Planned ${researchPlan.questions.length} document-grounded research question${
          researchPlan.questions.length === 1 ? "" : "s"
        }.`,
        detail: {
          questions: researchPlan.questions,
        },
      })
    );

    researchBrief = await runResearchBrief({
      ragService,
      question,
      docIds,
    });

    for (const finding of researchBrief.findings) {
      trace.push(
        buildStep({
          index: trace.length + 1,
          type: "research_question",
          label: "Research Question",
          status: finding.status === "completed" ? "completed" : "failed",
          summary: finding.question,
          detail: {
            citations: finding.citations?.length ?? 0,
            abstained: Boolean(finding.abstained),
            error: finding.error ?? null,
          },
        })
      );
    }
  }

  if (plan.wantsInventory) {
    const documents = ragService.listDocuments?.() ?? [];
    inventoryAnswer = buildInventoryAnswer(documents);

    trace.push(
      buildStep({
        index: trace.length + 1,
        type: "inventory",
        label: "Workspace Inventory",
        summary:
          documents.length === 0
            ? "No indexed documents found."
            : `Found ${documents.length} indexed document${
                documents.length === 1 ? "" : "s"
              }.`,
      })
    );
  }

  if (plan.wantsDiscovery) {
    const documents = ragService.listDocuments?.() ?? [];
    const matches = discoverDocuments({
      documents,
      question,
      docIds,
    });
    discoveryAnswer = buildDiscoveryAnswer(matches);

    trace.push(
      buildStep({
        index: trace.length + 1,
        type: "document_discovery",
        label: "Document Discovery",
        summary:
          matches.length === 0
            ? "No strong metadata match found."
            : `Found ${matches.length} likely matching document${
                matches.length === 1 ? "" : "s"
              }.`,
      })
    );
  }

  if (plan.wantsDocumentRag) {
    ragResult = await callDocumentRag({
      ragService,
      docIds,
      question,
      sessionId,
      userId,
    });

    trace.push(
      buildStep({
        index: trace.length + 1,
        type: "document_rag",
        label: "Document RAG",
        status: ragResult.ok ? "completed" : "failed",
        summary: ragResult.ok
          ? ragResult.value.abstained
            ? "Document RAG ran but reported insufficient evidence."
            : `Document RAG returned ${
                ragResult.value.citations?.length ?? 0
              } citation${ragResult.value.citations?.length === 1 ? "" : "s"}.`
          : `Document RAG failed: ${serializeError(
              ragResult.error,
              "Unable to answer from the document."
            )}`,
      })
    );
  }

  const shouldRunWeb =
    plan.wantsWeb || (ragResult?.ok && ragResult.value.abstained) || ragResult?.ok === false;

  if (shouldRunWeb) {
    webResult = await callWebSearch({
      webChatService,
      question,
    });

    trace.push(
      buildStep({
        index: trace.length + 1,
        type: "web_search",
        label: "Web Search",
        status: webResult.ok ? "completed" : "failed",
        summary: webResult.ok
          ? "Web search returned supplemental context."
          : `Web search failed: ${serializeError(
              webResult.error,
              "Unable to answer from web search."
            )}`,
      })
    );
  }

  const agentAnswer = buildSynthesisAnswer({
    plan: {
      ...plan,
      mode: ragResult?.ok && ragResult.value.abstained && webResult?.ok ? "document_web" : plan.mode,
    },
    ragResult,
    webResult,
    inventoryAnswer,
    discoveryAnswer,
    researchBrief,
  });
  const agentMode =
    ragResult?.ok && ragResult.value.abstained && webResult?.ok ? "document_web" : plan.mode;

  trace.push(
    buildStep({
      index: trace.length + 1,
      type: "synthesis",
      label: "Synthesis",
      summary: "Composed the final agent answer from completed tool results.",
    })
  );

  const ragError = ragResult?.ok === false
    ? serializeError(ragResult.error, "Unable to answer from the document.")
    : null;
  const webError = webResult?.ok === false
    ? serializeError(webResult.error, "Unable to answer from web search.")
    : null;
  const status =
    !["inventory", "document_discovery", "research_brief"].includes(plan.mode) &&
    !ragResult?.ok &&
    (shouldRunWeb ? !webResult?.ok : true)
      ? 502
      : 200;

  return {
    status,
    body: {
      agentAnswer,
      agentMode,
      agentTrace: trace,
      researchBrief,
      ragAnswer: researchBrief
        ? researchBrief.text
        : ragResult?.ok
        ? ragResult.value.text
        : ragError
          ? `RAG unavailable: ${ragError}`
          : "",
      ragSources: researchBrief?.citations ?? (ragResult?.ok ? ragResult.value.citations ?? [] : []),
      ragResolvedQuestion: ragResult?.ok ? ragResult.value.resolvedQuery ?? question : question,
      ragMemoryApplied: ragResult?.ok ? Boolean(ragResult.value.memoryApplied) : false,
      ragAbstained: researchBrief
        ? researchBrief.findings.some((finding) => finding.abstained)
        : ragResult?.ok
          ? Boolean(ragResult.value.abstained)
          : null,
      ragAbstainReason: ragResult?.ok
        ? ragResult.value.abstainReason ?? null
        : null,
      ragGapPlan: ragResult?.ok ? ragResult.value.gapPlan ?? null : null,
      mcpAnswer: webResult?.ok
        ? webResult.value.text
        : webResult?.ok === false
          ? `Web search unavailable: ${webError}`
          : ["inventory", "document_discovery", "research_brief"].includes(plan.mode)
            ? "Web search not used for workspace metadata."
            : "Web search not used: document evidence was sufficient.",
      errors: {
        rag: ragError,
        mcp: webError,
      },
    },
  };
};
