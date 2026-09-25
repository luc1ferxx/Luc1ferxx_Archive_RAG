import test from "node:test";
import assert from "node:assert/strict";
import { createAgentBudget } from "../rag/agent-budget.js";
import {
  EXECUTION_GRAPH_FAILURE_POLICIES,
  EXECUTION_GRAPH_REASON_CODES,
  createExecutionGraph,
} from "../rag/agent-execution-graph.js";
import { runExecutionGraph } from "../rag/agent-execution-graph-runner.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import {
  DEFAULT_MAX_REPLANS,
  REPLAN_DECISIONS,
  REPLAN_REASON_CODES,
  REPLAN_TRIGGERS,
  applyExecutionGraphPatch,
  buildReplanContext,
  createReplanResult,
  detectReplanTrigger,
  fingerprintExecutionGraph,
} from "../rag/agent-replanner.js";
import { createSkillRegistry } from "../rag/skills/registry.js";

// The replanner is the one component allowed to change a plan mid-run, so
// every test here is really asking the same question: can a second pass reach
// something the first pass was not allowed to reach? Scope, whitelist, budget,
// approvals, and completed work all have to survive a replan unchanged, and the
// loop has to terminate whether or not the model cooperates.

const createTestSkill = ({
  effects = "read_only",
  execute = async () => ({ citations: [], text: "", value: {} }),
  id,
  label = id,
  parallelSafe = true,
  retryable = true,
}) => ({
  budgetKey: "customSkillCalls",
  effects,
  execute,
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
  plannerSummary: `Summary for ${id}.`,
  requiresAccessScope: true,
  retryable,
  version: "1.0.0",
});

const compareSkill = () => createTestSkill({ id: "compare_documents" });
const riskSkill = () => createTestSkill({ id: "risk_review" });
const timelineSkill = () => createTestSkill({ id: "extract_timeline" });
const publishSkill = () =>
  createTestSkill({
    effects: "external_write",
    id: "publish_report",
    parallelSafe: false,
    retryable: false,
  });

const createTestRegistry = () =>
  createSkillRegistry([compareSkill(), riskSkill(), timelineSkill(), publishSkill()]);

const requestField = (field) => ({ field, source: "request" });

const graphNode = ({ dependsOn = [], inputBindings, nodeId, skillId, ...rest }) => ({
  dependsOn,
  failurePolicy: EXECUTION_GRAPH_FAILURE_POLICIES.failFast,
  inputBindings: inputBindings ?? {
    docIds: requestField("docIds"),
    question: requestField("question"),
  },
  nodeId,
  rationale: `Run ${nodeId}.`,
  skillId,
  ...rest,
});

const baseGraph = () =>
  createExecutionGraph({
    nodes: [
      graphNode({ nodeId: "compare", skillId: "compare_documents" }),
      graphNode({ nodeId: "risk", skillId: "risk_review" }),
    ],
  });

const nodeRun = ({
  abstained = false,
  citationCount = 2,
  nodeId,
  reason = null,
  skillId,
  status = "completed",
}) => ({
  citationCount,
  dependsOn: [],
  effects: "read_only",
  idempotency: "read_only_rag",
  nodeId,
  parallelSafe: true,
  reason,
  result: {
    abstained,
    citations: Array.from({ length: citationCount }, (unused, index) => ({
      docId: `doc-${index + 1}`,
    })),
    ok: status === "completed",
    skillId,
    text: abstained ? "" : "finding",
  },
  skillId,
  status,
  stepId: `custom_skill:${nodeId}`,
});

const stubAdapter = (createPatch, id = "llm_replan") => ({ createPatch, id });

const baseOptions = ({ graph = baseGraph(), nodeRuns, replanAdapter, ...rest } = {}) => ({
  authorizedDocIds: ["doc-1", "doc-2"],
  graph,
  nodeRuns:
    nodeRuns ?? [
      nodeRun({ abstained: true, citationCount: 0, nodeId: "compare", skillId: "compare_documents" }),
      nodeRun({ abstained: true, citationCount: 0, nodeId: "risk", skillId: "risk_review" }),
    ],
  question: "Compare the two contracts and review the risks.",
  registry: createTestRegistry(),
  replanAdapter,
  selectedSkills: [compareSkill(), riskSkill(), timelineSkill()],
  ...rest,
});

const timelinePatch = (overrides = {}) => ({
  addNodes: [graphNode({ nodeId: "timeline", skillId: "extract_timeline" })],
  rationale: "Both nodes abstained; widen the evidence with a timeline pass.",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

test("detectReplanTrigger reports insufficient evidence when every node abstained", () => {
  const trigger = detectReplanTrigger({
    nodeRuns: [
      nodeRun({ abstained: true, citationCount: 0, nodeId: "compare", skillId: "compare_documents" }),
    ],
  });

  assert.equal(trigger, REPLAN_TRIGGERS.insufficientEvidence);
});

test("detectReplanTrigger reports insufficient evidence when nothing cited a document", () => {
  const trigger = detectReplanTrigger({
    nodeRuns: [nodeRun({ citationCount: 0, nodeId: "compare", skillId: "compare_documents" })],
  });

  assert.equal(trigger, REPLAN_TRIGGERS.insufficientEvidence);
});

test("detectReplanTrigger reports a retryable failure before anything else", () => {
  const trigger = detectReplanTrigger({
    nodeRuns: [
      nodeRun({ nodeId: "compare", skillId: "compare_documents", status: "failed" }),
      nodeRun({ abstained: true, citationCount: 0, nodeId: "risk", skillId: "risk_review" }),
    ],
    registry: createTestRegistry(),
  });

  assert.equal(trigger, REPLAN_TRIGGERS.retryableFailure);
});

test("detectReplanTrigger does not call a non-retryable failure retryable", () => {
  const trigger = detectReplanTrigger({
    nodeRuns: [nodeRun({ nodeId: "publish", skillId: "publish_report", status: "failed" })],
    registry: createTestRegistry(),
  });

  assert.notEqual(trigger, REPLAN_TRIGGERS.retryableFailure);
});

test("detectReplanTrigger reports a missing input when a dependency never produced one", () => {
  const trigger = detectReplanTrigger({
    nodeRuns: [
      nodeRun({ nodeId: "compare", skillId: "compare_documents" }),
      nodeRun({
        nodeId: "risk",
        reason: "dependency_skipped",
        skillId: "risk_review",
        status: "skipped",
      }),
    ],
    registry: createTestRegistry(),
  });

  assert.equal(trigger, REPLAN_TRIGGERS.missingInput);
});

test("detectReplanTrigger reports an output schema failure", () => {
  const broken = nodeRun({ nodeId: "compare", skillId: "compare_documents" });
  broken.result.citations = "not-an-array";

  const trigger = detectReplanTrigger({
    nodeRuns: [broken],
    registry: createTestRegistry(),
  });

  assert.equal(trigger, REPLAN_TRIGGERS.outputSchemaFailure);
});

test("detectReplanTrigger reports an unmet success criterion", () => {
  const trigger = detectReplanTrigger({
    nodeRuns: [nodeRun({ nodeId: "compare", skillId: "compare_documents" })],
    successCriteria: [{ id: "needs_timeline", met: false }],
  });

  assert.equal(trigger, REPLAN_TRIGGERS.unmetSuccessCriterion);
});

test("detectReplanTrigger returns null when the run succeeded", () => {
  const trigger = detectReplanTrigger({
    nodeRuns: [
      nodeRun({ nodeId: "compare", skillId: "compare_documents" }),
      nodeRun({ nodeId: "risk", skillId: "risk_review" }),
    ],
    successCriteria: [{ id: "cited", met: true }],
  });

  assert.equal(trigger, null);
});

test("detectReplanTrigger returns null for an empty run", () => {
  assert.equal(detectReplanTrigger({ nodeRuns: [] }), null);
});

// ---------------------------------------------------------------------------
// Fingerprints and patches
// ---------------------------------------------------------------------------

test("fingerprintExecutionGraph is stable for the same plan", () => {
  assert.equal(fingerprintExecutionGraph(baseGraph()), fingerprintExecutionGraph(baseGraph()));
});

test("fingerprintExecutionGraph ignores node declaration order", () => {
  const reversed = createExecutionGraph({ nodes: [...baseGraph().nodes].reverse() });

  assert.equal(fingerprintExecutionGraph(baseGraph()), fingerprintExecutionGraph(reversed));
});

test("fingerprintExecutionGraph ignores the revision counter", () => {
  const revised = createExecutionGraph({ nodes: baseGraph().nodes, revision: 3 });

  assert.equal(fingerprintExecutionGraph(baseGraph()), fingerprintExecutionGraph(revised));
});

test("fingerprintExecutionGraph changes when a node scope changes", () => {
  const scoped = createExecutionGraph({
    nodes: [
      graphNode({ nodeId: "compare", scope: { docIds: ["doc-1"] }, skillId: "compare_documents" }),
      graphNode({ nodeId: "risk", skillId: "risk_review" }),
    ],
  });

  assert.notEqual(fingerprintExecutionGraph(baseGraph()), fingerprintExecutionGraph(scoped));
});

test("applyExecutionGraphPatch appends nodes and bumps the revision", () => {
  const graph = baseGraph();
  const patched = applyExecutionGraphPatch({ graph, patch: timelinePatch() });

  assert.equal(patched.revision, 1);
  assert.deepEqual(
    patched.nodes.map((node) => node.nodeId),
    ["compare", "risk", "timeline"]
  );
});

test("applyExecutionGraphPatch removes nodes the patch retires", () => {
  const patched = applyExecutionGraphPatch({
    graph: baseGraph(),
    patch: timelinePatch({ removeNodeIds: ["risk"] }),
  });

  assert.deepEqual(
    patched.nodes.map((node) => node.nodeId),
    ["compare", "timeline"]
  );
});

test("applyExecutionGraphPatch does not mutate the graph it is given", () => {
  const graph = baseGraph();
  const before = JSON.stringify(graph);

  applyExecutionGraphPatch({ graph, patch: timelinePatch({ removeNodeIds: ["risk"] }) });

  assert.equal(JSON.stringify(graph), before);
});

// ---------------------------------------------------------------------------
// What the replanner is allowed to see
// ---------------------------------------------------------------------------

test("buildReplanContext exposes redacted capabilities and no accessScope", () => {
  const context = buildReplanContext({
    accessScope: { userId: "alice", workspaceId: "acme" },
    authorizedDocIds: ["doc-1"],
    graph: baseGraph(),
    nodeRuns: [nodeRun({ nodeId: "compare", skillId: "compare_documents" })],
    question: "Compare the contracts.",
    selectedSkills: [compareSkill()],
    trigger: REPLAN_TRIGGERS.insufficientEvidence,
  });
  const serialized = JSON.stringify(context);

  assert.equal(context.accessScope, undefined);
  assert.equal(serialized.includes("alice"), false);
  assert.equal(serialized.includes("acme"), false);
  assert.equal(context.capabilities[0].execute, undefined);
  assert.equal(context.trigger, REPLAN_TRIGGERS.insufficientEvidence);
});

test("buildReplanContext summarizes node runs without leaking evidence text", () => {
  const context = buildReplanContext({
    authorizedDocIds: ["doc-1"],
    graph: baseGraph(),
    nodeRuns: [nodeRun({ nodeId: "compare", skillId: "compare_documents" })],
    question: "Compare the contracts.",
    selectedSkills: [compareSkill()],
    trigger: REPLAN_TRIGGERS.insufficientEvidence,
  });

  assert.deepEqual(context.nodeRuns, [
    {
      abstained: false,
      citationCount: 2,
      nodeId: "compare",
      reason: null,
      skillId: "compare_documents",
      status: "completed",
    },
  ]);
  assert.equal(JSON.stringify(context).includes("finding"), false);
});

// ---------------------------------------------------------------------------
// Bounded replanning
// ---------------------------------------------------------------------------

test("createReplanResult applies a valid patch and bumps the revision", async () => {
  const result = await createReplanResult(
    baseOptions({ replanAdapter: stubAdapter(() => timelinePatch()) })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.applied);
  assert.equal(result.trigger, REPLAN_TRIGGERS.insufficientEvidence);
  assert.equal(result.replanCount, 1);
  assert.equal(result.graph.revision, 1);
  assert.deepEqual(
    result.graph.nodes.map((node) => node.nodeId),
    ["compare", "risk", "timeline"]
  );
  assert.deepEqual(result.errors, []);
});

test("createReplanResult abstains when nothing triggered a replan", async () => {
  const result = await createReplanResult(
    baseOptions({
      nodeRuns: [
        nodeRun({ nodeId: "compare", skillId: "compare_documents" }),
        nodeRun({ nodeId: "risk", skillId: "risk_review" }),
      ],
      replanAdapter: stubAdapter(() => timelinePatch()),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.equal(result.reasonCode, REPLAN_REASON_CODES.notTriggered);
  assert.equal(result.graph, null);
});

test("createReplanResult allows only one replan by default", async () => {
  assert.equal(DEFAULT_MAX_REPLANS, 1);

  const result = await createReplanResult(
    baseOptions({
      replanAdapter: stubAdapter(() => timelinePatch()),
      replanCount: 1,
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.equal(result.reasonCode, REPLAN_REASON_CODES.limitReached);
  assert.equal(result.replanCount, 1);
});

test("createReplanResult does not let a caller raise its own replan limit", async () => {
  const result = await createReplanResult(
    baseOptions({
      maxReplans: 7,
      replanAdapter: stubAdapter(() => timelinePatch()),
      replanCount: 1,
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.equal(result.reasonCode, REPLAN_REASON_CODES.limitReached);
});

test("createReplanResult abstains on an equivalent plan", async () => {
  const result = await createReplanResult(
    baseOptions({
      fingerprints: [fingerprintExecutionGraph(baseGraph())],
      replanAdapter: stubAdapter(() => ({ addNodes: [], rationale: "try again" })),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.equal(result.reasonCode, REPLAN_REASON_CODES.noProgress);
});

test("createReplanResult abstains when the patch reproduces an earlier plan", async () => {
  const revisedFingerprint = fingerprintExecutionGraph(
    applyExecutionGraphPatch({ graph: baseGraph(), patch: timelinePatch() })
  );
  const result = await createReplanResult(
    baseOptions({
      fingerprints: [revisedFingerprint],
      replanAdapter: stubAdapter(() => timelinePatch()),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.equal(result.reasonCode, REPLAN_REASON_CODES.duplicatePlan);
});

test("createReplanResult abstains on a no-op patch", async () => {
  const result = await createReplanResult(
    baseOptions({
      replanAdapter: stubAdapter(() => ({ addNodes: [], removeNodeIds: [], rationale: "" })),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.equal(result.reasonCode, REPLAN_REASON_CODES.noProgress);
});

test("createReplanResult abstains when the replan adapter fails", async () => {
  const result = await createReplanResult(
    baseOptions({
      replanAdapter: stubAdapter(() => {
        throw new Error("replanner timed out");
      }),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.equal(result.reasonCode, REPLAN_REASON_CODES.adapterFailed);
  assert.match(result.reason, /replanner timed out/);
});

// ---------------------------------------------------------------------------
// A replan cannot reach further than the original plan
// ---------------------------------------------------------------------------

test("createReplanResult rejects a patch that adds an unregistered capability", async () => {
  const result = await createReplanResult(
    baseOptions({
      replanAdapter: stubAdapter(() => ({
        addNodes: [graphNode({ nodeId: "shell", skillId: "shell_exec" })],
        rationale: "escalate",
      })),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.equal(result.reasonCode, REPLAN_REASON_CODES.invalidPatch);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    [EXECUTION_GRAPH_REASON_CODES.unregisteredCapability]
  );
  assert.equal(result.graph, null);
});

test("createReplanResult rejects a patch that adds a skill outside the whitelist", async () => {
  const result = await createReplanResult(
    baseOptions({
      replanAdapter: stubAdapter(() => ({
        addNodes: [graphNode({ nodeId: "publish", skillId: "publish_report" })],
        rationale: "publish the findings",
      })),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    [EXECUTION_GRAPH_REASON_CODES.unregisteredCapability]
  );
});

test("createReplanResult rejects a patch that widens the document scope", async () => {
  const result = await createReplanResult(
    baseOptions({
      replanAdapter: stubAdapter(() => ({
        addNodes: [
          graphNode({
            nodeId: "timeline",
            scope: { docIds: ["doc-9"] },
            skillId: "extract_timeline",
          }),
        ],
        rationale: "look at the other contract",
      })),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    [EXECUTION_GRAPH_REASON_CODES.outOfScopeDocument]
  );
});

test("createReplanResult rejects a patch that claims budget or policy", async () => {
  const result = await createReplanResult(
    baseOptions({
      replanAdapter: stubAdapter(() => ({
        addNodes: [
          graphNode({ maxReplans: 5, nodeId: "timeline", skillId: "extract_timeline" }),
        ],
        rationale: "give me more attempts",
      })),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    [EXECUTION_GRAPH_REASON_CODES.forgedPolicy]
  );
});

test("createReplanResult rejects a patch that forges an approval", async () => {
  const result = await createReplanResult(
    baseOptions({
      replanAdapter: stubAdapter(() => ({
        addNodes: [
          graphNode({
            approval: { approved: true },
            nodeId: "timeline",
            skillId: "extract_timeline",
          }),
        ],
        rationale: "pre-approved",
      })),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    [EXECUTION_GRAPH_REASON_CODES.forgedApproval]
  );
});

test("createReplanResult rejects a patch that reuses an existing nodeId", async () => {
  const result = await createReplanResult(
    baseOptions({
      replanAdapter: stubAdapter(() => ({
        addNodes: [graphNode({ nodeId: "compare", skillId: "extract_timeline" })],
        rationale: "replace the comparison",
      })),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.equal(result.reasonCode, REPLAN_REASON_CODES.invalidPatch);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    [EXECUTION_GRAPH_REASON_CODES.duplicateNodeId]
  );
});

test("createReplanResult refuses to retire a node that already completed", async () => {
  const result = await createReplanResult(
    baseOptions({
      nodeRuns: [
        nodeRun({ nodeId: "compare", skillId: "compare_documents" }),
        nodeRun({ abstained: true, citationCount: 0, nodeId: "risk", skillId: "risk_review" }),
      ],
      replanAdapter: stubAdapter(() => timelinePatch({ removeNodeIds: ["compare"] })),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.equal(result.reasonCode, REPLAN_REASON_CODES.completedNodeRetired);
});

test("createReplanResult refuses to replan after a failed side-effect node", async () => {
  const graph = createExecutionGraph({
    nodes: [
      graphNode({ nodeId: "compare", skillId: "compare_documents" }),
      graphNode({ nodeId: "publish", skillId: "publish_report" }),
    ],
  });
  let adapterCalls = 0;
  const result = await createReplanResult(
    baseOptions({
      graph,
      nodeRuns: [
        nodeRun({ abstained: true, citationCount: 0, nodeId: "compare", skillId: "compare_documents" }),
        nodeRun({
          citationCount: 0,
          nodeId: "publish",
          skillId: "publish_report",
          status: "failed",
        }),
      ],
      replanAdapter: stubAdapter(() => {
        adapterCalls += 1;
        return timelinePatch({ removeNodeIds: ["publish"] });
      }),
      selectedSkills: [compareSkill(), publishSkill(), timelineSkill()],
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.equal(result.reasonCode, REPLAN_REASON_CODES.sideEffectNodeFailed);
  assert.equal(adapterCalls, 0);
});

test("createReplanResult abstains when the budget cannot fund the patch", async () => {
  const result = await createReplanResult(
    baseOptions({
      budgetRemaining: { customSkillCalls: 0 },
      replanAdapter: stubAdapter(() => timelinePatch()),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.abstain);
  assert.equal(result.reasonCode, REPLAN_REASON_CODES.budgetExhausted);
});

// A node that abstained still ran, still spent budget, and would abstain again
// on the same inputs. It is carried forward as completed work like any other,
// which is why a useful patch adds a new node instead of replaying an old one.
test("createReplanResult keeps settled node runs so the runtime can reuse them", async () => {
  const nodeRuns = [
    nodeRun({ nodeId: "compare", skillId: "compare_documents" }),
    nodeRun({ abstained: true, citationCount: 0, nodeId: "risk", skillId: "risk_review" }),
    nodeRun({ citationCount: 0, nodeId: "gap", skillId: "extract_timeline", status: "failed" }),
  ];
  const result = await createReplanResult(
    baseOptions({
      graph: createExecutionGraph({
        nodes: [
          graphNode({ nodeId: "compare", skillId: "compare_documents" }),
          graphNode({ nodeId: "risk", skillId: "risk_review" }),
          graphNode({ nodeId: "gap", skillId: "extract_timeline" }),
        ],
      }),
      nodeRuns,
      replanAdapter: stubAdapter(() => ({
        addNodes: [graphNode({ nodeId: "timeline_retry", skillId: "extract_timeline" })],
        rationale: "Retry the timeline extraction under a new nodeId.",
      })),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.applied);
  assert.deepEqual(
    result.completedNodeRuns.map((run) => run.nodeId),
    ["compare", "risk"]
  );
});

test("createReplanResult never hands the replanner an executable skill", async () => {
  const seen = [];
  const result = await createReplanResult(
    baseOptions({
      replanAdapter: stubAdapter((context) => {
        seen.push(context);

        return timelinePatch();
      }),
    })
  );

  assert.equal(result.decision, REPLAN_DECISIONS.applied);
  assert.equal(
    seen[0].capabilities.every(
      (capability) => capability.execute === undefined && capability.match === undefined
    ),
    true
  );
});

test("createReplanResult records the fingerprint of the plan it produced", async () => {
  const result = await createReplanResult(
    baseOptions({ replanAdapter: stubAdapter(() => timelinePatch()) })
  );

  assert.equal(result.fingerprint, fingerprintExecutionGraph(result.graph));
  assert.deepEqual(result.fingerprints, [
    fingerprintExecutionGraph(baseGraph()),
    result.fingerprint,
  ]);
});

// ---------------------------------------------------------------------------
// Scenario E -- end to end
//
// The unit tests above check each rule in isolation. This one runs the actual
// scheduler twice against a shared budget, because the claims that matter are
// claims about a real run: that completed work is reused rather than repeated,
// that the replanned node is the only thing that costs anything, and that the
// second time round the bound stops the loop instead of the model choosing to
// stop.
// ---------------------------------------------------------------------------

const countingSkill = ({ calls, id, result, ...rest }) =>
  createTestSkill({
    execute: async () => {
      calls.push(id);

      return result;
    },
    id,
    ...rest,
  });

const runScenarioGraph = async ({ budgetState, completedNodeRuns, graph, registry }) => {
  const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });

  return runExecutionGraph({
    accessScope: { userId: "alice", workspaceId: "acme" },
    authorizedDocIds: ["doc-1", "doc-2"],
    authorizedSkillIds: registry.list().map((skill) => skill.id),
    budgetState,
    buildSkillTraceDetail: tracker.buildSkillTraceDetail,
    completedNodeRuns,
    docIds: ["doc-1", "doc-2"],
    executeObservedSkill: tracker.executeObservedSkill,
    graph,
    question: "Compare the two contracts and review the risks.",
    ragService: {},
    recordSkillResult: tracker.recordSkillResult,
    recordSkippedSkill: tracker.recordSkippedSkill,
    registry,
    retrievalPlan: { retrievalQueries: [{ id: "primary", query: "contract risks" }] },
    sessionId: "session-1",
    userId: "alice",
  });
};

const statusByNodeId = (outcome) =>
  Object.fromEntries(outcome.nodeRuns.map((run) => [run.nodeId, run.status]));

test("Scenario E: one replan reuses completed nodes, then the bound stops the loop", async () => {
  const calls = [];
  const registry = createSkillRegistry([
    countingSkill({
      calls,
      id: "compare_documents",
      result: { citations: [{ docId: "doc-1", page: 1 }], text: "compared" },
    }),
    countingSkill({
      calls,
      id: "risk_review",
      result: { abstained: true, citations: [], text: "" },
    }),
    countingSkill({
      calls,
      id: "extract_timeline",
      result: { citations: [{ docId: "doc-2", page: 3 }], text: "timeline" },
    }),
  ]);
  const selectedSkills = registry.list();
  // One shared budget across both passes. A replan that could quietly refill
  // the budget would make the whole bound decorative.
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 3 });
  const graph = createExecutionGraph({
    nodes: [
      graphNode({ nodeId: "compare", skillId: "compare_documents" }),
      graphNode({ nodeId: "risk", skillId: "risk_review" }),
    ],
  });

  const firstRun = await runScenarioGraph({ budgetState, graph, registry });

  assert.equal(firstRun.ok, true);
  assert.deepEqual([...calls].sort(), ["compare_documents", "risk_review"]);

  const trigger = detectReplanTrigger({ nodeRuns: firstRun.nodeRuns, registry });

  assert.equal(trigger, REPLAN_TRIGGERS.insufficientEvidence);

  const replan = await createReplanResult({
    authorizedDocIds: ["doc-1", "doc-2"],
    graph,
    nodeRuns: firstRun.nodeRuns,
    question: "Compare the two contracts and review the risks.",
    registry,
    replanAdapter: stubAdapter(() => timelinePatch()),
    selectedSkills,
  });

  assert.equal(replan.decision, REPLAN_DECISIONS.applied);
  assert.equal(replan.replanCount, 1);
  assert.equal(replan.graph.revision, 1);

  const secondRun = await runScenarioGraph({
    budgetState,
    completedNodeRuns: replan.completedNodeRuns,
    graph: replan.graph,
    registry,
  });

  assert.equal(secondRun.ok, true);
  assert.deepEqual(statusByNodeId(secondRun), {
    compare: "reused",
    risk: "reused",
    timeline: "completed",
  });
  // Only the replanned node ran a second time, and only it was charged.
  assert.deepEqual([...calls].sort(), [
    "compare_documents",
    "extract_timeline",
    "risk_review",
  ]);

  // risk_review still abstained, so the run is still short of evidence -- and
  // that is precisely when a runtime is tempted to keep trying.
  assert.equal(
    detectReplanTrigger({ nodeRuns: secondRun.nodeRuns, registry }),
    REPLAN_TRIGGERS.insufficientEvidence
  );

  const secondReplan = await createReplanResult({
    authorizedDocIds: ["doc-1", "doc-2"],
    fingerprints: replan.fingerprints,
    graph: replan.graph,
    nodeRuns: secondRun.nodeRuns,
    question: "Compare the two contracts and review the risks.",
    registry,
    replanAdapter: stubAdapter(() => ({
      addNodes: [graphNode({ nodeId: "risk_again", skillId: "risk_review" })],
      rationale: "Try the risk review once more.",
    })),
    replanCount: replan.replanCount,
    selectedSkills,
  });

  assert.equal(secondReplan.decision, REPLAN_DECISIONS.abstain);
  assert.equal(secondReplan.reasonCode, REPLAN_REASON_CODES.limitReached);
  assert.equal(secondReplan.graph, null);
  // The refused replan cost nothing: no fourth skill call was made.
  assert.equal(calls.length, 3);
});
