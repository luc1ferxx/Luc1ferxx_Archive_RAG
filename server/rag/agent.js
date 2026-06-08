import { performance } from "node:perf_hooks";
import {
  buildEvidenceRetryQuestion,
  evaluateDocumentEvidence,
  selectBetterRagResult,
} from "./agent-self-check.js";
import { finalizeAgentAnswer } from "./agent-finalizer.js";
import {
  appendTraceStep,
  buildBudgetLimitStep,
  consumeBudget,
  createAgentBudget,
  getBudgetSnapshot,
} from "./agent-budget.js";
import {
  AGENT_SKILL_IDS,
  CUSTOM_SKILL_IDS,
  buildFailedSkillResult,
  createDefaultSkillRegistry,
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

const TIMELINE_SIGNAL_PATTERN =
  /\b(timeline|chronology|chronological|sequence|milestones?|key dates?|event order|date order)\b|时间线|时间顺序|按时间|大事记|里程碑|事件顺序|关键日期/i;

const serializeError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error.message;
  }

  return fallbackMessage;
};

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

const normalizeText = (value) => (hasText(value) ? value.trim() : "");

const roundDurationMs = (durationMs) =>
  Number.isFinite(durationMs) ? Number(durationMs.toFixed(2)) : 0;

const getSkillKey = ({ skillId, id }) => skillId ?? id ?? "unknown";

const getSkillDescriptor = (skill = {}) => ({
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
  const wantsTimeline = TIMELINE_SIGNAL_PATTERN.test(question);
  const hasDocuments = docIds.length > 0;

  if (wantsTimeline) {
    return {
      mode: CUSTOM_SKILL_IDS.extractTimeline,
      wantsTimeline: true,
      wantsResearch: false,
      wantsInventory: false,
      wantsDiscovery: false,
      wantsDocumentRag: false,
      wantsWeb: false,
      requiresDocuments: true,
      summary: "Extract a cited chronological timeline from selected documents.",
    };
  }

  if (wantsResearch) {
    return {
      mode: "research_brief",
      wantsTimeline: false,
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
      wantsTimeline: false,
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
      wantsTimeline: false,
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
      wantsTimeline: false,
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
    wantsTimeline: false,
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
  customSkillResults,
  inventoryAnswer,
  discoveryAnswer,
  researchBrief,
}) => {
  if (plan.mode === CUSTOM_SKILL_IDS.extractTimeline) {
    const timelineResult = customSkillResults.find(
      (result) => result.ok && result.skillId === CUSTOM_SKILL_IDS.extractTimeline
    );

    return timelineResult?.text ?? "The timeline could not be extracted.";
  }

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

const buildFinalizerSummary = (finalizer) => {
  if (!finalizer.changed) {
    return `Final answer passed claim-level citation finalization with ${
      finalizer.claimSupport.supportedClaimCount
    } supported claim${finalizer.claimSupport.supportedClaimCount === 1 ? "" : "s"}.`;
  }

  if (finalizer.abstained) {
    return `Finalizer removed ${finalizer.removedClaims.length} unsupported claim${
      finalizer.removedClaims.length === 1 ? "" : "s"
    } and returned an evidence-limited answer.`;
  }

  return `Finalizer removed ${finalizer.removedClaims.length} unsupported claim${
    finalizer.removedClaims.length === 1 ? "" : "s"
  } from the final answer.`;
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
  const registry = skillRegistry ?? createDefaultSkillRegistry();
  const skillExecutions = new Map();
  const skillObservations = new Map();
  const skillRuns = [];
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
  const selectedSkillKeys = new Set(selectedSkills.map((skill) => skill.id));
  const getSelectedSkill = (skillId) =>
    selectedSkills.find((skill) => skill.id === skillId) ?? null;
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

    if (phase === "retry") {
      observation.retryCount += 1;
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
    { phase = "primary", budget = null } = {}
  ) => {
    const budgetBefore = getBudgetSnapshot(budgetState);
    const startedAt = performance.now();
    const result = await executeAgentSkill(skill, context);
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
  const recordSkippedSkill = ({ skill, result, phase, budget }) => {
    recordSkillObservation({
      skill,
      result,
      phase,
      status: "skipped",
      budget,
      budgetAfter: getBudgetSnapshot(budgetState),
    });
  };
  const buildAgentObservability = ({ agentMode }) => ({
    agentMode,
    planMode: plan.mode,
    selectedSkills: selectedSkills.map((skill) => getSkillDescriptor(skill)),
    skills: [...skillObservations.values()].sort((left, right) =>
      left.skillId.localeCompare(right.skillId)
    ),
    runs: skillRuns,
    budget: getBudgetSnapshot(budgetState),
  });

  for (const skill of selectedSkills) {
    getOrCreateSkillObservation(skill);
  }

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
  const customSkillResults = [];

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

    const researchResult = await executeObservedSkill(researchSkill, {
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
    const inventoryResult = await executeObservedSkill(inventorySkill, {
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
    const discoveryResult = await executeObservedSkill(discoverySkill, {
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

  const customSkills = selectedSkills.filter((skill) => skill.kind === "custom");

  for (const customSkill of customSkills) {
    const customBudget = customSkill.budgetKey
      ? consumeBudget(budgetState, customSkill.budgetKey)
      : null;
    const customResult = customBudget && !customBudget.ok
      ? buildFailedSkillResult(customSkill, new Error(customBudget.reason))
      : await executeObservedSkill(customSkill, {
          ragService,
          question,
          docIds,
          sessionId,
          userId,
          accessScope,
        }, {
          phase: "primary",
          budget: customBudget,
        });

    customSkillResults.push(customResult);
    recordSkillResult(customResult);

    if (customBudget && !customBudget.ok) {
      recordSkippedSkill({
        skill: customSkill,
        result: customResult,
        phase: "primary",
        budget: customBudget,
      });
      addBudgetLimitTrace({
        tool: customSkill.label,
        reason: customBudget.reason,
      });
      continue;
    }

    addTraceStep({
      type: "custom_skill",
      label: customSkill.label,
      status: customResult.ok ? "completed" : "failed",
      summary: customResult.ok
        ? `${customSkill.label} completed with ${customResult.citations?.length ?? 0} citation${
            customResult.citations?.length === 1 ? "" : "s"
          }.`
        : `${customSkill.label} failed: ${serializeError(
            customResult.error,
            "Unable to run custom skill."
          )}`,
      detail: buildSkillTraceDetail(customResult, {
        skillKind: customSkill.kind,
        ...(customResult.traceDetail ?? {}),
      }),
    });
  }

  const documentRagSkill = getSelectedSkill(AGENT_SKILL_IDS.documentRag);

  if (documentRagSkill) {
    const primaryBudget = consumeBudget(budgetState, documentRagSkill.budgetKey);
    const primaryRagResult = primaryBudget.ok
      ? await executeObservedSkill(documentRagSkill, {
          ragService,
          docIds,
          question,
          sessionId,
          userId,
          accessScope,
        }, {
          phase: "primary",
          budget: primaryBudget,
        })
      : buildFailedSkillResult(documentRagSkill, new Error(primaryBudget.reason));

    ragResult = primaryRagResult;
    recordSkillResult(primaryRagResult);

    if (!primaryBudget.ok) {
      recordSkippedSkill({
        skill: documentRagSkill,
        result: primaryRagResult,
        phase: "primary",
        budget: primaryBudget,
      });
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
        recordSkippedSkill({
          skill: documentRagSkill,
          result: buildFailedSkillResult(
            documentRagSkill,
            new Error(retryBudget.reason)
          ),
          phase: "retry",
          budget: retryBudget,
        });
        addBudgetLimitTrace({
          tool: "Document retry",
          reason: retryBudget.reason,
        });
      } else {
        const retryRagResult = await executeObservedSkill(documentRagSkill, {
          ragService,
          docIds,
          question: retryQuestion,
          sessionId,
          userId,
          accessScope,
        }, {
          phase: "retry",
          budget: retryBudget,
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
      recordSkippedSkill({
        skill: webSearchSkill,
        result: buildFailedSkillResult(webSearchSkill, new Error(webBudget.reason)),
        phase: plannedWebSearchSkill ? "primary" : "fallback",
        budget: webBudget,
      });
      addBudgetLimitTrace({
        tool: "Web Search",
        reason: webBudget.reason,
      });
    } else {
      webResult = await executeObservedSkill(webSearchSkill, {
        webChatService,
        question,
      }, {
        phase: plannedWebSearchSkill ? "primary" : "fallback",
        budget: webBudget,
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

  const agentMode =
    ragResult?.ok && ragResult.value.abstained && webResult?.ok ? "document_web" : plan.mode;
  const primaryCustomResult = customSkillResults.find((result) => result.ok);
  const directAnswerModes = new Set([
    "inventory",
    "document_discovery",
    "research_brief",
    ...customSkills.map((skill) => skill.id),
  ]);
  const ragSources = researchBrief?.citations ??
    (ragResult?.ok
      ? ragResult.value.citations ?? []
      : primaryCustomResult?.citations ?? []);
  const baseAgentAnswer = buildSynthesisAnswer({
    plan: {
      ...plan,
      mode: agentMode,
    },
    ragResult,
    webResult,
    customSkillResults,
    inventoryAnswer,
    discoveryAnswer,
    researchBrief,
  });
  const shouldFinalizeAnswer =
    ragSources.length > 0 &&
    (agentMode === "document" ||
      (primaryCustomResult && agentMode === primaryCustomResult.skillId));

  addTraceStep({
    type: "synthesis",
    label: "Synthesis",
    summary: "Composed the final agent answer from completed tool results.",
    detail: {
      budget: getBudgetSnapshot(budgetState),
    },
  });

  const finalizer = shouldFinalizeAnswer
    ? finalizeAgentAnswer({
        answerText: baseAgentAnswer,
        citations: ragSources,
      })
    : null;

  if (finalizer) {
    addTraceStep({
      type: "answer_finalizer",
      label: "Answer Finalizer",
      summary: buildFinalizerSummary(finalizer),
      detail: {
        changed: finalizer.changed,
        abstained: finalizer.abstained,
        removedClaims: finalizer.removedClaims,
        claimSupport: finalizer.claimSupport,
      },
    });
  }

  const agentAnswer = finalizer?.text ?? baseAgentAnswer;

  const ragError = ragResult?.ok === false
    ? serializeError(ragResult.error, "Unable to answer from the document.")
    : null;
  const webError = webResult?.ok === false
    ? serializeError(webResult.error, "Unable to answer from web search.")
    : null;
  const rawRagAnswer = researchBrief
    ? researchBrief.text
    : ragResult?.ok
    ? ragResult.value.text
    : primaryCustomResult?.text
      ? primaryCustomResult.text
    : ragError
      ? `RAG unavailable: ${ragError}`
      : "";
  const ragAnswer =
    finalizer &&
    (agentMode === "document" ||
      (primaryCustomResult && agentMode === primaryCustomResult.skillId))
      ? agentAnswer
      : rawRagAnswer;
  const rawRagAbstained = researchBrief
    ? researchBrief.findings.some((finding) => finding.abstained)
    : ragResult?.ok
      ? Boolean(ragResult.value.abstained)
      : primaryCustomResult
        ? Boolean(primaryCustomResult.abstained)
        : null;
  const ragAbstained = finalizer?.abstained ? true : rawRagAbstained;
  const status =
    !directAnswerModes.has(plan.mode) &&
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
      agentObservability: buildAgentObservability({
        agentMode,
      }),
      researchBrief,
      ragAnswer,
      ragSources,
      ragResolvedQuestion: ragResult?.ok ? ragResult.value.resolvedQuery ?? question : question,
      ragMemoryApplied: ragResult?.ok ? Boolean(ragResult.value.memoryApplied) : false,
      ragAbstained,
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
          : directAnswerModes.has(plan.mode)
            ? "Web search not used for this direct agent skill."
            : "Web search not used: document evidence was sufficient.",
      errors: {
        rag: ragError,
        mcp: webError,
      },
    },
  };
};
