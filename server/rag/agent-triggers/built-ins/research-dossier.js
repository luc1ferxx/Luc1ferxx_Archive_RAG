import { AGENT_TASK_RUNNER_ID } from "../../agent-task-contract.js";
import { RESEARCH_DOSSIER_WORKFLOW_ID } from "../../agent-workflows/built-ins/research-dossier.js";
import {
  AGENT_TRIGGER_APPROVAL_MODES,
  AGENT_TRIGGER_MODES,
  AGENT_TRIGGER_SPEC_VERSION,
  AGENT_TRIGGER_TYPE,
} from "../schema.js";

export const RESEARCH_DOSSIER_TRIGGER_ID = "research_dossier_manual";

const buildQuestionTemplate = (...parts) => parts;

export const createResearchDossierTriggerSpec = () => ({
  id: RESEARCH_DOSSIER_TRIGGER_ID,
  version: AGENT_TRIGGER_SPEC_VERSION,
  type: AGENT_TRIGGER_TYPE,
  label: "Research dossier trigger",
  description:
    "Create a scoped durable agent goal for the built-in research dossier workflow.",
  enabled: true,
  trigger: {
    mode: AGENT_TRIGGER_MODES.manual,
    input: {
      required: ["question"],
      optional: ["docIds", "maxIterations", "sessionId", "userPreferences", "userId"],
    },
  },
  target: {
    runnerId: AGENT_TASK_RUNNER_ID,
    workflowId: RESEARCH_DOSSIER_WORKFLOW_ID,
    questionTemplate: buildQuestionTemplate(
      "research_task: {{question}}"
    ),
    defaultInput: {
      maxIterations: 10,
    },
  },
  scopePolicy: {
    requiresUserId: true,
    requiresWorkspaceId: true,
  },
  approvalPolicy: {
    mode: AGENT_TRIGGER_APPROVAL_MODES.userConfirmation,
    requiresApproval: true,
  },
  idempotency: {
    keyTemplate: "{{triggerId}}:{{request.id}}",
    requiredFields: ["request.id"],
  },
  privacyPolicy: {
    allowedPayloadFields: [
      "question",
      "docIds",
      "maxIterations",
      "sessionId",
      "userPreferences",
      "userId",
    ],
    redactedFields: [
      "apiKey",
      "authorization",
      "cookie",
      "password",
      "secret",
      "token",
    ],
    storesRawPayload: false,
  },
  metadata: {
    source: "built_in",
  },
});
