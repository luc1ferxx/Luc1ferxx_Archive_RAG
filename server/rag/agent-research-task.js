export const AGENT_RESEARCH_TASK_VERSION = "1.0.0";
export const AGENT_RESEARCH_TASK_TYPE = "research_task";

const MAX_TEXT_LENGTH = 320;

const normalizeText = (value, maxLength = MAX_TEXT_LENGTH) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeDocIds = (value) =>
  toArray(value).map((item) => normalizeText(item)).filter(Boolean);

const RESEARCH_TASK_PATTERN =
  /\b(research[_\s-]?task|dossier|deep research|research report|risk report)\b|研究型任务|研究任务|研究档案|调研报告|风险报告|深度研究/i;

const isClarificationResponse = (body = {}) =>
  body.clarification?.needed === true || body.agentMode === "clarification";

export const isResearchTaskGoal = ({ question = "" } = {}) =>
  RESEARCH_TASK_PATTERN.test(normalizeText(question));

const buildPhase = ({
  expectedCapability = "",
  expectedSkill = "",
  id,
  label,
  question,
  summary,
} = {}) => ({
  expectedCapability: normalizeText(expectedCapability, 120),
  expectedSkill: normalizeText(expectedSkill, 120),
  id: normalizeText(id, 80),
  label: normalizeText(label, 120),
  question: normalizeText(question, 1000),
  status: "pending",
  summary: normalizeText(summary),
});

const buildLocalResearchQuestion = ({ goal = "" } = {}) =>
  [
    "Create a document-grounded research brief for this dossier.",
    "Use the selected local documents first. Extract key findings, cited evidence, conflicts, and unresolved gaps.",
    "Do not use web or arXiv in this step.",
    `Original goal: ${goal}`,
  ].join("\n\n");

const buildWebSupplementQuestion = ({ goal = "" } = {}) =>
  [
    "Search the web for current external context that can supplement this research dossier.",
    "Use web context only for freshness or external validation. Keep document evidence separate from web context.",
    "Return concise findings, source links, and any uncertainty.",
    `Original goal: ${goal}`,
  ].join("\n\n");

const buildArxivSupplementQuestion = ({ goal = "" } = {}) =>
  [
    "Search arXiv and import the most relevant papers for this research dossier topic.",
    "Keep the import narrow and relevant to the original goal.",
    `Topic and goal: ${goal}`,
  ].join("\n\n");

const buildCompareRiskQuestion = ({ docIds = [], goal = "" } = {}) => {
  if (docIds.length > 1) {
    return [
      "Compare the selected documents, then perform a citation-backed risk review.",
      "Identify common ground, differences, conflicts, missing terms, risks, gaps, exceptions, and evidence limits.",
      "Every evidence-backed bullet must include document citations.",
      `Original goal: ${goal}`,
    ].join("\n\n");
  }

  return [
    "Perform a citation-backed risk review for the selected document.",
    "Identify risks, gaps, conflicts, exceptions, missing terms, uncertainty, and evidence limits.",
    "Every evidence-backed bullet must include document citations.",
    `Original goal: ${goal}`,
  ].join("\n\n");
};

const buildCitationCheckQuestion = ({ goal = "" } = {}) =>
  [
    "Run a citation self-check for this research dossier.",
    "Verify which claims are supported by selected document citations, which claims remain unsupported, and what gaps are unresolved.",
    "Return only supported claims, unsupported claims, unresolved gaps, and recommended follow-up retrieval questions.",
    `Original goal: ${goal}`,
  ].join("\n\n");

const buildFinalDossierQuestion = ({ goal = "" } = {}) =>
  [
    "Create the final research dossier answer.",
    "Synthesize the local document research, external context, arXiv supplement, compare/risk review, and citation self-check into a concise cited dossier.",
    "Keep document-cited claims separate from web/arXiv context when evidence types differ. Do not invent unsupported claims.",
    "End with unresolved gaps and follow-up actions.",
    `Original goal: ${goal}`,
  ].join("\n\n");

const buildResearchTaskPhases = ({ docIds = [], goal = "" } = {}) => [
  buildPhase({
    expectedSkill: "research_brief",
    id: "local_research",
    label: "Local document research",
    question: buildLocalResearchQuestion({
      goal,
    }),
    summary: "Search selected local documents and build a cited research brief.",
  }),
  buildPhase({
    expectedCapability: "web.search",
    id: "web_supplement",
    label: "Web supplement",
    question: buildWebSupplementQuestion({
      goal,
    }),
    summary: "Use current web context as supplemental, separately labeled evidence.",
  }),
  buildPhase({
    expectedCapability: "arxiv.import_topic",
    id: "arxiv_supplement",
    label: "arXiv supplement",
    question: buildArxivSupplementQuestion({
      goal,
    }),
    summary: "Search/import relevant arXiv papers for the dossier topic.",
  }),
  buildPhase({
    expectedSkill: docIds.length > 1 ? "compare_documents>risk_review" : "risk_review",
    id: "compare_risk_review",
    label: docIds.length > 1 ? "Compare and risk review" : "Risk review",
    question: buildCompareRiskQuestion({
      docIds,
      goal,
    }),
    summary:
      docIds.length > 1
        ? "Compare selected documents, then review risks and gaps."
        : "Review risks and gaps in the selected document.",
  }),
  buildPhase({
    expectedSkill: "document_rag",
    id: "citation_self_check",
    label: "Citation self-check",
    question: buildCitationCheckQuestion({
      goal,
    }),
    summary: "Check supported claims, unsupported claims, and unresolved gaps.",
  }),
  buildPhase({
    expectedSkill: "document_rag",
    id: "final_dossier",
    label: "Final dossier",
    question: buildFinalDossierQuestion({
      goal,
    }),
    summary: "Synthesize the final cited dossier before report export.",
  }),
];

const getFirstPendingPhase = (phases = []) =>
  phases.find((phase) => phase.status === "pending") ?? null;

const getPhaseIndex = ({ phases = [], phaseId = "" } = {}) =>
  phases.findIndex((phase) => phase.id === phaseId);

export const createResearchTaskFlow = ({
  docIds = [],
  question = "",
} = {}) => {
  const goal = normalizeText(question);

  if (!isResearchTaskGoal({
    question: goal,
  })) {
    return null;
  }

  const normalizedDocIds = normalizeDocIds(docIds);
  const phases = buildResearchTaskPhases({
    docIds: normalizedDocIds,
    goal,
  });
  const firstPhase = phases[0] ?? null;

  return {
    version: AGENT_RESEARCH_TASK_VERSION,
    type: AGENT_RESEARCH_TASK_TYPE,
    goal,
    status: firstPhase ? "running" : "completed",
    currentPhaseId: firstPhase?.id ?? null,
    docIds: normalizedDocIds,
    phases: firstPhase
      ? [
          {
            ...firstPhase,
            status: "running",
          },
          ...phases.slice(1),
        ]
      : [],
    maxIterations: Math.min(phases.length + 4, 10),
  };
};

export const normalizeResearchTaskFlow = (flow = null) => {
  const normalizedFlow = normalizeRecord(flow, null);

  if (!normalizedFlow) {
    return null;
  }

  const phases = toArray(normalizedFlow.phases)
    .map((phase) => ({
      expectedCapability: normalizeText(phase.expectedCapability, 120),
      expectedSkill: normalizeText(phase.expectedSkill, 120),
      id: normalizeText(phase.id, 80),
      label: normalizeText(phase.label, 120),
      question: normalizeText(phase.question, 1000),
      status: normalizeText(phase.status, 80) || "pending",
      summary: normalizeText(phase.summary),
    }))
    .filter((phase) => phase.id);
  const currentPhaseId =
    normalizeText(normalizedFlow.currentPhaseId, 80) ||
    phases.find((phase) => phase.status === "running")?.id ||
    getFirstPendingPhase(phases)?.id ||
    null;

  return {
    version: normalizeText(normalizedFlow.version, 40) || AGENT_RESEARCH_TASK_VERSION,
    type: normalizeText(normalizedFlow.type, 80) || AGENT_RESEARCH_TASK_TYPE,
    goal: normalizeText(normalizedFlow.goal),
    status: normalizeText(normalizedFlow.status, 80) || "running",
    currentPhaseId,
    docIds: normalizeDocIds(normalizedFlow.docIds),
    phases,
    maxIterations: Number.isFinite(Number(normalizedFlow.maxIterations))
      ? Number(normalizedFlow.maxIterations)
      : Math.min(phases.length + 4, 10),
  };
};

export const getResearchTaskActivePhase = (flow = null) => {
  const normalizedFlow = normalizeResearchTaskFlow(flow);

  if (!normalizedFlow || normalizedFlow.status !== "running") {
    return null;
  }

  return (
    normalizedFlow.phases.find(
      (phase) => phase.id === normalizedFlow.currentPhaseId
    ) ??
    normalizedFlow.phases.find((phase) => phase.status === "running") ??
    getFirstPendingPhase(normalizedFlow.phases)
  );
};

export const getResearchTaskQuestion = (flow = null) =>
  normalizeText(getResearchTaskActivePhase(flow)?.question, 1000);

export const getResearchTaskIterationPhase = (flow = null) => {
  const phase = getResearchTaskActivePhase(flow);

  return phase
    ? {
        expectedCapability: phase.expectedCapability,
        expectedSkill: phase.expectedSkill,
        id: phase.id,
        label: phase.label,
        summary: phase.summary,
      }
    : null;
};

export const advanceResearchTaskFlow = ({
  body = {},
  flow = null,
  responseStatus = 200,
} = {}) => {
  const normalizedFlow = normalizeResearchTaskFlow(flow);
  const activePhase = getResearchTaskActivePhase(normalizedFlow);

  if (!normalizedFlow || !activePhase) {
    return normalizedFlow;
  }

  if (responseStatus >= 400 || isClarificationResponse(body)) {
    return normalizedFlow;
  }

  const activeIndex = getPhaseIndex({
    phases: normalizedFlow.phases,
    phaseId: activePhase.id,
  });
  const phases = normalizedFlow.phases.map((phase, index) => {
    if (index < activeIndex || phase.status === "completed") {
      return {
        ...phase,
        status: "completed",
      };
    }

    if (index === activeIndex) {
      return {
        ...phase,
        status: "completed",
      };
    }

    return {
      ...phase,
      status: "pending",
    };
  });
  const nextPhase = phases.find((phase) => phase.status === "pending") ?? null;

  if (!nextPhase) {
    return {
      ...normalizedFlow,
      currentPhaseId: null,
      phases,
      status: "completed",
    };
  }

  return {
    ...normalizedFlow,
    currentPhaseId: nextPhase.id,
    phases: phases.map((phase) =>
      phase.id === nextPhase.id
        ? {
            ...phase,
            status: "running",
          }
        : phase
    ),
    status: "running",
  };
};

export const shouldContinueResearchTask = (flow = null) =>
  Boolean(getResearchTaskQuestion(flow));

export const compactResearchTaskFlow = (flow = null) => {
  const normalizedFlow = normalizeResearchTaskFlow(flow);

  if (!normalizedFlow) {
    return null;
  }

  return {
    version: normalizedFlow.version,
    type: normalizedFlow.type,
    goal: normalizedFlow.goal,
    status: normalizedFlow.status,
    currentPhaseId: normalizedFlow.currentPhaseId,
    counts: {
      completed: normalizedFlow.phases.filter(
        (phase) => phase.status === "completed"
      ).length,
      total: normalizedFlow.phases.length,
    },
    phases: normalizedFlow.phases.map((phase) => ({
      expectedCapability: phase.expectedCapability,
      expectedSkill: phase.expectedSkill,
      id: phase.id,
      label: phase.label,
      status: phase.status,
      summary: phase.summary,
    })),
  };
};
