import test from "node:test";
import assert from "node:assert/strict";

import { createUnifiedGraphPlannerAdapter } from "../app-services.js";
import { runAgentRag } from "../rag/agent.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";

// What one document question does under each value of
// AGENT_UNIFIED_GRAPH_ROLLOUT: which path answers it and what it leaves in the
// run store. Literal expectations, so a change to what a value does shows up
// as a diff of this file.

const accessScope = Object.freeze({ userId: "dial-user", workspaceId: "dial-workspace" });
const DOC_ID = "vendor-msa";
const QUESTION = "What notice period does the vendor require before renewal?";
const ANSWER = "The vendor requires 30 days written notice before renewal. [Source 1]";

const withEnv = async (overrides, callback) => {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const createRagService = () => {
  const calls = [];
  const inScope = (scope) =>
    scope?.userId === accessScope.userId && scope?.workspaceId === accessScope.workspaceId;

  return {
    calls,
    chat: async (docIds, question) => {
      calls.push({ docIds, question });

      return {
        abstained: false,
        citations: [
          {
            docId: DOC_ID,
            excerpt: "The vendor requires 30 days written notice before renewal.",
            fileName: "vendor-msa.pdf",
            pageNumber: 2,
          },
        ],
        text: ANSWER,
      };
    },
    getDocument: (docId, scope) =>
      inScope(scope) && docId === DOC_ID ? { docId, fileName: "vendor-msa.pdf" } : null,
    listDocuments: (scope) =>
      inScope(scope) ? [{ docId: DOC_ID, fileName: "vendor-msa.pdf" }] : [],
  };
};

// The request as app-services.js sends it: the planner adapter it injects for
// the unified graph, under the deterministic planning dial.
const ask = async (rollout) => {
  const store = createInMemoryAgentRunStore();
  const agentRunService = createAgentRunService({ agentRunStore: store });
  const ragService = createRagService();
  const outcome = await withEnv(
    {
      AGENT_PLANNER_ROLLOUT: "deterministic",
      AGENT_UNIFIED_GRAPH_CAPABILITIES: undefined,
      AGENT_UNIFIED_GRAPH_ROLLOUT: rollout,
      RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
      RAG_LONG_MEMORY_ENABLED: "false",
    },
    async () => {
      try {
        return {
          response: await runAgentRag({
            accessScope,
            agentRunService,
            docIds: [DOC_ID],
            question: QUESTION,
            ragService,
            sessionId: "dial-session",
            unifiedGraphPlannerAdapter: createUnifiedGraphPlannerAdapter(),
            userId: accessScope.userId,
          }),
        };
      } catch (error) {
        return { error };
      }
    }
  );
  const runs = await store.list({ accessScope });
  const run = runs.length === 1
    ? await store.get({ accessScope, runId: runs[0].runId })
    : null;
  const checkpoint = run?.result?.__skillGraphCheckpoint;

  return {
    answer: outcome.response?.body.agentAnswer ?? null,
    checkpoint: checkpoint ? `${checkpoint.version}/${checkpoint.phase}` : null,
    documentCalls: ragService.calls.length,
    error: outcome.error?.code ?? null,
    events: run ? [...new Set(run.events.map((event) => event.type))] : null,
    runStatus: run?.status ?? null,
    runs: runs.length,
    steps: run ? run.steps.map((step) => step.type) : null,
    unifiedGraphPlanned: run
      ? run.events
          .filter((event) => event.type === "unified_graph_planned")
          .map((event) => `${event.payload.mode}:${event.payload.status}`)
      : null,
  };
};

// The outer execution plan answered: a document_rag step, no graph.
const OUTER_PLAN = Object.freeze({
  answer: ANSWER,
  checkpoint: null,
  documentCalls: 1,
  error: null,
  events: [
    "run_created",
    "run_prepared",
    "execution_planned",
    "step_started",
    "step_completed",
    "run_completed",
  ],
  runStatus: "completed",
  runs: 1,
  steps: ["plan", "query_planner", "document_rag", "self_check", "synthesis", "answer_finalizer"],
  unifiedGraphPlanned: [],
});

test("unset or off: the outer execution plan answers", async () => {
  assert.deepEqual(await ask(undefined), OUTER_PLAN);
  assert.deepEqual(await ask("off"), OUTER_PLAN);
});

test("shadow: the outer execution plan answers and a v3 graph is planned beside it", async () => {
  assert.deepEqual(await ask("shadow"), {
    ...OUTER_PLAN,
    events: [
      "run_created",
      "run_prepared",
      "unified_graph_planned",
      "execution_planned",
      "step_started",
      "step_completed",
      "run_completed",
    ],
    unifiedGraphPlanned: ["shadow:selected"],
  });
});

test("guarded: a v3 graph answers the whole request and the outer plan never runs", async () => {
  assert.deepEqual(await ask("guarded"), {
    answer: ANSWER,
    checkpoint: "v2/completed",
    documentCalls: 1,
    error: null,
    events: [
      "run_created",
      "run_prepared",
      "unified_graph_planned",
      "skill_graph_checkpointed",
      "step_started",
      "step_completed",
      "unified_graph_executed",
      "run_completed",
    ],
    runStatus: "completed",
    runs: 1,
    steps: ["plan", "query_planner", "graph_node", "graph_node", "self_check", "synthesis", "answer_finalizer"],
    unifiedGraphPlanned: ["guarded:selected"],
  });
});

test("a value that is none of the three is read as off", async () => {
  assert.deepEqual(await ask("gaurded"), OUTER_PLAN);
});
