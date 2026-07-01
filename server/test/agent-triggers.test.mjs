import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_TASK_RUNNER_ID } from "../rag/agent-task-contract.js";
import { RESEARCH_DOSSIER_WORKFLOW_ID } from "../rag/agent-workflows/built-ins/research-dossier.js";
import {
  AGENT_TRIGGER_APPROVAL_MODES,
  AGENT_TRIGGER_MODES,
  RESEARCH_DOSSIER_TRIGGER_ID,
  compactAgentTriggerSpec,
  createAgentTriggerRegistry,
  createBuiltInAgentTriggers,
  createDefaultAgentTriggerRegistry,
  createResearchDossierTriggerSpec,
  renderAgentTriggerTemplate,
  validateAgentTriggerSpec,
} from "../rag/agent-triggers/index.js";

const buildEventTriggerSpec = (overrides = {}) => ({
  ...createResearchDossierTriggerSpec(),
  id: "github_research_dossier",
  label: "GitHub research dossier",
  trigger: {
    mode: AGENT_TRIGGER_MODES.event,
    event: {
      eventType: "issue.opened",
      requiredFields: ["event.id", "question"],
      source: "github",
    },
    input: {
      required: ["question"],
      optional: ["docIds"],
    },
  },
  approvalPolicy: {
    mode: AGENT_TRIGGER_APPROVAL_MODES.ownerApproved,
    requiresApproval: false,
  },
  idempotency: {
    keyTemplate: "{{triggerId}}:{{event.id}}",
    requiredFields: ["event.id"],
  },
  ...overrides,
});

test("research dossier trigger spec validates as dispatch-only contract data", () => {
  const trigger = createResearchDossierTriggerSpec();
  const validation = validateAgentTriggerSpec(trigger);

  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(validation.spec.id, RESEARCH_DOSSIER_TRIGGER_ID);
  assert.equal(validation.spec.type, "agent_trigger");
  assert.equal(validation.spec.trigger.mode, AGENT_TRIGGER_MODES.manual);
  assert.equal(validation.spec.target.runnerId, AGENT_TASK_RUNNER_ID);
  assert.equal(validation.spec.target.workflowId, RESEARCH_DOSSIER_WORKFLOW_ID);
  assert.deepEqual(validation.spec.trigger.input.required, ["question"]);
  assert.equal(validation.spec.scopePolicy.requiresUserId, true);
  assert.equal(validation.spec.scopePolicy.requiresWorkspaceId, true);
  assert.equal(
    renderAgentTriggerTemplate(validation.spec.target.questionTemplate, {
      question: "Build a risk report",
      triggerId: validation.spec.id,
    }),
    "research_task: Build a risk report"
  );
  assert.doesNotThrow(() => JSON.stringify(validation.spec));
});

test("trigger public projection hides execution templates and default input", () => {
  const trigger = createResearchDossierTriggerSpec();
  const publicSpec = compactAgentTriggerSpec(trigger);
  const publicJson = JSON.stringify(publicSpec);

  assert.equal(publicSpec.id, RESEARCH_DOSSIER_TRIGGER_ID);
  assert.deepEqual(publicSpec.target, {
    runnerId: AGENT_TASK_RUNNER_ID,
    workflowId: RESEARCH_DOSSIER_WORKFLOW_ID,
  });
  assert.equal(publicSpec.target.questionTemplate, undefined);
  assert.equal(publicSpec.target.defaultInput, undefined);
  assert.equal(publicSpec.idempotency.hasKeyTemplate, true);
  assert.doesNotMatch(publicJson, /questionTemplate/);
  assert.doesNotMatch(publicJson, /research_task/);
  assert.doesNotMatch(publicJson, /defaultInput/);
});

test("default trigger registry lists and selects built-ins without exposing mutable state", () => {
  const registry = createDefaultAgentTriggerRegistry();
  const selected = registry.select({
    triggerId: RESEARCH_DOSSIER_TRIGGER_ID,
  });

  assert.equal(selected.id, RESEARCH_DOSSIER_TRIGGER_ID);
  assert.equal(
    registry.select({ mode: AGENT_TRIGGER_MODES.manual }).id,
    RESEARCH_DOSSIER_TRIGGER_ID
  );

  selected.label = "Mutated trigger";

  assert.equal(
    registry.get(RESEARCH_DOSSIER_TRIGGER_ID).label,
    "Research dossier trigger"
  );
  assert.deepEqual(
    registry.list().map((trigger) => trigger.id),
    [RESEARCH_DOSSIER_TRIGGER_ID]
  );
  assert.deepEqual(
    registry.listPublic().map((trigger) => trigger.id),
    [RESEARCH_DOSSIER_TRIGGER_ID]
  );
  assert.deepEqual(
    createBuiltInAgentTriggers().map((trigger) => trigger.id),
    [RESEARCH_DOSSIER_TRIGGER_ID]
  );
});

test("event trigger contracts select by event source and type only when enabled", () => {
  const eventTrigger = buildEventTriggerSpec();
  const disabledTrigger = buildEventTriggerSpec({
    enabled: false,
    id: "disabled_github_research_dossier",
    trigger: {
      ...eventTrigger.trigger,
      event: {
        ...eventTrigger.trigger.event,
        eventType: "issue.closed",
      },
    },
  });
  const validation = validateAgentTriggerSpec(eventTrigger);
  const registry = createAgentTriggerRegistry({
    triggers: [eventTrigger, disabledTrigger],
  });

  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(
    registry.select({
      event: {
        eventType: "issue.opened",
        source: "github",
      },
      mode: AGENT_TRIGGER_MODES.event,
    }).id,
    "github_research_dossier"
  );
  assert.equal(
    registry.select({
      event: {
        eventType: "issue.closed",
        source: "github",
      },
      mode: AGENT_TRIGGER_MODES.event,
    }),
    null
  );
  assert.equal(
    registry.select({ triggerId: "disabled_github_research_dossier" }),
    null
  );
});

test("trigger validation rejects unsafe or malformed automation contracts", () => {
  const unsafeTrigger = {
    ...createResearchDossierTriggerSpec(),
    approvalPolicy: {
      mode: "none",
      requiresApproval: false,
    },
    id: "",
    idempotency: {
      keyTemplate: "",
    },
    label: "",
    privacyPolicy: {
      allowedPayloadFields: ["question", "apiKey"],
      storesRawPayload: true,
    },
    scopePolicy: {
      requiresUserId: false,
      requiresWorkspaceId: false,
    },
    target: {
      defaultInput: {
        authorization: "Bearer secret",
      },
      questionTemplate: ["Run with {{secret}}"],
      runnerId: "",
      workflowId: RESEARCH_DOSSIER_WORKFLOW_ID,
    },
    trigger: {
      event: {
        source: "github",
      },
      input: {
        required: ["apiKey"],
      },
      mode: AGENT_TRIGGER_MODES.event,
    },
    type: "unsafe_trigger",
  };
  const validation = validateAgentTriggerSpec(unsafeTrigger);

  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some((error) => /Trigger id is required/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /type must be agent_trigger/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /eventType is required/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /idempotency\.keyTemplate/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /target runnerId is required/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /sensitive field: apiKey/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /sensitive field: secret/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /scopePolicy/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /approval mode/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /raw payload/.test(error)),
    validation.errors.join("\n")
  );

  assert.throws(
    () =>
      createAgentTriggerRegistry({
        triggers: [
          createResearchDossierTriggerSpec(),
          createResearchDossierTriggerSpec(),
        ],
      }),
    /Duplicate agent trigger id/
  );
});

test("schedule trigger validation rejects cron and timezone gaps", () => {
  const scheduleTrigger = buildEventTriggerSpec({
    id: "scheduled_research_dossier",
    trigger: {
      input: {
        required: ["question"],
      },
      mode: AGENT_TRIGGER_MODES.schedule,
      schedule: {
        cron: "daily",
        timezone: "Mars/Phobos",
      },
    },
  });
  const validation = validateAgentTriggerSpec(scheduleTrigger);

  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some((error) => /cron must have 5 or 6 fields/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /timezone is invalid/.test(error)),
    validation.errors.join("\n")
  );
});
