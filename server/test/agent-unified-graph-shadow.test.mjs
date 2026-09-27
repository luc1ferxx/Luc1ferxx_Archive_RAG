import test from "node:test";
import assert from "node:assert/strict";

import { createAgentBudget } from "../rag/agent-budget.js";
import { runAgentRag } from "../rag/agent.js";
import { createAgentRunService, createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { observeUnifiedAgentGraphShadow } from "../rag/agent-unified-graph-shadow.js";
import { withShadowPlanner } from "../rag/agent-planner-shadow.js";
import { createCapabilityRegistry } from "../rag/capabilities/registry.js";
import { createWebSearchCapability } from "../rag/capabilities/web.js";
import { createDefaultSkillRegistry } from "../rag/skills/registry.js";

const accessScope = { userId: "alice", workspaceId: "private-workspace" };
const docIds = ["private-document"];
const question = "Compare private-document with the contract.";
const registry = createDefaultSkillRegistry();
const ragService = {
  getDocument: (docId, scope) =>
    scope === accessScope && docId === docIds[0] ? { docId } : null,
};
const capabilityRegistry = createCapabilityRegistry([
  createWebSearchCapability({
    webChatService: async () => { throw new Error("shadow must not execute Web"); },
  }),
]);
const context = {
  accessScope,
  budgetState: createAgentBudget(),
  capabilityRegistry,
  docIds,
  plan: { mode: "document" },
  question,
  ragService,
  registry,
};

test("all-stage shadow records a redacted, validated graph but executes nothing", async () => {
  const recorded = [];
  const event = await observeUnifiedAgentGraphShadow({
    ...context,
    plannerAdapter: {
      id: "injected-shadow",
      createExecutionGraph: async () => ({
        nodes: [{
          dependsOn: [],
          failurePolicy: "fail_fast",
          inputBindings: {
            docIds: { field: "docIds", source: "request" },
            question: { field: "question", source: "request" },
          },
          nodeId: "private-document",
          skillId: "document_rag",
        }],
      }),
    },
    record: (payload) => recorded.push(payload),
  });

  assert.equal(event.status, "selected");
  assert.equal(event.executed, false);
  assert.deepEqual(event.graph, {
    nodeCount: 1,
    skillIds: ["document_rag"],
    version: "v3",
  });
  assert.deepEqual(recorded, [event]);
  assert.equal(JSON.stringify(event).includes("private-document"), false);
  assert.equal(JSON.stringify(event).includes("private-workspace"), false);
  assert.equal(JSON.stringify(event).includes(question), false);
  assert.equal(context.budgetState.used.documentRagCalls, 0);
});

test("missing adapter and observation write failure cannot execute or throw", async () => {
  const trace = [];
  const event = await observeUnifiedAgentGraphShadow({
    ...context,
    addTraceStep: (step) => trace.push(step),
    record: () => { throw new Error("event store unavailable"); },
  });

  assert.equal(event.status, "rejected");
  assert.equal(event.executed, false);
  assert.deepEqual(event.errorCodes, ["invalid_node_shape"]);
  assert.equal(trace[0]?.type, "unified_graph_shadow_observation");
  assert.equal(context.budgetState.used.documentRagCalls, 0);

  const doubleSinkFailure = await observeUnifiedAgentGraphShadow({
    ...context,
    addTraceStep: () => { throw new Error("trace unavailable"); },
    record: () => { throw new Error("event store unavailable"); },
  });
  assert.equal(doubleSinkFailure.status, "rejected");
});

test("real AgentRAG request records the v3 shadow proposal while V1 still answers", async () => {
  const originalRollout = process.env.AGENT_UNIFIED_GRAPH_ROLLOUT;
  const originalSkillRollout = process.env.AGENT_SKILL_GRAPH_ROLLOUT;
  process.env.AGENT_UNIFIED_GRAPH_ROLLOUT = "shadow";
  process.env.AGENT_SKILL_GRAPH_ROLLOUT = "off";
  let plannerCalls = 0;
  let ragCalls = 0;
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });

  try {
    const response = await runAgentRag({
      accessScope,
      agentRunService,
      docIds,
      question: "What does the policy require?",
      ragService: {
        ...ragService,
        listDocuments: () => [{ docId: docIds[0], fileName: "policy.pdf" }],
        chat: async () => {
          ragCalls += 1;
          return {
            abstained: false,
            citations: [{
              docId: docIds[0],
              excerpt: "The policy requires manager approval.",
              fileName: "policy.pdf",
              pageNumber: 1,
              rank: 1,
            }],
            text: "The policy requires manager approval. [Source 1]",
          };
        },
      },
      unifiedGraphPlannerAdapter: {
        id: "injected-shadow",
        createExecutionGraph: async () => {
          plannerCalls += 1;
          return {
            nodes: [{
              dependsOn: [],
              failurePolicy: "fail_fast",
              inputBindings: {
                docIds: { field: "docIds", source: "request" },
                question: { field: "question", source: "request" },
              },
              nodeId: "document",
              skillId: "document_rag",
            }],
          };
        },
      },
      userId: accessScope.userId,
    });
    const run = await agentRunService.getRun({
      accessScope,
      runId: response.body.agentRunId,
    });
    const shadowEvents = run.events.filter((event) => event.type === "unified_graph_planned");

    assert.equal(response.status, 200);
    assert.equal(plannerCalls, 1);
    assert.equal(shadowEvents.length, 1);
    assert.equal(shadowEvents[0].payload.graph.version, "v3");
    assert.equal(shadowEvents[0].payload.executed, false);
    assert.equal(run.steps.some((step) => step.type === "graph_node"), false);
    assert.ok(ragCalls >= 1, "the legacy answer path still executes");
  } finally {
    if (originalRollout === undefined) {
      delete process.env.AGENT_UNIFIED_GRAPH_ROLLOUT;
    } else {
      process.env.AGENT_UNIFIED_GRAPH_ROLLOUT = originalRollout;
    }
    if (originalSkillRollout === undefined) {
      delete process.env.AGENT_SKILL_GRAPH_ROLLOUT;
    } else {
      process.env.AGENT_SKILL_GRAPH_ROLLOUT = originalSkillRollout;
    }
  }
});

test("shadow records the observed planner's own outcome, never a fallback graph", async () => {
  const documentProposal = () => ({
    nodes: [{
      dependsOn: [],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: { field: "docIds", source: "request" },
        question: { field: "question", source: "request" },
      },
      nodeId: "document",
      skillId: "document_rag",
    }],
  });
  const calls = { deterministic: 0, model: 0 };
  const deterministic = {
    id: "deterministic_unified_graph",
    createExecutionGraph: async () => {
      calls.deterministic += 1;
      return documentProposal();
    },
  };
  // The model adapter's shape: a failed plan would be replaced whole by the
  // deterministic graph on the guarded path.
  const model = {
    id: "llm_unified_graph",
    createExecutionGraph: async () => {
      calls.model += 1;
      throw new Error("I cannot plan this request.");
    },
    fallbackPlannerAdapter: deterministic,
  };

  const failed = await observeUnifiedAgentGraphShadow({ ...context, plannerAdapter: model });
  assert.equal(failed.status, "rejected");
  assert.deepEqual(failed.errorCodes, ["invalid_node_shape"]);
  assert.equal(failed.graph, null);
  assert.equal(failed.planner.requestedPlannerId, "llm_unified_graph");
  assert.equal(failed.planner.selectedPlannerId, null);
  assert.equal(failed.planner.fallback, false);
  assert.deepEqual(calls, { deterministic: 0, model: 1 });

  // AGENT_PLANNER_ROLLOUT=shadow keeps the deterministic graph primary and
  // carries the model beside it: shadow observation plans with the model.
  const rolled = await observeUnifiedAgentGraphShadow({
    ...context,
    plannerAdapter: withShadowPlanner(deterministic, {
      ...model,
      createExecutionGraph: async () => {
        calls.model += 1;
        return documentProposal();
      },
    }),
  });
  assert.equal(rolled.status, "selected");
  assert.equal(rolled.planner.requestedPlannerId, "llm_unified_graph");
  assert.equal(rolled.planner.selectedPlannerId, "llm_unified_graph");
  assert.equal(rolled.planner.fallback, false);
  assert.deepEqual(calls, { deterministic: 0, model: 2 });
  assert.equal(context.budgetState.used.documentRagCalls, 0);
});
