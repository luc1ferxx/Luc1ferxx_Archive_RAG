import test from "node:test";
import assert from "node:assert/strict";
import { createAgentBudget, getBudgetSnapshot } from "../rag/agent-budget.js";
import {
  EXECUTION_GRAPH_FAILURE_POLICIES,
  EXECUTION_GRAPH_REASON_CODES,
  createExecutionGraph,
} from "../rag/agent-execution-graph.js";
import { runExecutionGraph } from "../rag/agent-execution-graph-runner.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import {
  CUSTOM_RAG_SKILL_CONTRACT,
} from "../rag/skills/custom/custom-skill-contract.js";
import { SKILL_EFFECTS, SKILL_IDEMPOTENCY } from "../rag/skills/skill-contract.js";

// ---------------------------------------------------------------------------
// Harness
//
// Concurrency here is asserted with barriers and deferred promises, never with
// elapsed milliseconds: a timing assertion would pass on a fast machine and
// flake on a loaded one, and it would not actually prove that two nodes were
// in flight at the same moment.
// ---------------------------------------------------------------------------

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
};

/**
 * Resolves once `size` callers have arrived. Lets a test prove that N nodes
 * were genuinely concurrent: if the scheduler serialized them, the first
 * arrival would block forever and the test would time out rather than pass.
 */
const createBarrier = (size) => {
  const arrivals = [];
  const opened = createDeferred();

  return {
    arrivals,
    arrive: (nodeId) => {
      arrivals.push(nodeId);

      if (arrivals.length >= size) {
        opened.resolve(arrivals);
      }

      return opened.promise;
    },
    opened: opened.promise,
  };
};

const createTracker = (budgetState) =>
  createAgentSkillTracker({ budgetState, selectedSkills: [] });

const createSkill = ({
  budgetKey = "customSkillCalls",
  effects,
  execute,
  id,
  label = id,
  parallelSafe,
  version = "1.0.0",
}) => ({
  ...CUSTOM_RAG_SKILL_CONTRACT,
  budgetKey,
  execute,
  id,
  kind: "custom",
  label,
  match: () => true,
  requiresAccessScope: true,
  version,
  ...(effects === undefined ? {} : { effects }),
  ...(parallelSafe === undefined ? {} : { parallelSafe }),
});

const createRegistry = (skills) => {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));

  return {
    get: (skillId) => byId.get(skillId) ?? null,
    list: () => [...byId.values()],
  };
};

const answering = (text, citations = []) =>
  async () => ({ abstained: false, citations, text });

const requestField = (field) => ({ field, source: "request" });
const nodeOutput = (nodeId, output) => ({ nodeId, output, source: "node" });

const node = ({
  dependsOn = [],
  failurePolicy = EXECUTION_GRAPH_FAILURE_POLICIES.failFast,
  inputBindings,
  nodeId,
  rationale = `Run ${nodeId}.`,
  skillId,
  scope,
}) => ({
  dependsOn,
  failurePolicy,
  inputBindings: inputBindings ?? {
    docIds: requestField("docIds"),
    question: requestField("question"),
  },
  nodeId,
  rationale,
  skillId,
  ...(scope === undefined ? {} : { scope }),
});

const runGraph = async ({
  authorizedSkillIds,
  budgetState = createAgentBudget(),
  completedNodeRuns,
  docIds = ["doc-1", "doc-2"],
  graph,
  maxConcurrency,
  question = "Compare the two contracts and review the risks.",
  registry,
  tracker = createTracker(budgetState),
}) => {
  const budgetTrace = [];
  const trace = [];
  const lifecycle = [];

  const outcome = await runExecutionGraph({
    accessScope: { userId: "alice", workspaceId: "acme" },
    addBudgetLimitTrace: (step) => budgetTrace.push(step),
    addTraceStep: (step) => trace.push(step),
    authorizedDocIds: docIds,
    authorizedSkillIds: authorizedSkillIds ?? registry.list().map((skill) => skill.id),
    budgetState,
    buildSkillTraceDetail: tracker.buildSkillTraceDetail,
    completedNodeRuns,
    docIds,
    executeObservedSkill: tracker.executeObservedSkill,
    graph,
    maxConcurrency,
    question,
    ragService: {},
    recordSkillResult: tracker.recordSkillResult,
    recordSkippedSkill: tracker.recordSkippedSkill,
    registry,
    retrievalPlan: { retrievalQueries: [{ id: "primary", query: "contract risks" }] },
    sessionId: "session-1",
    stepLifecycle: {
      completeStep: async (patch) => lifecycle.push({ verb: "complete", ...patch }),
      failStep: async (patch) => lifecycle.push({ verb: "fail", ...patch }),
      startStep: async (patch) => lifecycle.push({ verb: "start", ...patch }),
    },
    userId: "alice",
  });

  return { budgetState, budgetTrace, lifecycle, outcome, trace, tracker };
};

// ---------------------------------------------------------------------------
// Scenario D -- an illegal graph is refused as a whole
// ---------------------------------------------------------------------------

test("runExecutionGraph rejects an illegal graph without executing any node", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare_documents");

        return { citations: [], text: "compared" };
      },
      id: "compare_documents",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({ nodeId: "shell", skillId: "shell_exec" }),
    ],
  });

  const { budgetState, outcome, trace } = await runGraph({ graph, registry });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "rejected");
  assert.deepEqual(executed, []);
  assert.deepEqual(outcome.results, []);
  assert.deepEqual(trace, []);
  assert.equal(getBudgetSnapshot(budgetState).used.customSkillCalls, 0);
  assert.equal(
    outcome.errors.some(
      (error) => error.code === EXECUTION_GRAPH_REASON_CODES.unregisteredCapability
    ),
    true
  );
});

test("runExecutionGraph rejects a cyclic graph without executing the acyclic part", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("risk_review");

        return { citations: [], text: "risk" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ dependsOn: ["second"], nodeId: "first", skillId: "risk_review" }),
      node({ dependsOn: ["first"], nodeId: "second", skillId: "risk_review" }),
    ],
  });

  const { outcome } = await runGraph({ graph, registry });

  assert.equal(outcome.status, "rejected");
  assert.deepEqual(executed, []);
  assert.equal(
    outcome.errors.some(
      (error) => error.code === EXECUTION_GRAPH_REASON_CODES.cycleDetected
    ),
    true
  );
});

// ---------------------------------------------------------------------------
// Scenario A -- parallel fan-out with per-document citation integrity
// ---------------------------------------------------------------------------

test("runExecutionGraph runs independent parallel-safe nodes concurrently", async () => {
  const barrier = createBarrier(3);
  const registry = createRegistry([
    createSkill({
      execute: async ({ docIds }) => {
        await barrier.arrive("compare");

        return { citations: [{ docId: docIds[0] }], text: "compared" };
      },
      id: "compare_documents",
    }),
    createSkill({
      execute: async ({ docIds }) => {
        await barrier.arrive(`risk:${docIds[0]}`);

        return { citations: [{ docId: docIds[0] }], text: `risk for ${docIds[0]}` };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({
        inputBindings: {
          docIds: requestField("docIds"),
          question: requestField("question"),
        },
        nodeId: "risk_a",
        scope: { docIds: ["doc-1"] },
        skillId: "risk_review",
      }),
      node({
        inputBindings: {
          docIds: requestField("docIds"),
          question: requestField("question"),
        },
        nodeId: "risk_b",
        scope: { docIds: ["doc-2"] },
        skillId: "risk_review",
      }),
    ],
  });

  const { outcome } = await runGraph({
    budgetState: createAgentBudget({ maxCustomSkillCalls: 3 }),
    graph,
    maxConcurrency: 3,
    registry,
  });

  assert.equal(outcome.status, "completed");
  assert.equal(barrier.arrivals.length, 3);
  assert.deepEqual(
    outcome.nodeRuns.map((run) => run.nodeId),
    ["compare", "risk_a", "risk_b"]
  );
  assert.equal(
    outcome.nodeRuns.every((run) => run.status === "completed"),
    true
  );
});

test("runExecutionGraph keeps per-node citations attributed to the node that produced them", async () => {
  const registry = createRegistry([
    createSkill({
      execute: async ({ docIds }) => ({
        citations: docIds.map((docId) => ({ docId, page: 1 })),
        text: `risk for ${docIds.join(",")}`,
      }),
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({
        nodeId: "risk_a",
        scope: { docIds: ["doc-1"] },
        skillId: "risk_review",
      }),
      node({
        nodeId: "risk_b",
        scope: { docIds: ["doc-2"] },
        skillId: "risk_review",
      }),
    ],
  });

  const { outcome } = await runGraph({ graph, maxConcurrency: 2, registry });

  const byNodeId = new Map(outcome.nodeRuns.map((run) => [run.nodeId, run]));

  assert.deepEqual(
    byNodeId.get("risk_a").result.citations.map((citation) => citation.docId),
    ["doc-1"]
  );
  assert.deepEqual(
    byNodeId.get("risk_b").result.citations.map((citation) => citation.docId),
    ["doc-2"]
  );
});

test("runExecutionGraph narrows docIds to the node scope without widening the request scope", async () => {
  const seenDocIds = [];
  const registry = createRegistry([
    createSkill({
      execute: async ({ docIds }) => {
        seenDocIds.push([...docIds]);

        return { citations: [], text: "ok" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "scoped", scope: { docIds: ["doc-2"] }, skillId: "risk_review" }),
      node({ nodeId: "unscoped", skillId: "risk_review" }),
    ],
  });

  const { outcome } = await runGraph({
    docIds: ["doc-1", "doc-2"],
    graph,
    maxConcurrency: 1,
    registry,
  });

  assert.equal(outcome.status, "completed");
  assert.deepEqual(seenDocIds, [["doc-2"], ["doc-1", "doc-2"]]);
});

// ---------------------------------------------------------------------------
// Scenario B -- dependency ordering
// ---------------------------------------------------------------------------

test("runExecutionGraph does not start a dependent node before its dependency resolves", async () => {
  const started = [];
  const compareStarted = createDeferred();
  const compareGate = createDeferred();
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        started.push("compare");
        compareStarted.resolve();
        await compareGate.promise;

        return { citations: [{ docId: "doc-1" }], text: "compare output" };
      },
      id: "compare_documents",
    }),
    createSkill({
      execute: async () => {
        started.push("risk_delta");

        return { citations: [{ docId: "doc-1" }], text: "delta" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({
        dependsOn: ["compare"],
        inputBindings: {
          docIds: requestField("docIds"),
          priorFindings: nodeOutput("compare", "text"),
          question: requestField("question"),
        },
        nodeId: "risk_delta",
        skillId: "risk_review",
      }),
    ],
  });

  const pending = runGraph({ graph, maxConcurrency: 4, registry });

  // compare is in flight; give the scheduler every chance to launch the
  // dependent node early before releasing the gate.
  await compareStarted.promise;
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(started, ["compare"]);

  compareGate.resolve();

  const { outcome } = await pending;

  assert.deepEqual(started, ["compare", "risk_delta"]);
  assert.equal(outcome.status, "completed");
});

test("runExecutionGraph binds an upstream output into a typed input instead of concatenating free text", async () => {
  const contexts = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => ({ citations: [], text: "Clause 4 changed." }),
      id: "compare_documents",
    }),
    createSkill({
      execute: async (context) => {
        contexts.push(context);

        return { citations: [], text: "delta" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({
        dependsOn: ["compare"],
        inputBindings: {
          docIds: requestField("docIds"),
          priorFindings: nodeOutput("compare", "text"),
          question: requestField("question"),
        },
        nodeId: "risk_delta",
        skillId: "risk_review",
      }),
    ],
  });

  const question = "What changed and what is now risky?";
  const { outcome } = await runGraph({ graph, question, registry });

  assert.equal(outcome.status, "completed");
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].priorFindings, "Clause 4 changed.");
  assert.equal(contexts[0].question, question);
  assert.doesNotMatch(contexts[0].question, /Previous skill outputs/i);
});

// ---------------------------------------------------------------------------
// Scheduling policy
// ---------------------------------------------------------------------------

test("runExecutionGraph never exceeds the configured concurrency", async () => {
  let inFlight = 0;
  let peakInFlight = 0;
  const release = createDeferred();
  const arrivals = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        arrivals.push(inFlight);

        if (arrivals.length >= 2) {
          release.resolve();
        }

        await release.promise;
        inFlight -= 1;

        return { citations: [], text: "ok" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: ["a", "b", "c", "d"].map((nodeId) =>
      node({ nodeId, skillId: "risk_review" })
    ),
  });

  const { outcome } = await runGraph({
    budgetState: createAgentBudget({ maxCustomSkillCalls: 4 }),
    graph,
    maxConcurrency: 2,
    registry,
  });

  assert.equal(outcome.status, "completed");
  assert.equal(peakInFlight, 2);
  assert.equal(outcome.nodeRuns.length, 4);
});

test("runExecutionGraph runs a side-effecting node alone", async () => {
  let inFlight = 0;
  const publishInFlightPeers = [];
  const readBarrier = createBarrier(2);
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        inFlight += 1;
        await readBarrier.arrive("read");
        inFlight -= 1;

        return { citations: [], text: "read" };
      },
      id: "risk_review",
    }),
    createSkill({
      effects: SKILL_EFFECTS.externalWrite,
      execute: async () => {
        publishInFlightPeers.push(inFlight);

        return { citations: [], text: "published" };
      },
      id: "publish_report",
      parallelSafe: false,
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "read_a", skillId: "risk_review" }),
      node({ nodeId: "read_b", skillId: "risk_review" }),
      node({ nodeId: "publish", skillId: "publish_report" }),
    ],
  });

  const { outcome } = await runGraph({
    budgetState: createAgentBudget({ maxCustomSkillCalls: 3 }),
    graph,
    maxConcurrency: 3,
    registry,
  });

  assert.equal(outcome.status, "completed");
  assert.deepEqual(publishInFlightPeers, [0]);
  assert.equal(readBarrier.arrivals.length, 2);
});

test("runExecutionGraph returns results in declaration order regardless of completion order", async () => {
  const gates = { first: createDeferred(), second: createDeferred() };
  const registry = createRegistry([
    createSkill({
      execute: async ({ priorFindings }) => {
        const gate = priorFindings === "second" ? gates.second : gates.first;

        if (priorFindings === "second") {
          gates.second.resolve();
        }

        await gate.promise;

        return { citations: [], text: priorFindings ?? "first" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "first", skillId: "risk_review" }),
      node({
        inputBindings: {
          docIds: requestField("docIds"),
          priorFindings: requestField("question"),
          question: requestField("question"),
        },
        nodeId: "second",
        skillId: "risk_review",
      }),
    ],
  });

  const pending = runGraph({
    graph,
    maxConcurrency: 2,
    question: "second",
    registry,
  });

  await gates.second.promise;
  gates.first.resolve();

  const { outcome } = await pending;

  assert.deepEqual(
    outcome.nodeRuns.map((run) => run.nodeId),
    ["first", "second"]
  );
  assert.deepEqual(
    outcome.results.map((result) => result.text),
    ["first", "second"]
  );
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

test("runExecutionGraph reserves budget before launch and skips nodes it cannot fund", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async ({ docIds }) => {
        executed.push(docIds.join(","));

        return { citations: [], text: "ok" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "a", scope: { docIds: ["doc-1"] }, skillId: "risk_review" }),
      node({ nodeId: "b", scope: { docIds: ["doc-2"] }, skillId: "risk_review" }),
      node({ nodeId: "c", scope: { docIds: ["doc-1"] }, skillId: "risk_review" }),
    ],
  });
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 2 });

  const { budgetTrace, outcome, tracker } = await runGraph({
    budgetState,
    graph,
    maxConcurrency: 3,
    registry,
  });

  assert.equal(executed.length, 2);
  assert.equal(outcome.status, "partial");
  assert.equal(getBudgetSnapshot(budgetState).used.customSkillCalls, 2);

  const skipped = outcome.nodeRuns.filter((run) => run.status === "skipped");

  assert.deepEqual(
    skipped.map((run) => run.nodeId),
    ["c"]
  );
  assert.equal(skipped[0].reason, "budget_exhausted");
  assert.equal(budgetTrace.length, 1);
  assert.equal(
    tracker.getSkillRuns().some((run) => run.status === "skipped"),
    true
  );
});

test("runExecutionGraph does not strand a reservation when a node is never launched", async () => {
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        throw new Error("upstream failed");
      },
      id: "compare_documents",
    }),
    createSkill({
      execute: async () => ({ citations: [], text: "never" }),
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({
        dependsOn: ["compare"],
        inputBindings: {
          docIds: requestField("docIds"),
          priorFindings: nodeOutput("compare", "text"),
          question: requestField("question"),
        },
        nodeId: "risk_delta",
        skillId: "risk_review",
      }),
    ],
  });
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 2 });

  await runGraph({ budgetState, graph, registry });

  assert.equal(getBudgetSnapshot(budgetState).used.customSkillCalls, 1);
});

// ---------------------------------------------------------------------------
// Failure policy
// ---------------------------------------------------------------------------

test("runExecutionGraph skips dependents of a failed node and reports the reason", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare");
        throw new Error("retrieval unavailable");
      },
      id: "compare_documents",
    }),
    createSkill({
      execute: async () => {
        executed.push("risk");

        return { citations: [], text: "risk" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({
        failurePolicy: EXECUTION_GRAPH_FAILURE_POLICIES.continue,
        nodeId: "compare",
        skillId: "compare_documents",
      }),
      node({
        dependsOn: ["compare"],
        failurePolicy: EXECUTION_GRAPH_FAILURE_POLICIES.continue,
        inputBindings: {
          docIds: requestField("docIds"),
          priorFindings: nodeOutput("compare", "text"),
          question: requestField("question"),
        },
        nodeId: "risk_delta",
        skillId: "risk_review",
      }),
      node({
        failurePolicy: EXECUTION_GRAPH_FAILURE_POLICIES.continue,
        nodeId: "risk_independent",
        skillId: "risk_review",
      }),
    ],
  });

  const { outcome } = await runGraph({
    budgetState: createAgentBudget({ maxCustomSkillCalls: 3 }),
    graph,
    maxConcurrency: 3,
    registry,
  });

  const byNodeId = new Map(outcome.nodeRuns.map((run) => [run.nodeId, run]));

  assert.equal(outcome.status, "partial");
  assert.equal(byNodeId.get("compare").status, "failed");
  assert.equal(byNodeId.get("risk_delta").status, "skipped");
  assert.equal(byNodeId.get("risk_delta").reason, "dependency_failed");
  assert.equal(byNodeId.get("risk_independent").status, "completed");
  assert.deepEqual(executed.sort(), ["compare", "risk"]);
});

test("runExecutionGraph fail_fast stops nodes that have not started yet", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare");
        throw new Error("retrieval unavailable");
      },
      id: "compare_documents",
    }),
    createSkill({
      execute: async () => {
        executed.push("risk");

        return { citations: [], text: "risk" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({
        dependsOn: ["compare"],
        inputBindings: {
          docIds: requestField("docIds"),
          priorFindings: nodeOutput("compare", "text"),
          question: requestField("question"),
        },
        nodeId: "risk_delta",
        skillId: "risk_review",
      }),
      node({ dependsOn: ["risk_delta"], nodeId: "risk_tail", skillId: "risk_review" }),
    ],
  });

  const { outcome } = await runGraph({
    budgetState: createAgentBudget({ maxCustomSkillCalls: 3 }),
    graph,
    maxConcurrency: 1,
    registry,
  });

  const byNodeId = new Map(outcome.nodeRuns.map((run) => [run.nodeId, run]));

  assert.deepEqual(executed, ["compare"]);
  assert.equal(outcome.status, "partial");
  assert.equal(byNodeId.get("risk_delta").status, "skipped");
  assert.equal(byNodeId.get("risk_tail").status, "skipped");
});

// ---------------------------------------------------------------------------
// Scenario C -- minimal graphs stay minimal
// ---------------------------------------------------------------------------

test("runExecutionGraph runs exactly one node for a single-node graph", async () => {
  let calls = 0;
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        calls += 1;

        return { citations: [{ docId: "doc-1" }], text: "answer" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [node({ nodeId: "risk_review", skillId: "risk_review" })],
  });

  const { outcome, trace } = await runGraph({
    docIds: ["doc-1"],
    graph,
    registry,
  });

  assert.equal(calls, 1);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.nodeRuns.length, 1);
  assert.equal(trace.length, 1);
});

// ---------------------------------------------------------------------------
// Scenario F -- recovery
// ---------------------------------------------------------------------------

test("runExecutionGraph reuses completed node runs instead of re-executing them", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare");

        return { citations: [], text: "fresh compare" };
      },
      id: "compare_documents",
    }),
    createSkill({
      execute: async ({ priorFindings }) => {
        executed.push(`risk:${priorFindings}`);

        return { citations: [], text: "risk" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({
        dependsOn: ["compare"],
        inputBindings: {
          docIds: requestField("docIds"),
          priorFindings: nodeOutput("compare", "text"),
          question: requestField("question"),
        },
        nodeId: "risk_delta",
        skillId: "risk_review",
      }),
    ],
  });
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 2 });

  const { outcome } = await runGraph({
    budgetState,
    completedNodeRuns: [
      {
        nodeId: "compare",
        result: {
          abstained: false,
          citations: [{ docId: "doc-1" }],
          label: "compare_documents",
          ok: true,
          skillId: "compare_documents",
          skillVersion: "1.0.0",
          text: "recovered compare",
        },
        skillId: "compare_documents",
        status: "completed",
      },
    ],
    graph,
    registry,
  });

  const byNodeId = new Map(outcome.nodeRuns.map((run) => [run.nodeId, run]));

  assert.deepEqual(executed, ["risk:recovered compare"]);
  assert.equal(byNodeId.get("compare").status, "reused");
  assert.equal(byNodeId.get("risk_delta").status, "completed");
  // The reused node must not be charged to the budget a second time.
  assert.equal(getBudgetSnapshot(budgetState).used.customSkillCalls, 1);
});

/**
 * A node that a previous replan already reused is still finished work. Carrying
 * only `completed` forward would mean the second replan re-ran what the first
 * one correctly skipped -- wasted budget for a read, a repeated write for
 * anything else.
 */
test("runExecutionGraph reuses a node run a previous replan had already reused", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare");

        return { citations: [], text: "fresh compare" };
      },
      id: "compare_documents",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [node({ nodeId: "compare", skillId: "compare_documents" })],
  });
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 1 });

  const { outcome } = await runGraph({
    budgetState,
    completedNodeRuns: [
      {
        nodeId: "compare",
        result: {
          abstained: false,
          citations: [],
          ok: true,
          skillId: "compare_documents",
          skillVersion: "1.0.0",
          text: "recovered compare",
        },
        skillId: "compare_documents",
        status: "reused",
      },
    ],
    graph,
    registry,
  });

  assert.deepEqual(executed, []);
  assert.equal(outcome.nodeRuns[0].status, "reused");
  assert.equal(outcome.nodeRuns[0].result.text, "recovered compare");
  assert.equal(getBudgetSnapshot(budgetState).used.customSkillCalls, 0);
});

test("runExecutionGraph ignores a completed node run whose skill no longer matches the node", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare");

        return { citations: [], text: "fresh compare" };
      },
      id: "compare_documents",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [node({ nodeId: "compare", skillId: "compare_documents" })],
  });

  const { outcome } = await runGraph({
    completedNodeRuns: [
      {
        nodeId: "compare",
        result: { ok: true, skillId: "risk_review", text: "wrong skill" },
        skillId: "risk_review",
        status: "completed",
      },
    ],
    graph,
    registry,
  });

  assert.deepEqual(executed, ["compare"]);
  assert.equal(outcome.nodeRuns[0].status, "completed");
});

// ---------------------------------------------------------------------------
// Persistence / observability contracts
// ---------------------------------------------------------------------------

test("runExecutionGraph keeps the replay-safe custom_skill step contract", async () => {
  const registry = createRegistry([
    createSkill({
      execute: async () => ({ citations: [{ docId: "doc-1" }], text: "ok" }),
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [node({ nodeId: "risk_a", skillId: "risk_review" })],
  });

  const { lifecycle, trace } = await runGraph({ graph, registry });

  const startPatch = lifecycle.find((entry) => entry.verb === "start");

  assert.equal(startPatch.type, "custom_skill");
  assert.equal(startPatch.id, "custom_skill:risk_a");
  assert.equal(startPatch.input.skillId, "risk_review");
  assert.equal(startPatch.input.question, "Compare the two contracts and review the risks.");
  assert.deepEqual(startPatch.input.docIds, ["doc-1", "doc-2"]);
  assert.equal(trace[0].type, "custom_skill");
  assert.equal(trace[0].id, "custom_skill:risk_a");
  assert.equal(trace[0].detail.nodeId, "risk_a");
  assert.deepEqual(trace[0].detail.dependsOn, []);
});

test("runExecutionGraph records the node rationale and graph version on each trace step", async () => {
  const registry = createRegistry([
    createSkill({
      execute: async () => ({ citations: [], text: "ok" }),
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({
        nodeId: "risk_a",
        rationale: "Surface risks in the newer agreement.",
        skillId: "risk_review",
      }),
    ],
  });

  const { trace } = await runGraph({ graph, registry });

  assert.equal(trace[0].detail.rationale, "Surface risks in the newer agreement.");
  assert.equal(trace[0].detail.graphVersion, graph.version);
});

test("runExecutionGraph does not mutate the graph it is given", async () => {
  const registry = createRegistry([
    createSkill({
      execute: async () => ({ citations: [], text: "ok" }),
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "a", skillId: "risk_review" }),
      node({ dependsOn: ["a"], nodeId: "b", skillId: "risk_review" }),
    ],
  });
  const snapshot = JSON.stringify(graph);

  await runGraph({
    budgetState: createAgentBudget({ maxCustomSkillCalls: 2 }),
    graph,
    registry,
  });

  assert.equal(JSON.stringify(graph), snapshot);
});

test("runExecutionGraph reports node idempotency so the recovery layer can reason about replay", async () => {
  const registry = createRegistry([
    createSkill({
      execute: async () => ({ citations: [], text: "ok" }),
      id: "risk_review",
    }),
    createSkill({
      effects: SKILL_EFFECTS.externalWrite,
      execute: async () => ({ citations: [], text: "published" }),
      id: "publish_report",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "risk_a", skillId: "risk_review" }),
      node({ dependsOn: ["risk_a"], nodeId: "publish", skillId: "publish_report" }),
    ],
  });

  const { outcome } = await runGraph({
    budgetState: createAgentBudget({ maxCustomSkillCalls: 2 }),
    graph,
    registry,
  });

  const byNodeId = new Map(outcome.nodeRuns.map((run) => [run.nodeId, run]));

  assert.equal(byNodeId.get("risk_a").idempotency, SKILL_IDEMPOTENCY.readOnlyRag);
  assert.equal(byNodeId.get("risk_a").effects, SKILL_EFFECTS.readOnly);
  assert.equal(byNodeId.get("publish").effects, SKILL_EFFECTS.externalWrite);
  assert.equal(byNodeId.get("publish").parallelSafe, false);
});

/**
 * The node run carries the contract for the trace, but the recovery layer never
 * sees a node run -- it sees a persisted step. A graph node is stored under the
 * same custom_skill step type as an ordinary RAG read, so unless the contract
 * travels with the step input there is nothing in the record that would stop
 * auto recovery from re-running a skill that writes.
 */
test("runExecutionGraph persists each node's replay contract with the step input", async () => {
  const registry = createRegistry([
    createSkill({
      execute: async () => ({ citations: [], text: "ok" }),
      id: "risk_review",
    }),
    {
      // Declared by the skill rather than inherited from the read-only RAG
      // contract the harness builds on: a skill that writes has no standing to
      // call itself replay-safe, and the persisted record has to carry what the
      // skill actually said.
      ...createSkill({
        effects: SKILL_EFFECTS.externalWrite,
        execute: async () => ({ citations: [], text: "published" }),
        id: "publish_report",
      }),
      idempotency: SKILL_IDEMPOTENCY.adapterDefined,
      replaySafe: false,
    },
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "risk_a", skillId: "risk_review" }),
      node({ dependsOn: ["risk_a"], nodeId: "publish", skillId: "publish_report" }),
    ],
  });

  const { lifecycle } = await runGraph({
    budgetState: createAgentBudget({ maxCustomSkillCalls: 2 }),
    graph,
    registry,
  });

  const startedInput = new Map(
    lifecycle
      .filter((entry) => entry.verb === "start")
      .map((entry) => [entry.id, entry.input])
  );

  assert.deepEqual(
    {
      effects: startedInput.get("custom_skill:risk_a").effects,
      idempotency: startedInput.get("custom_skill:risk_a").idempotency,
      replaySafe: startedInput.get("custom_skill:risk_a").replaySafe,
    },
    {
      effects: SKILL_EFFECTS.readOnly,
      idempotency: SKILL_IDEMPOTENCY.readOnlyRag,
      replaySafe: true,
    }
  );
  assert.deepEqual(
    {
      effects: startedInput.get("custom_skill:publish").effects,
      idempotency: startedInput.get("custom_skill:publish").idempotency,
      replaySafe: startedInput.get("custom_skill:publish").replaySafe,
    },
    {
      effects: SKILL_EFFECTS.externalWrite,
      idempotency: SKILL_IDEMPOTENCY.adapterDefined,
      replaySafe: false,
    }
  );
});

// ---------------------------------------------------------------------------
// Scenario F -- a retry must run on the input the node was originally given
// ---------------------------------------------------------------------------

test("runExecutionGraph persists the upstream-bound input with the step so a replay sees the same data", async () => {
  const registry = createRegistry([
    createSkill({
      execute: answering("Compare found a renewal clause.", [{ docId: "doc-1", page: 2 }]),
      id: "compare_documents",
    }),
    createSkill({
      execute: answering("Risk reviewed.", [{ docId: "doc-1", page: 3 }]),
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({
        dependsOn: ["compare"],
        inputBindings: {
          docIds: requestField("docIds"),
          priorFindings: nodeOutput("compare", "text"),
          question: requestField("question"),
        },
        nodeId: "risk",
        skillId: "risk_review",
      }),
    ],
  });

  const { lifecycle } = await runGraph({ graph, registry });
  const startedInput = new Map(
    lifecycle
      .filter((entry) => entry.verb === "start")
      .map((entry) => [entry.id, entry.input])
  );

  // The recovery handler is handed the stored step and nothing else. If the
  // upstream text lived only in memory, a retried risk node would run without
  // it and quietly answer a different question than the one that was traced.
  assert.equal(
    startedInput.get("custom_skill:risk").priorFindings,
    "Compare found a renewal clause."
  );
  assert.equal(
    Object.hasOwn(startedInput.get("custom_skill:compare"), "priorFindings"),
    false
  );
});
