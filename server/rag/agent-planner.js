export const SKILL_CHAIN_MODE = "skill_chain";

const MAX_CLARIFICATION_DOCUMENTS = 12;

const normalizeText = (value) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : "";

export const buildPreExecutionClarification = ({ plan, docIds = [] } = {}) => {
  if (plan.wantsCompareDocuments && docIds.length < 2) {
    return {
      reason: "comparison_requires_multiple_documents",
      summary: "The comparison request needs at least two selected documents.",
      question:
        "Which two or more documents should I compare? Select the documents, then send the comparison request again.",
      detail: {
        selectedDocumentCount: docIds.length,
        requiredDocumentCount: 2,
      },
    };
  }

  if (plan.requiresDocuments && docIds.length === 0) {
    return {
      reason: "missing_required_documents",
      summary: "The request needs selected document context before the agent can answer.",
      question:
        "Which document should I use for this request? Select at least one document, then send the request again.",
      detail: {
        selectedDocumentCount: 0,
        requiredDocumentCount: 1,
      },
    };
  }

  if (plan.requiresDocuments && docIds.length > MAX_CLARIFICATION_DOCUMENTS) {
    return {
      reason: "too_many_documents",
      summary: "The request has too many selected documents to answer reliably without narrowing scope.",
      question: `You selected ${docIds.length} documents. Which ${MAX_CLARIFICATION_DOCUMENTS} or fewer should I focus on for this request?`,
      detail: {
        selectedDocumentCount: docIds.length,
        maxDocumentCount: MAX_CLARIFICATION_DOCUMENTS,
      },
    };
  }

  return null;
};

export const orderSelectedSkills = ({ selectedSkills = [], plan = {} } = {}) => {
  if (!Array.isArray(plan.skillChain) || plan.skillChain.length === 0) {
    return selectedSkills;
  }

  const byId = new Map(selectedSkills.map((skill) => [skill.id, skill]));
  const chainSkills = plan.skillChain
    .map((skillId) => byId.get(skillId))
    .filter(Boolean);
  const chainIds = new Set(chainSkills.map((skill) => skill.id));
  const remainingSkills = selectedSkills.filter((skill) => !chainIds.has(skill.id));

  return [...chainSkills, ...remainingSkills];
};

export const buildSkillChainSummary = ({ chainSkills = [] } = {}) =>
  `Chained ${chainSkills.length} skill${chainSkills.length === 1 ? "" : "s"}: ${
    chainSkills.map((skill) => skill.label).join(" -> ")
  }.`;

export const buildChainedSkillQuestion = ({
  question,
  previousResults = [],
} = {}) => {
  const usableResults = previousResults
    .filter((result) => result?.ok && normalizeText(result.text))
    .slice(-3);

  if (usableResults.length === 0) {
    return question;
  }

  return [
    "Continue the same agent task using previous skill outputs as context.",
    `Original request: ${normalizeText(question)}`,
    "Previous skill outputs:",
    ...usableResults.map((result) =>
      [
        `${result.label}:`,
        normalizeText(result.text),
      ].join("\n")
    ),
    "Use previous outputs to avoid repeating work, but verify every final claim against selected document citations.",
  ].join("\n\n");
};

export const buildPlannerActions = ({ plan, docIds, skills }) => {
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
