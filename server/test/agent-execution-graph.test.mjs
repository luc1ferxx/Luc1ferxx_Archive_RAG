import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTION_GRAPH_FAILURE_POLICIES,
  EXECUTION_GRAPH_REASON_CODES,
  EXECUTION_GRAPH_VERSION,
  EXECUTION_GRAPH_LIMITS,
  compileExecutionGraph,
  createExecutionGraph,
  validateExecutionGraph,
} from "../rag/agent-execution-graph.js";
import { describeSkillForPlanner } from "../rag/skills/skill-contract.js";
import { createSkillRegistry } from "../rag/skills/registry.js";

const createTestSkill = ({
  budgetKey = "customSkillCalls",
  effects = "read_only",
  id,
  inputSchema,
  outputSchema,
  parallelSafe = true,
}) => ({
  id,
  version: "1.0.0",
  label: id,
  kind: "custom",
  budgetKey,
  requiresAccessScope: true,
  effects,
  parallelSafe,
  inputSchema: inputSchema ?? {
    docIds: { type: "string[]", required: true, scoped: true },
    question: { type: "string", required: true },
    priorFindings: { type: "string", required: false },
  },
  outputSchema: outputSchema ?? {
    text: { type: "string" },
    citations: { type: "citation[]" },
    abstained: { type: "boolean" },
  },
  match: () => true,
  execute: async () => ({ value: {}, text: "", citations: [] }),
});

const createTestRegistry = (skills = []) =>
  createSkillRegistry([
    createTestSkill({ id: "compare_documents" }),
    createTestSkill({ id: "risk_review" }),
    createTestSkill({
      id: "publish_report",
      effects: "external_write",
      parallelSafe: false,
    }),
    ...skills,
  ]);

const requestField = (field) => ({ source: "request", field });

const nodeOutput = (nodeId, output) => ({ source: "node", nodeId, output });

const baseContext = () => ({
  accessScope: { userId: "alice", workspaceId: "acme" },
  authorizedDocIds: ["doc-1", "doc-2"],
  authorizedSkillIds: ["compare_documents", "risk_review", "publish_report"],
  registry: createTestRegistry(),
});

const compareNode = (overrides = {}) => ({
  nodeId: "compare",
  skillId: "compare_documents",
  dependsOn: [],
  inputBindings: {
    docIds: requestField("docIds"),
    question: requestField("question"),
  },
  failurePolicy: EXECUTION_GRAPH_FAILURE_POLICIES.failFast,
  rationale: "Compare the two selected documents.",
  ...overrides,
});

const riskNode = (overrides = {}) => ({
  nodeId: "risk",
  skillId: "risk_review",
  dependsOn: [],
  inputBindings: {
    docIds: requestField("docIds"),
    question: requestField("question"),
  },
  failurePolicy: EXECUTION_GRAPH_FAILURE_POLICIES.failFast,
  rationale: "Review risks.",
  ...overrides,
});

const codesOf = (result) => result.errors.map((error) => error.code);

test("createExecutionGraph stamps the current graph version", () => {
  const graph = createExecutionGraph({ nodes: [compareNode()] });

  assert.equal(graph.version, EXECUTION_GRAPH_VERSION);
  assert.equal(graph.nodes.length, 1);
});

test("validateExecutionGraph accepts a parallel compare + risk fan-out", () => {
  const graph = createExecutionGraph({
    nodes: [compareNode(), riskNode({ nodeId: "risk_a" }), riskNode({ nodeId: "risk_b" })],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
  assert.equal(result.graph.nodes.length, 3);
});

test("validateExecutionGraph accepts the same skill under distinct nodeIds", () => {
  const graph = createExecutionGraph({
    nodes: [riskNode({ nodeId: "risk_a" }), riskNode({ nodeId: "risk_b" })],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("validateExecutionGraph rejects an unregistered skill", () => {
  const graph = createExecutionGraph({
    nodes: [compareNode({ skillId: "shell_exec" })],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.unregisteredCapability));
});

test("validateExecutionGraph rejects a registered skill outside the authorized whitelist", () => {
  const context = baseContext();
  const graph = createExecutionGraph({ nodes: [compareNode()] });
  const result = validateExecutionGraph({
    graph,
    ...context,
    authorizedSkillIds: ["risk_review"],
  });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.unregisteredCapability));
});

test("validateExecutionGraph rejects duplicate nodeIds", () => {
  const graph = createExecutionGraph({
    nodes: [compareNode(), compareNode()],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.duplicateNodeId));
});

test("validateExecutionGraph rejects a dangling dependency", () => {
  const graph = createExecutionGraph({
    nodes: [riskNode({ dependsOn: ["missing_node"] })],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.danglingDependency));
});

test("validateExecutionGraph rejects a self dependency", () => {
  const graph = createExecutionGraph({
    nodes: [riskNode({ dependsOn: ["risk"] })],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.selfDependency));
});

test("validateExecutionGraph rejects a dependency cycle", () => {
  const graph = createExecutionGraph({
    nodes: [
      compareNode({ dependsOn: ["risk"] }),
      riskNode({ dependsOn: ["compare"] }),
    ],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.cycleDetected));
});

test("validateExecutionGraph rejects an output reference to a non-dependency node", () => {
  const graph = createExecutionGraph({
    nodes: [
      compareNode(),
      riskNode({
        dependsOn: [],
        inputBindings: {
          docIds: requestField("docIds"),
          question: requestField("question"),
          priorFindings: nodeOutput("compare", "text"),
        },
      }),
    ],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(
    codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.illegalOutputReference)
  );
});

test("validateExecutionGraph rejects an output field absent from the upstream outputSchema", () => {
  const graph = createExecutionGraph({
    nodes: [
      compareNode(),
      riskNode({
        dependsOn: ["compare"],
        inputBindings: {
          docIds: requestField("docIds"),
          question: requestField("question"),
          priorFindings: nodeOutput("compare", "secretInternalState"),
        },
      }),
    ],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(
    codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.illegalOutputReference)
  );
});

test("validateExecutionGraph rejects a type-incompatible output reference", () => {
  const graph = createExecutionGraph({
    nodes: [
      compareNode(),
      riskNode({
        dependsOn: ["compare"],
        inputBindings: {
          docIds: requestField("docIds"),
          question: requestField("question"),
          priorFindings: nodeOutput("compare", "citations"),
        },
      }),
    ],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.inputTypeMismatch));
});

test("validateExecutionGraph accepts a type-compatible upstream text reference", () => {
  const graph = createExecutionGraph({
    nodes: [
      compareNode(),
      riskNode({
        dependsOn: ["compare"],
        inputBindings: {
          docIds: requestField("docIds"),
          question: requestField("question"),
          priorFindings: nodeOutput("compare", "text"),
        },
      }),
    ],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("validateExecutionGraph rejects a missing required input", () => {
  const graph = createExecutionGraph({
    nodes: [
      compareNode({
        inputBindings: {
          question: requestField("question"),
        },
      }),
    ],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(
    codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.missingRequiredInput)
  );
});

test("validateExecutionGraph rejects an unknown request field binding", () => {
  const graph = createExecutionGraph({
    nodes: [
      compareNode({
        inputBindings: {
          docIds: requestField("docIds"),
          question: requestField("accessScope"),
        },
      }),
    ],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(
    codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.illegalOutputReference)
  );
});

test("validateExecutionGraph rejects literal input bindings outright", () => {
  const graph = createExecutionGraph({
    nodes: [
      compareNode({
        inputBindings: {
          docIds: { source: "literal", value: ["doc-9"] },
          question: requestField("question"),
        },
      }),
    ],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(
    codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.illegalOutputReference)
  );
});

test("validateExecutionGraph rejects a node scope outside the authorized document scope", () => {
  const graph = createExecutionGraph({
    nodes: [compareNode({ scope: { docIds: ["doc-1", "doc-99"] } })],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(
    codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.outOfScopeDocument)
  );
});

test("validateExecutionGraph accepts a node scope that narrows the authorized scope", () => {
  const graph = createExecutionGraph({
    nodes: [compareNode({ scope: { docIds: ["doc-1"] } })],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("validateExecutionGraph rejects a forged approval on a node", () => {
  const graph = createExecutionGraph({
    nodes: [
      compareNode({
        approval: { status: "approved", approvalObjectHash: "deadbeef" },
      }),
    ],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.forgedApproval));
});

test("validateExecutionGraph rejects a forged approvalGateId on a node", () => {
  const graph = createExecutionGraph({
    nodes: [compareNode({ approvalGateId: "gate-1" })],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.forgedApproval));
});

test("validateExecutionGraph rejects forged budget, accessScope, and policy fields", () => {
  for (const forged of [
    { budget: { maxCustomSkillCalls: 99 } },
    { accessScope: { userId: "root" } },
    { policy: { requiresApproval: false } },
    { concurrency: 32 },
  ]) {
    const graph = createExecutionGraph({ nodes: [compareNode(forged)] });
    const result = validateExecutionGraph({ graph, ...baseContext() });

    assert.equal(result.ok, false, `expected ${JSON.stringify(forged)} to be rejected`);
    assert.ok(
      codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.forgedPolicy),
      `expected forged_policy for ${JSON.stringify(forged)}, got ${codesOf(result).join()}`
    );
  }
});

test("validateExecutionGraph rejects a graph above the node limit", () => {
  const nodes = Array.from({ length: EXECUTION_GRAPH_LIMITS.maxNodes + 1 }, (_, index) =>
    riskNode({ nodeId: `risk_${index}` })
  );
  const graph = createExecutionGraph({ nodes });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.maxNodesExceeded));
});

test("validateExecutionGraph rejects a graph above the depth limit", () => {
  const depth = EXECUTION_GRAPH_LIMITS.maxDepth + 1;
  const nodes = Array.from({ length: depth }, (_, index) =>
    riskNode({
      nodeId: `risk_${index}`,
      dependsOn: index === 0 ? [] : [`risk_${index - 1}`],
    })
  );
  const graph = createExecutionGraph({ nodes });
  const result = validateExecutionGraph({
    graph,
    ...baseContext(),
    limits: { ...EXECUTION_GRAPH_LIMITS, maxNodes: depth + 1 },
  });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.maxDepthExceeded));
});

test("validateExecutionGraph rejects a graph that exceeds the remaining budget", () => {
  const graph = createExecutionGraph({
    nodes: [compareNode(), riskNode({ nodeId: "risk_a" }), riskNode({ nodeId: "risk_b" })],
  });
  const result = validateExecutionGraph({
    graph,
    ...baseContext(),
    budgetRemaining: { customSkillCalls: 2 },
  });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.budgetExceeded));
});

test("validateExecutionGraph rejects an unsafe side-effect node declared parallelSafe", () => {
  const graph = createExecutionGraph({
    nodes: [
      compareNode(),
      {
        nodeId: "publish",
        skillId: "publish_report",
        dependsOn: [],
        inputBindings: {
          docIds: requestField("docIds"),
          question: requestField("question"),
        },
        failurePolicy: EXECUTION_GRAPH_FAILURE_POLICIES.failFast,
        rationale: "Publish.",
        parallelSafe: true,
      },
    ],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.ok, false);
  assert.ok(
    codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.unsafeParallelSideEffect)
  );
});

test("validateExecutionGraph rejects an unknown graph version", () => {
  const result = validateExecutionGraph({
    graph: { version: "v99", nodes: [compareNode()] },
    ...baseContext(),
  });

  assert.equal(result.ok, false);
  assert.ok(
    codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.invalidGraphVersion)
  );
});

test("validateExecutionGraph rejects an empty graph", () => {
  const result = validateExecutionGraph({
    graph: createExecutionGraph({ nodes: [] }),
    ...baseContext(),
  });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.emptyGraph));
});

test("validateExecutionGraph rejects a malformed node shape", () => {
  const result = validateExecutionGraph({
    graph: createExecutionGraph({ nodes: ["compare_documents"] }),
    ...baseContext(),
  });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.invalidNodeShape));
});

test("validateExecutionGraph rejects an unknown failurePolicy", () => {
  const result = validateExecutionGraph({
    graph: createExecutionGraph({
      nodes: [compareNode({ failurePolicy: "ignore_everything" })],
    }),
    ...baseContext(),
  });

  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes(EXECUTION_GRAPH_REASON_CODES.invalidNodeShape));
});

test("validateExecutionGraph reports every reason code for a multi-fault graph", () => {
  const graph = createExecutionGraph({
    nodes: [
      compareNode({ skillId: "shell_exec" }),
      riskNode({ dependsOn: ["ghost"] }),
      riskNode({ nodeId: "risk", approvalGateId: "gate-1" }),
    ],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });
  const codes = codesOf(result);

  assert.equal(result.ok, false);
  assert.ok(codes.includes(EXECUTION_GRAPH_REASON_CODES.unregisteredCapability));
  assert.ok(codes.includes(EXECUTION_GRAPH_REASON_CODES.danglingDependency));
  assert.ok(codes.includes(EXECUTION_GRAPH_REASON_CODES.duplicateNodeId));
  assert.ok(codes.includes(EXECUTION_GRAPH_REASON_CODES.forgedApproval));
});

test("validateExecutionGraph errors carry a stable nodeId and reason code", () => {
  const graph = createExecutionGraph({
    nodes: [compareNode({ skillId: "shell_exec" })],
  });
  const result = validateExecutionGraph({ graph, ...baseContext() });

  assert.equal(result.errors.length > 0, true);
  for (const error of result.errors) {
    assert.equal(typeof error.code, "string");
    assert.equal(typeof error.message, "string");
    assert.ok("nodeId" in error);
  }
  assert.equal(result.errors[0].nodeId, "compare");
});

test("validateExecutionGraph is pure and does not mutate the input graph", () => {
  const graph = createExecutionGraph({ nodes: [compareNode()] });
  const snapshot = JSON.parse(JSON.stringify(graph));

  validateExecutionGraph({ graph, ...baseContext() });

  assert.deepEqual(JSON.parse(JSON.stringify(graph)), snapshot);
});

test("compileExecutionGraph produces stable topological layers", () => {
  const graph = createExecutionGraph({
    nodes: [
      compareNode(),
      riskNode({ nodeId: "risk_a" }),
      riskNode({ nodeId: "risk_b" }),
      riskNode({
        nodeId: "risk_delta",
        dependsOn: ["compare"],
        inputBindings: {
          docIds: requestField("docIds"),
          question: requestField("question"),
          priorFindings: nodeOutput("compare", "text"),
        },
      }),
    ],
  });
  const compiled = compileExecutionGraph({ graph, ...baseContext() });

  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors));
  assert.deepEqual(compiled.layers, [["compare", "risk_a", "risk_b"], ["risk_delta"]]);
  assert.equal(compiled.depth, 2);
});

test("compileExecutionGraph ordering is deterministic across shuffled declarations", () => {
  const build = (nodes) =>
    compileExecutionGraph({
      graph: createExecutionGraph({ nodes }),
      ...baseContext(),
    });
  const a = build([compareNode(), riskNode({ nodeId: "risk_a" })]);
  const b = build([compareNode(), riskNode({ nodeId: "risk_a" })]);

  assert.deepEqual(a.layers, b.layers);
  assert.deepEqual(a.order, b.order);
});

test("compileExecutionGraph refuses to compile an invalid graph", () => {
  const compiled = compileExecutionGraph({
    graph: createExecutionGraph({ nodes: [compareNode({ skillId: "shell_exec" })] }),
    ...baseContext(),
  });

  assert.equal(compiled.ok, false);
  assert.equal(compiled.layers, null);
  assert.ok(
    compiled.errors.some(
      (error) => error.code === EXECUTION_GRAPH_REASON_CODES.unregisteredCapability
    )
  );
});

test("describeSkillForPlanner exposes only redacted planning metadata", () => {
  const skill = createTestSkill({ id: "compare_documents" });
  const descriptor = describeSkillForPlanner(skill);

  assert.equal(descriptor.id, "compare_documents");
  assert.equal(descriptor.version, "1.0.0");
  assert.equal(descriptor.effects, "read_only");
  assert.equal(descriptor.parallelSafe, true);
  assert.deepEqual(Object.keys(descriptor.inputSchema).sort(), [
    "docIds",
    "priorFindings",
    "question",
  ]);
  assert.equal(descriptor.execute, undefined);
  assert.equal(descriptor.match, undefined);
  assert.equal(descriptor.budgetKey, "customSkillCalls");
});

test("describeSkillForPlanner never leaks executable references through JSON", () => {
  const descriptor = describeSkillForPlanner(createTestSkill({ id: "risk_review" }));
  const serialized = JSON.stringify(descriptor);

  assert.ok(!serialized.includes("function"));
  assert.ok(!serialized.includes("execute"));
});
