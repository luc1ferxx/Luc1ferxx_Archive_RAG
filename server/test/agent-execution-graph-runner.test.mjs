import test from "node:test";
import assert from "node:assert/strict";
import { createAgentBudget, getBudgetSnapshot } from "../rag/agent-budget.js";
import {
  EXECUTION_GRAPH_FAILURE_POLICIES,
  EXECUTION_GRAPH_REASON_CODES,
  createExecutionGraph,
} from "../rag/agent-execution-graph.js";
import { runExecutionGraph } from "../rag/agent-execution-graph-runner.js";
import { AGENT_INTERRUPT_TYPES, AgentRunInterruptError } from "../rag/agent-interrupts.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import { createBuiltInSkills } from "../rag/skills/built-ins.js";
import {
  CUSTOM_RAG_SKILL_INPUT_SCHEMA,
  CUSTOM_RAG_SKILL_CONTRACT,
  CUSTOM_RAG_SKILL_OUTPUT_SCHEMA,
} from "../rag/skills/custom/custom-skill-contract.js";
import {
  SKILL_EFFECTS,
  SKILL_IDEMPOTENCY,
  SKILL_VALUE_TYPES,
} from "../rag/skills/skill-contract.js";

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

// Most scheduler fixtures predate the now-required abstained field. Keep
// their success shape explicit while allowing raw malformed outputs in the
// output-contract regressions below.
const createSkill = ({
  budgetKey = "customSkillCalls",
  effects,
  execute,
  id,
  inputSchema,
  label = id,
  outputSchema,
  parallelSafe,
  rawExecute = false,
  version = "1.0.0",
}) => ({
  ...CUSTOM_RAG_SKILL_CONTRACT,
  budgetKey,
  execute: rawExecute
    ? execute
    : async (context) => ({ abstained: false, ...(await execute(context)) }),
  id,
  kind: "custom",
  label,
  match: () => true,
  requiresAccessScope: true,
  version,
  ...(effects === undefined ? {} : { effects }),
  ...(inputSchema === undefined ? {} : { inputSchema }),
  ...(outputSchema === undefined ? {} : { outputSchema }),
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
  when,
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
  ...(when === undefined ? {} : { when }),
});

const runGraph = async ({
  authorizedDocIds = null,
  authorizedSkillIds,
  budgetState = createAgentBudget(),
  capabilityRegistry,
  completedNodeRuns,
  docIds = ["doc-1", "doc-2"],
  graph,
  maxConcurrency,
  onNodeSettled,
  question = "Compare the two contracts and review the risks.",
  ragService = {},
  registry,
  retrievalPlan = { retrievalQueries: [{ id: "primary", query: "contract risks" }] },
  tracker = createTracker(budgetState),
}) => {
  const budgetTrace = [];
  const trace = [];
  const lifecycle = [];

  const outcome = await runExecutionGraph({
    accessScope: { userId: "alice", workspaceId: "acme" },
    addBudgetLimitTrace: (step) => budgetTrace.push(step),
    addTraceStep: (step) => trace.push(step),
    authorizedDocIds: authorizedDocIds ?? docIds,
    authorizedSkillIds: authorizedSkillIds ?? registry.list().map((skill) => skill.id),
    budgetState,
    capabilityRegistry,
    buildSkillTraceDetail: tracker.buildSkillTraceDetail,
    completedNodeRuns,
    docIds,
    executeObservedSkill: tracker.executeObservedSkill,
    graph,
    maxConcurrency,
    onNodeSettled,
    question,
    ragService,
    recordSkillResult: tracker.recordSkillResult,
    recordSkippedSkill: tracker.recordSkippedSkill,
    registry,
    retrievalPlan,
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

// This test asserts the default follow-up question; the flag that changes it
// (AGENT_FOLLOW_UP_ORIGINAL_QUESTION) is pinned off so an ambient value does
// not change what is asserted.
const pinDefaultFollowUpQuestion = (t) => {
  const previous = process.env.AGENT_FOLLOW_UP_ORIGINAL_QUESTION;

  process.env.AGENT_FOLLOW_UP_ORIGINAL_QUESTION = "false";
  t.after(() => {
    if (previous === undefined) {
      delete process.env.AGENT_FOLLOW_UP_ORIGINAL_QUESTION;
    } else {
      process.env.AGENT_FOLLOW_UP_ORIGINAL_QUESTION = previous;
    }
  });
};

test("v3 runs a contracted non-custom node with a distinct graph lifecycle identity", async () => {
  const calls = [];
  const registry = createRegistry([{
    ...createSkill({
      budgetKey: "webSearchCalls",
      effects: SKILL_EFFECTS.externalRead,
      execute: async ({ capabilityRegistry, question }) => {
        calls.push({ capabilityRegistry, question });
        return { citations: [], text: "External evidence" };
      },
      id: "web_search",
      inputSchema: { question: { required: true, type: SKILL_VALUE_TYPES.string } },
      parallelSafe: false,
    }),
    idempotency: SKILL_IDEMPOTENCY.nondeterministic,
    kind: "built_in",
    replaySafe: false,
    retryable: false,
  }]);
  const capabilityRegistry = { marker: "trusted-runtime-only" };
  const graph = createExecutionGraph({
    nodes: [node({
      inputBindings: { question: requestField("question") },
      nodeId: "web:search",
      skillId: "web_search",
    })],
    version: "v3",
  });

  const { lifecycle, outcome, trace } = await runGraph({
    capabilityRegistry,
    docIds: [],
    graph,
    registry,
  });

  const expectedStepId = `agent_graph_node:${Buffer.from("web:search").toString("base64url")}`;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.nodeRuns[0].stepId, expectedStepId);
  assert.deepEqual(calls, [{ capabilityRegistry, question: "Compare the two contracts and review the risks." }]);
  assert.deepEqual(lifecycle.map(({ type, id, verb }) => ({ type, id, verb })), [
    { id: expectedStepId, type: "graph_node", verb: "start" },
    { id: expectedStepId, type: undefined, verb: "complete" },
  ]);
  assert.equal(trace[0].type, "graph_node");
});

test("graph preflight interrupts before lifecycle start, budget charge, or adapter execution", async () => {
  let executed = 0;
  let started = 0;
  let preflighted = 0;
  const skill = createSkill({
    execute: async () => {
      executed += 1;
      return { citations: [], text: "Unexpected execution" };
    },
    id: "approval_example",
    parallelSafe: false,
  });
  const registry = createRegistry([skill]);
  const budgetState = createAgentBudget();
  const graph = createExecutionGraph({
    nodes: [node({ nodeId: "write", skillId: skill.id })],
    version: "v3",
  });

  await assert.rejects(
    runExecutionGraph({
      accessScope: { userId: "alice", workspaceId: "acme" },
      authorizedDocIds: ["doc-1"],
      authorizedSkillIds: [skill.id],
      budgetState,
      docIds: ["doc-1"],
      executeObservedSkill: async () => {
        executed += 1;
        throw new Error("Unexpected adapter call");
      },
      graph,
      preflightNode: ({ boundInputs, node: graphNode }) => {
        preflighted += 1;
        assert.equal(graphNode.nodeId, "write");
        assert.deepEqual(boundInputs.docIds, ["doc-1"]);
        assert.equal(budgetState.used.customSkillCalls, 0);
        throw new AgentRunInterruptError({
          type: AGENT_INTERRUPT_TYPES.capabilityApprovalRequired,
        });
      },
      question: "Review a document",
      registry,
      stepLifecycle: {
        startStep: async () => { started += 1; },
        completeStep: async () => { throw new Error("Unexpected completion"); },
        failStep: async () => { throw new Error("Unexpected failure step"); },
      },
    }),
    (error) => error.agentRunInterrupt === true &&
      error.executionGraphNodeRuns[0].status === "pending"
  );
  assert.equal(preflighted, 1);
  assert.equal(started, 0);
  assert.equal(executed, 0);
  assert.equal(budgetState.used.customSkillCalls, 0);
});

const createDocumentFollowUpGraph = () => createExecutionGraph({
  nodes: [
    node({ nodeId: "primary", skillId: "document_rag" }),
    node({
      dependsOn: ["primary"],
      inputBindings: {
        docIds: requestField("docIds"),
        evidence: nodeOutput("primary", "evidence"),
        question: requestField("question"),
      },
      nodeId: "check",
      skillId: "document_evidence_check",
    }),
    node({
      dependsOn: ["check"],
      inputBindings: {
        docIds: requestField("docIds"),
        question: nodeOutput("check", "followUpQuestion"),
        retrievalPlan: nodeOutput("check", "followUpRetrievalPlan"),
      },
      nodeId: "follow-up",
      skillId: "document_rag",
      when: { equals: true, nodeId: "check", output: "retryRecommended" },
    }),
  ],
  version: "v3",
});

test("v3 document evidence node schedules exactly one typed follow-up when support is missing", async (t) => {
  pinDefaultFollowUpQuestion(t);
  const registry = createRegistry(createBuiltInSkills());
  const docIds = ["doc-1", "doc-2"];
  const calls = [];
  const graph = createDocumentFollowUpGraph();
  const primaryRetrievalPlan = {
    phase: "primary",
    retrievalQueries: [{ id: "primary", query: "contract risks" }],
  };
  const { outcome, budgetState } = await runGraph({
    docIds,
    graph,
    ragService: {
      chat: async (selectedDocIds, question, options) => {
        calls.push({ selectedDocIds, question, options });
        return calls.length === 1
          ? { abstained: false, citations: [], text: "The agreements differ." }
          : {
              abstained: false,
              citations: [{
                docId: "doc-1",
                excerpt: "The agreements differ in notice periods.",
                fileName: "a.pdf",
                pageNumber: 1,
                rank: 1,
              }],
              text: "The agreements differ in notice periods. [Source 1]",
            };
      },
    },
    registry,
    retrievalPlan: primaryRetrievalPlan,
  });

  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.nodeRuns.map((run) => run.status), [
    "completed", "completed", "completed",
  ]);
  assert.equal(outcome.nodeRuns[1].result.graphOutput.retryRecommended, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.selectedDocIds), [docIds, docIds]);
  assert.match(calls[1].question, /Evidence issue:/);
  assert.equal(calls[0].options.retrievalPlan, primaryRetrievalPlan);
  assert.deepEqual(
    calls[1].options.retrievalPlan,
    outcome.nodeRuns[1].result.graphOutput.followUpRetrievalPlan
  );
  assert.equal(calls[1].options.retrievalPlan.phase, "follow_up");
  assert.notDeepEqual(calls[1].options.retrievalPlan, primaryRetrievalPlan);
  assert.deepEqual(
    calls[1].options.retrievalPlan.retrievalQueries.map(({ id }) => id),
    ["primary", "follow-up-evidence", "follow-up-source-check"]
  );
  assert.equal(budgetState.used.documentRagCalls, 2);
});

test("v3 explicit document abstention does not schedule a follow-up RAG call", async () => {
  const calls = [];
  const { outcome, budgetState } = await runGraph({
    graph: createDocumentFollowUpGraph(),
    ragService: {
      chat: async (...args) => {
        calls.push(args);
        return { abstained: true, citations: [], text: "Insufficient evidence." };
      },
    },
    registry: createRegistry(createBuiltInSkills()),
  });

  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.nodeRuns.map((run) => run.status), [
    "completed", "completed", "skipped",
  ]);
  assert.equal(outcome.nodeRuns[1].result.graphOutput.retryRecommended, false);
  assert.equal(
    Object.hasOwn(outcome.nodeRuns[1].result.graphOutput, "followUpRetrievalPlan"),
    false
  );
  assert.equal(calls.length, 1);
  assert.equal(budgetState.used.documentRagCalls, 1);
});

test("v3 validates a document result before taking a conditional Web edge", async () => {
  const order = [];
  const builtIns = createBuiltInSkills();
  const registry = createRegistry(builtIns.filter(
    (skill) => ["document_rag", "web_search"].includes(skill.id)
  ));
  const ragService = {
    chat: async (selectedDocIds, requestQuestion, options) => {
      order.push("document_rag");
      assert.deepEqual(selectedDocIds, ["doc-1", "doc-2"]);
      assert.equal(options.accessScope.userId, "alice");
      assert.equal(requestQuestion, "Compare the two contracts and review the risks.");
      return { abstained: true, citations: [], text: "Insufficient document evidence." };
    },
  };
  const capabilityRegistry = {
    execute: async (capabilityId, args) => {
      order.push("web_search");
      assert.equal(capabilityId, "web.search");
      assert.equal(args.accessScope.workspaceId, "acme");
      return { citations: [{ url: "https://example.test/source" }], text: "External context." };
    },
  };
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "document", skillId: "document_rag" }),
      node({
        dependsOn: ["document"],
        inputBindings: { question: requestField("question") },
        nodeId: "web",
        skillId: "web_search",
        when: { equals: true, nodeId: "document", output: "abstained" },
      }),
    ],
    version: "v3",
  });

  const { budgetState, outcome, trace } = await runGraph({
    capabilityRegistry,
    graph,
    ragService,
    registry,
  });

  assert.equal(outcome.ok, true);
  assert.deepEqual(order, ["document_rag", "web_search"]);
  assert.deepEqual(outcome.nodeRuns.map((run) => run.status), ["completed", "completed"]);
  assert.deepEqual(trace.map((step) => step.type), ["graph_node", "graph_node"]);
  assert.equal(getBudgetSnapshot(budgetState).used.documentRagCalls, 1);
  assert.equal(getBudgetSnapshot(budgetState).used.webSearchCalls, 1);
});

test("a typed upstream docIds output cannot widen the request scope", async () => {
  const executed = [];
  const source = createSkill({
    execute: async () => ({
      citations: [],
      docIds: ["foreign-doc"],
      text: "Select foreign document",
    }),
    id: "select_documents",
    outputSchema: {
      ...CUSTOM_RAG_SKILL_OUTPUT_SCHEMA,
      docIds: { required: true, type: SKILL_VALUE_TYPES.stringArray },
    },
  });
  const target = createSkill({
    execute: async () => { executed.push("target"); return { citations: [], text: "read" }; },
    id: "read_documents",
  });
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "source", skillId: source.id }),
      node({
        dependsOn: ["source"],
        inputBindings: {
          docIds: nodeOutput("source", "docIds"),
          question: requestField("question"),
        },
        nodeId: "target",
        skillId: target.id,
      }),
    ],
  });

  const { budgetState, outcome } = await runGraph({
    graph,
    registry: createRegistry([source, target]),
  });

  assert.deepEqual(executed, []);
  assert.equal(outcome.nodeRuns[0].status, "completed");
  assert.equal(outcome.nodeRuns[1].status, "failed");
  assert.match(outcome.nodeRuns[1].result.error.message, /authorized request/);
  assert.equal(getBudgetSnapshot(budgetState).used.customSkillCalls, 1);
});

test("a dynamic empty scoped document list fails before adapter execution or budget", async () => {
  const executed = [];
  const source = createSkill({
    execute: async () => ({ citations: [], docIds: [], text: "No matches" }),
    id: "select_documents",
    outputSchema: {
      ...CUSTOM_RAG_SKILL_OUTPUT_SCHEMA,
      docIds: { required: true, type: SKILL_VALUE_TYPES.stringArray },
    },
  });
  const target = createSkill({
    execute: async () => { executed.push("target"); return { citations: [], text: "read" }; },
    id: "read_documents",
  });
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "source", skillId: source.id }),
      node({
        dependsOn: ["source"],
        inputBindings: {
          docIds: nodeOutput("source", "docIds"),
          question: requestField("question"),
        },
        nodeId: "target",
        skillId: target.id,
      }),
    ],
  });

  const { budgetState, outcome } = await runGraph({
    graph,
    registry: createRegistry([source, target]),
  });

  assert.deepEqual(executed, []);
  assert.equal(outcome.nodeRuns[1].status, "failed");
  assert.match(outcome.nodeRuns[1].result.error.message, /at least one document/);
  assert.equal(getBudgetSnapshot(budgetState).used.customSkillCalls, 1);
});

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

test("runExecutionGraph rejects out-of-scope request docIds even without node scope", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async ({ docIds }) => {
        executed.push([...docIds]);
        return { citations: [], text: "must not run" };
      },
      id: "compare_documents",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [node({ nodeId: "compare", skillId: "compare_documents" })],
  });

  const { budgetState, lifecycle, outcome, trace } = await runGraph({
    authorizedDocIds: ["doc-1"],
    docIds: ["doc-1", "doc-2"],
    graph,
    registry,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.errors[0].code, EXECUTION_GRAPH_REASON_CODES.outOfScopeDocument);
  assert.deepEqual(outcome.nodeRuns, []);
  assert.deepEqual(outcome.results, []);
  assert.deepEqual(executed, []);
  assert.deepEqual(lifecycle, []);
  assert.deepEqual(trace, []);
  assert.equal(getBudgetSnapshot(budgetState).used.customSkillCalls, 0);
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

test("v2 false condition skips without execution or budget and propagates dependencySkipped", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("gate");
        return { citations: [], proceed: false, text: "No follow-up needed." };
      },
      id: "gate",
      outputSchema: { proceed: { type: SKILL_VALUE_TYPES.boolean, required: true } },
    }),
    createSkill({
      execute: async () => {
        executed.push("conditional");
        return { citations: [], text: "conditional" };
      },
      id: "conditional",
    }),
    createSkill({
      execute: async () => {
        executed.push("downstream");
        return { citations: [], text: "downstream" };
      },
      id: "downstream",
    }),
  ]);
  const graph = createExecutionGraph({
    version: "v2",
    nodes: [
      node({ nodeId: "gate", skillId: "gate" }),
      node({
        dependsOn: ["gate"],
        nodeId: "conditional",
        skillId: "conditional",
        when: { nodeId: "gate", output: "proceed", equals: true },
      }),
      node({ dependsOn: ["conditional"], nodeId: "downstream", skillId: "downstream" }),
    ],
  });

  const { budgetState, lifecycle, outcome } = await runGraph({ graph, registry });

  assert.deepEqual(executed, ["gate"]);
  assert.deepEqual(outcome.nodeRuns.map(({ status, reason }) => ({ status, reason })), [
    { status: "completed", reason: null },
    { status: "skipped", reason: "condition_not_met" },
    { status: "skipped", reason: "dependency_skipped" },
  ]);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.ok, true);
  assert.equal(getBudgetSnapshot(budgetState).used.customSkillCalls, 1);
  assert.deepEqual(lifecycle.filter(({ verb }) => verb === "start").map(({ id }) => id), [
    "custom_skill:gate",
  ]);
});

test("v2 true condition waits for the validated source checkpoint", async () => {
  const executed = [];
  const checkpointEntered = createDeferred();
  const releaseCheckpoint = createDeferred();
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("gate");
        return { citations: [], proceed: true, text: "Proceed." };
      },
      id: "gate",
      outputSchema: { proceed: { type: SKILL_VALUE_TYPES.boolean, required: true } },
    }),
    createSkill({
      execute: async () => {
        executed.push("conditional");
        return { citations: [], text: "Done." };
      },
      id: "conditional",
    }),
  ]);
  const graph = createExecutionGraph({
    version: "v2",
    nodes: [
      node({ nodeId: "gate", skillId: "gate" }),
      node({
        dependsOn: ["gate"],
        nodeId: "conditional",
        skillId: "conditional",
        when: { nodeId: "gate", output: "proceed", equals: true },
      }),
    ],
  });
  const pending = runGraph({
    graph,
    registry,
    onNodeSettled: async ({ nodeRun }) => {
      if (nodeRun.nodeId === "gate") {
        checkpointEntered.resolve();
        await releaseCheckpoint.promise;
      }
    },
  });

  await checkpointEntered.promise;
  assert.deepEqual(executed, ["gate"]);
  releaseCheckpoint.resolve();

  const { budgetState, outcome } = await pending;
  assert.deepEqual(executed, ["gate", "conditional"]);
  assert.equal(outcome.status, "completed");
  assert.equal(getBudgetSnapshot(budgetState).used.customSkillCalls, 2);
});

test("v2 condition can take the false-valued branch", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => ({ citations: [], proceed: false, text: "No extra evidence." }),
      id: "gate",
      outputSchema: { proceed: { type: SKILL_VALUE_TYPES.boolean, required: true } },
    }),
    createSkill({
      execute: async () => {
        executed.push("no_follow_up");
        return { citations: [], text: "Answer directly." };
      },
      id: "no_follow_up",
    }),
  ]);
  const graph = createExecutionGraph({
    version: "v2",
    nodes: [
      node({ nodeId: "gate", skillId: "gate" }),
      node({
        dependsOn: ["gate"],
        nodeId: "no_follow_up",
        skillId: "no_follow_up",
        when: { nodeId: "gate", output: "proceed", equals: false },
      }),
    ],
  });

  const { outcome } = await runGraph({ graph, registry });

  assert.deepEqual(executed, ["no_follow_up"]);
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
  assert.equal(outcome.ok, false);
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
  assert.equal(outcome.ok, false);
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

test("runExecutionGraph refuses a completed node run whose skill no longer matches the node", async () => {
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

  await assert.rejects(runGraph({
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
  }), { code: "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY" });

  assert.deepEqual(executed, []);
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

test("runExecutionGraph fails malformed success before a dependent can consume it", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare");

        // Registry normalization would turn missing text into an empty string.
        return { abstained: false, citations: [] };
      },
      id: "compare_documents",
      rawExecute: true,
    }),
    createSkill({
      execute: async () => {
        executed.push("risk");

        return { citations: [], text: "should not run" };
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

  const { lifecycle, outcome, trace, tracker } = await runGraph({ graph, registry });

  assert.deepEqual(executed, ["compare"]);
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.nodeRuns[0].status, "failed");
  assert.equal(outcome.nodeRuns[0].result.error.name, "SkillOutputContractError");
  assert.equal(outcome.nodeRuns[1].status, "skipped");
  assert.equal(outcome.nodeRuns[1].reason, "dependency_failed");
  assert.deepEqual(lifecycle.map((entry) => entry.verb), ["start", "fail"]);
  assert.equal(trace[0].status, "failed");
  assert.equal(tracker.getSkillObservations()[0].status, "failed");
});

test("runExecutionGraph rejects a wrong output type without forwarding citations", async () => {
  const registry = createRegistry([
    createSkill({
      execute: async () => ({ abstained: false, citations: "doc-1", text: "bad" }),
      id: "compare_documents",
      rawExecute: true,
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [node({ nodeId: "compare", skillId: "compare_documents" })],
  });

  const { outcome } = await runGraph({ graph, registry });

  assert.equal(outcome.nodeRuns[0].status, "failed");
  assert.match(outcome.nodeRuns[0].result.error.message, /citations must be citation\[\]/);
  assert.deepEqual(outcome.nodeRuns[0].result.citations, []);
});

test("runExecutionGraph applies fail_fast when a skill returns malformed output", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare");

        return { abstained: false, citations: [], text: undefined };
      },
      id: "compare_documents",
      rawExecute: true,
    }),
    createSkill({
      execute: async () => {
        executed.push("risk");

        return { citations: [], text: "should not run" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({ nodeId: "risk", skillId: "risk_review" }),
    ],
  });

  const { outcome } = await runGraph({ graph, maxConcurrency: 1, registry });

  assert.deepEqual(executed, ["compare"]);
  assert.equal(outcome.nodeRuns[0].status, "failed");
  assert.equal(outcome.nodeRuns[1].status, "skipped");
  assert.equal(outcome.nodeRuns[1].reason, "aborted_after_failure");
});

test("runExecutionGraph rejects a concrete request input with the wrong type before calling the skill", async () => {
  let executions = 0;
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 1 });
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executions += 1;

        return { citations: [], text: "should not run" };
      },
      id: "compare_documents",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [node({ nodeId: "compare", skillId: "compare_documents" })],
  });

  const { lifecycle, outcome, tracker } = await runGraph({
    budgetState,
    graph,
    question: 42,
    registry,
  });

  assert.equal(executions, 0);
  assert.equal(outcome.nodeRuns[0].status, "failed");
  assert.equal(outcome.nodeRuns[0].result.error.name, "SkillInputContractError");
  assert.deepEqual(lifecycle.map((entry) => entry.verb), ["start", "fail"]);
  assert.equal(tracker.getSkillObservations()[0].status, "failed");
  assert.equal(getBudgetSnapshot(budgetState).used.customSkillCalls, 0);
});

test("runExecutionGraph blocks invalid resolved input even when an observer ignores validation hooks", async () => {
  let observerCalls = 0;
  let executions = 0;
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 1 });
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executions += 1;
        return { citations: [], text: "must not run" };
      },
      id: "compare_documents",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [node({ nodeId: "compare", skillId: "compare_documents" })],
  });

  const outcome = await runExecutionGraph({
    accessScope: { userId: "alice", workspaceId: "acme" },
    authorizedDocIds: ["doc-1"],
    budgetState,
    docIds: ["doc-1"],
    executeObservedSkill: async (skill, context) => {
      observerCalls += 1;
      return { ok: true, ...(await skill.execute(context)) };
    },
    graph,
    question: 42,
    registry,
    stepLifecycle: {
      runStep: async ({ execute }) => execute(),
    },
  });

  assert.equal(observerCalls, 0);
  assert.equal(executions, 0);
  assert.equal(outcome.nodeRuns[0].result.error.name, "SkillInputContractError");
  assert.equal(getBudgetSnapshot(budgetState).used.customSkillCalls, 0);
});

test("runExecutionGraph still supplies runtime identity to the Skill context", async () => {
  let observedIdentity = null;
  const registry = createRegistry([
    createSkill({
      execute: async ({ sessionId, userId }) => {
        observedIdentity = { sessionId, userId };
        return { citations: [], text: "done" };
      },
      id: "compare_documents",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [node({ nodeId: "compare", skillId: "compare_documents" })],
  });

  const { outcome } = await runGraph({ graph, registry });

  assert.equal(outcome.status, "completed");
  assert.deepEqual(observedIdentity, { sessionId: "session-1", userId: "alice" });
});

test("runExecutionGraph treats a null optional retrieval plan as absent", async () => {
  const observed = [];
  const registry = createRegistry([
    createSkill({
      execute: async ({ retrievalPlan }) => {
        observed.push(retrievalPlan);

        return { citations: [], text: "without a retrieval plan" };
      },
      id: "compare_documents",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({
        inputBindings: {
          docIds: requestField("docIds"),
          question: requestField("question"),
          retrievalPlan: requestField("retrievalPlan"),
        },
        nodeId: "compare",
        skillId: "compare_documents",
      }),
    ],
  });

  const { outcome } = await runGraph({ graph, registry, retrievalPlan: null });

  assert.equal(outcome.status, "completed");
  assert.deepEqual(observed, [null]);
});

test("runExecutionGraph fails a required input absent from an optional upstream output", async () => {
  const executed = [];
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 2 });
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare");

        return { citations: [], text: "comparison" };
      },
      id: "compare_documents",
      outputSchema: {
        ...CUSTOM_RAG_SKILL_OUTPUT_SCHEMA,
        delta: { required: false, type: SKILL_VALUE_TYPES.string },
      },
    }),
    createSkill({
      execute: async () => {
        executed.push("risk");

        return { citations: [], text: "should not run" };
      },
      id: "risk_review",
      inputSchema: {
        ...CUSTOM_RAG_SKILL_INPUT_SCHEMA,
        delta: { required: true, type: SKILL_VALUE_TYPES.string },
      },
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({
        dependsOn: ["compare"],
        inputBindings: {
          delta: nodeOutput("compare", "delta"),
          docIds: requestField("docIds"),
          question: requestField("question"),
        },
        nodeId: "risk",
        skillId: "risk_review",
      }),
    ],
  });

  const { outcome } = await runGraph({ budgetState, graph, registry });

  assert.deepEqual(executed, ["compare"]);
  assert.equal(outcome.nodeRuns[0].status, "completed");
  assert.equal(outcome.nodeRuns[1].status, "failed");
  assert.equal(outcome.nodeRuns[1].result.error.name, "SkillInputContractError");
  assert.equal(getBudgetSnapshot(budgetState).used.customSkillCalls, 1);
});

test("runExecutionGraph refuses a malformed completed output without repeating effects", async () => {
  let executions = 0;
  const registry = createRegistry([
    createSkill({
      effects: SKILL_EFFECTS.externalWrite,
      execute: async () => {
        executions += 1;

        return { citations: [], text: "fresh" };
      },
      id: "compare_documents",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [node({ nodeId: "compare", skillId: "compare_documents" })],
  });

  await assert.rejects(runGraph({
    completedNodeRuns: [
      {
        nodeId: "compare",
        result: {
          abstained: false,
          ok: true,
          skillId: "compare_documents",
          skillVersion: "1.0.0",
          text: "checkpoint missing citations",
        },
        status: "completed",
      },
    ],
    graph,
    registry,
  }), { code: "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY" });

  assert.equal(executions, 0);
});

test("runExecutionGraph refuses a completed output whose typed envelope disagrees with the saved result", async () => {
  let executions = 0;
  const registry = createRegistry([
    createSkill({
      effects: SKILL_EFFECTS.workspaceWrite,
      execute: async () => {
        executions += 1;
        return { citations: [], text: "fresh" };
      },
      id: "compare_documents",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [node({ nodeId: "compare", skillId: "compare_documents" })],
  });

  await assert.rejects(runGraph({
    completedNodeRuns: [{
      nodeId: "compare",
      result: {
        abstained: false,
        citations: [],
        graphOutput: { abstained: false, citations: [], text: "different evidence" },
        ok: true,
        skillId: "compare_documents",
        skillVersion: "1.0.0",
        text: "saved answer",
      },
      skillId: "compare_documents",
      status: "completed",
    }],
    graph,
    registry,
  }), { code: "AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY" });
  assert.equal(executions, 0);
});

test("runExecutionGraph forwards only validated declared structured outputs", async () => {
  const observed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => ({
        abstained: false,
        citations: [],
        text: "comparison",
        value: { differences: { clause: "renewal" }, undeclared: "discard me" },
      }),
      id: "compare_documents",
      outputSchema: {
        ...CUSTOM_RAG_SKILL_OUTPUT_SCHEMA,
        differences: { required: true, type: SKILL_VALUE_TYPES.object },
      },
      rawExecute: true,
    }),
    createSkill({
      execute: async ({ differences }) => {
        observed.push(differences);

        return { citations: [], text: "reviewed" };
      },
      id: "risk_review",
      inputSchema: {
        ...CUSTOM_RAG_SKILL_INPUT_SCHEMA,
        differences: { required: true, type: SKILL_VALUE_TYPES.object },
      },
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({
        dependsOn: ["compare"],
        inputBindings: {
          differences: nodeOutput("compare", "differences"),
          docIds: requestField("docIds"),
          question: requestField("question"),
        },
        nodeId: "risk",
        skillId: "risk_review",
      }),
    ],
  });

  const { lifecycle, outcome } = await runGraph({ graph, registry });

  assert.equal(outcome.status, "completed");
  assert.deepEqual(observed, [{ clause: "renewal" }]);
  assert.deepEqual(outcome.nodeRuns[0].result.graphOutput, {
    abstained: false,
    citations: [],
    differences: { clause: "renewal" },
    text: "comparison",
  });
  assert.deepEqual(
    lifecycle.find((entry) => entry.id === "custom_skill:risk" && entry.verb === "start")
      .input.boundInputs.differences,
    { clause: "renewal" }
  );
  assert.equal(Object.hasOwn(outcome.nodeRuns[0].result.graphOutput, "undeclared"), false);
});

test("runExecutionGraph awaits checkpoint before launching a dependent node", async () => {
  const checkpointEntered = createDeferred();
  const releaseCheckpoint = createDeferred();
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare");

        return { citations: [], text: "comparison" };
      },
      id: "compare_documents",
    }),
    createSkill({
      execute: async () => {
        executed.push("risk");

        return { citations: [], text: "review" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({ dependsOn: ["compare"], nodeId: "risk", skillId: "risk_review" }),
    ],
  });
  const pending = runGraph({
    graph,
    onNodeSettled: async ({ nodeRun }) => {
      if (nodeRun.nodeId === "compare") {
        checkpointEntered.resolve();
        await releaseCheckpoint.promise;
      }
    },
    registry,
  });

  await checkpointEntered.promise;
  assert.deepEqual(executed, ["compare"]);
  releaseCheckpoint.resolve();
  const { outcome } = await pending;
  assert.equal(outcome.status, "completed");
  assert.deepEqual(executed, ["compare", "risk"]);
});

test("a parallel sibling cannot wake dependents while their checkpoint is pending", async () => {
  const checkpointEntered = createDeferred();
  const releaseCheckpoint = createDeferred();
  const siblingSettled = createDeferred();
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare");

        return { citations: [], text: "comparison" };
      },
      id: "compare_documents",
    }),
    createSkill({
      execute: async () => {
        executed.push("summary");

        return { citations: [], text: "summary" };
      },
      id: "summarize_contract",
    }),
    createSkill({
      execute: async () => {
        executed.push("risk");

        return { citations: [], text: "review" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({ nodeId: "summary", skillId: "summarize_contract" }),
      node({ dependsOn: ["compare"], nodeId: "risk", skillId: "risk_review" }),
    ],
  });
  const pending = runGraph({
    budgetState: createAgentBudget({ maxCustomSkillCalls: 3 }),
    graph,
    maxConcurrency: 2,
    onNodeSettled: async ({ nodeRun }) => {
      if (nodeRun.nodeId === "compare") {
        checkpointEntered.resolve();
        await releaseCheckpoint.promise;
      } else if (nodeRun.nodeId === "summary") {
        siblingSettled.resolve();
      }
    },
    registry,
  });

  await Promise.all([checkpointEntered.promise, siblingSettled.promise]);
  // Let the scheduling loop react to the sibling's completion. This checks a
  // state transition, not an elapsed-time or throughput threshold.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(executed, ["compare", "summary"]);
  releaseCheckpoint.resolve();
  const { outcome } = await pending;
  assert.equal(outcome.status, "completed");
  assert.deepEqual(executed, ["compare", "summary", "risk"]);
});

test("runExecutionGraph stops before dependents when checkpoint persistence fails", async () => {
  const executed = [];
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare");

        return { citations: [], text: "comparison" };
      },
      id: "compare_documents",
    }),
    createSkill({
      execute: async () => {
        executed.push("risk");

        return { citations: [], text: "review" };
      },
      id: "risk_review",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({ dependsOn: ["compare"], nodeId: "risk", skillId: "risk_review" }),
    ],
  });

  await assert.rejects(
    runGraph({
      graph,
      onNodeSettled: async () => {
        throw new Error("checkpoint unavailable");
      },
      registry,
    }),
    /checkpoint unavailable/
  );
  assert.deepEqual(executed, ["compare"]);
});

test("a sibling checkpoint success cannot hide a same-turn checkpoint failure", async () => {
  const bothSettling = createDeferred();
  const releaseSuccessfulCheckpoint = createDeferred();
  const failOtherCheckpoint = createDeferred();
  const executed = [];
  let settlingCount = 0;
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare");
        return { citations: [], text: "comparison" };
      },
      id: "compare_documents",
    }),
    createSkill({
      execute: async () => {
        executed.push("summary");
        return { citations: [], text: "summary" };
      },
      id: "summarize_contract",
    }),
    createSkill({
      effects: SKILL_EFFECTS.workspaceWrite,
      execute: async () => {
        executed.push("write");
        return { citations: [], text: "written" };
      },
      id: "publish_report",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({ nodeId: "summary", skillId: "summarize_contract" }),
      node({ nodeId: "write", skillId: "publish_report" }),
    ],
  });
  const pending = runGraph({
    budgetState: createAgentBudget({ maxCustomSkillCalls: 3 }),
    graph,
    maxConcurrency: 2,
    onNodeSettled: async ({ nodeRun }) => {
      settlingCount += 1;

      if (settlingCount === 2) {
        bothSettling.resolve();
      }

      if (nodeRun.nodeId === "compare") {
        await failOtherCheckpoint.promise;
      } else if (nodeRun.nodeId === "summary") {
        await releaseSuccessfulCheckpoint.promise;
      }
    },
    registry,
  });

  await bothSettling.promise;
  assert.deepEqual(executed, ["compare", "summary"]);
  // These resolutions occur in one turn. Promise.race may observe the success
  // first, but the failure must still remain visible before scheduling write.
  releaseSuccessfulCheckpoint.resolve();
  failOtherCheckpoint.reject(new Error("compare checkpoint failed"));

  await assert.rejects(pending, /compare checkpoint failed/);
  assert.deepEqual(executed, ["compare", "summary"]);
});

test("checkpoint failure drains already-running siblings before rejecting", async () => {
  const bothSettling = createDeferred();
  const failCheckpoint = createDeferred();
  const releaseSibling = createDeferred();
  const executed = [];
  let settlingCount = 0;
  const registry = createRegistry([
    createSkill({
      execute: async () => {
        executed.push("compare");
        return { citations: [], text: "comparison" };
      },
      id: "compare_documents",
    }),
    createSkill({
      execute: async () => {
        executed.push("summary");
        return { citations: [], text: "summary" };
      },
      id: "summarize_contract",
    }),
    createSkill({
      effects: SKILL_EFFECTS.workspaceWrite,
      execute: async () => {
        executed.push("write");
        return { citations: [], text: "written" };
      },
      id: "publish_report",
    }),
  ]);
  const graph = createExecutionGraph({
    nodes: [
      node({ nodeId: "compare", skillId: "compare_documents" }),
      node({ nodeId: "summary", skillId: "summarize_contract" }),
      node({ nodeId: "write", skillId: "publish_report" }),
    ],
  });
  const pending = runGraph({
    budgetState: createAgentBudget({ maxCustomSkillCalls: 3 }),
    graph,
    maxConcurrency: 2,
    onNodeSettled: async ({ nodeRun }) => {
      settlingCount += 1;

      if (settlingCount === 2) {
        bothSettling.resolve();
      }

      if (nodeRun.nodeId === "compare") {
        await failCheckpoint.promise;
      } else if (nodeRun.nodeId === "summary") {
        await releaseSibling.promise;
      }
    },
    registry,
  });

  await bothSettling.promise;
  let finished = false;
  pending.finally(() => { finished = true; }).catch(() => {});
  failCheckpoint.reject(new Error("compare checkpoint failed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false, "the in-flight sibling must settle before rejection");
  assert.deepEqual(executed, ["compare", "summary"]);

  releaseSibling.resolve();
  await assert.rejects(pending, /compare checkpoint failed/);
  assert.equal(finished, true);
  assert.deepEqual(executed, ["compare", "summary"]);
});
