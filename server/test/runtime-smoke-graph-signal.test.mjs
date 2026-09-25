import assert from "node:assert/strict";
import test from "node:test";

import { loadGuardedGraphSignal } from "../evaluation/runtime-smoke-graph-signal.js";
import { runAgentRag } from "../rag/agent.js";
import { createAgentRunService, createInMemoryAgentRunStore } from "../rag/agent-runs.js";

const createGraphEvent = () => ({
  type: "skill_graph_planned",
  payload: {
    executed: true,
    fallback: null,
    graph: { nodeIds: ["summary", "risk"], version: "v1" },
    mode: "guarded",
    nodeRuns: [
      { nodeId: "summary", skillId: "summarize_contract", status: "completed" },
      { nodeId: "risk", skillId: "risk_review", status: "completed" },
    ],
    planner: { selectedPlannerId: "llm_dag" },
    status: "completed",
  },
});

const createPersistedSteps = () => [
  {
    id: "custom_skill:summary",
    input: { nodeId: "summary", skillId: "summarize_contract" },
    status: "completed",
    type: "custom_skill",
  },
  {
    id: "custom_skill:risk",
    input: { nodeId: "risk", skillId: "risk_review" },
    status: "completed",
    type: "custom_skill",
  },
];

const loadSignal = async (events, calls = [], steps = createPersistedSteps()) =>
  loadGuardedGraphSignal({
    agentRunService: {
      getRun: async (request) => {
        calls.push(request);

        return { events, steps };
      },
    },
    chat: { agentRunId: "run-1" },
    userId: "alice",
  });

test("runtime smoke accepts a completed guarded LLM DAG with exactly the authorized skills", async () => {
  const calls = [];
  const signal = await loadSignal([createGraphEvent()], calls);

  assert.deepEqual(signal, {
    executed: true,
    fallback: null,
    mode: "guarded",
    selectedPlannerId: "llm_dag",
    skillIds: ["risk_review", "summarize_contract"],
  });
  assert.deepEqual(calls, [
    {
      accessScope: { userId: "alice", workspaceId: "" },
      runId: "run-1",
    },
  ]);
});

test("runtime smoke rejects off mode", async () => {
  const event = createGraphEvent();
  event.payload.mode = "off";

  await assert.rejects(loadSignal([event]), /guarded DAG/);
});

test("runtime smoke rejects a graph that was planned but not executed", async () => {
  const event = createGraphEvent();
  event.payload.executed = false;

  await assert.rejects(loadSignal([event]), /must execute/);
});

test("runtime smoke rejects V1 fallback", async () => {
  const event = createGraphEvent();
  event.payload.fallback = "v1";

  await assert.rejects(loadSignal([event]), /must not fall back/);
});

test("runtime smoke rejects a missing skill graph event", async () => {
  await assert.rejects(
    loadSignal([{ type: "agent_trace", payload: {} }]),
    /skill_graph_planned event/
  );
});

test("runtime smoke rejects a deterministic DAG planner", async () => {
  const event = createGraphEvent();
  event.payload.planner.selectedPlannerId = "deterministic_dag";

  await assert.rejects(loadSignal([event]), /real LLM planner/);
});

test("runtime smoke rejects a missing or additional skill run", async () => {
  const missing = createGraphEvent();
  missing.payload.nodeRuns.pop();
  missing.payload.graph.nodeIds.pop();
  await assert.rejects(loadSignal([missing]), /exactly the authorized custom skills/);

  const additional = createGraphEvent();
  additional.payload.nodeRuns.push({
    nodeId: "compare",
    skillId: "compare_documents",
    status: "completed",
  });
  additional.payload.graph.nodeIds.push("compare");
  await assert.rejects(loadSignal([additional]), /exactly the authorized custom skills/);
});

test("runtime smoke rejects a duplicate skill run rather than deduplicating it", async () => {
  const event = createGraphEvent();
  event.payload.nodeRuns.push({
    nodeId: "risk-2",
    skillId: "risk_review",
    status: "completed",
  });
  event.payload.graph.nodeIds.push("risk-2");

  await assert.rejects(loadSignal([event]), /exactly the authorized custom skills/);
});

test("runtime smoke rejects an incomplete node or mismatched plan", async () => {
  const incomplete = createGraphEvent();
  incomplete.payload.nodeRuns[1].status = "failed";
  await assert.rejects(loadSignal([incomplete]), /nodes must all complete/);

  const mismatch = createGraphEvent();
  mismatch.payload.graph.nodeIds[1] = "other";
  await assert.rejects(loadSignal([mismatch]), /must match its persisted plan/);
});

test("runtime smoke rejects a graph event that claims completion without persisted custom skill steps", async () => {
  await assert.rejects(
    loadSignal([createGraphEvent()], [], []),
    /persisted custom skill steps/
  );
});

test("runtime smoke rejects persisted custom skill steps with a different status or skill identity", async () => {
  const wrongStatus = createPersistedSteps();
  wrongStatus[1].status = "running";
  await assert.rejects(
    loadSignal([createGraphEvent()], [], wrongStatus),
    /persisted custom skill steps/
  );

  const wrongSkill = createPersistedSteps();
  wrongSkill[1].input.skillId = "compare_documents";
  await assert.rejects(
    loadSignal([createGraphEvent()], [], wrongSkill),
    /persisted custom skill steps/
  );
});

test("runtime smoke accepts a reused graph node backed by its completed persisted step", async () => {
  const event = createGraphEvent();
  event.payload.nodeRuns[0].status = "reused";
  const signal = await loadSignal([event]);
  assert.equal(signal.executed, true);
});

test("runtime smoke accepts matching steps persisted by a real guarded agent run", async () => {
  const previousMode = process.env.AGENT_SKILL_GRAPH_ROLLOUT;
  process.env.AGENT_SKILL_GRAPH_ROLLOUT = "guarded";
  const accessScope = { userId: "smoke-step-user", workspaceId: "" };
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore(),
  });
  const requestBinding = (field) => ({ source: "request", field });

  try {
    const response = await runAgentRag({
      accessScope,
      agentRunService,
      dagPlannerAdapter: {
        // The planner is stubbed: this test proves actual run-step persistence,
        // while the scheduled runtime smoke separately proves provider identity.
        id: "llm_dag",
        createExecutionGraph: () => ({
          nodes: [
            {
              dependsOn: [],
              failurePolicy: "continue",
              inputBindings: {
                docIds: requestBinding("docIds"),
                question: requestBinding("question"),
              },
              nodeId: "summary",
              skillId: "summarize_contract",
            },
            {
              dependsOn: ["summary"],
              failurePolicy: "continue",
              inputBindings: {
                docIds: requestBinding("docIds"),
                priorFindings: { source: "node", nodeId: "summary", output: "text" },
                question: requestBinding("question"),
              },
              nodeId: "risk",
              skillId: "risk_review",
            },
          ],
        }),
      },
      docIds: ["contract"],
      executionPlannerAdapter: {
        id: "test_execution",
        createExecutionPlan: () => [
          { id: "custom_skills", condition: "selected_custom_skills" },
        ],
      },
      intentPlannerAdapter: {
        id: "test_intent",
        selectIntentPlan: async () => ({ selectedIntentId: "summarize_contract" }),
      },
      question: "Summarize the contract and assess risks.",
      ragService: {
        getDocument: (docId, scope) =>
          docId === "contract" && scope?.userId === accessScope.userId
            ? { docId: "contract", fileName: "contract.pdf" }
            : null,
        listDocuments: () => [{ docId: "contract", fileName: "contract.pdf" }],
        chat: async () => ({
          abstained: false,
          citations: [{ docId: "contract", excerpt: "Notice is 30 days.", pageNumber: 1 }],
          text: "The contract requires 30 days notice. [Source 1]",
        }),
      },
      sessionId: "smoke-step-session",
      userId: accessScope.userId,
    });

    assert.equal(response.status, 200);
    const signal = await loadGuardedGraphSignal({
      agentRunService,
      chat: response.body,
      userId: accessScope.userId,
    });
    assert.deepEqual(signal.skillIds, ["risk_review", "summarize_contract"]);
  } finally {
    if (previousMode === undefined) {
      delete process.env.AGENT_SKILL_GRAPH_ROLLOUT;
    } else {
      process.env.AGENT_SKILL_GRAPH_ROLLOUT = previousMode;
    }
  }
});
