import test from "node:test";
import assert from "node:assert/strict";
import { createAgentRunContext } from "../rag/agent-run-context.js";

test("agent run context appends trace steps and exposes budget snapshots", () => {
  const context = createAgentRunContext({
    agentBudget: {
      maxTraceSteps: 2,
    },
    docIds: ["doc-1"],
    executionLoop: {
      followUpsRun: 0,
      maxFollowUps: 1,
    },
    longMemory: {
      enabled: true,
      postgresConfigured: true,
      reason: "postgres_configured_default",
      status: "ready",
    },
    plan: {
      mode: "document",
    },
    question: "What is the policy?",
    selectedSkills: [],
    workingMemory: {
      goal: "What is the policy?",
    },
  });

  assert.equal(
    context.addTraceStep({
      type: "plan",
      label: "Plan",
      summary: "Planned document RAG.",
    }),
    true
  );
  assert.equal(
    context.addBudgetLimitTrace({
      tool: "Web Search",
      reason: "web search budget exhausted.",
    }),
    true
  );

  assert.deepEqual(
    context.trace.map((step) => step.id),
    ["1-plan", "2-budget_limit"]
  );
  assert.equal(context.getBudgetSnapshot().used.traceSteps, 2);
  assert.equal(
    context.buildAgentObservability({ agentMode: "document" }).executionPlanner.status,
    "not_run"
  );
  assert.deepEqual(
    context.buildAgentObservability({ agentMode: "document" }).longMemory,
    {
      enabled: true,
      postgresConfigured: true,
      reason: "postgres_configured_default",
      status: "ready",
    }
  );
  assert.equal(
    context.buildAgentObservability({ agentMode: "document" }).experienceMemory.status,
    "disabled"
  );

  context.setExecutionPlanner({
    fallback: true,
    fallbackReason: "Invalid AgentRAG execution plan.",
    requestedPlannerId: "llm",
    selectedPlannerId: "deterministic",
    status: "fallback",
    stepIds: ["document_rag"],
  });

  assert.deepEqual(
    context.buildAgentObservability({ agentMode: "document" }).executionPlanner,
    {
      fallback: true,
      fallbackReason: "Invalid AgentRAG execution plan.",
      requestedPlannerId: "llm",
      selectedPlannerId: "deterministic",
      status: "fallback",
      stepIds: ["document_rag"],
    }
  );
});

test("agent run context returns clarification response and records agent trace", async () => {
  const recordedEvents = [];
  const context = createAgentRunContext({
    chainSkills: [
      {
        id: "risk_review",
        version: "1.0.0",
        label: "Risk Review",
        budgetKey: "customSkillCalls",
      },
    ],
    docIds: ["doc-1"],
    executionLoop: {
      followUpsRun: 0,
      maxFollowUps: 1,
    },
    plan: {
      mode: "document",
    },
    question: "What does the document say?",
    recordTrace: async (event) => {
      recordedEvents.push(event);
    },
    selectedSkills: [
      {
        id: "document_rag",
        version: "1.0.0",
        label: "Document RAG",
        budgetKey: "documentRagCalls",
      },
    ],
    timestamp: () => "2026-01-01T00:00:00.000Z",
    workingMemory: {
      goal: "What does the document say?",
    },
  });

  context.setSkillTracker({
    getAgentSkills: () => [
      {
        skillId: "document_rag",
        skillVersion: "1.0.0",
        label: "Document RAG",
        status: "failed",
      },
    ],
    getSkillObservations: () => [
      {
        skillId: "document_rag",
        selected: true,
        status: "failed",
      },
    ],
    getSkillRuns: () => [
      {
        skillId: "document_rag",
        phase: "primary",
        status: "failed",
      },
    ],
  });
  context.setAgentRetrievalPlan({
    retrievalQueries: [
      {
        id: "primary",
        query: "document policy",
      },
    ],
  });
  assert.equal(context.getAgentRetrievalPlan().retrievalQueries[0].id, "primary");

  const response = await context.returnClarification({
    reason: "missing_required_documents",
    summary: "The request needs selected document context.",
    question: "Which document should I use?",
    detail: {
      selectedDocumentCount: 0,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, "clarification");
  assert.equal(response.body.agentAnswer, "Which document should I use?");
  assert.equal(response.body.agentTrace[0].type, "clarification_gate");
  assert.equal(response.body.agentObservability.planMode, "document");
  assert.equal(response.body.agentObservability.executionPlanner.status, "not_run");
  assert.equal(response.body.agentObservability.skills[0].skillId, "document_rag");
  assert.equal(response.body.agentObservability.runs[0].phase, "primary");
  assert.equal(recordedEvents.length, 1);
  assert.equal(recordedEvents[0].timestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(recordedEvents[0].traceType, "agent");
  assert.equal(recordedEvents[0].status, 200);
  assert.equal(recordedEvents[0].agentRetrievalPlan.retrievalQueries[0].id, "primary");
  assert.deepEqual(recordedEvents[0].agentTraceSummary, [
    {
      type: "clarification_gate",
      label: "Clarification Gate",
      status: "needs_input",
    },
  ]);
});
