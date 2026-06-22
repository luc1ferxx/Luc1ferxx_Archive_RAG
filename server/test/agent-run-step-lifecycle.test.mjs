import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import { AGENT_RUN_STEP_STATUSES } from "../rag/agent-run-steps.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

const createLifecycleRun = async ({ runId = "run-lifecycle" } = {}) => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Record primary step lifecycle",
    runId,
  });

  return {
    agentRunService,
    lifecycle: createAgentRunStepLifecycle({
      accessScope,
      agentRunService,
      runId,
    }),
    runId,
  };
};

test("agent run step lifecycle records primary document step input and output", async () => {
  const { agentRunService, lifecycle, runId } = await createLifecycleRun();

  await lifecycle.startStep({
    id: "primary-document-rag",
    input: {
      docIds: ["doc-1"],
      question: "What changed?",
    },
    label: "Document RAG",
    type: "document_rag",
  });
  await lifecycle.completeStep({
    id: "primary-document-rag",
    output: {
      citationCount: 1,
      text: "Answer.",
    },
  });

  const run = await agentRunService.getRun({
    accessScope,
    runId,
  });
  const step = run.steps.find((item) => item.id === "primary-document-rag");

  assert.equal(run.status, AGENT_RUN_STATUSES.running);
  assert.equal(step.status, AGENT_RUN_STEP_STATUSES.completed);
  assert.equal(step.type, "document_rag");
  assert.equal(step.label, "Document RAG");
  assert.deepEqual(step.input, {
    docIds: ["doc-1"],
    question: "What changed?",
  });
  assert.deepEqual(step.output, {
    citationCount: 1,
    text: "Answer.",
  });
  assert.deepEqual(
    run.events.map((event) => event.type),
    ["run_created", "step_started", "step_completed"]
  );
});

test("agent run step lifecycle records failed steps without changing run status", async () => {
  const { agentRunService, lifecycle, runId } = await createLifecycleRun({
    runId: "run-lifecycle-failed-step",
  });

  await lifecycle.startStep({
    id: "primary-document-rag",
    input: {
      docIds: ["doc-1"],
      question: "What changed?",
    },
    label: "Document RAG",
    type: "document_rag",
  });
  await lifecycle.failStep({
    id: "primary-document-rag",
    error: new Error("RAG failed."),
    output: {
      citationCount: 0,
    },
  });

  const run = await agentRunService.getRun({
    accessScope,
    runId,
  });
  const step = run.steps.find((item) => item.id === "primary-document-rag");

  assert.equal(run.status, AGENT_RUN_STATUSES.running);
  assert.equal(step.status, AGENT_RUN_STEP_STATUSES.failed);
  assert.equal(step.error.message, "RAG failed.");
  assert.equal(step.error.name, "Error");
  assert.deepEqual(step.output, {
    citationCount: 0,
  });
  assert.deepEqual(
    run.events.map((event) => event.type),
    ["run_created", "step_started", "step_failed"]
  );
});

test("agent run step lifecycle records paused steps without changing run status", async () => {
  const { agentRunService, lifecycle, runId } = await createLifecycleRun({
    runId: "run-lifecycle-paused-step",
  });

  await lifecycle.startStep({
    id: "primary-document-rag",
    input: {
      docIds: ["doc-1"],
      question: "What changed?",
    },
    label: "Document RAG",
    type: "document_rag",
  });
  await lifecycle.pauseStep({
    detail: {
      reason: "scope_needed",
    },
    id: "primary-document-rag",
  });

  const run = await agentRunService.getRun({
    accessScope,
    runId,
  });
  const step = run.steps.find((item) => item.id === "primary-document-rag");

  assert.equal(run.status, AGENT_RUN_STATUSES.running);
  assert.equal(step.status, AGENT_RUN_STEP_STATUSES.paused);
  assert.deepEqual(step.detail, {
    reason: "scope_needed",
  });
  assert.deepEqual(
    run.events.map((event) => event.type),
    ["run_created", "step_started", "step_paused"]
  );
});

test("agent run step lifecycle no-ops when service or run id is missing", async () => {
  let recordCallCount = 0;
  const missingServiceLifecycle = createAgentRunStepLifecycle({
    accessScope,
    runId: "run-missing-service",
  });
  const missingRunLifecycle = createAgentRunStepLifecycle({
    accessScope,
    agentRunService: {
      recordRunStep: async () => {
        recordCallCount += 1;
      },
    },
  });

  assert.equal(
    await missingServiceLifecycle.startStep({
      id: "primary-document-rag",
      type: "document_rag",
    }),
    null
  );
  assert.equal(
    await missingRunLifecycle.completeStep({
      id: "primary-document-rag",
      output: {
        text: "Answer.",
      },
    }),
    null
  );
  assert.equal(recordCallCount, 0);
});

test("agent run step lifecycle cannot create missing terminal steps", async () => {
  const { agentRunService, lifecycle, runId } = await createLifecycleRun({
    runId: "run-lifecycle-terminal-create",
  });

  await assert.rejects(
    () =>
      lifecycle.completeStep({
        id: "missing-completed-step",
        output: {
          text: "Answer.",
        },
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /New agent run steps must start as running, pending, or paused: completed/
      );
      return true;
    }
  );
  await assert.rejects(
    () =>
      lifecycle.failStep({
        error: new Error("RAG failed."),
        id: "missing-failed-step",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /New agent run steps must start as running, pending, or paused: failed/
      );
      return true;
    }
  );
  await assert.rejects(
    () =>
      agentRunService.recordRunStep({
        accessScope,
        runId,
        status: AGENT_RUN_STEP_STATUSES.skipped,
        stepId: "missing-skipped-step",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /New agent run steps must start as running, pending, or paused: skipped/
      );
      return true;
    }
  );

  const run = await agentRunService.getRun({
    accessScope,
    runId,
  });

  assert.deepEqual(run.steps, []);
  assert.deepEqual(run.events.map((event) => event.type), ["run_created"]);
});

test("recordRunStep requires explicit event type for missing pending steps", async () => {
  const { agentRunService, runId } = await createLifecycleRun({
    runId: "run-lifecycle-pending-step",
  });

  await assert.rejects(
    () =>
      agentRunService.recordRunStep({
        accessScope,
        input: {
          question: "What changed?",
        },
        runId,
        stepId: "pending-step-without-event",
        type: "document_rag",
      }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(
        error.message,
        /Pending agent run step creation requires an explicit eventType/
      );
      return true;
    }
  );

  const updatedRun = await agentRunService.recordRunStep({
    accessScope,
    eventType: "step_pending_recorded",
    input: {
      question: "What changed?",
    },
    runId,
    status: AGENT_RUN_STEP_STATUSES.pending,
    stepId: "pending-step-with-event",
    type: "document_rag",
  });
  const step = updatedRun.steps.find(
    (item) => item.id === "pending-step-with-event"
  );

  assert.equal(step.status, AGENT_RUN_STEP_STATUSES.pending);
  assert.deepEqual(step.input, {
    question: "What changed?",
  });
  assert.deepEqual(
    updatedRun.events.map((event) => event.type),
    ["run_created", "step_pending_recorded"]
  );
});

test("recordRunStep metadata-only updates use step_updated unless event type is explicit", async () => {
  const { agentRunService, lifecycle, runId } = await createLifecycleRun({
    runId: "run-lifecycle-metadata-event",
  });

  await lifecycle.startStep({
    id: "primary-document-rag",
    input: {
      docIds: ["doc-1"],
      question: "What changed?",
    },
    label: "Document RAG",
    type: "document_rag",
  });
  await agentRunService.recordRunStep({
    accessScope,
    output: {
      partialText: "Draft answer.",
    },
    runId,
    stepId: "primary-document-rag",
  });
  const explicitEventRun = await agentRunService.recordRunStep({
    accessScope,
    detail: {
      observed: true,
    },
    eventType: "step_observed",
    runId,
    stepId: "primary-document-rag",
  });
  const step = explicitEventRun.steps.find(
    (item) => item.id === "primary-document-rag"
  );

  assert.equal(step.status, AGENT_RUN_STEP_STATUSES.running);
  assert.deepEqual(step.output, {
    partialText: "Draft answer.",
  });
  assert.deepEqual(step.detail, {
    observed: true,
  });
  assert.deepEqual(
    explicitEventRun.events.map((event) => event.type),
    ["run_created", "step_started", "step_updated", "step_observed"]
  );
});

test("recordRunStep preserves omitted input output and error then allows explicit replacement", async () => {
  const { agentRunService, lifecycle, runId } = await createLifecycleRun({
    runId: "run-lifecycle-preserve-replace",
  });

  await lifecycle.startStep({
    id: "primary-document-rag",
    input: {
      docIds: ["doc-1"],
      question: "What changed?",
    },
    label: "Document RAG",
    type: "document_rag",
  });
  await agentRunService.recordRunStep({
    accessScope,
    output: {
      partialText: "Draft answer.",
    },
    runId,
    stepId: "primary-document-rag",
  });
  const failedRun = await lifecycle.failStep({
    error: new Error("RAG failed."),
    id: "primary-document-rag",
  });
  let step = failedRun.steps.find((item) => item.id === "primary-document-rag");

  assert.deepEqual(step.input, {
    docIds: ["doc-1"],
    question: "What changed?",
  });
  assert.deepEqual(step.output, {
    partialText: "Draft answer.",
  });
  assert.deepEqual(step.error, {
    message: "RAG failed.",
    name: "Error",
  });

  const replacedRun = await agentRunService.recordRunStep({
    accessScope,
    error: null,
    eventType: "step_metadata_replaced",
    input: null,
    output: null,
    runId,
    status: AGENT_RUN_STEP_STATUSES.failed,
    stepId: "primary-document-rag",
  });
  step = replacedRun.steps.find((item) => item.id === "primary-document-rag");

  assert.equal(step.input, null);
  assert.equal(step.output, null);
  assert.equal(step.error, null);
  assert.deepEqual(
    replacedRun.events.map((event) => event.type),
    [
      "run_created",
      "step_started",
      "step_updated",
      "step_failed",
      "step_metadata_replaced",
    ]
  );
});

test("recordRunStep maps needs_input status to paused step event", async () => {
  const { agentRunService, lifecycle, runId } = await createLifecycleRun({
    runId: "run-lifecycle-needs-input",
  });

  const createdRun = await agentRunService.recordRunStep({
    accessScope,
    detail: {
      reason: "scope_needed",
    },
    runId,
    status: "needs_input",
    stepId: "needs-input-step",
    type: "clarification_gate",
  });
  let step = createdRun.steps.find((item) => item.id === "needs-input-step");

  assert.equal(step.status, AGENT_RUN_STEP_STATUSES.paused);
  assert.deepEqual(
    createdRun.events.map((event) => event.type),
    ["run_created", "step_paused"]
  );

  await lifecycle.startStep({
    id: "primary-document-rag",
    label: "Document RAG",
    type: "document_rag",
  });
  const pausedRun = await agentRunService.recordRunStep({
    accessScope,
    detail: {
      reason: "more_input_needed",
    },
    runId,
    status: "needs_input",
    stepId: "primary-document-rag",
  });
  step = pausedRun.steps.find((item) => item.id === "primary-document-rag");

  assert.equal(step.status, AGENT_RUN_STEP_STATUSES.paused);
  assert.deepEqual(step.detail, {
    reason: "more_input_needed",
  });
  assert.deepEqual(
    pausedRun.events.map((event) => event.type),
    ["run_created", "step_paused", "step_started", "step_paused"]
  );

  const explicitEventRun = await agentRunService.recordRunStep({
    accessScope,
    eventType: "step_waiting_for_scope",
    runId,
    status: "needs_input",
    stepId: "primary-document-rag",
  });

  assert.deepEqual(
    explicitEventRun.events.map((event) => event.type),
    [
      "run_created",
      "step_paused",
      "step_started",
      "step_paused",
      "step_waiting_for_scope",
    ]
  );
});

test("recordRunStep enforces invalid existing-step transitions through step helper", async () => {
  const { agentRunService, lifecycle, runId } = await createLifecycleRun({
    runId: "run-lifecycle-invalid-existing-transition",
  });

  await lifecycle.startStep({
    id: "primary-document-rag",
    label: "Document RAG",
    type: "document_rag",
  });
  await lifecycle.completeStep({
    id: "primary-document-rag",
    output: {
      text: "Answer.",
    },
  });

  await assert.rejects(
    () =>
      agentRunService.recordRunStep({
        accessScope,
        runId,
        status: AGENT_RUN_STEP_STATUSES.running,
        stepId: "primary-document-rag",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Invalid agent run step status transition: completed -> running/
      );
      return true;
    }
  );

  const run = await agentRunService.getRun({
    accessScope,
    runId,
  });

  assert.deepEqual(
    run.events.map((event) => event.type),
    ["run_created", "step_started", "step_completed"]
  );
});
