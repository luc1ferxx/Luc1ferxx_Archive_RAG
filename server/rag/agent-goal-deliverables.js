import { CAPABILITY_IDS } from "./capabilities/index.js";
import { buildCapabilityArtifactIdempotencyKey } from "./capabilities/artifacts.js";
import { TASK_STATUSES } from "./tasks.js";
import {
  ARTIFACT_STATUSES,
  ARTIFACT_TYPES,
} from "./workspace-artifacts/index.js";

export const AGENT_GOAL_DELIVERABLE_STATUSES = Object.freeze({
  approved: "approved",
  completed: "completed",
  failed: "failed",
  notRequested: "not_requested",
  running: "running",
  waitingForApproval: "waiting_for_approval",
});

const MAX_TEXT_LENGTH = 240;
const MAX_CONTENT_LENGTH = 12000;

const ARTIFACT_TYPES_BY_CAPABILITY = Object.freeze({
  [CAPABILITY_IDS.documentOrganize]: ARTIFACT_TYPES.documentCollection,
  [CAPABILITY_IDS.reportExport]: ARTIFACT_TYPES.report,
  [CAPABILITY_IDS.summaryCreate]: ARTIFACT_TYPES.summary,
});

const normalizeText = (value, maxLength = MAX_TEXT_LENGTH) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeDocIds = (value) =>
  toArray(value).map((item) => normalizeText(item)).filter(Boolean);

const getGoal = ({ payload = {} } = {}) =>
  normalizeText(
    payload.taskMemory?.goal ||
      payload.question ||
      payload.lastQuestion ||
      payload.input?.question
  );

const getFinalAnswer = ({ body = {}, payload = {} } = {}) =>
  normalizeText(
    body.agentAnswer ||
      body.ragAnswer ||
      toArray(payload.iterations).at(-1)?.answer ||
      "",
    MAX_CONTENT_LENGTH
  );

const getAgentRunId = ({ body = {}, payload = {} } = {}) =>
  normalizeText(body.agentRunId || payload.agentRunId, 120);

const getCitations = (body = {}) =>
  toArray(body.ragSources ?? body.citations).map((citation) =>
    normalizeRecord(citation)
  );

const getIterationCitations = (payload = {}) =>
  toArray(payload.iterations).flatMap((iteration) =>
    toArray(iteration.citations).map((citation) => normalizeRecord(citation))
  );

const getAllCitations = ({ body = {}, payload = {} } = {}) => {
  const seen = new Set();
  const citations = [];

  for (const citation of [...getCitations(body), ...getIterationCitations(payload)]) {
    const key = [
      normalizeText(citation.docId, 120),
      normalizeText(citation.url, 200),
      normalizeText(citation.title || citation.fileName, 200),
    ].join("\u0000");

    if (!key.replace(/\u0000/g, "") || seen.has(key)) {
      continue;
    }

    seen.add(key);
    citations.push(citation);
  }

  return citations.slice(0, 50);
};

const hasPattern = (value = "", pattern) => pattern.test(value);

const wantsReport = (goal = "") =>
  hasPattern(
    goal,
    /\b(report|dossier|markdown|risk review|risk assessment)\b|报告|风险|评估/i
  );

const wantsOrganization = (goal = "") =>
  hasPattern(goal, /\b(organize|organise|arrange|group|cluster)\b|整理|归类|分类/i);

const wantsSavedSummary = (goal = "") =>
  wantsReport(goal) ||
  hasPattern(
    goal,
    /\b(create|save|store|record|persist|generate)\b.*\b(summary|summaries)\b|(?:创建|保存|记录|生成).*(?:摘要|总结)/i
  );

const wantsFollowUpTask = (goal = "") =>
  wantsReport(goal) ||
  hasPattern(goal, /\b(follow[-\s]?up|todo|to-do|task|action item)\b|后续|待办|行动项/i);

const buildBaseTitle = (goal = "") =>
  normalizeText(goal, 90)
    .replace(/[。！？.!?]+$/g, "")
    .replace(/\s+/g, " ") || "Agent goal result";

const buildMetadata = ({ body = {}, payload = {}, type }) => ({
  agentRunId: getAgentRunId({
    body,
    payload,
  }),
  goal: getGoal({
    payload,
  }),
  type,
});

const buildReportContent = ({ answer = "", goal = "" } = {}) =>
  [
    `Goal: ${goal || "Agent goal"}`,
    "",
    answer || "The agent completed the goal without a text answer.",
  ]
    .join("\n")
    .trim();

const getResearchTaskIterations = (payload = {}) =>
  toArray(payload.iterations).filter(
    (iteration) =>
      iteration.researchTaskPhase &&
      iteration.clarificationNeeded !== true &&
      Number(iteration.responseStatus ?? 200) < 400
  );

const buildDossierContent = ({ answer = "", goal = "", payload = {} } = {}) => {
  const researchTask = normalizeRecord(payload.researchTask, null);
  const researchIterations = getResearchTaskIterations(payload);

  if (!researchTask || researchIterations.length === 0) {
    return buildReportContent({
      answer,
      goal,
    });
  }

  return [
    `Goal: ${goal || "Research dossier"}`,
    "",
    "## Research Flow",
    "",
    ...toArray(researchTask.phases).map((phase) => {
      const status = normalizeText(phase.status, 80) || "pending";

      return `- ${normalizeText(phase.label, 120)}: ${status}`;
    }),
    "",
    "## Findings",
    "",
    ...researchIterations.flatMap((iteration) => {
      const phase = normalizeRecord(iteration.researchTaskPhase);
      const citations = toArray(iteration.citations);

      return [
        `### ${normalizeText(phase.label, 120) || "Research step"}`,
        "",
        normalizeText(iteration.answer, MAX_CONTENT_LENGTH) ||
          "No answer text was recorded for this step.",
        "",
        citations.length > 0
          ? `Citation count: ${citations.length}`
          : "Citation count: 0",
        "",
      ];
    }),
    "## Final Answer",
    "",
    answer || "The agent completed the dossier without a final text answer.",
  ]
    .join("\n")
    .trim();
};

const buildSpec = ({
  artifactType,
  capabilityId,
  input = {},
  label,
  sourceRunId = "",
  sourceTaskId = "",
  title,
} = {}) => {
  const id = `${artifactType}:${capabilityId}`;
  const canonicalArtifactType = ARTIFACT_TYPES_BY_CAPABILITY[capabilityId];

  return {
    ...(canonicalArtifactType
      ? {
          artifactExecution: {
            artifactType: canonicalArtifactType,
            idempotencyKey: buildCapabilityArtifactIdempotencyKey({
              namespace: "goal-deliverable",
              parts: [sourceTaskId, id],
            }),
            sourceRunId: normalizeText(sourceRunId, 120),
            sourceTaskId: normalizeText(sourceTaskId, 160),
          },
        }
      : {}),
    id,
    artifactType,
    capabilityId,
    input: normalizeRecord(input),
    label: normalizeText(label, 120),
    status: AGENT_GOAL_DELIVERABLE_STATUSES.waitingForApproval,
    title: normalizeText(title, 160),
  };
};

export const buildAgentGoalDeliverableSpecs = ({
  body = {},
  payload = {},
  sourceTaskId = "",
} = {}) => {
  const goal = getGoal({
    payload,
  });
  const answer = getFinalAnswer({
    body,
    payload,
  });
  const docIds = normalizeDocIds(payload.docIds);
  const citations = getAllCitations({
    body,
    payload,
  });
  const baseTitle = buildBaseTitle(goal);
  const content = buildDossierContent({
    answer,
    goal,
    payload,
  });
  const sourceRunId = getAgentRunId({
    body,
    payload,
  });
  const specs = [];

  if (wantsOrganization(goal)) {
    specs.push(
      buildSpec({
        artifactType: "document_organization",
        capabilityId: CAPABILITY_IDS.documentOrganize,
        input: {
          docIds,
          strategy: "profile_tags",
          title: `${baseTitle} organization`,
        },
        label: "Document organization",
        sourceRunId,
        sourceTaskId,
        title: `${baseTitle} organization`,
      })
    );
  }

  if (wantsReport(goal)) {
    specs.push(
      buildSpec({
        artifactType: "markdown_report",
        capabilityId: CAPABILITY_IDS.reportExport,
        input: {
          citations,
          content,
          format: "markdown",
          metadata: buildMetadata({
            body,
            payload,
            type: "markdown_report",
          }),
          title: `${baseTitle} report`,
        },
        label: "Markdown report",
        sourceRunId,
        sourceTaskId,
        title: `${baseTitle} report`,
      })
    );
  }

  if (wantsSavedSummary(goal)) {
    specs.push(
      buildSpec({
        artifactType: "saved_summary",
        capabilityId: CAPABILITY_IDS.summaryCreate,
        input: {
          citations,
          docIds,
          metadata: buildMetadata({
            body,
            payload,
            type: "saved_summary",
          }),
          summary: content || answer || goal,
          title: `${baseTitle} summary`,
        },
        label: "Saved summary",
        sourceRunId,
        sourceTaskId,
        title: `${baseTitle} summary`,
      })
    );
  }

  if (wantsFollowUpTask(goal)) {
    specs.push(
      buildSpec({
        artifactType: "follow_up_task",
        capabilityId: CAPABILITY_IDS.taskCreate,
        input: {
          description:
            answer ||
            `Review the completed agent goal and capture follow-up actions: ${goal}`,
          priority: wantsReport(goal) ? "medium" : "",
          tags: ["agent-goal", "follow-up"].filter(Boolean),
          title: `Review follow-ups for ${baseTitle}`,
        },
        label: "Follow-up task",
        title: `Review follow-ups for ${baseTitle}`,
      })
    );
  }

  return specs;
};

const compactInputPreview = (input = {}) => ({
  docIds: normalizeDocIds(input.docIds),
  format: normalizeText(input.format, 40),
  provider: normalizeText(input.provider, 80),
  sourceUrl: normalizeText(input.sourceUrl, 160),
  title: normalizeText(input.title, 160),
});

const buildApprovalGate = ({ capability = {}, spec = {} } = {}) => ({
  id: `deliverable:${normalizeText(spec.id, 160)}`,
  type: "goal_deliverable_approval",
  status: "pending",
  capabilityId: normalizeText(spec.capabilityId, 120),
  capabilityVersion: normalizeText(capability.version, 80),
  capabilityLabel: normalizeText(capability.label || spec.label, 120),
  inputPreview: Object.fromEntries(
    Object.entries(compactInputPreview(spec.input)).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : Boolean(value)
    )
  ),
  policy: {
    externalCall: Boolean(capability.privacyPolicy?.externalCall),
    storesResult: Boolean(capability.privacyPolicy?.storesResult),
    writesWorkspace: Boolean(capability.approvalPolicy?.writesWorkspace),
  },
  reason: "Approval is required before the agent creates goal deliverables.",
  riskFlags: [
    capability.approvalPolicy?.writesWorkspace ? "writes_workspace" : null,
    capability.privacyPolicy?.storesResult ? "stores_result" : null,
    capability.privacyPolicy?.externalCall ? "external_call" : null,
  ].filter(Boolean),
});

const buildApprovalGates = ({ capabilityRegistry, specs = [] } = {}) =>
  specs.map((spec) =>
    buildApprovalGate({
      capability: capabilityRegistry?.describe?.(spec.capabilityId) ?? {},
      spec,
    })
  );

export const prepareAgentGoalDeliverables = ({
  body = {},
  capabilityRegistry,
  payload = {},
  sourceTaskId = "",
} = {}) => {
  const existing = normalizeRecord(payload.deliverables, null);

  if (existing) {
    return existing;
  }

  const specs = buildAgentGoalDeliverableSpecs({
    body,
    payload,
    sourceTaskId,
  });

  if (specs.length === 0) {
    return {
      approvalGates: [],
      results: [],
      specs: [],
      status: AGENT_GOAL_DELIVERABLE_STATUSES.notRequested,
    };
  }

  return {
    approvalGates: buildApprovalGates({
      capabilityRegistry,
      specs,
    }),
    results: [],
    specs,
    status: AGENT_GOAL_DELIVERABLE_STATUSES.waitingForApproval,
  };
};

const getCapabilityText = (result = {}) =>
  normalizeText(result.text || result.message || result.summary);

const compactReportOutput = (result = {}) => {
  const report = normalizeRecord(result.report, null);

  if (!report) {
    return {};
  }

  return {
    fileName: normalizeText(report.fileName, 160),
    format: normalizeText(report.format, 40),
    mimeType: normalizeText(report.mimeType, 80),
    stored: result.stored === true,
  };
};

const compactTaskOutput = (task = {}) => ({
  taskId: normalizeText(task.id, 160),
  status: normalizeText(task.status, 80),
  summary: normalizeText(task.summary),
  type: normalizeText(task.type, 80),
});

const compactArtifactOutput = (artifact = {}) => ({
  artifactId: normalizeText(artifact.artifactId, 180),
  artifactType: normalizeText(artifact.artifactType, 80),
  fileName: normalizeText(artifact.fileName, 160),
  format: normalizeText(artifact.format, 40),
  mimeType: normalizeText(artifact.mimeType, 120),
  sourceRunId: normalizeText(artifact.sourceRunId, 120),
  sourceTaskId: normalizeText(artifact.sourceTaskId, 160),
  status: normalizeText(artifact.status, 80),
  title: normalizeText(artifact.title, 160),
});

const hasStoredArtifactReference = ({ artifact = {}, capabilityId } = {}) =>
  Boolean(
    normalizeText(artifact.artifactId, 180) &&
      normalizeText(artifact.artifactType, 80) ===
        ARTIFACT_TYPES_BY_CAPABILITY[capabilityId] &&
      Object.values(ARTIFACT_STATUSES).includes(
        normalizeText(artifact.status, 80)
      )
  );

const compactCapabilityOutput = ({ capabilityId, result = {} } = {}) => {
  if (capabilityId === CAPABILITY_IDS.reportExport) {
    return {
      ...compactReportOutput(result),
      ...compactArtifactOutput(result.artifact),
    };
  }

  if (capabilityId === CAPABILITY_IDS.documentOrganize) {
    return {
      ...compactArtifactOutput(result.artifact),
      documentCount: result.organization?.documentCount ?? 0,
      groupCount: toArray(result.organization?.groups).length,
      task: compactTaskOutput(result.task),
    };
  }

  if (capabilityId === CAPABILITY_IDS.summaryCreate) {
    return {
      ...compactArtifactOutput(result.artifact),
      docIds: normalizeDocIds(result.summary?.docIds),
      task: compactTaskOutput(result.task),
      title: normalizeText(result.summary?.title, 160),
    };
  }

  if (capabilityId === CAPABILITY_IDS.taskCreate) {
    return {
      task: compactTaskOutput(result.task),
      title: normalizeText(result.task?.label || result.task?.result?.title, 160),
    };
  }

  if (capabilityId === CAPABILITY_IDS.externalImport) {
    return {
      importResult: normalizeRecord(result.importResult, null),
      provider: normalizeText(result.importRequest?.provider, 80),
      task: compactTaskOutput(result.task),
    };
  }

  return {};
};

const completeSpec = ({ result = {}, spec = {} } = {}) => ({
  ...spec,
  output: compactCapabilityOutput({
    capabilityId: spec.capabilityId,
    result,
  }),
  status: AGENT_GOAL_DELIVERABLE_STATUSES.completed,
  summary: getCapabilityText(result) || `${spec.label} created.`,
});

const failSpec = ({ error, spec = {} } = {}) => ({
  ...spec,
  error: error instanceof Error ? error.message : String(error),
  status: AGENT_GOAL_DELIVERABLE_STATUSES.failed,
  summary: `${spec.label} failed.`,
});

const getOverallStatus = (results = []) =>
  results.some((result) => result.status === AGENT_GOAL_DELIVERABLE_STATUSES.failed)
    ? AGENT_GOAL_DELIVERABLE_STATUSES.failed
    : AGENT_GOAL_DELIVERABLE_STATUSES.completed;

export const executeAgentGoalDeliverables = async ({
  accessScope = {},
  approval = {},
  capabilityRegistry,
  deliverables = {},
} = {}) => {
  const specs = toArray(deliverables.specs);
  const results = [];

  if (specs.length === 0) {
    return {
      ...deliverables,
      results,
      status: AGENT_GOAL_DELIVERABLE_STATUSES.notRequested,
    };
  }

  if (!capabilityRegistry?.execute) {
    throw new Error("Capability registry is required to create goal deliverables.");
  }

  for (const spec of specs) {
    try {
      const result = await capabilityRegistry.execute(spec.capabilityId, {
        accessScope,
        approval,
        input: spec.input,
        services: spec.artifactExecution
          ? {
              artifactExecution: spec.artifactExecution,
            }
          : {},
      });

      if (
        ARTIFACT_TYPES_BY_CAPABILITY[spec.capabilityId] &&
        !hasStoredArtifactReference({
          artifact: result.artifact,
          capabilityId: spec.capabilityId,
        })
      ) {
        throw new Error(
          `${spec.label} did not return a stored workspace artifact reference.`
        );
      }

      results.push(
        completeSpec({
          result,
          spec,
        })
      );
    } catch (error) {
      results.push(
        failSpec({
          error,
          spec,
        })
      );
    }
  }

  return {
    ...deliverables,
    approvalGates: [],
    results,
    specs,
    status: getOverallStatus(results),
  };
};

export const compactAgentGoalDeliverables = (deliverables = {}) => {
  const status = normalizeText(deliverables.status, 80);
  const planned = toArray(deliverables.specs).map((spec) => ({
    artifactType: normalizeText(spec.artifactType, 80),
    capabilityId: normalizeText(spec.capabilityId, 120),
    id: normalizeText(spec.id, 160),
    label: normalizeText(spec.label, 120),
    status: normalizeText(spec.status || status, 80),
    title: normalizeText(spec.title, 160),
  }));
  const results = toArray(deliverables.results).map((result) => ({
    artifactType: normalizeText(result.artifactType, 80),
    capabilityId: normalizeText(result.capabilityId, 120),
    error: result.error ?? null,
    id: normalizeText(result.id, 160),
    label: normalizeText(result.label, 120),
    output: normalizeRecord(result.output),
    status: normalizeText(result.status, 80),
    summary: normalizeText(result.summary),
    title: normalizeText(result.title, 160),
  }));

  return {
    approvalRequired:
      status === AGENT_GOAL_DELIVERABLE_STATUSES.waitingForApproval,
    counts: {
      completed: results.filter(
        (result) =>
          result.status === AGENT_GOAL_DELIVERABLE_STATUSES.completed
      ).length,
      failed: results.filter(
        (result) => result.status === AGENT_GOAL_DELIVERABLE_STATUSES.failed
      ).length,
      planned: planned.length,
    },
    items: results.length > 0 ? results : planned,
    status: status || AGENT_GOAL_DELIVERABLE_STATUSES.notRequested,
  };
};

export const getDeliverableTaskStatus = (deliverables = {}) => {
  if (deliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.failed) {
    return TASK_STATUSES.failed;
  }

  if (deliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.completed) {
    return TASK_STATUSES.completed;
  }

  if (
    deliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.waitingForApproval
  ) {
    return TASK_STATUSES.waitingForUser;
  }

  if (
    deliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.running ||
    deliverables.status === AGENT_GOAL_DELIVERABLE_STATUSES.approved
  ) {
    return TASK_STATUSES.running;
  }

  return TASK_STATUSES.pending;
};
