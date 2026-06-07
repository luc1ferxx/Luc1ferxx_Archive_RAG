import {
  buildEvidenceRetryQuestion,
  evaluateDocumentEvidence,
  selectBetterRagResult,
} from "./agent-self-check.js";
import {
  appendTraceStep,
  buildBudgetLimitStep,
  consumeBudget,
  createAgentBudget,
  getBudgetSnapshot,
} from "./agent-budget.js";
import {
  AGENT_SKILL_IDS,
  buildFailedSkillResult,
  createBuiltInSkillRegistry,
  executeAgentSkill,
} from "./skills/registry.js";

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

const buildPlannerActions = ({ plan, docIds, skills }) => {
  const actions = [
    {
      id: "classify_request",
      label: "Classify request",
      summary: plan.summary,
    },
  ];

  for (const skill of skills) {
    actions.push(...(skill.plannerActions?.({
      plan,
      docIds,
    }) ?? []));
  }

  actions.push({
    id: "synthesis",
    label: "Synthesize answer",
    summary: "Compose the final response from verified tool results.",
  });

  return actions;
};

const buildSelfCheckSummary = (check) => {
  if (check.passed) {
    return `Evidence check passed with ${check.citationCount} citation${
      check.citationCount === 1 ? "" : "s"
    } across ${check.citedDocCount} cited document${
      check.citedDocCount === 1 ? "" : "s"
    }.`;
  }

  return `Evidence check needs attention: ${check.reasons.join(" ")}`;
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

export const runAgentRag = async ({
  agentBudget,
  ragService,
  webChatService,
  question,
  docIds,
  sessionId,
  userId,
  accessScope,
  skillRegistry,
}) => {
  const trace = [];
  const budgetState = createAgentBudget(agentBudget);
  const registry = skillRegistry ?? createBuiltInSkillRegistry();
  const skillExecutions = new Map();
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
    ...detail,
  });
  const addTraceStep = (step) =>
    appendTraceStep({
      budgetState,
      trace,
      step: buildStep({
        index: trace.length + 1,
        ...step,
      }),
    });
  const addBudgetLimitTrace = ({ reason, tool }) =>
    appendTraceStep({
      budgetState,
      trace,
      step: buildBudgetLimitStep({
        index: trace.length + 1,
        reason,
        tool,
      }),
    });
  const plan = buildPlan({
    question,
    docIds,
  });
  const selectedSkills = registry.select({
    plan,
    docIds,
  });
  const getSelectedSkill = (skillId) =>
    selectedSkills.find((skill) => skill.id === skillId) ?? null;

  addTraceStep({
    type: "plan",
    label: "Plan",
    summary: plan.summary,
    detail: {
      mode: plan.mode,
      docIds,
      budget: getBudgetSnapshot(budgetState),
      actions: buildPlannerActions({
        plan,
        docIds,
        skills: selectedSkills,
      }),
    },
  });

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

  const researchSkill = getSelectedSkill(AGENT_SKILL_IDS.researchBrief);

  if (researchSkill) {
    const selectedDocuments = ragService
      .listDocuments?.(accessScope)
      ?.filter((document) => docIds.includes(document.docId)) ?? [];
    const researchPlan = researchSkill.createPlan({
      question,
      documents: selectedDocuments,
    });

    addTraceStep({
      type: "research_plan",
      label: "Research Plan",
      summary: `Planned ${researchPlan.questions.length} document-grounded research question${
        researchPlan.questions.length === 1 ? "" : "s"
      }.`,
      detail: {
        questions: researchPlan.questions,
      },
    });

    const researchResult = await executeAgentSkill(researchSkill, {
      budgetState,
      ragService,
      question,
      docIds,
      accessScope,
      researchPlan,
    });
    recordSkillResult(researchResult);
    researchBrief = researchResult.ok ? researchResult.value : null;

    if (!researchResult.ok) {
      addTraceStep({
        type: "research_question",
        label: "Research Question",
        status: "failed",
        summary: `Research brief failed: ${serializeError(
          researchResult.error,
          "Unable to generate research brief."
        )}`,
        detail: buildSkillTraceDetail(researchResult),
      });
    }

    for (const finding of researchBrief?.findings ?? []) {
      if (finding.status === "skipped") {
        addBudgetLimitTrace({
          tool: "Research Question",
          reason: finding.error ?? "Research question budget exhausted.",
        });
        continue;
      }

      addTraceStep({
        type: "research_question",
        label: "Research Question",
        status: finding.status === "completed" ? "completed" : "failed",
        summary: finding.question,
        detail: {
          citations: finding.citations?.length ?? 0,
          abstained: Boolean(finding.abstained),
          error: finding.error ?? null,
          skillId: researchResult.skillId,
          skillVersion: researchResult.skillVersion,
        },
      });
    }
  }

  const inventorySkill = getSelectedSkill(AGENT_SKILL_IDS.inventory);

  if (inventorySkill) {
    const inventoryResult = await executeAgentSkill(inventorySkill, {
      ragService,
      accessScope,
    });
    recordSkillResult(inventoryResult);
    const documents = inventoryResult.value?.documents ?? [];
    inventoryAnswer = inventoryResult.ok
      ? inventoryResult.text
      : `Workspace inventory unavailable: ${serializeError(
          inventoryResult.error,
          "Unable to list indexed documents."
        )}`;
    addTraceStep({
      type: "inventory",
      label: "Workspace Inventory",
      status: inventoryResult.ok ? "completed" : "failed",
      summary:
        inventoryResult.ok && documents.length === 0
          ? "No indexed documents found."
          : inventoryResult.ok
            ? `Found ${documents.length} indexed document${
                documents.length === 1 ? "" : "s"
              }.`
            : `Workspace inventory failed: ${serializeError(
                inventoryResult.error,
                "Unable to list indexed documents."
              )}`,
      detail: buildSkillTraceDetail(inventoryResult, {
        documentCount: documents.length,
      }),
    });
  }

  const discoverySkill = getSelectedSkill(AGENT_SKILL_IDS.documentDiscovery);

  if (discoverySkill) {
    const discoveryResult = await executeAgentSkill(discoverySkill, {
      ragService,
      question,
      docIds,
      accessScope,
    });
    recordSkillResult(discoveryResult);
    const matches = discoveryResult.value?.matches ?? [];
    discoveryAnswer = discoveryResult.ok
      ? discoveryResult.text
      : `Document discovery unavailable: ${serializeError(
          discoveryResult.error,
          "Unable to inspect workspace metadata."
        )}`;
    addTraceStep({
      type: "document_discovery",
      label: "Document Discovery",
      status: discoveryResult.ok ? "completed" : "failed",
      summary:
        discoveryResult.ok && matches.length === 0
          ? "No strong metadata match found."
          : discoveryResult.ok
            ? `Found ${matches.length} likely matching document${
                matches.length === 1 ? "" : "s"
              }.`
            : `Document discovery failed: ${serializeError(
                discoveryResult.error,
                "Unable to inspect workspace metadata."
              )}`,
      detail: buildSkillTraceDetail(discoveryResult, {
        matchCount: matches.length,
      }),
    });
  }

  const documentRagSkill = getSelectedSkill(AGENT_SKILL_IDS.documentRag);

  if (documentRagSkill) {
    const primaryBudget = consumeBudget(budgetState, documentRagSkill.budgetKey);
    const primaryRagResult = primaryBudget.ok
      ? await executeAgentSkill(documentRagSkill, {
          ragService,
          docIds,
          question,
          sessionId,
          userId,
          accessScope,
        })
      : buildFailedSkillResult(documentRagSkill, new Error(primaryBudget.reason));

    ragResult = primaryRagResult;
    recordSkillResult(primaryRagResult);

    if (!primaryBudget.ok) {
      addBudgetLimitTrace({
        tool: "Document RAG",
        reason: primaryBudget.reason,
      });
    } else {
      addTraceStep({
        type: "document_rag",
        label: "Document RAG",
        status: primaryRagResult.ok ? "completed" : "failed",
        summary: primaryRagResult.ok
          ? primaryRagResult.value.abstained
            ? "Document RAG ran but reported insufficient evidence."
            : `Document RAG returned ${
                primaryRagResult.value.citations?.length ?? 0
              } citation${
                primaryRagResult.value.citations?.length === 1 ? "" : "s"
              }.`
          : `Document RAG failed: ${serializeError(
              primaryRagResult.error,
              "Unable to answer from the document."
            )}`,
        detail: buildSkillTraceDetail(
          primaryRagResult,
          primaryRagResult.traceDetail ?? {}
        ),
      });
    }

    const primaryCheck = evaluateDocumentEvidence({
      ragResult: primaryRagResult,
      docIds,
    });

    if (primaryBudget.ok) {
      addTraceStep({
        type: "self_check",
        label: "Self Check",
        status: primaryCheck.passed ? "completed" : "failed",
        summary: buildSelfCheckSummary(primaryCheck),
        detail: primaryCheck,
      });
    }

    if (primaryCheck.retryRecommended) {
      const retryQuestion = buildEvidenceRetryQuestion({
        question,
        check: primaryCheck,
      });
      const retryBudget = consumeBudget(budgetState, documentRagSkill.budgetKey);

      if (!retryBudget.ok) {
        addBudgetLimitTrace({
          tool: "Document retry",
          reason: retryBudget.reason,
        });
      } else {
        const retryRagResult = await executeAgentSkill(documentRagSkill, {
          ragService,
          docIds,
          question: retryQuestion,
          sessionId,
          userId,
          accessScope,
        });
        recordSkillResult(retryRagResult);

        addTraceStep({
          type: "document_retry",
          label: "Document Retry",
          status: retryRagResult.ok ? "completed" : "failed",
          summary: retryRagResult.ok
            ? `Focused retry returned ${
                retryRagResult.value.citations?.length ?? 0
              } citation${
                retryRagResult.value.citations?.length === 1 ? "" : "s"
              }.`
            : `Focused retry failed: ${serializeError(
                retryRagResult.error,
              "Unable to retry document evidence lookup."
            )}`,
          detail: buildSkillTraceDetail(retryRagResult, {
            retryQuestion,
          }),
        });

        if (retryRagResult.ok) {
          const retryCheck = evaluateDocumentEvidence({
            ragResult: retryRagResult,
            docIds,
          });

          addTraceStep({
            type: "self_check",
            label: "Retry Self Check",
            status: retryCheck.passed ? "completed" : "failed",
            summary: buildSelfCheckSummary(retryCheck),
            detail: retryCheck,
          });
        }

        ragResult = selectBetterRagResult({
          primary: primaryRagResult,
          retry: retryRagResult,
        });
      }
    }
  }

  const plannedWebSearchSkill = getSelectedSkill(AGENT_SKILL_IDS.webSearch);
  const webSearchSkill = plannedWebSearchSkill ?? registry.get(AGENT_SKILL_IDS.webSearch);
  const shouldRunWeb =
    Boolean(webSearchSkill) &&
    (Boolean(plannedWebSearchSkill) ||
      (ragResult?.ok && ragResult.value.abstained) ||
      ragResult?.ok === false);
  let skippedWebBecauseBudget = false;

  if (shouldRunWeb) {
    const webBudget = consumeBudget(budgetState, webSearchSkill.budgetKey);

    if (!webBudget.ok) {
      skippedWebBecauseBudget = true;
      addBudgetLimitTrace({
        tool: "Web Search",
        reason: webBudget.reason,
      });
    } else {
      webResult = await executeAgentSkill(webSearchSkill, {
        webChatService,
        question,
      });
      recordSkillResult(webResult);

      addTraceStep({
        type: "web_search",
        label: "Web Search",
        status: webResult.ok ? "completed" : "failed",
        summary: webResult.ok
          ? "Web search returned supplemental context."
          : `Web search failed: ${serializeError(
              webResult.error,
              "Unable to answer from web search."
            )}`,
        detail: buildSkillTraceDetail(webResult),
      });
    }
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

  addTraceStep({
    type: "synthesis",
    label: "Synthesis",
    summary: "Composed the final agent answer from completed tool results.",
    detail: {
      budget: getBudgetSnapshot(budgetState),
    },
  });

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
      agentSkills: getAgentSkills(),
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
      ragEvidenceSummary: ragResult?.ok
        ? ragResult.value.evidenceSummary ?? null
        : null,
      mcpAnswer: webResult?.ok
        ? webResult.value.text
        : webResult?.ok === false
          ? `Web search unavailable: ${webError}`
          : skippedWebBecauseBudget
            ? "Web search not used: agent budget exhausted."
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
