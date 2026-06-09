import {
  buildEvidenceRetryQuestion,
  buildEvidenceGaps,
  evaluateDocumentEvidence,
  selectBetterRagResult,
} from "./agent-self-check.js";
import { finalizeAgentAnswer } from "./agent-finalizer.js";
import {
  createAgentSkillTracker,
  getSkillDescriptor,
} from "./agent-skill-observability.js";
import { createAgentWorkingMemory } from "./agent-working-memory.js";
import {
  SKILL_CHAIN_MODE,
  buildChainedSkillQuestion,
  buildPlan,
  buildPlannerActions,
  buildPreExecutionClarification,
  buildSkillChainSummary,
  orderSelectedSkills,
} from "./agent-planner.js";
import { buildAgentRetrievalPlan } from "./agent-query-planner.js";
import {
  buildAgentTraceSummary,
  buildFinalizerSummary,
  buildGapAnalysisSummary,
  buildQueryPlannerSummary,
  buildSelfCheckSummary,
  buildStep,
} from "./agent-trace.js";
import { recordRagTrace } from "./observability.js";
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
} from "./skills/registry.js";

const MAX_AGENT_FOLLOW_UPS = 1;

const serializeError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error.message;
  }

  return fallbackMessage;
};

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

const normalizeText = (value) => (hasText(value) ? value.trim() : "");

const buildEvidenceClarification = ({ reason, check, gaps = [] } = {}) => ({
  reason,
  summary:
    "The agent could not verify the answer from the selected document evidence.",
  question:
    "I could not verify the answer from the selected documents. Which specific section, term, date, or document should I focus on?",
  detail: {
    reasons: check?.reasons ?? [],
    gaps,
  },
});

const buildSynthesisAnswer = ({
  plan,
  ragResult,
  webResult,
  customSkillResults,
  inventoryAnswer,
  discoveryAnswer,
  researchBrief,
}) => {
  if (plan.mode === SKILL_CHAIN_MODE) {
    const completedResults = customSkillResults
      .filter((result) => result.ok && normalizeText(result.text))
      .map((result) => normalizeText(result.text));

    return completedResults.length > 0
      ? completedResults.join("\n\n")
      : "The skill chain could not complete the request.";
  }

  if (Object.values(CUSTOM_SKILL_IDS).includes(plan.mode)) {
    const customResult = customSkillResults.find(
      (result) => result.ok && result.skillId === plan.mode
    );

    return customResult?.text ?? "The custom skill could not complete the request.";
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
  let agentRetrievalPlan = null;
  const {
    executionLoop,
    recordExecutionGaps,
    recordWorkingMemoryClaimSupport,
    recordWorkingMemoryGaps,
    recordWorkingMemoryQueries,
    resolveWorkingMemoryGaps,
    workingMemory,
  } = createAgentWorkingMemory({
    docIds,
    maxFollowUps: MAX_AGENT_FOLLOW_UPS,
    question,
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
  const selectedSkills = orderSelectedSkills({
    selectedSkills: registry.select({
      plan,
      docIds,
    }),
    plan,
  });
  const chainSkills = Array.isArray(plan.skillChain)
    ? plan.skillChain
        .map((skillId) => selectedSkills.find((skill) => skill.id === skillId))
        .filter(Boolean)
    : [];
  const getSelectedSkill = (skillId) =>
    selectedSkills.find((skill) => skill.id === skillId) ?? null;
  const {
    buildSkillTraceDetail,
    executeObservedSkill,
    getAgentSkills,
    getOrCreateSkillObservation,
    getSkillObservations,
    getSkillRuns,
    recordSkillResult,
    recordSkippedSkill,
  } = createAgentSkillTracker({
    budgetState,
    recordWorkingMemoryQueries,
    selectedSkills,
  });
  const buildAgentObservability = ({ agentMode }) => ({
    agentMode,
    planMode: plan.mode,
    skillChain: chainSkills.map((skill) => getSkillDescriptor(skill)),
    executionLoop,
    workingMemory,
    selectedSkills: selectedSkills.map((skill) => getSkillDescriptor(skill)),
    skills: getSkillObservations(),
    runs: getSkillRuns(),
    budget: getBudgetSnapshot(budgetState),
  });
  const returnClarification = async (clarification) => {
    const agentMode = "clarification";

    addTraceStep({
      type: "clarification_gate",
      label: "Clarification Gate",
      status: "needs_input",
      summary: clarification.summary,
      detail: {
        reason: clarification.reason,
        clarificationQuestion: clarification.question,
        ...(clarification.detail ?? {}),
      },
    });

    const agentObservability = buildAgentObservability({
      agentMode,
    });
    const status = 200;

    await recordRagTrace({
      traceType: "agent",
      timestamp: new Date().toISOString(),
      agentMode,
      planMode: plan.mode,
      docIds,
      agentSkills: getAgentSkills(),
      agentObservability,
      agentRetrievalPlan,
      agentTraceSummary: buildAgentTraceSummary(trace),
      status,
    });

    return {
      status,
      body: {
        agentAnswer: clarification.question,
        agentMode,
        agentTrace: trace,
        agentSkills: getAgentSkills(),
        agentObservability,
        agentWorkingMemory: workingMemory,
        researchBrief: null,
        ragAnswer: clarification.question,
        ragSources: [],
        ragResolvedQuestion: question,
        ragMemoryApplied: false,
        ragAbstained: true,
        ragAbstainReason: clarification.summary,
        ragGapPlan: null,
        ragEvidenceSummary: null,
        mcpAnswer: "Web search not used: clarification needed.",
        clarification: {
          needed: true,
          reason: clarification.reason,
          question: clarification.question,
          detail: clarification.detail ?? null,
        },
        errors: {
          rag: null,
          mcp: null,
        },
      },
    };
  };

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

  const preExecutionClarification = buildPreExecutionClarification({
    plan,
    docIds,
  });

  if (preExecutionClarification) {
    return returnClarification(preExecutionClarification);
  }

  let inventoryAnswer = null;
  let discoveryAnswer = null;
  let researchBrief = null;
  let ragResult = null;
  let webResult = null;
  let documentEvidenceClarification = null;
  const customSkillResults = [];
  const shouldPlanRetrieval = selectedSkills.some(
    (skill) => skill.id === AGENT_SKILL_IDS.documentRag || skill.kind === "custom"
  );
  agentRetrievalPlan = shouldPlanRetrieval
    ? buildAgentRetrievalPlan({
        question,
        plan,
        docIds,
      })
    : null;

  if (agentRetrievalPlan) {
    addTraceStep({
      type: "query_planner",
      label: "Query Planner",
      summary: buildQueryPlannerSummary(agentRetrievalPlan),
      detail: agentRetrievalPlan,
    });
  }

  if (chainSkills.length > 0) {
    addTraceStep({
      type: "skill_chain",
      label: "Skill Chain",
      summary: buildSkillChainSummary({
        chainSkills,
      }),
      detail: {
        mode: plan.mode,
        skills: chainSkills.map((skill) => getSkillDescriptor(skill)),
      },
    });
  }

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
  const previousChainResults = [];

  for (const customSkill of customSkills) {
    const chainQuestion = plan.mode === SKILL_CHAIN_MODE
      ? buildChainedSkillQuestion({
          question,
          previousResults: previousChainResults,
        })
      : question;
    const customBudget = customSkill.budgetKey
      ? consumeBudget(budgetState, customSkill.budgetKey)
      : null;
    const customResult = customBudget && !customBudget.ok
      ? buildFailedSkillResult(customSkill, new Error(customBudget.reason))
      : await executeObservedSkill(customSkill, {
          ragService,
          question: chainQuestion,
          docIds,
          sessionId,
          userId,
          accessScope,
          retrievalPlan: agentRetrievalPlan,
        }, {
          phase: "primary",
          budget: customBudget,
        });

    customSkillResults.push(customResult);
    recordSkillResult(customResult);

    if (customResult.ok) {
      previousChainResults.push(customResult);
    }

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
        chainMode: plan.mode === SKILL_CHAIN_MODE,
        previousSkillCount: Math.max(0, previousChainResults.length - 1),
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
          retrievalPlan: agentRetrievalPlan,
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
      recordWorkingMemoryClaimSupport({
        skill: documentRagSkill,
        phase: "primary",
        check: primaryCheck,
      });

      addTraceStep({
        type: "self_check",
        label: "Self Check",
        status: primaryCheck.passed ? "completed" : "failed",
        summary: buildSelfCheckSummary(primaryCheck),
        detail: primaryCheck,
      });
    }

    if (
      primaryCheck.retryRecommended &&
      executionLoop.followUpsRun < executionLoop.maxFollowUps
    ) {
      const gaps = recordExecutionGaps({
        skill: documentRagSkill,
        check: primaryCheck,
      });

      executionLoop.stoppedReason = "follow_up_planned";

      addTraceStep({
        type: "gap_analysis",
        label: "Gap Analysis",
        status: gaps.length > 0 ? "completed" : "skipped",
        summary: buildGapAnalysisSummary(gaps),
        detail: {
          skillId: documentRagSkill.id,
          skillVersion: documentRagSkill.version,
          followUpRecommended: gaps.length > 0,
          gaps,
        },
      });

      const followUpQuestion = buildEvidenceRetryQuestion({
        question,
        check: primaryCheck,
      });
      const followUpRetrievalPlan = buildAgentRetrievalPlan({
        question: followUpQuestion,
        plan,
        docIds,
        phase: "follow_up",
        focus: {
          originalQuestion: question,
          reasons: primaryCheck.reasons,
          unsupportedClaims: primaryCheck.claimSupport?.claims
            ?.filter((claim) => !claim.supported)
            .map((claim) => claim.text) ?? [],
          gaps,
        },
      });
      const followUpBudget = consumeBudget(
        budgetState,
        documentRagSkill.budgetKey
      );

      if (!followUpBudget.ok) {
        executionLoop.stoppedReason = "budget_exhausted";
        documentEvidenceClarification = buildEvidenceClarification({
          reason: "document_follow_up_budget_exhausted",
          check: primaryCheck,
          gaps,
        });
        recordSkippedSkill({
          skill: documentRagSkill,
          result: buildFailedSkillResult(
            documentRagSkill,
            new Error(followUpBudget.reason)
          ),
          phase: "follow_up",
          budget: followUpBudget,
        });
        addBudgetLimitTrace({
          tool: "Document follow-up",
          reason: followUpBudget.reason,
        });
      } else {
        const followUpRagResult = await executeObservedSkill(documentRagSkill, {
          ragService,
          docIds,
          question: followUpQuestion,
          sessionId,
          userId,
          accessScope,
          retrievalPlan: followUpRetrievalPlan,
        }, {
          phase: "follow_up",
          budget: followUpBudget,
        });
        executionLoop.followUpsRun += 1;
        executionLoop.stoppedReason = "follow_up_completed";
        recordSkillResult(followUpRagResult);

        addTraceStep({
          type: "follow_up_retrieval",
          label: "Follow-up Retrieval",
          status: followUpRagResult.ok ? "completed" : "failed",
          summary: followUpRagResult.ok
            ? `Focused follow-up returned ${
                followUpRagResult.value.citations?.length ?? 0
              } citation${
                followUpRagResult.value.citations?.length === 1 ? "" : "s"
              }.`
            : `Focused follow-up failed: ${serializeError(
                followUpRagResult.error,
              "Unable to run follow-up document evidence lookup."
            )}`,
          detail: buildSkillTraceDetail(followUpRagResult, {
            followUpQuestion,
            retrievalPlan: followUpRetrievalPlan,
            gaps,
          }),
        });

        if (followUpRagResult.ok) {
          const followUpCheck = evaluateDocumentEvidence({
            ragResult: followUpRagResult,
            docIds,
          });
          recordWorkingMemoryClaimSupport({
            skill: documentRagSkill,
            phase: "follow_up",
            check: followUpCheck,
          });

          addTraceStep({
            type: "self_check",
            label: "Follow-up Self Check",
            status: followUpCheck.passed ? "completed" : "failed",
            summary: buildSelfCheckSummary(followUpCheck),
            detail: followUpCheck,
          });

          executionLoop.stoppedReason = followUpCheck.passed
            ? "follow_up_resolved"
            : "follow_up_unresolved";

          if (followUpCheck.passed) {
            resolveWorkingMemoryGaps({
              skill: documentRagSkill,
              phase: "follow_up",
            });
          }

          if (!followUpCheck.passed) {
            const followUpGaps = (followUpCheck.gaps?.length
              ? followUpCheck.gaps
              : buildEvidenceGaps(followUpCheck)).map((gap) => ({
                ...gap,
                skillId: documentRagSkill.id,
                skillVersion: documentRagSkill.version,
              }));

            recordWorkingMemoryGaps({
              gaps: followUpGaps,
              phase: "follow_up",
            });
            documentEvidenceClarification = buildEvidenceClarification({
              reason: "document_evidence_unresolved_after_follow_up",
              check: followUpCheck,
              gaps: followUpGaps,
            });
          }
        }

        ragResult = selectBetterRagResult({
          primary: primaryRagResult,
          retry: followUpRagResult,
        });
      }
    } else if (primaryCheck.retryRecommended) {
      executionLoop.stoppedReason = "follow_up_limit_reached";
      documentEvidenceClarification = buildEvidenceClarification({
        reason: "document_follow_up_limit_reached",
        check: primaryCheck,
        gaps: primaryCheck.gaps?.length
          ? primaryCheck.gaps
          : buildEvidenceGaps(primaryCheck),
      });
    }
  }

  if (documentEvidenceClarification && !plan.wantsWeb) {
    return returnClarification(documentEvidenceClarification);
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
  const successfulCustomResults = customSkillResults.filter((result) => result.ok);
  const primaryCustomResult = customSkillResults.find((result) => result.ok);
  const customCitations = successfulCustomResults.flatMap(
    (result) => result.citations ?? []
  );
  const directAnswerModes = new Set([
    "inventory",
    "document_discovery",
    "research_brief",
    SKILL_CHAIN_MODE,
    ...customSkills.map((skill) => skill.id),
  ]);
  const ragSources = researchBrief?.citations ??
    (ragResult?.ok
      ? ragResult.value.citations ?? []
      : customCitations);
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
      agentMode === SKILL_CHAIN_MODE ||
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
    recordWorkingMemoryClaimSupport({
      skill: primaryCustomResult ?? documentRagSkill ?? {
        id: "answer_finalizer",
        version: "1.0.0",
        label: "Answer Finalizer",
      },
      phase: "final",
      check: {
        claimSupport: finalizer.claimSupport,
      },
    });

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
    : agentMode === SKILL_CHAIN_MODE
      ? baseAgentAnswer
    : primaryCustomResult?.text
      ? primaryCustomResult.text
    : ragError
      ? `RAG unavailable: ${ragError}`
      : "";
  const ragAnswer =
    finalizer &&
    (agentMode === "document" ||
      agentMode === SKILL_CHAIN_MODE ||
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
  const agentObservability = buildAgentObservability({
    agentMode,
  });
  await recordRagTrace({
    traceType: "agent",
    timestamp: new Date().toISOString(),
    agentMode,
    planMode: plan.mode,
    docIds,
    agentSkills: getAgentSkills(),
    agentObservability,
    agentRetrievalPlan,
    agentTraceSummary: buildAgentTraceSummary(trace),
    status,
  });

  return {
    status,
    body: {
      agentAnswer,
      agentMode,
      agentTrace: trace,
      agentSkills: getAgentSkills(),
      agentObservability,
      agentWorkingMemory: workingMemory,
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
