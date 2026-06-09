import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentRag } from "../rag/agent.js";
import {
  AGENT_SKILL_IDS,
  CUSTOM_SKILL_IDS,
} from "../rag/skills/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resultsDirectory = path.join(__dirname, "results");

const DEFAULT_ACCESS_SCOPE = {
  userId: "trajectory-user",
  workspaceId: "trajectory-workspace",
};

const TRAJECTORY_REPORT_VERSION = "1.0.0";
const LATEST_TRAJECTORY_JSON = "latest-trajectory.json";
const LATEST_TRAJECTORY_MD = "latest-trajectory.md";

const CATEGORY_LABELS = {
  access_scope: "Access scope",
  budget: "Budget",
  clarification: "Clarification",
  follow_up: "Follow-up",
  skill_selection: "Skill selection",
};

const normalizeArray = (value) => (Array.isArray(value) ? value : []);

const hasTraceStep = (response, type) =>
  normalizeArray(response?.body?.agentTrace).some((step) => step.type === type);

const getTraceSteps = (response, type) =>
  normalizeArray(response?.body?.agentTrace).filter((step) => step.type === type);

const getTraceTypes = (response) =>
  normalizeArray(response?.body?.agentTrace).map((step) => step.type);

const getObservedSkill = (response, skillId) =>
  normalizeArray(response?.body?.agentObservability?.skills).find(
    (skill) => skill.skillId === skillId
  ) ?? null;

const getSkillChainIds = (response) =>
  normalizeArray(response?.body?.agentObservability?.skillChain).map(
    (skill) => skill.skillId
  );

const getSelectedSkillIds = (response) =>
  normalizeArray(response?.body?.agentObservability?.selectedSkills).map(
    (skill) => skill.skillId
  );

const getRunPhases = (response, skillId = null) =>
  normalizeArray(response?.body?.agentObservability?.runs)
    .filter((run) => !skillId || run.skillId === skillId)
    .map((run) => run.phase);

const sameScope = (scope) =>
  scope?.userId === DEFAULT_ACCESS_SCOPE.userId &&
  scope?.workspaceId === DEFAULT_ACCESS_SCOPE.workspaceId;

const buildCheck = ({ id, label, category, passed, detail = null }) => ({
  id,
  label,
  category,
  passed: Boolean(passed),
  detail,
});

const buildScopedRagService = ({
  documents = [],
  chat,
  telemetry,
}) => ({
  chat: async (docIds, question, options = {}) => {
    telemetry.chatCalls.push({
      docIds,
      question,
      accessScope: options.accessScope ?? null,
      retrievalPlan: options.retrievalPlan ?? null,
    });

    return chat({
      callIndex: telemetry.chatCalls.length,
      docIds,
      question,
      options,
    });
  },
  listDocuments: (accessScope) => {
    telemetry.listDocumentScopes.push(accessScope ?? null);

    return sameScope(accessScope) ? documents : [];
  },
});

const buildSource = ({
  docId = "doc-1",
  fileName = "document.pdf",
  pageNumber = 1,
  excerpt,
} = {}) => ({
  docId,
  fileName,
  pageNumber,
  excerpt,
});

const buildCaseResponseSummary = ({ response, telemetry }) => ({
  status: response?.status ?? null,
  agentMode: response?.body?.agentMode ?? null,
  traceTypes: getTraceTypes(response),
  agentSkills: response?.body?.agentSkills ?? [],
  selectedSkills: response?.body?.agentObservability?.selectedSkills ?? [],
  skillChain: response?.body?.agentObservability?.skillChain ?? [],
  executionLoop: response?.body?.agentObservability?.executionLoop ?? null,
  clarification: response?.body?.clarification ?? null,
  budget: response?.body?.agentObservability?.budget ?? null,
  workingMemory: {
    checkedQueryCount:
      response?.body?.agentWorkingMemory?.checkedQueries?.length ?? 0,
    unresolvedGapCount:
      response?.body?.agentWorkingMemory?.unresolvedGaps?.length ?? 0,
    resolvedGapCount:
      response?.body?.agentWorkingMemory?.resolvedGaps?.length ?? 0,
    unsupportedClaimCount:
      response?.body?.agentWorkingMemory?.unsupportedClaims?.length ?? 0,
  },
  telemetry: {
    chatCallCount: telemetry.chatCalls.length,
    listDocumentCallCount: telemetry.listDocumentScopes.length,
  },
});

const finishCase = ({ id, label, description, checks, response, telemetry }) => {
  const failedChecks = checks.filter((check) => !check.passed);

  return {
    id,
    label,
    description,
    passed: failedChecks.length === 0,
    failedCheckCount: failedChecks.length,
    checks,
    response: buildCaseResponseSummary({
      response,
      telemetry,
    }),
  };
};

const runCaseSafely = async (caseDefinition) => {
  try {
    return await caseDefinition.run();
  } catch (error) {
    const telemetry = {
      chatCalls: [],
      listDocumentScopes: [],
    };

    return finishCase({
      id: caseDefinition.id,
      label: caseDefinition.label,
      description: caseDefinition.description,
      response: null,
      telemetry,
      checks: [
        buildCheck({
          id: "case_error",
          label: "Case completed without throwing",
          category: "trajectory",
          passed: false,
          detail: error instanceof Error ? error.message : String(error),
        }),
      ],
    });
  }
};

const createSkillChainCase = () => ({
  id: "skill_chain_contract_review",
  label: "Contract review skill chain",
  description:
    "A contract risk review should select the summarize_contract -> risk_review whitelist chain.",
  run: async () => {
    const telemetry = {
      chatCalls: [],
      listDocumentScopes: [],
    };
    const citation = buildSource({
      docId: "contract-1",
      fileName: "services-agreement.pdf",
      pageNumber: 3,
      excerpt:
        "Acme and Beta signed a services agreement. It renews every 12 months unless either party gives 30 days notice. Late notice creates renewal risk. Security audit timing is not specified.",
    });
    const ragService = buildScopedRagService({
      documents: [
        {
          docId: "contract-1",
          fileName: "services-agreement.pdf",
        },
      ],
      telemetry,
      chat: async ({ question }) => {
        const isRiskReview = /risk review|risks?|gaps?|exceptions?/i.test(question);

        return {
          text: isRiskReview
            ? [
                "Risk Review",
                "- Risk: Late notice creates renewal risk. [Source 1]",
                "- Gap: Security audit timing is not specified. [Source 1]",
              ].join("\n")
            : [
                "Contract Summary",
                "- Parties: Acme and Beta signed a services agreement. [Source 1]",
                "- Key Terms: The agreement renews every 12 months unless either party gives 30 days notice. [Source 1]",
              ].join("\n"),
          citations: [citation],
          abstained: false,
          resolvedQuery: question,
          memoryApplied: false,
        };
      },
    });
    const response = await runAgentRag({
      ragService,
      webChatService: async () => ({
        text: "web should not run",
      }),
      question: "Review this contract for risks and key terms.",
      docIds: ["contract-1"],
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      accessScope: DEFAULT_ACCESS_SCOPE,
    });
    const chainIds = getSkillChainIds(response);
    const customSkillSteps = getTraceSteps(response, "custom_skill");

    return finishCase({
      id: "skill_chain_contract_review",
      label: "Contract review skill chain",
      description:
        "A contract risk review should select the summarize_contract -> risk_review whitelist chain.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "mode_is_skill_chain",
          label: "Agent mode is skill_chain",
          category: "skill_selection",
          passed: response.body.agentMode === "skill_chain",
          detail: response.body.agentMode,
        }),
        buildCheck({
          id: "expected_chain_order",
          label: "Selected chain order is summarize_contract -> risk_review",
          category: "skill_selection",
          passed:
            chainIds.join(">") ===
            `${CUSTOM_SKILL_IDS.summarizeContract}>${CUSTOM_SKILL_IDS.riskReview}`,
          detail: chainIds,
        }),
        buildCheck({
          id: "skill_chain_trace_step",
          label: "Trace records the skill_chain step",
          category: "skill_selection",
          passed: hasTraceStep(response, "skill_chain"),
          detail: getTraceTypes(response),
        }),
        buildCheck({
          id: "both_custom_skills_ran",
          label: "Both custom skills ran in the trajectory",
          category: "skill_selection",
          passed: customSkillSteps.length === 2,
          detail: customSkillSteps.map((step) => step.detail?.skillId),
        }),
      ],
    });
  },
});

const createFollowUpCase = () => ({
  id: "document_follow_up_retrieval",
  label: "Document evidence follow-up",
  description:
    "Unsupported document claims should trigger gap_analysis and a focused follow-up retrieval.",
  run: async () => {
    const telemetry = {
      chatCalls: [],
      listDocumentScopes: [],
    };
    const ragService = buildScopedRagService({
      documents: [
        {
          docId: "policy-1",
          fileName: "remote-work-policy.pdf",
        },
      ],
      telemetry,
      chat: async ({ callIndex, question }) => {
        if (callIndex === 1) {
          return {
            text:
              "Remote work requires manager approval. The satellite stipend is 500 dollars. [Source 1]",
            citations: [
              buildSource({
                docId: "policy-1",
                fileName: "remote-work-policy.pdf",
                pageNumber: 2,
                excerpt:
                  "Remote work requires manager approval before the first remote day.",
              }),
            ],
            abstained: false,
            resolvedQuery: question,
            memoryApplied: false,
          };
        }

        return {
          text:
            "Remote work requires manager approval before the first remote day. [Source 1]",
          citations: [
            buildSource({
              docId: "policy-1",
              fileName: "remote-work-policy.pdf",
              pageNumber: 2,
              excerpt:
                "Remote work requires manager approval before the first remote day.",
            }),
          ],
          abstained: false,
          resolvedQuery: question,
          memoryApplied: false,
        };
      },
    });
    const response = await runAgentRag({
      ragService,
      webChatService: async () => {
        throw new Error("Web search should not run when follow-up resolves evidence.");
      },
      question: "What does remote work require?",
      docIds: ["policy-1"],
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      accessScope: DEFAULT_ACCESS_SCOPE,
    });
    const selfChecks = getTraceSteps(response, "self_check");
    const documentObservation = getObservedSkill(response, AGENT_SKILL_IDS.documentRag);
    const executionLoop = response.body.agentObservability.executionLoop;

    return finishCase({
      id: "document_follow_up_retrieval",
      label: "Document evidence follow-up",
      description:
        "Unsupported document claims should trigger gap_analysis and a focused follow-up retrieval.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "self_check_failed_then_passed",
          label: "Self-check failed before follow-up and passed after follow-up",
          category: "follow_up",
          passed:
            selfChecks.length === 2 &&
            selfChecks[0].status === "failed" &&
            selfChecks[1].status === "completed",
          detail: selfChecks.map((step) => step.status),
        }),
        buildCheck({
          id: "gap_analysis_recorded",
          label: "Gap analysis recorded unsupported claim",
          category: "follow_up",
          passed:
            hasTraceStep(response, "gap_analysis") &&
            response.body.agentObservability.executionLoop.gaps?.[0]?.type ===
              "unsupported_claim",
          detail: response.body.agentObservability.executionLoop.gaps ?? [],
        }),
        buildCheck({
          id: "follow_up_retrieval_ran",
          label: "Focused follow-up retrieval ran",
          category: "follow_up",
          passed:
            hasTraceStep(response, "follow_up_retrieval") &&
            getRunPhases(response, AGENT_SKILL_IDS.documentRag).includes("follow_up"),
          detail: getRunPhases(response, AGENT_SKILL_IDS.documentRag),
        }),
        buildCheck({
          id: "working_memory_resolved_gap",
          label: "Working memory resolved the evidence gap",
          category: "follow_up",
          passed:
            response.body.agentWorkingMemory.unresolvedGaps.length === 0 &&
            response.body.agentWorkingMemory.resolvedGaps.length > 0,
          detail: response.body.agentWorkingMemory,
        }),
        buildCheck({
          id: "document_budget_bounded",
          label: "Document RAG stayed within retry budget",
          category: "budget",
          passed:
            documentObservation?.attempts === 2 &&
            documentObservation?.budgetUsed === 2 &&
            executionLoop.followUpsRun === 1,
          detail: {
            attempts: documentObservation?.attempts,
            budgetUsed: documentObservation?.budgetUsed,
            followUpsRun: executionLoop.followUpsRun,
          },
        }),
      ],
    });
  },
});

const createClarificationCase = () => ({
  id: "comparison_requires_clarification",
  label: "Comparison clarification gate",
  description:
    "A comparison request with only one selected document should ask for clarification instead of running tools.",
  run: async () => {
    const telemetry = {
      chatCalls: [],
      listDocumentScopes: [],
    };
    const ragService = buildScopedRagService({
      documents: [
        {
          docId: "contract-1",
          fileName: "contract-a.pdf",
        },
      ],
      telemetry,
      chat: async () => {
        throw new Error("Document chat should not run before clarification.");
      },
    });
    const response = await runAgentRag({
      ragService,
      webChatService: async () => {
        throw new Error("Web search should not run before clarification.");
      },
      question: "Compare this contract against the other agreement.",
      docIds: ["contract-1"],
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      accessScope: DEFAULT_ACCESS_SCOPE,
    });

    return finishCase({
      id: "comparison_requires_clarification",
      label: "Comparison clarification gate",
      description:
        "A comparison request with only one selected document should ask for clarification instead of running tools.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "agent_mode_clarification",
          label: "Agent returned clarification mode",
          category: "clarification",
          passed: response.body.agentMode === "clarification",
          detail: response.body.agentMode,
        }),
        buildCheck({
          id: "comparison_reason",
          label: "Clarification reason identifies missing comparison document",
          category: "clarification",
          passed:
            response.body.clarification?.reason ===
            "comparison_requires_multiple_documents",
          detail: response.body.clarification,
        }),
        buildCheck({
          id: "clarification_trace",
          label: "Trace records the clarification gate",
          category: "clarification",
          passed: hasTraceStep(response, "clarification_gate"),
          detail: getTraceTypes(response),
        }),
        buildCheck({
          id: "no_tool_execution_before_clarification",
          label: "No document chat ran before clarification",
          category: "clarification",
          passed: telemetry.chatCalls.length === 0,
          detail: telemetry.chatCalls,
        }),
      ],
    });
  },
});

const createAccessScopeCase = () => ({
  id: "custom_skill_access_scope",
  label: "Custom skill access scope",
  description:
    "A custom skill must pass the authenticated accessScope to document listing and RAG chat.",
  run: async () => {
    const telemetry = {
      chatCalls: [],
      listDocumentScopes: [],
    };
    const ragService = buildScopedRagService({
      documents: [
        {
          docId: "security-1",
          fileName: "security-policy.pdf",
        },
      ],
      telemetry,
      chat: async ({ question }) => ({
        text: [
          "Risk Review",
          "- Risk: Security exceptions require written approval. [Source 1]",
          "- Gap: Audit cadence is not specified. [Source 1]",
        ].join("\n"),
        citations: [
          buildSource({
            docId: "security-1",
            fileName: "security-policy.pdf",
            pageNumber: 5,
            excerpt:
              "Security exceptions require written approval. Audit cadence is not specified.",
          }),
        ],
        abstained: false,
        resolvedQuery: question,
        memoryApplied: false,
      }),
    });
    const response = await runAgentRag({
      ragService,
      webChatService: async () => ({
        text: "web should not run",
      }),
      question: "Review this policy for risks and gaps.",
      docIds: ["security-1"],
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      accessScope: DEFAULT_ACCESS_SCOPE,
    });
    const customStep = getTraceSteps(response, "custom_skill")[0];

    return finishCase({
      id: "custom_skill_access_scope",
      label: "Custom skill access scope",
      description:
        "A custom skill must pass the authenticated accessScope to document listing and RAG chat.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "risk_review_selected",
          label: "Risk review custom skill selected",
          category: "skill_selection",
          passed: getSelectedSkillIds(response).includes(CUSTOM_SKILL_IDS.riskReview),
          detail: getSelectedSkillIds(response),
        }),
        buildCheck({
          id: "list_documents_scoped",
          label: "Document listing received the accessScope",
          category: "access_scope",
          passed:
            telemetry.listDocumentScopes.length > 0 &&
            telemetry.listDocumentScopes.every(sameScope),
          detail: telemetry.listDocumentScopes,
        }),
        buildCheck({
          id: "chat_scoped",
          label: "RAG chat received the accessScope",
          category: "access_scope",
          passed:
            telemetry.chatCalls.length > 0 &&
            telemetry.chatCalls.every((call) => sameScope(call.accessScope)),
          detail: telemetry.chatCalls.map((call) => call.accessScope),
        }),
        buildCheck({
          id: "selected_doc_count_scoped",
          label: "Trace shows scoped selected document count",
          category: "access_scope",
          passed: customStep?.detail?.selectedDocumentCount === 1,
          detail: customStep?.detail ?? null,
        }),
      ],
    });
  },
});

const createBudgetCase = () => ({
  id: "budget_exhaustion_clarification",
  label: "Budget exhaustion clarification",
  description:
    "When follow-up budget is exhausted, the agent should stop and ask for clarification instead of looping.",
  run: async () => {
    const telemetry = {
      chatCalls: [],
      listDocumentScopes: [],
    };
    const ragService = buildScopedRagService({
      documents: [
        {
          docId: "policy-1",
          fileName: "remote-work-policy.pdf",
        },
      ],
      telemetry,
      chat: async ({ question }) => ({
        text:
          "Remote work requires manager approval. The satellite stipend is 500 dollars. [Source 1]",
        citations: [
          buildSource({
            docId: "policy-1",
            fileName: "remote-work-policy.pdf",
            pageNumber: 2,
            excerpt:
              "Remote work requires manager approval before the first remote day.",
          }),
        ],
        abstained: false,
        resolvedQuery: question,
        memoryApplied: false,
      }),
    });
    const response = await runAgentRag({
      agentBudget: {
        maxDocumentRagCalls: 1,
      },
      ragService,
      webChatService: async () => {
        throw new Error("Web search should not run for budget clarification.");
      },
      question: "What does remote work require?",
      docIds: ["policy-1"],
      sessionId: "trajectory-session",
      userId: DEFAULT_ACCESS_SCOPE.userId,
      accessScope: DEFAULT_ACCESS_SCOPE,
    });
    const documentObservation = getObservedSkill(response, AGENT_SKILL_IDS.documentRag);

    return finishCase({
      id: "budget_exhaustion_clarification",
      label: "Budget exhaustion clarification",
      description:
        "When follow-up budget is exhausted, the agent should stop and ask for clarification instead of looping.",
      response,
      telemetry,
      checks: [
        buildCheck({
          id: "budget_reason_clarification",
          label: "Clarification reason identifies exhausted document follow-up budget",
          category: "budget",
          passed:
            response.body.agentMode === "clarification" &&
            response.body.clarification?.reason ===
              "document_follow_up_budget_exhausted",
          detail: response.body.clarification,
        }),
        buildCheck({
          id: "budget_limit_trace",
          label: "Trace records budget_limit instead of unbounded retry",
          category: "budget",
          passed: hasTraceStep(response, "budget_limit"),
          detail: getTraceTypes(response),
        }),
        buildCheck({
          id: "no_follow_up_after_budget_exhaustion",
          label: "Follow-up retrieval did not run after budget exhaustion",
          category: "budget",
          passed:
            !hasTraceStep(response, "follow_up_retrieval") &&
            documentObservation?.attempts === 1 &&
            documentObservation?.budgetUsed === 1,
          detail: {
            attempts: documentObservation?.attempts,
            budgetUsed: documentObservation?.budgetUsed,
            traceTypes: getTraceTypes(response),
          },
        }),
      ],
    });
  },
});

export const createDefaultTrajectoryCases = () => [
  createSkillChainCase(),
  createFollowUpCase(),
  createClarificationCase(),
  createAccessScopeCase(),
  createBudgetCase(),
];

const buildMetricSummary = (caseResults) => {
  const checks = caseResults.flatMap((caseResult) => caseResult.checks);
  const categoryEntries = Object.entries(CATEGORY_LABELS).map(([category, label]) => {
    const categoryChecks = checks.filter((check) => check.category === category);
    const passedCheckCount = categoryChecks.filter((check) => check.passed).length;

    return [
      category,
      {
        label,
        checkCount: categoryChecks.length,
        passedCheckCount,
        failedCheckCount: categoryChecks.length - passedCheckCount,
        passRate:
          categoryChecks.length === 0
            ? null
            : Number((passedCheckCount / categoryChecks.length).toFixed(4)),
      },
    ];
  });
  const passedCaseCount = caseResults.filter((caseResult) => caseResult.passed).length;
  const passedCheckCount = checks.filter((check) => check.passed).length;

  return {
    caseCount: caseResults.length,
    passedCaseCount,
    failedCaseCount: caseResults.length - passedCaseCount,
    checkCount: checks.length,
    passedCheckCount,
    failedCheckCount: checks.length - passedCheckCount,
    overallPassRate:
      caseResults.length === 0
        ? null
        : Number((passedCaseCount / caseResults.length).toFixed(4)),
    checkPassRate:
      checks.length === 0
        ? null
        : Number((passedCheckCount / checks.length).toFixed(4)),
    categories: Object.fromEntries(categoryEntries),
  };
};

export const runTrajectoryEvaluation = async ({
  cases = createDefaultTrajectoryCases(),
  createdAt = new Date().toISOString(),
  runId = `trajectory-${createdAt.replace(/[:.]/g, "-")}`,
} = {}) => {
  const caseResults = [];

  for (const caseDefinition of cases) {
    caseResults.push(await runCaseSafely(caseDefinition));
  }

  const metrics = buildMetricSummary(caseResults);
  const status = metrics.failedCaseCount > 0 ? "fail" : "pass";

  return {
    summary: {
      version: TRAJECTORY_REPORT_VERSION,
      runId,
      createdAt,
      status,
      metrics,
    },
    cases: caseResults,
  };
};

const formatPercent = (value) =>
  typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "N/A";

export const formatTrajectoryReportMarkdown = (report = {}) => {
  const summary = report.summary ?? {};
  const metrics = summary.metrics ?? {};
  const categories = metrics.categories ?? {};
  const lines = [
    "# AgentRAG Trajectory Eval",
    "",
    `- Run ID: \`${summary.runId ?? "unknown"}\``,
    `- Created: \`${summary.createdAt ?? "unknown"}\``,
    `- Status: \`${summary.status ?? "unknown"}\``,
    `- Cases: \`${metrics.passedCaseCount ?? 0}/${metrics.caseCount ?? 0}\` passed`,
    `- Checks: \`${metrics.passedCheckCount ?? 0}/${metrics.checkCount ?? 0}\` passed`,
    "",
    "## Category Metrics",
    "",
    "| Category | Passed | Failed | Pass rate |",
    "| --- | ---: | ---: | ---: |",
  ];

  for (const [category, categoryMetrics] of Object.entries(categories)) {
    lines.push(
      `| ${categoryMetrics.label ?? category} | ${
        categoryMetrics.passedCheckCount ?? 0
      } | ${categoryMetrics.failedCheckCount ?? 0} | ${formatPercent(
        categoryMetrics.passRate
      )} |`
    );
  }

  lines.push("", "## Cases", "");

  for (const caseResult of report.cases ?? []) {
    lines.push(
      `### ${caseResult.passed ? "PASS" : "FAIL"} ${caseResult.label}`,
      "",
      caseResult.description,
      "",
      `- ID: \`${caseResult.id}\``,
      `- Agent mode: \`${caseResult.response?.agentMode ?? "unknown"}\``,
      `- Trace: \`${(caseResult.response?.traceTypes ?? []).join(" -> ")}\``,
      "",
      "| Check | Category | Status |",
      "| --- | --- | --- |"
    );

    for (const check of caseResult.checks ?? []) {
      lines.push(
        `| ${check.label} | ${CATEGORY_LABELS[check.category] ?? check.category} | ${
          check.passed ? "pass" : "fail"
        } |`
      );
    }

    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
};

export const writeTrajectoryEvaluationReport = async ({
  report,
  outputDirectory = resultsDirectory,
} = {}) => {
  await mkdir(outputDirectory, {
    recursive: true,
  });

  const jsonPath = path.join(outputDirectory, LATEST_TRAJECTORY_JSON);
  const markdownPath = path.join(outputDirectory, LATEST_TRAJECTORY_MD);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, formatTrajectoryReportMarkdown(report), "utf8");

  return {
    jsonPath,
    markdownPath,
  };
};

