import { createResearchDossierWorkflowSpec } from "./built-ins/research-dossier.js";
import {
  normalizeAgentWorkflowSpec,
  validateAgentWorkflowSpec,
} from "./schema.js";

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const cloneWorkflowSpec = (workflow = {}) =>
  JSON.parse(JSON.stringify(workflow ?? {}));

export const createBuiltInAgentWorkflows = () => [
  createResearchDossierWorkflowSpec(),
];

const buildRegistryError = ({ errors = [], workflow = {} } = {}) => {
  const error = new Error(
    `Invalid agent workflow ${workflow.id || "unknown"}: ${errors.join(", ")}`
  );

  error.errors = errors;
  return error;
};

const compileTriggerPattern = (pattern = {}) => {
  try {
    return new RegExp(pattern.source, pattern.flags);
  } catch {
    return null;
  }
};

const workflowMatchesQuestion = (workflow = {}, question = "") => {
  const normalizedQuestion = normalizeText(question).toLowerCase();

  if (!normalizedQuestion) {
    return false;
  }

  if (
    toArray(workflow.trigger?.keywords).some((keyword) =>
      normalizedQuestion.includes(normalizeText(keyword).toLowerCase())
    )
  ) {
    return true;
  }

  return toArray(workflow.trigger?.patterns).some((pattern) => {
    const matcher = compileTriggerPattern(pattern);

    return matcher ? matcher.test(question) : false;
  });
};

export const createAgentWorkflowRegistry = ({
  workflows = createBuiltInAgentWorkflows(),
} = {}) => {
  const workflowMap = new Map();

  const register = (workflow = {}) => {
    const validation = validateAgentWorkflowSpec(workflow);

    if (!validation.valid) {
      throw buildRegistryError({
        errors: validation.errors,
        workflow: validation.spec,
      });
    }

    workflowMap.set(validation.spec.id, validation.spec);

    return cloneWorkflowSpec(validation.spec);
  };

  for (const workflow of workflows) {
    register(workflow);
  }

  return {
    get(workflowId) {
      const workflow = workflowMap.get(normalizeText(workflowId));

      return workflow ? cloneWorkflowSpec(workflow) : null;
    },

    list() {
      return [...workflowMap.values()].map(cloneWorkflowSpec);
    },

    register,

    select({ question = "", workflowId = "" } = {}) {
      const requestedWorkflowId = normalizeText(workflowId);

      if (requestedWorkflowId) {
        return this.get(requestedWorkflowId);
      }

      const workflow = [...workflowMap.values()].find((candidate) =>
        workflowMatchesQuestion(candidate, question)
      );

      return workflow ? cloneWorkflowSpec(workflow) : null;
    },
  };
};

export const createDefaultAgentWorkflowRegistry = () =>
  createAgentWorkflowRegistry();

export {
  normalizeAgentWorkflowSpec,
  validateAgentWorkflowSpec,
} from "./schema.js";
