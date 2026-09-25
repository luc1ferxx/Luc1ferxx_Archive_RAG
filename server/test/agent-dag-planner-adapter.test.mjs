import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTION_GRAPH_FAILURE_POLICIES,
  EXECUTION_GRAPH_REASON_CODES,
  EXECUTION_GRAPH_VERSION,
} from "../rag/agent-execution-graph.js";
import {
  DAG_PLANNER_IDS,
  buildDagPlannerPrompt,
  buildDagPlanningContext,
  createAgentExecutionGraphResult,
  createDeterministicExecutionGraph,
  deterministicDagPlannerAdapter,
  normalizeExecutionGraphPayload,
} from "../rag/agent-dag-planner-adapter.js";
import { createSkillRegistry } from "../rag/skills/registry.js";
import { withPlannerRollout, withShadowPlanner } from "../rag/agent-planner-shadow.js";

// The V2 planner is the least trusted component in the runtime: it is the only
// place a language model writes something the scheduler will act on. These
// tests hold two lines at once -- what the planner is allowed to SEE (redacted
// descriptors, authorized documents, no accessScope, no executable handles) and
// what the runtime is willing to ACT on (validated graphs only, everything else
// falls back deterministically).

const createTestSkill = ({
  effects = "read_only",
  id,
  label = id,
  parallelSafe = true,
  plannerSummary = `Summary for ${id}.`,
}) => ({
  budgetKey: "customSkillCalls",
  effects,
  execute: async () => ({ citations: [], text: "", value: {} }),
  id,
  inputSchema: {
    docIds: { required: true, scoped: true, type: "string[]" },
    priorFindings: { required: false, type: "string" },
    question: { required: true, type: "string" },
  },
  kind: "custom",
  label,
  match: () => true,
  outputSchema: {
    abstained: { type: "boolean" },
    citations: { type: "citation[]" },
    text: { type: "string" },
  },
  parallelSafe,
  plannerActions: () => [{ id, label, summary: "internal planner action" }],
  plannerSummary,
  requiresAccessScope: true,
  version: "1.0.0",
});

const compareSkill = () => createTestSkill({ id: "compare_documents", label: "Compare Documents" });
const riskSkill = () => createTestSkill({ id: "risk_review", label: "Risk Review" });
const publishSkill = () =>
  createTestSkill({
    effects: "external_write",
    id: "publish_report",
    label: "Publish Report",
    parallelSafe: false,
  });

const createTestRegistry = (skills = [compareSkill(), riskSkill(), publishSkill()]) =>
  createSkillRegistry(skills);

const requestField = (field) => ({ field, source: "request" });

const nodeOutput = (nodeId, output) => ({ nodeId, output, source: "node" });

const ragNode = ({
  dependsOn = [],
  inputBindings,
  nodeId,
  rationale = `Run ${nodeId}.`,
  skillId,
  ...rest
}) => ({
  dependsOn,
  failurePolicy: EXECUTION_GRAPH_FAILURE_POLICIES.failFast,
  inputBindings: inputBindings ?? {
    docIds: requestField("docIds"),
    question: requestField("question"),
  },
  nodeId,
  rationale,
  skillId,
  ...rest,
});

const baseOptions = ({
  plannerAdapter,
  registry = createTestRegistry(),
  selectedSkills,
  ...rest
} = {}) => ({
  accessScope: { authenticated: true, authProvider: "local", userId: "alice", workspaceId: "acme" },
  authorizedDocIds: ["doc-1", "doc-2"],
  plannerAdapter,
  plannerContext: {
    docIds: ["doc-1", "doc-2"],
    plan: { mode: "skill_chain", summary: "Compare and review risk." },
    question: "Compare the two contracts and review the risks.",
    selectedSkills: selectedSkills ?? [compareSkill(), riskSkill()],
    taskMemory: {
      completedSteps: [{ agentMode: "skill_chain", answer: "earlier answer", question: "earlier question" }],
      goal: "Understand contract risk",
    },
  },
  registry,
  selectedSkills: selectedSkills ?? [compareSkill(), riskSkill()],
  ...rest,
});

const stubAdapter = (id, createExecutionGraph) => ({ createExecutionGraph, id });

const codesOf = (result) =>
  (result.planner.fallbackReasonCodes ?? []).slice().sort();

// ---------------------------------------------------------------------------
// What the planner is allowed to see
// ---------------------------------------------------------------------------

test("buildDagPlanningContext exposes only redacted skill descriptors", () => {
  const context = buildDagPlanningContext({
    authorizedDocIds: ["doc-1"],
    question: "Compare the contracts.",
    selectedSkills: [compareSkill()],
  });

  const [descriptor] = context.capabilities;

  assert.equal(descriptor.id, "compare_documents");
  assert.equal(descriptor.summary, "Summary for compare_documents.");
  assert.equal(descriptor.execute, undefined);
  assert.equal(descriptor.match, undefined);
  assert.equal(descriptor.plannerActions, undefined);
  assert.deepEqual(Object.keys(descriptor).includes("inputSchema"), true);
  assert.deepEqual(Object.keys(descriptor).includes("outputSchema"), true);
});

test("buildDagPlanningContext never exposes accessScope or credentials", () => {
  const context = buildDagPlanningContext({
    accessScope: { authenticated: true, userId: "alice", workspaceId: "acme" },
    authorizedDocIds: ["doc-1"],
    question: "Compare the contracts.",
    selectedSkills: [compareSkill()],
    secrets: { apiKey: "super-secret" },
  });

  const serialized = JSON.stringify(context);

  assert.equal(context.accessScope, undefined);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("acme"), false);
  assert.equal(serialized.includes("alice"), false);
});

test("buildDagPlanningContext limits documents to the authorized scope", () => {
  const context = buildDagPlanningContext({
    authorizedDocIds: ["doc-1", "doc-2"],
    docIds: ["doc-1", "doc-2", "doc-outside"],
    question: "Compare the contracts.",
    selectedSkills: [compareSkill()],
  });

  assert.deepEqual(context.authorizedDocIds, ["doc-1", "doc-2"]);
});

test("buildDagPlanningContext marks task memory as planning context only", () => {
  const context = buildDagPlanningContext({
    authorizedDocIds: ["doc-1"],
    question: "Compare the contracts.",
    selectedSkills: [compareSkill()],
    taskMemory: { goal: "Understand contract risk" },
  });

  assert.equal(context.taskMemoryPlanningContext.evidencePolicy, "planning_context_only");
  assert.equal(context.taskMemoryPlanningContext.goal, "Understand contract risk");
});

test("buildDagPlannerPrompt states the governance rules the planner must not break", () => {
  const prompt = buildDagPlannerPrompt(
    buildDagPlanningContext({
      authorizedDocIds: ["doc-1"],
      question: "Compare the contracts.",
      selectedSkills: [compareSkill()],
    })
  );

  assert.match(prompt, /Do not invent/i);
  assert.match(prompt, /nodeId/);
  assert.match(prompt, /dependsOn/);
  assert.match(prompt, /inputBindings/);
  assert.match(prompt, /planning context only/i);
});

// ---------------------------------------------------------------------------
// Payload normalization
// ---------------------------------------------------------------------------

test("normalizeExecutionGraphPayload builds a versioned graph of atomic nodes", () => {
  const graph = normalizeExecutionGraphPayload({
    nodes: [
      {
        dependsOn: [],
        failurePolicy: "fail_fast",
        inputBindings: { docIds: requestField("docIds"), question: requestField("question") },
        nodeId: "compare",
        rationale: "Compare both contracts.",
        skillId: "compare_documents",
      },
      {
        dependsOn: ["compare"],
        failurePolicy: "abstain",
        inputBindings: {
          docIds: requestField("docIds"),
          priorFindings: nodeOutput("compare", "text"),
          question: requestField("question"),
        },
        nodeId: "risk",
        rationale: "Review risk against the comparison.",
        skillId: "risk_review",
      },
    ],
  });

  assert.equal(graph.version, EXECUTION_GRAPH_VERSION);
  assert.equal(graph.revision, 0);
  assert.deepEqual(
    graph.nodes.map((node) => node.nodeId),
    ["compare", "risk"]
  );
  assert.deepEqual(graph.nodes[1].dependsOn, ["compare"]);
  assert.deepEqual(graph.nodes[1].inputBindings.priorFindings, nodeOutput("compare", "text"));
});

test("normalizeExecutionGraphPayload accepts a fenced JSON array of nodes", () => {
  const graph = normalizeExecutionGraphPayload([
    {
      inputBindings: { docIds: requestField("docIds"), question: requestField("question") },
      nodeId: "compare",
      skillId: "compare_documents",
    },
  ]);

  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].failurePolicy, EXECUTION_GRAPH_FAILURE_POLICIES.failFast);
});

test("normalizeExecutionGraphPayload rejects an empty payload", () => {
  assert.throws(() => normalizeExecutionGraphPayload({ nodes: [] }), /non-empty/i);
  assert.throws(() => normalizeExecutionGraphPayload(null), /non-empty/i);
});

test("normalizeExecutionGraphPayload preserves forged fields so the validator can reject them", () => {
  const graph = normalizeExecutionGraphPayload({
    nodes: [
      {
        approval: { approved: true },
        budgetKey: "documentRagCalls",
        inputBindings: { docIds: requestField("docIds"), question: requestField("question") },
        nodeId: "compare",
        skillId: "compare_documents",
      },
    ],
  });

  // Silently stripping a forged approval would launder it: the planner would
  // learn that asking for privilege is free, and the audit trail would show a
  // clean graph that never revealed the attempt.
  assert.deepEqual(graph.nodes[0].approval, { approved: true });
  assert.equal(graph.nodes[0].budgetKey, "documentRagCalls");
});

// ---------------------------------------------------------------------------
// Deterministic fallback graph
// ---------------------------------------------------------------------------

test("createDeterministicExecutionGraph plans one node per selected skill", () => {
  const graph = createDeterministicExecutionGraph({
    selectedSkills: [compareSkill(), riskSkill()],
  });

  assert.deepEqual(
    graph.nodes.map((node) => node.skillId),
    ["compare_documents", "risk_review"]
  );
  assert.deepEqual(
    graph.nodes.map((node) => node.nodeId),
    ["compare_documents", "risk_review"]
  );
});

test("createDeterministicExecutionGraph chains findings through a typed binding", () => {
  const graph = createDeterministicExecutionGraph({
    selectedSkills: [compareSkill(), riskSkill()],
  });

  assert.deepEqual(graph.nodes[0].dependsOn, []);
  assert.deepEqual(graph.nodes[1].dependsOn, ["compare_documents"]);
  assert.deepEqual(
    graph.nodes[1].inputBindings.priorFindings,
    nodeOutput("compare_documents", "text")
  );
});

test("createDeterministicExecutionGraph plans a single node for a single skill", () => {
  const graph = createDeterministicExecutionGraph({ selectedSkills: [compareSkill()] });

  assert.equal(graph.nodes.length, 1);
  assert.deepEqual(graph.nodes[0].dependsOn, []);
  assert.equal(graph.nodes[0].inputBindings.priorFindings, undefined);
});

test("createDeterministicExecutionGraph omits a priorFindings binding a skill cannot accept", () => {
  const narrowSkill = createTestSkill({ id: "extract_timeline" });
  narrowSkill.inputSchema = {
    docIds: { required: true, scoped: true, type: "string[]" },
    question: { required: true, type: "string" },
  };

  const graph = createDeterministicExecutionGraph({
    selectedSkills: [compareSkill(), narrowSkill],
  });

  assert.deepEqual(graph.nodes[1].dependsOn, []);
  assert.equal(graph.nodes[1].inputBindings.priorFindings, undefined);
});

test("deterministicDagPlannerAdapter is registered under a stable id", () => {
  assert.equal(deterministicDagPlannerAdapter.id, DAG_PLANNER_IDS.deterministic);
  assert.equal(typeof deterministicDagPlannerAdapter.createExecutionGraph, "function");
});

// ---------------------------------------------------------------------------
// Selection, validation, and fallback
// ---------------------------------------------------------------------------

test("createAgentExecutionGraphResult returns a validated primary graph", async () => {
  const plannerAdapter = stubAdapter("llm_dag", () => ({
    nodes: [
      ragNode({ nodeId: "compare", skillId: "compare_documents" }),
      ragNode({ nodeId: "risk_a", scope: { docIds: ["doc-1"] }, skillId: "risk_review" }),
      ragNode({ nodeId: "risk_b", scope: { docIds: ["doc-2"] }, skillId: "risk_review" }),
    ],
  }));

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.status, "selected");
  assert.equal(result.planner.fallback, false);
  assert.equal(result.planner.selectedPlannerId, "llm_dag");
  assert.deepEqual(result.planner.nodeIds, ["compare", "risk_a", "risk_b"]);
  assert.equal(result.graph.version, EXECUTION_GRAPH_VERSION);
  assert.deepEqual(result.errors, []);
});

test("createAgentExecutionGraphResult plans the same skill twice under different nodeIds", async () => {
  const plannerAdapter = stubAdapter("llm_dag", () => ({
    nodes: [
      ragNode({ nodeId: "risk_a", scope: { docIds: ["doc-1"] }, skillId: "risk_review" }),
      ragNode({ nodeId: "risk_b", scope: { docIds: ["doc-2"] }, skillId: "risk_review" }),
    ],
  }));

  const result = await createAgentExecutionGraphResult(
    baseOptions({ plannerAdapter, selectedSkills: [riskSkill()] })
  );

  assert.equal(result.planner.fallback, false);
  assert.deepEqual(
    result.graph.nodes.map((node) => node.skillId),
    ["risk_review", "risk_review"]
  );
});

test("createAgentExecutionGraphResult falls back when the planner throws", async () => {
  const plannerAdapter = stubAdapter("llm_dag", () => {
    throw new Error("planner timed out");
  });

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.status, "fallback");
  assert.equal(result.planner.fallback, true);
  assert.equal(result.planner.requestedPlannerId, "llm_dag");
  assert.equal(result.planner.selectedPlannerId, DAG_PLANNER_IDS.deterministic);
  assert.match(result.planner.fallbackReason, /planner timed out/);
  assert.deepEqual(
    result.graph.nodes.map((node) => node.skillId),
    ["compare_documents", "risk_review"]
  );
});

test("deterministic DAG fallback runs only intent-selected Skills, not the authorized catalog", async () => {
  const plannerAdapter = stubAdapter("llm_dag", (context) => {
    assert.deepEqual(
      context.capabilities.map((capability) => capability.id),
      ["compare_documents", "risk_review"]
    );
    throw new Error("planner unavailable");
  });
  const result = await createAgentExecutionGraphResult(
    baseOptions({
      fallbackSelectedSkills: [compareSkill()],
      plannerAdapter,
      selectedSkills: [compareSkill(), riskSkill()],
    })
  );

  assert.equal(result.planner.fallback, true);
  assert.deepEqual(result.graph.nodes.map((node) => node.skillId), ["compare_documents"]);
});

test("an empty intent fallback rejects the graph without running the authorized catalog", async () => {
  const result = await createAgentExecutionGraphResult(
    baseOptions({
      fallbackSelectedSkills: [],
      plannerAdapter: deterministicDagPlannerAdapter,
      selectedSkills: [compareSkill(), riskSkill()],
    })
  );

  assert.equal(result.graph, null);
  assert.equal(result.planner.status, "rejected");
  assert.match(result.planner.fallbackReason, /non-empty nodes array/);
});

test("createAgentExecutionGraphResult falls back on an unregistered capability", async () => {
  const plannerAdapter = stubAdapter("llm_dag", () => ({
    nodes: [ragNode({ nodeId: "exfiltrate", skillId: "shell_exec" })],
  }));

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.fallback, true);
  assert.deepEqual(codesOf(result), [EXECUTION_GRAPH_REASON_CODES.unregisteredCapability]);
  assert.equal(
    result.graph.nodes.some((node) => node.skillId === "shell_exec"),
    false
  );
});

test("createAgentExecutionGraphResult falls back on a skill outside the selected whitelist", async () => {
  const plannerAdapter = stubAdapter("llm_dag", () => ({
    nodes: [ragNode({ nodeId: "publish", skillId: "publish_report" })],
  }));

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.fallback, true);
  assert.deepEqual(codesOf(result), [EXECUTION_GRAPH_REASON_CODES.unregisteredCapability]);
});

test("createAgentExecutionGraphResult falls back on an out-of-scope document", async () => {
  const plannerAdapter = stubAdapter("llm_dag", () => ({
    nodes: [
      ragNode({
        nodeId: "compare",
        scope: { docIds: ["doc-1", "doc-99"] },
        skillId: "compare_documents",
      }),
    ],
  }));

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.fallback, true);
  assert.deepEqual(codesOf(result), [EXECUTION_GRAPH_REASON_CODES.outOfScopeDocument]);
});

test("createAgentExecutionGraphResult falls back on a forged approval", async () => {
  const plannerAdapter = stubAdapter("llm_dag", () => ({
    nodes: [
      ragNode({
        approval: { approved: true, gateId: "gate-1" },
        nodeId: "compare",
        skillId: "compare_documents",
      }),
    ],
  }));

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.fallback, true);
  assert.deepEqual(codesOf(result), [EXECUTION_GRAPH_REASON_CODES.forgedApproval]);
});

test("createAgentExecutionGraphResult falls back on a cyclic graph", async () => {
  const plannerAdapter = stubAdapter("llm_dag", () => ({
    nodes: [
      ragNode({ dependsOn: ["risk"], nodeId: "compare", skillId: "compare_documents" }),
      ragNode({ dependsOn: ["compare"], nodeId: "risk", skillId: "risk_review" }),
    ],
  }));

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.fallback, true);
  assert.deepEqual(codesOf(result), [EXECUTION_GRAPH_REASON_CODES.cycleDetected]);
});

test("createAgentExecutionGraphResult falls back on an illegal output reference", async () => {
  const plannerAdapter = stubAdapter("llm_dag", () => ({
    nodes: [
      ragNode({ nodeId: "compare", skillId: "compare_documents" }),
      ragNode({
        dependsOn: [],
        inputBindings: {
          docIds: requestField("docIds"),
          priorFindings: nodeOutput("compare", "text"),
          question: requestField("question"),
        },
        nodeId: "risk",
        skillId: "risk_review",
      }),
    ],
  }));

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.fallback, true);
  assert.deepEqual(codesOf(result), [EXECUTION_GRAPH_REASON_CODES.illegalOutputReference]);
});

test("createAgentExecutionGraphResult falls back when the planner exceeds the node limit", async () => {
  const plannerAdapter = stubAdapter("llm_dag", () => ({
    nodes: Array.from({ length: 13 }, (unused, index) =>
      ragNode({ nodeId: `risk_${index}`, skillId: "risk_review" })
    ),
  }));

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.fallback, true);
  assert.equal(
    codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.maxNodesExceeded),
    true
  );
});

test("createAgentExecutionGraphResult reports every reason code, not just the first", async () => {
  const plannerAdapter = stubAdapter("llm_dag", () => ({
    nodes: [
      ragNode({
        dependsOn: ["ghost"],
        nodeId: "compare",
        scope: { docIds: ["doc-99"] },
        skillId: "compare_documents",
      }),
    ],
  }));

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.deepEqual(codesOf(result), [
    EXECUTION_GRAPH_REASON_CODES.danglingDependency,
    EXECUTION_GRAPH_REASON_CODES.outOfScopeDocument,
  ]);
});

test("createAgentExecutionGraphResult uses the deterministic planner when none is configured", async () => {
  const result = await createAgentExecutionGraphResult(baseOptions());

  assert.equal(result.planner.fallback, false);
  assert.equal(result.planner.selectedPlannerId, DAG_PLANNER_IDS.deterministic);
  assert.deepEqual(result.planner.nodeIds, ["compare_documents", "risk_review"]);
});

test("createAgentExecutionGraphResult keeps the deterministic fallback valid", async () => {
  const plannerAdapter = stubAdapter("llm_dag", () => {
    throw new Error("planner unavailable");
  });

  const result = await createAgentExecutionGraphResult(
    baseOptions({ plannerAdapter, selectedSkills: [compareSkill(), riskSkill(), publishSkill()] })
  );

  assert.equal(result.planner.fallback, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.graph.nodes.map((node) => node.skillId),
    ["compare_documents", "risk_review", "publish_report"]
  );
});

test("createAgentExecutionGraphResult never widens the authorized document scope", async () => {
  const plannerAdapter = stubAdapter("llm_dag", () => ({
    nodes: [ragNode({ nodeId: "compare", skillId: "compare_documents" })],
  }));
  const seen = [];
  const observed = stubAdapter("llm_dag", (context) => {
    seen.push(context);

    return plannerAdapter.createExecutionGraph(context);
  });

  await createAgentExecutionGraphResult(baseOptions({ plannerAdapter: observed }));

  assert.deepEqual(seen[0].authorizedDocIds, ["doc-1", "doc-2"]);
  assert.equal(seen[0].accessScope, undefined);
});

test("createAgentExecutionGraphResult passes only whitelisted capabilities to the planner", async () => {
  const seen = [];
  const plannerAdapter = stubAdapter("llm_dag", (context) => {
    seen.push(context);

    return { nodes: [ragNode({ nodeId: "compare", skillId: "compare_documents" })] };
  });

  await createAgentExecutionGraphResult(
    baseOptions({ plannerAdapter, selectedSkills: [compareSkill()] })
  );

  assert.deepEqual(
    seen[0].capabilities.map((capability) => capability.id),
    ["compare_documents"]
  );
});

// ---------------------------------------------------------------------------
// Shadow rollout
// ---------------------------------------------------------------------------

test("createAgentExecutionGraphResult records a shadow planner comparison", async () => {
  const plannerAdapter = withShadowPlanner(
    stubAdapter("deterministic_dag_primary", () => ({
      nodes: [ragNode({ nodeId: "compare", skillId: "compare_documents" })],
    })),
    stubAdapter("llm_dag", () => ({
      nodes: [
        ragNode({ nodeId: "compare", skillId: "compare_documents" }),
        ragNode({ nodeId: "risk", skillId: "risk_review" }),
      ],
    }))
  );

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.fallback, false);
  assert.deepEqual(result.planner.nodeIds, ["compare"]);
  assert.equal(result.planner.shadow.requestedPlannerId, "llm_dag");
  assert.deepEqual(result.planner.shadow.nodeIds, ["compare", "risk"]);
  assert.equal(result.planner.shadow.diverged, true);
});

test("createAgentExecutionGraphResult marks an agreeing shadow planner as not diverged", async () => {
  const buildNodes = () => ({
    nodes: [ragNode({ nodeId: "compare", skillId: "compare_documents" })],
  });
  const plannerAdapter = withShadowPlanner(
    stubAdapter("deterministic_dag_primary", buildNodes),
    stubAdapter("llm_dag", buildNodes)
  );

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.shadow.diverged, false);
});

test("createAgentExecutionGraphResult keeps the primary graph when the shadow planner fails", async () => {
  const plannerAdapter = withShadowPlanner(
    stubAdapter("deterministic_dag_primary", () => ({
      nodes: [ragNode({ nodeId: "compare", skillId: "compare_documents" })],
    })),
    stubAdapter("llm_dag", () => {
      throw new Error("shadow exploded");
    })
  );

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.fallback, false);
  assert.deepEqual(result.planner.nodeIds, ["compare"]);
  assert.equal(result.planner.shadow.status, "error");
  assert.match(result.planner.shadow.error, /shadow exploded/);
});

test("createAgentExecutionGraphResult keeps the primary graph when the shadow planner is illegal", async () => {
  const plannerAdapter = withShadowPlanner(
    stubAdapter("deterministic_dag_primary", () => ({
      nodes: [ragNode({ nodeId: "compare", skillId: "compare_documents" })],
    })),
    stubAdapter("llm_dag", () => ({
      nodes: [ragNode({ nodeId: "exfiltrate", skillId: "shell_exec" })],
    }))
  );

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.fallback, false);
  assert.deepEqual(result.planner.nodeIds, ["compare"]);
  assert.equal(result.planner.shadow.status, "error");
});

test("createAgentExecutionGraphResult carries the rollout mode through", async () => {
  const plannerAdapter = withPlannerRollout(
    stubAdapter("llm_dag", () => ({
      nodes: [ragNode({ nodeId: "compare", skillId: "compare_documents" })],
    })),
    "guarded"
  );

  const result = await createAgentExecutionGraphResult(baseOptions({ plannerAdapter }));

  assert.equal(result.planner.rolloutMode, "guarded");
});
