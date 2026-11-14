import test from "node:test";
import assert from "node:assert/strict";

import { runAgentRag } from "../rag/agent.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";

// What one document question does under each value of
// AGENT_UNIFIED_GRAPH_ROLLOUT: which path answers it and what it leaves in the
// run store. Literal expectations, so a change to what a value does shows up
// as a diff of this file. The file was written before ADR 0001 phase 10
// removed the v3 unified graph (`shadow` planned a graph beside the answer,
// `guarded` let a graph answer the request, a mistyped value read as `off`);
// its diff in that commit is what the removal changed for a new request.

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

// The request as app-services.js sends it, under the deterministic planning
// dial.
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

// A removed value refuses where the outer plan would be scheduled. A process
// never gets this far: server.js and createAppServices refuse it at start-up
// (test/agent-runtime-removed.test.mjs). An in-process caller of runAgentRag,
// such as an evaluation runner, gets the error and a failed run: no document
// is read, nothing is planned beside the answer and no graph is stored.
const REFUSED = Object.freeze({
  answer: null,
  checkpoint: null,
  documentCalls: 0,
  error: "AGENT_UNIFIED_GRAPH_ROLLOUT_REMOVED",
  events: ["run_created", "run_prepared", "execution_planned", "run_failed"],
  runStatus: "failed",
  runs: 1,
  steps: [],
  unifiedGraphPlanned: [],
});

test("shadow and guarded were removed: nothing is planned beside the answer and no graph answers", async () => {
  assert.deepEqual(await ask("shadow"), REFUSED);
  assert.deepEqual(await ask("guarded"), REFUSED);
});

test("a value that is none of the three is refused too, no longer read as off", async () => {
  assert.deepEqual(await ask("gaurded"), REFUSED);
});
