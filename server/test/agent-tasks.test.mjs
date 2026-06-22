import assert from "node:assert/strict";
import test from "node:test";

import { createJobOrchestrator } from "../rag/job-orchestrator.js";
import {
  AGENT_TASK_ACTIONS,
  AGENT_TASK_RUNNER_ID,
  AGENT_TASK_TYPE,
  createAgentTaskRunner,
  createAgentTaskService,
} from "../rag/agent-tasks.js";
import {
  createInMemoryTaskStore,
  createTaskService,
  TASK_STATUSES,
} from "../rag/tasks.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

test("agent task service creates queued durable goal tasks without leaking internal payload", async () => {
  const scheduledRuns = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const agentTaskService = createAgentTaskService({
    createTaskId: () => "task-1",
    jobOrchestrator: {
      scheduleTaskRun: (run) => scheduledRuns.push(run),
    },
    taskService,
  });

  const task = await agentTaskService.createTask({
    accessScope,
    docIds: ["doc-1"],
    maxIterations: 2,
    question: "Summarize the renewal terms.",
    sessionId: "session-1",
    userId: "alice",
  });

  assert.equal(task.id, "agent_goal:task-1");
  assert.equal(task.type, AGENT_TASK_TYPE);
  assert.equal(task.runnerId, AGENT_TASK_RUNNER_ID);
  assert.equal(task.status, TASK_STATUSES.queued);
  assert.equal(task.payload, undefined);
  assert.deepEqual(task.input, {
    docIds: ["doc-1"],
    maxIterations: 2,
    question: "Summarize the renewal terms.",
    sessionId: "session-1",
    userId: "alice",
  });
  assert.deepEqual(scheduledRuns, [
    {
      accessScope,
      taskId: "agent_goal:task-1",
    },
  ]);

  const internalTask = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:task-1",
  });

  assert.deepEqual(internalTask.payload.iterations, []);
  assert.equal(internalTask.payload.question, "Summarize the renewal terms.");
});

test("agent task runner continues until blocked and resumes with preserved run context", async () => {
  const calls = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const runner = createAgentTaskRunner({
    runAgentTask: async (request) => {
      calls.push(request);

      if (calls.length === 1) {
        return {
          status: 200,
          body: {
            agentAnswer: "Need an approved web lookup.",
            agentMode: "planner",
            agentRunId: "run-1",
            agentTask: {
              continue: true,
              nextQuestion: "Search the web for renewal updates.",
            },
            clarification: {
              needed: false,
            },
          },
        };
      }

      if (calls.length === 2) {
        return {
          status: 200,
          body: {
            agentAnswer: "Approve Web Search?",
            agentMode: "clarification",
            agentRunId: "run-1",
            approvalGates: [
              {
                capabilityId: "web.search",
                id: "approval:web.search:1.0.0",
                status: "pending",
              },
            ],
            clarification: {
              detail: {
                approvalGates: [
                  {
                    capabilityId: "web.search",
                    id: "approval:web.search:1.0.0",
                    status: "pending",
                  },
                ],
              },
              needed: true,
              question: "Approve Web Search?",
              reason: "capability_approval_required",
            },
          },
        };
      }

      return {
        status: 200,
        body: {
          agentAnswer: "Renewal answer with approved web evidence.",
          agentMode: "web",
          agentRunId: "run-1",
          clarification: {
            needed: false,
          },
        },
      };
    },
  });
  const orchestrator = createJobOrchestrator({
    runners: {
      [runner.id]: runner,
    },
    taskService,
  });

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "agent_goal:task-1",
      input: {
        docIds: ["doc-1"],
        maxIterations: 3,
        question: "Summarize the renewal terms.",
        sessionId: "session-1",
        userId: "alice",
      },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds: ["doc-1"],
        iterations: [],
        maxIterations: 3,
        question: "Summarize the renewal terms.",
        sessionId: "session-1",
        userId: "alice",
      },
      runnerId: AGENT_TASK_RUNNER_ID,
      status: TASK_STATUSES.queued,
      type: AGENT_TASK_TYPE,
    },
  });

  await orchestrator.runTask({
    accessScope,
    taskId: "agent_goal:task-1",
  });

  let task = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:task-1",
  });

  assert.equal(task.status, TASK_STATUSES.waitingForUser);
  assert.equal(task.requiredUserAction, "approve_capability");
  assert.equal(task.payload.agentRunId, "run-1");
  assert.equal(task.payload.iterations.length, 2);
  assert.deepEqual(
    calls.map((call) => call.question),
    [
      "Summarize the renewal terms.",
      "Search the web for renewal updates.",
    ]
  );

  await orchestrator.resumeTask({
    accessScope,
    action: AGENT_TASK_ACTIONS.approve,
    payload: {
      approval: {
        approved: true,
        decision: "approved",
        source: "task_action",
      },
      capabilityId: "web.search",
    },
    runImmediately: false,
    taskId: "agent_goal:task-1",
  });
  await orchestrator.runTask({
    accessScope,
    taskId: "agent_goal:task-1",
  });

  task = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:task-1",
  });

  assert.equal(task.status, TASK_STATUSES.completed);
  assert.equal(task.counts.iterations, 3);
  assert.equal(task.result.answer, "Renewal answer with approved web evidence.");
  assert.equal(task.result.agentRunId, "run-1");
  assert.equal(calls[2].agentRunId, "run-1");
  assert.deepEqual(calls[2].capabilityApprovals, {
    "web.search": {
      approved: true,
      decision: "approved",
      source: "task_action",
    },
  });
});

test("agent task runner can continue after iteration budget is exhausted", async () => {
  const calls = [];
  const taskService = createTaskService({
    taskStore: createInMemoryTaskStore(),
  });
  const runner = createAgentTaskRunner({
    runAgentTask: async (request) => {
      calls.push(request);

      if (calls.length === 1) {
        return {
          status: 200,
          body: {
            agentAnswer: "Need one more iteration.",
            agentMode: "planner",
            agentRunId: "run-budget",
            agentTask: {
              continue: true,
              nextQuestion: "Finish the second step.",
            },
            clarification: {
              needed: false,
            },
          },
        };
      }

      return {
        status: 200,
        body: {
          agentAnswer: "Finished after user continuation.",
          agentMode: "document",
          agentRunId: "run-budget",
          clarification: {
            needed: false,
          },
        },
      };
    },
  });
  const orchestrator = createJobOrchestrator({
    runners: {
      [runner.id]: runner,
    },
    taskService,
  });

  await taskService.upsertTask({
    accessScope,
    task: {
      id: "agent_goal:budget",
      input: {
        docIds: [],
        maxIterations: 1,
        question: "Run two steps.",
        sessionId: "session-1",
        userId: "alice",
      },
      payload: {
        agentRunId: null,
        capabilityApprovals: {},
        docIds: [],
        iterations: [],
        maxIterations: 1,
        question: "Run two steps.",
        sessionId: "session-1",
        userId: "alice",
      },
      runnerId: AGENT_TASK_RUNNER_ID,
      status: TASK_STATUSES.queued,
      type: AGENT_TASK_TYPE,
    },
  });

  await orchestrator.runTask({
    accessScope,
    taskId: "agent_goal:budget",
  });

  let task = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:budget",
  });

  assert.equal(task.status, TASK_STATUSES.waitingForUser);
  assert.equal(task.requiredUserAction, "continue_task");
  assert.equal(task.payload.pending.reason, "iteration_budget_exhausted");

  await orchestrator.resumeTask({
    accessScope,
    action: AGENT_TASK_ACTIONS.continue,
    payload: {},
    runImmediately: false,
    taskId: "agent_goal:budget",
  });
  await orchestrator.runTask({
    accessScope,
    taskId: "agent_goal:budget",
  });

  task = await taskService.getInternalTask({
    accessScope,
    taskId: "agent_goal:budget",
  });

  assert.equal(task.status, TASK_STATUSES.completed);
  assert.equal(task.result.answer, "Finished after user continuation.");
  assert.deepEqual(
    calls.map((call) => call.question),
    ["Run two steps.", "Finish the second step."]
  );
});
