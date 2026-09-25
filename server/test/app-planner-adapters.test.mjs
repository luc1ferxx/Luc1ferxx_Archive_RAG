import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  createAppServices,
  createDagPlannerAdapter,
  createReplanAdapter,
} from "../app-services.js";
import { DAG_PLANNER_IDS } from "../rag/agent-dag-planner-adapter.js";
import { REPLAN_ADAPTER_IDS } from "../rag/agent-replan-adapter.js";
import { REPLAN_REASON_CODES } from "../rag/agent-replanner.js";
import { createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";
import {
  createInMemoryWorkspaceArtifactStore,
} from "../rag/workspace-artifacts/index.js";

// Which planner the composition root hands the runtime is a permission
// decision, not a preference: it decides whether a model is allowed to shape a
// plan that will actually execute. These tests pin that decision to the dials
// the operator sets, so it cannot drift into "on" by default.

const withEnv = async (overrides, callback) => {
  const originalValues = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test("the DAG planner follows the rollout dial the V1 planner already reads", async () => {
  await withEnv({ AGENT_PLANNER_ROLLOUT: "llm" }, () => {
    const adapter = createDagPlannerAdapter();

    assert.equal(adapter.id, DAG_PLANNER_IDS.llm);
    assert.equal(adapter.rolloutMode, "llm");
  });

  await withEnv({ AGENT_PLANNER_ROLLOUT: "deterministic" }, () => {
    assert.equal(createDagPlannerAdapter().id, DAG_PLANNER_IDS.deterministic);
  });
});

// Shadow means the model plans beside the run, not for it. The deterministic
// graph stays primary and the model's graph is only compared against it.
test("the shadow rollout keeps the deterministic graph primary", async () => {
  await withEnv({ AGENT_PLANNER_ROLLOUT: "shadow" }, () => {
    const adapter = createDagPlannerAdapter();

    assert.equal(adapter.id, DAG_PLANNER_IDS.deterministic);
    assert.equal(adapter.shadowPlannerAdapter.id, DAG_PLANNER_IDS.llm);
  });
});

test("the configured rollout defers to the execution planner setting", async () => {
  await withEnv(
    { AGENT_EXECUTION_PLANNER: "llm", AGENT_PLANNER_ROLLOUT: "configured" },
    () => {
      assert.equal(createDagPlannerAdapter().id, DAG_PLANNER_IDS.llm);
    }
  );

  await withEnv(
    {
      AGENT_EXECUTION_PLANNER: "deterministic",
      AGENT_PLANNER_ROLLOUT: "configured",
    },
    () => {
      assert.equal(createDagPlannerAdapter().id, DAG_PLANNER_IDS.deterministic);
    }
  );
});

/**
 * There is no deterministic replanner. Wherever the operator has kept a model
 * out of the primary plan, a replan would be the one path that let it back in
 * -- after the run has already produced evidence, which is the point where an
 * injected instruction has the most to work with.
 */
test("the replanner is withheld wherever a model is not already planning for real", async () => {
  for (const rollout of ["deterministic", "shadow"]) {
    await withEnv({ AGENT_PLANNER_ROLLOUT: rollout }, () => {
      assert.equal(createReplanAdapter(), null);
    });
  }

  await withEnv(
    {
      AGENT_EXECUTION_PLANNER: "deterministic",
      AGENT_PLANNER_ROLLOUT: "configured",
    },
    () => {
      assert.equal(createReplanAdapter(), null);
    }
  );
});

test("the replanner is available once the model plans the executed graph", async () => {
  for (const rollout of ["guarded_llm", "llm"]) {
    await withEnv({ AGENT_PLANNER_ROLLOUT: rollout }, () => {
      assert.equal(createReplanAdapter().id, REPLAN_ADAPTER_IDS.llm);
    });
  }
});

// The replanner reads the planner it was actually given rather than resolving
// the dials a second time, so an injected planner cannot be paired with a
// replanner the caller never asked for.
test("the replanner answers for the planner it is handed", () => {
  assert.equal(createReplanAdapter({ id: DAG_PLANNER_IDS.deterministic }), null);
  assert.equal(
    createReplanAdapter({ id: DAG_PLANNER_IDS.llm }).id,
    REPLAN_ADAPTER_IDS.llm
  );
  assert.equal(createReplanAdapter(null), null);
});

// What createAppServices resolves is only half the decision; the other half
// is where the resolved adapters are actually handed. /chat receives them
// through the route, and a background agent task receives them through the
// runAgentTask callback the composition root builds inline. That callback is
// the one place a task could silently run on an ungoverned planner, so this
// drives a task through it and watches the adapters get called.

const TASK_ACCESS_SCOPE = {
  userId: "alice",
  workspaceId: "workspace-a",
};

const createContractRagService = ({ questions }) => {
  const citation = {
    docId: "contract-1",
    excerpt: "Late notice creates renewal risk.",
    fileName: "services-agreement.pdf",
    pageNumber: 3,
  };

  return {
    chat: async (docIds, question) => {
      questions.push(question);

      // The first risk review comes back empty so the run has a reason to
      // consult the replanner; nothing else in the run is unusual.
      if (questions.length === 2) {
        return { abstained: true, citations: [], resolvedQuery: question, text: "" };
      }

      return {
        abstained: false,
        citations: [citation],
        resolvedQuery: question,
        text: /risk/i.test(question)
          ? "Risk Review\n- Risk: Late notice creates renewal risk. [Source 1]"
          : "Contract Summary\n- Parties: Acme and Beta. [Source 1]",
      };
    },
    clearDocuments: async () => [],
    clearSessionMemory: () => true,
    deleteDocument: async () => null,
    getDocument: (docId) =>
      docId === "contract-1"
        ? { docId, fileName: "services-agreement.pdf" }
        : null,
    ingestDocument: async () => null,
    initializeDocumentRegistry: async () => [],
    initializeSessionMemory: async () => true,
    listDocuments: () => [{ docId: "contract-1", fileName: "services-agreement.pdf" }],
  };
};

const requestBinding = (field) => ({ field, source: "request" });

test("the background agent task path runs on the same governed planner and replanner as /chat", async () => {
  await withEnv({ AGENT_SKILL_GRAPH_ROLLOUT: "guarded" }, async () => {
    const plannerContexts = [];
    const replanContexts = [];
    const questions = [];
    const dagPlannerAdapter = {
      createExecutionGraph: (context) => {
        plannerContexts.push(context);

        return {
          nodes: [
            {
              dependsOn: [],
              failurePolicy: "continue",
              inputBindings: {
                docIds: requestBinding("docIds"),
                question: requestBinding("question"),
              },
              nodeId: "summary",
              rationale: "Summarize first.",
              skillId: "summarize_contract",
            },
            {
              dependsOn: ["summary"],
              failurePolicy: "continue",
              inputBindings: {
                docIds: requestBinding("docIds"),
                priorFindings: { nodeId: "summary", output: "text", source: "node" },
                question: requestBinding("question"),
              },
              nodeId: "risk",
              rationale: "Review risks against the summary.",
              skillId: "risk_review",
            },
          ],
        };
      },
      id: DAG_PLANNER_IDS.llm,
    };
    const replanAdapter = {
      createPatch: (context) => {
        replanContexts.push(context);

        return { addNodes: [], removeNodeIds: [] };
      },
      id: "test_replan",
    };
    const services = createAppServices(
      {
        agentRunStore: createInMemoryAgentRunStore(),
        dagPlannerAdapter,
        healthService: {
          buildHealthReport: async () => ({ checks: {}, status: "ok" }),
          runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
        },
        ragService: createContractRagService({ questions }),
        replanAdapter,
        taskStore: createInMemoryTaskStore(),
        workspaceArtifactStore: createInMemoryWorkspaceArtifactStore(),
      },
      { uploadsDirectory: os.tmpdir() }
    );

    assert.equal(services.dagPlannerAdapter, dagPlannerAdapter);
    assert.equal(services.replanAdapter, replanAdapter);

    const outcome = await services.agentTaskRunner.run({
      accessScope: TASK_ACCESS_SCOPE,
      patchTask: async () => {},
      task: {
        id: "agent_goal:governed-task",
        input: {
          docIds: ["contract-1"],
          maxIterations: 1,
          question: "Review this contract for risks and key terms.",
          sessionId: "task-session",
          userId: TASK_ACCESS_SCOPE.userId,
        },
      },
    });

    assert.equal(outcome.status, "completed");

    // The task's planner call went through the injected adapter, and it saw
    // the redacted planning view only: no scope, no identity, no handles.
    assert.equal(plannerContexts.length, 1);
    assert.deepEqual(Object.keys(plannerContexts[0]).sort(), [
      "authorizedDocIds",
      "capabilities",
      "documentCount",
      "goal",
      "intentPlan",
      "limits",
      "taskMemoryPlanningContext",
    ]);
    assert.deepEqual(plannerContexts[0].authorizedDocIds, ["contract-1"]);
    assert.doesNotMatch(JSON.stringify(plannerContexts[0]), /alice|workspace-a/);

    // The empty risk review consulted the injected replanner, which likewise
    // saw statuses rather than evidence or identity.
    assert.equal(replanContexts.length, 1);
    assert.equal(replanContexts[0].trigger, "insufficient_evidence");
    assert.deepEqual(
      replanContexts[0].nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun.status, nodeRun.abstained]),
      [
        ["summary", "completed", false],
        ["risk", "completed", true],
      ]
    );
    assert.doesNotMatch(JSON.stringify(replanContexts[0]), /alice|workspace-a|Late notice/);

    // And the persisted run says the injected graph -- not a fallback and not
    // the V1 chain -- is what executed for this task.
    const run = await services.agentRunService.getRun({
      accessScope: TASK_ACCESS_SCOPE,
      runId: outcome.payload.agentRunId,
    });
    const graphEvents = run.events.filter((event) => event.type === "skill_graph_planned");

    assert.equal(graphEvents.length, 1);
    assert.equal(graphEvents[0].payload.executed, true);
    assert.equal(graphEvents[0].payload.mode, "guarded");
    assert.equal(graphEvents[0].payload.fallback, null);
    assert.equal(graphEvents[0].payload.planner.selectedPlannerId, DAG_PLANNER_IDS.llm);
    assert.equal(graphEvents[0].payload.planner.fallback, false);
    assert.deepEqual(graphEvents[0].payload.graph.nodeIds, ["summary", "risk"]);
    assert.deepEqual(
      graphEvents[0].payload.replans.map((replan) => replan.reasonCode),
      [REPLAN_REASON_CODES.noProgress]
    );
    assert.deepEqual(
      run.steps.filter((step) => step.type === "custom_skill").map((step) => step.id),
      ["custom_skill:summary", "custom_skill:risk"]
    );
    assert.equal(questions.length, 2);
  });
});

test("background agent task forwards the injected all-stage shadow planner without executing its graph", async () => {
  await withEnv({
    AGENT_PLANNER_ROLLOUT: "deterministic",
    AGENT_SKILL_GRAPH_ROLLOUT: "off",
    AGENT_UNIFIED_GRAPH_ROLLOUT: "shadow",
  }, async () => {
    const plannerContexts = [];
    const unifiedGraphPlannerAdapter = {
      id: "injected-unified-shadow",
      createExecutionGraph: async (context) => {
        plannerContexts.push(context);
        return {
          nodes: [{
            dependsOn: [],
            failurePolicy: "fail_fast",
            inputBindings: {
              docIds: requestBinding("docIds"),
              question: requestBinding("question"),
            },
            nodeId: "primary",
            skillId: "document_rag",
          }],
        };
      },
    };
    const services = createAppServices({
      agentRunStore: createInMemoryAgentRunStore(),
      ragService: {
        getDocument: (docId, scope) =>
          docId === "contract-1" && scope?.workspaceId === TASK_ACCESS_SCOPE.workspaceId
            ? { docId, fileName: "contract.pdf" }
            : null,
        listDocuments: () => [{ docId: "contract-1", fileName: "contract.pdf" }],
        chat: async () => ({
          abstained: false,
          citations: [{
            docId: "contract-1",
            excerpt: "The contract requires thirty days notice.",
            fileName: "contract.pdf",
            pageNumber: 1,
            rank: 1,
          }],
          text: "The contract requires thirty days notice. [Source 1]",
        }),
      },
      taskStore: createInMemoryTaskStore(),
      unifiedGraphPlannerAdapter,
      workspaceArtifactStore: createInMemoryWorkspaceArtifactStore(),
    }, { uploadsDirectory: os.tmpdir() });

    assert.equal(services.unifiedGraphPlannerAdapter, unifiedGraphPlannerAdapter);
    const outcome = await services.agentTaskRunner.run({
      accessScope: TASK_ACCESS_SCOPE,
      patchTask: async () => {},
      task: {
        id: "agent_goal:unified-shadow",
        input: {
          docIds: ["contract-1"],
          maxIterations: 1,
          question: "What notice does the contract require?",
          sessionId: "unified-shadow-session",
          userId: TASK_ACCESS_SCOPE.userId,
        },
      },
    });
    const run = await services.agentRunService.getRun({
      accessScope: TASK_ACCESS_SCOPE,
      runId: outcome.payload.agentRunId,
    });
    const shadowEvents = run.events.filter((event) => event.type === "unified_graph_planned");

    assert.equal(outcome.status, "completed");
    assert.equal(plannerContexts.length, 1);
    assert.equal(plannerContexts[0].graphVersion, "v3");
    assert.equal(shadowEvents.length, 1);
    assert.equal(shadowEvents[0].payload.status, "selected");
    assert.equal(shadowEvents[0].payload.executed, false);
    assert.equal(run.steps.some((step) => step.type === "graph_node"), false);
  });
});
