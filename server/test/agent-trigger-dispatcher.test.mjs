import assert from "node:assert/strict";
import test from "node:test";

import { createAgentTaskService } from "../rag/agent-tasks.js";
import {
  createAgentTriggerRegistry,
  createResearchDossierTriggerSpec,
} from "../rag/agent-triggers/index.js";
import { AGENT_TRIGGER_MODES } from "../rag/agent-triggers/schema.js";
import { createAgentTriggerDispatcher } from "../rag/agent-trigger-dispatcher.js";
import {
  createInMemoryTaskStore,
  createTaskService,
  TASK_STATUSES,
} from "../rag/tasks.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

const createEventResearchTriggerSpec = () => ({
  ...createResearchDossierTriggerSpec(),
  approvalPolicy: {
    mode: "owner_approved",
    requiresApproval: false,
  },
  id: "github_research_dossier",
  label: "GitHub research dossier",
  trigger: {
    event: {
      eventType: "issue.opened",
      requiredFields: ["event.id", "question"],
      source: "github",
    },
    input: {
      required: ["question"],
      optional: ["docIds"],
    },
    mode: AGENT_TRIGGER_MODES.event,
  },
  idempotency: {
    keyTemplate: "{{triggerId}}:{{event.id}}",
    requiredFields: ["event.id"],
  },
  privacyPolicy: {
    allowedPayloadFields: ["question", "docIds"],
    redactedFields: ["apiKey", "authorization", "secret", "token"],
    storesRawPayload: false,
  },
});

test("trigger dispatcher creates one idempotent agent task through the existing service", async () => {
  const scheduledRuns = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const agentTaskService = createAgentTaskService({
    createTaskId: () => "unused-random-id",
    jobOrchestrator: {
      scheduleTaskRun: (run) => scheduledRuns.push(run),
    },
    taskService,
  });
  const dispatcher = createAgentTriggerDispatcher({
    agentTaskService,
  });

  const firstDispatch = await dispatcher.dispatch({
    accessScope,
    input: {
      docIds: ["doc-1"],
      question: "Build a risk report",
      sessionId: "session-1",
      userPreferences: ["Use concise bullets."],
    },
    request: {
      id: "request-1",
    },
    triggerId: "research_dossier_manual",
  });
  const secondDispatch = await dispatcher.dispatch({
    accessScope,
    input: {
      docIds: ["doc-1"],
      question: "Build a risk report",
      sessionId: "session-1",
      userPreferences: ["Use concise bullets."],
    },
    request: {
      id: "request-1",
    },
    triggerId: "research_dossier_manual",
  });

  assert.equal(firstDispatch.task.id, secondDispatch.task.id);
  assert.equal(firstDispatch.task.status, TASK_STATUSES.queued);
  assert.equal(firstDispatch.task.input.question, "research_task: Build a risk report");
  assert.deepEqual(firstDispatch.task.input.docIds, ["doc-1"]);
  assert.equal(firstDispatch.task.input.userId, "alice");
  assert.equal(scheduledRuns.length, 1);
  assert.deepEqual(scheduledRuns[0], {
    accessScope,
    taskId: firstDispatch.task.id,
  });
  assert.deepEqual(firstDispatch.triggerDispatch, {
    idempotent: true,
    mode: AGENT_TRIGGER_MODES.manual,
    target: {
      runnerId: "agent_goal_runner",
      workflowId: "research_dossier",
    },
    taskId: firstDispatch.task.id,
    triggerId: "research_dossier_manual",
  });
});

test("trigger dispatcher filters payload before calling agent task service", async () => {
  const createTaskCalls = [];
  const registry = createAgentTriggerRegistry({
    triggers: [createEventResearchTriggerSpec()],
  });
  const dispatcher = createAgentTriggerDispatcher({
    agentTaskService: {
      createTask: async (request) => {
        createTaskCalls.push(request);

        return {
          id: "agent_goal:from-trigger",
          status: TASK_STATUSES.queued,
        };
      },
    },
    triggerRegistry: registry,
  });

  const result = await dispatcher.dispatch({
    accessScope,
    event: {
      eventType: "issue.opened",
      id: "event-1",
      source: "github",
    },
    input: {
      apiKey: "sk-secret-value",
      docIds: ["doc-1"],
      question: "Summarize the issue",
      token: "secret-token",
    },
    mode: AGENT_TRIGGER_MODES.event,
  });

  assert.equal(createTaskCalls.length, 1);
  assert.deepEqual(createTaskCalls[0], {
    accessScope,
    docIds: ["doc-1"],
    idempotencyKey: "github_research_dossier:event-1",
    maxIterations: 10,
    question: "research_task: Summarize the issue",
    sessionId: undefined,
    userPreferences: undefined,
    userId: "alice",
  });
  assert.doesNotMatch(JSON.stringify(createTaskCalls[0]), /sk-secret-value/);
  assert.doesNotMatch(JSON.stringify(result), /secret-token/);
});

test("trigger dispatcher rejects missing required fields and scope before creating tasks", async () => {
  let createTaskCalled = false;
  const dispatcher = createAgentTriggerDispatcher({
    agentTaskService: {
      createTask: async () => {
        createTaskCalled = true;
      },
    },
  });

  await assert.rejects(
    () =>
      dispatcher.dispatch({
        accessScope,
        input: {},
        request: {
          id: "request-1",
        },
        triggerId: "research_dossier_manual",
      }),
    /Trigger input missing required field\(s\): question/
  );

  await assert.rejects(
    () =>
      dispatcher.dispatch({
        accessScope: {
          userId: "alice",
        },
        input: {
          question: "Build a report",
        },
        request: {
          id: "request-2",
        },
        triggerId: "research_dossier_manual",
      }),
    /requires a workspace scope/
  );

  assert.equal(createTaskCalled, false);
});
