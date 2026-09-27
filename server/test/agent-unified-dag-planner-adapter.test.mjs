import test from "node:test";
import assert from "node:assert/strict";

import { runAgentRag } from "../rag/agent.js";
import { createAgentBudget } from "../rag/agent-budget.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { assessUnifiedGraphAdmission } from "../rag/agent-unified-graph-admission.js";
import { createUnifiedAgentExecutionGraphResult } from "../rag/agent-unified-dag-planner.js";
import {
  UNIFIED_GRAPH_PLANNER_IDS,
  buildUnifiedGraphPlannerResponseFormat,
  deterministicUnifiedGraphPlannerAdapter,
  getUnifiedGraphPlannerPromptDescriptor,
  unifiedGraphLlmPlannerAdapter,
} from "../rag/agent-unified-dag-planner-adapter.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { createRunUsage, runWithRunUsage } from "../rag/run-usage.js";
import { createDefaultSkillRegistry } from "../rag/skills/registry.js";
import { createUnifiedGraphPlannerAdapter } from "../app-services.js";
import {
  APPROVAL_TASK_QUESTION,
  DOCUMENT_LOOP_QUESTION,
  UNIFIED_ACCESS_SCOPE as accessScope,
  UNIFIED_DOC_ID,
  UNIFIED_SESSION_ID,
  createDocumentLoopRagService,
  createTaskCapabilityRegistry,
  createWebHandOffProposal,
} from "./fixtures/unified-graph-run-fixtures.mjs";

// The v3 (unified) graph planner adapters: the model adapter's strict,
// catalog-built response schema, first-complete-JSON parsing, redacted input,
// and whole-graph fallback to the deterministic graph; and the deterministic
// graph itself, which must pass the same validator and admission.

const PLANS = Object.freeze({
  document: { mode: "document", summary: "doc", wantsDocumentRag: true },
  riskReview: { mode: "risk_review", summary: "risk", wantsRiskReview: true },
  workspaceAction: {
    actionCapabilityId: "task.create",
    mode: "workspace_action",
    summary: "action",
    wantsAction: true,
  },
});

const withProvider = async (completeText, callback) => {
  configureOpenAIProvider({ completeText });

  try {
    return await callback();
  } finally {
    resetOpenAIProvider();
  }
};

const planWith = async ({ plan, plannerAdapter, capabilityApprovals = {} }) => {
  const ragService = createDocumentLoopRagService({ primary: "supported" });
  const { registry: capabilityRegistry } = await createTaskCapabilityRegistry({ ragService });
  const skillRegistry = createDefaultSkillRegistry();

  return createUnifiedAgentExecutionGraphResult({
    accessScope,
    allowedCapabilityIds: ["task.create"],
    assessGraph: ({ graph, graphRegistry }) =>
      assessUnifiedGraphAdmission({
        accessScope,
        capabilityApprovals,
        capabilityRegistry,
        docIds: [UNIFIED_DOC_ID],
        graph,
        plan,
        registry: graphRegistry,
      }),
    budgetState: createAgentBudget(),
    capabilityRegistry,
    docIds: [UNIFIED_DOC_ID],
    plan,
    plannerAdapter,
    question: DOCUMENT_LOOP_QUESTION,
    ragService,
    registry: skillRegistry,
  });
};

// Every object is closed and lists every property; every string is bounded by
// an enum or a pattern; every array has maxItems.
const assertStrictSchema = (schema, path = "$") => {
  if (Array.isArray(schema?.anyOf)) {
    schema.anyOf.forEach((option, index) => assertStrictSchema(option, `${path}|${index}`));
    return;
  }

  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, path);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), path);
    for (const [key, value] of Object.entries(schema.properties)) {
      assertStrictSchema(value, `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    assert.ok(Number.isInteger(schema.maxItems) && schema.maxItems > 0, path);
    assertStrictSchema(schema.items, `${path}[]`);
  } else if (schema.type === "string") {
    assert.ok(Array.isArray(schema.enum) || typeof schema.pattern === "string", path);
  }
};

test("the deterministic graph for each supported intent passes validation and admission", async () => {
  for (const [name, plan] of Object.entries(PLANS)) {
    const planned = await planWith({ plan, plannerAdapter: deterministicUnifiedGraphPlannerAdapter });

    assert.equal(planned.planner.status, "selected", name);
    assert.equal(planned.planner.fallback, false, name);
    assert.equal(planned.planner.selectedPlannerId, UNIFIED_GRAPH_PLANNER_IDS.deterministic, name);
    assert.equal(planned.errors.length, 0, name);
  }

  const action = await planWith({
    plan: PLANS.workspaceAction,
    plannerAdapter: deterministicUnifiedGraphPlannerAdapter,
  });
  const actionNode = action.graph.nodes.find((node) => node.skillId === "capability:task.create");
  // The action runs only on a verified document answer, which it records.
  assert.deepEqual(actionNode.when, { equals: true, nodeId: "evidence_check", output: "passed" });
  assert.deepEqual(actionNode.inputBindings.description, {
    nodeId: "document",
    output: "text",
    source: "node",
  });
  assert.deepEqual(actionNode.inputBindings.title, { field: "question", source: "request" });

  const risk = await planWith({ plan: PLANS.riskReview, plannerAdapter: deterministicUnifiedGraphPlannerAdapter });
  assert.deepEqual(risk.graph.nodes.map((node) => node.skillId), [
    "document_rag",
    "document_evidence_check",
    "risk_review",
  ]);

  const document = await planWith({ plan: PLANS.document, plannerAdapter: deterministicUnifiedGraphPlannerAdapter });
  assert.deepEqual(document.graph.nodes.map((node) => node.nodeId), [
    "document",
    "evidence_check",
    "follow_up",
    "follow_up_check",
  ]);
});

test("the model adapter sends a strict catalog-built schema and a redacted prompt, and parses the first JSON value", async () => {
  const calls = [];
  const proposal = await planWith({ plan: PLANS.riskReview, plannerAdapter: deterministicUnifiedGraphPlannerAdapter });
  const reply = `${JSON.stringify({
    nodes: proposal.graph.nodes.map((node) => ({ ...node, rationale: null, when: node.when ?? null })),
  })}\nThis graph answers the request.`;
  const planned = await withProvider(async (prompt, options) => {
    calls.push({ options, prompt });
    return reply;
  }, () =>
    runWithRunUsage(createRunUsage(), () =>
      planWith({ plan: PLANS.riskReview, plannerAdapter: unifiedGraphLlmPlannerAdapter })
    )
  );

  assert.equal(planned.planner.status, "selected");
  assert.equal(planned.planner.fallback, false);
  assert.equal(planned.planner.selectedPlannerId, UNIFIED_GRAPH_PLANNER_IDS.llm);
  assert.deepEqual(planned.graph.nodes.map((node) => node.nodeId), proposal.graph.nodes.map((node) => node.nodeId));
  assert.equal(planned.graph.nodes[0].when, undefined);
  assert.equal(typeof planned.planner.plannerCall.latencyMs, "number");
  assert.deepEqual(planned.planner.plannerCall.promptTemplate, { ...getUnifiedGraphPlannerPromptDescriptor() });

  const [{ options, prompt }] = calls;
  assertStrictSchema(options.responseFormat.json_schema.schema);
  assert.equal(options.responseFormat.json_schema.strict, true);
  const skillIds = options.responseFormat.json_schema.schema.properties.nodes.items.anyOf
    .map((variant) => variant.properties.skillId.enum[0]);
  assert.ok(skillIds.includes("capability:task.create"));
  assert.ok(skillIds.includes("document_rag"));
  // No document text, identity, or scope ever reaches the planner.
  assert.equal(prompt.includes("30 days written notice"), false);
  assert.equal(prompt.includes(accessScope.userId), false);
  assert.equal(prompt.includes(accessScope.workspaceId), false);
  assert.ok(prompt.includes(DOCUMENT_LOOP_QUESTION));
});

test("an invalid, inadmissible, or failed model plan is replaced whole by the deterministic graph", async () => {
  const cases = [
    {
      expectedCodes: ["unregistered_capability"],
      reply: JSON.stringify({
        nodes: [{ dependsOn: [], failurePolicy: "fail_fast", inputBindings: {}, nodeId: "x", skillId: "shell_tool", when: null, rationale: null }],
      }),
    },
    {
      // Web text handed to a Skill prompt: valid, but refused at admission.
      capabilityApprovals: { "web.search": { approved: true } },
      expectedCodes: ["external_output_hand_off"],
      reply: JSON.stringify(createWebHandOffProposal()),
    },
    {
      // A valid document answer that leaves out the intent's own Skill: the
      // finalizer could only say the Skill did not run, so it is refused.
      expectedCodes: ["intent_skill_missing"],
      reply: JSON.stringify({
        nodes: [{
          dependsOn: [],
          failurePolicy: "fail_fast",
          inputBindings: {
            docIds: { field: "docIds", source: "request" },
            question: { field: "question", source: "request" },
          },
          nodeId: "document_rag",
          rationale: null,
          skillId: "document_rag",
          when: null,
        }],
      }),
    },
    { expectedCodes: ["invalid_node_shape"], reply: "I cannot plan this request." },
  ];

  for (const { capabilityApprovals, expectedCodes, reply } of cases) {
    const planned = await withProvider(async () => reply, () =>
      planWith({
        capabilityApprovals,
        plan: PLANS.riskReview,
        plannerAdapter: unifiedGraphLlmPlannerAdapter,
      })
    );

    assert.equal(planned.planner.status, "selected", reply);
    assert.equal(planned.planner.fallback, true, reply);
    assert.equal(planned.planner.requestedPlannerId, UNIFIED_GRAPH_PLANNER_IDS.llm);
    assert.equal(planned.planner.selectedPlannerId, UNIFIED_GRAPH_PLANNER_IDS.deterministic);
    assert.deepEqual(planned.planner.fallbackReasonCodes, expectedCodes, reply);
    assert.deepEqual(planned.graph.nodes.map((node) => node.skillId), [
      "document_rag",
      "document_evidence_check",
      "risk_review",
    ]);
  }

  const thrown = await withProvider(async () => {
    throw new Error("model unavailable");
  }, () => planWith({ plan: PLANS.riskReview, plannerAdapter: unifiedGraphLlmPlannerAdapter }));
  assert.equal(thrown.planner.fallback, true);
  assert.match(thrown.planner.fallbackReason, /model unavailable/);
});

test("a guarded request records the model planner's call, and the default adapter follows the planner dial", async () => {
  const agentRunService = createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });
  const ragService = createDocumentLoopRagService({ primary: "supported" });
  const { registry, writes } = await createTaskCapabilityRegistry({ ragService });
  const previous = { ...process.env };
  Object.assign(process.env, {
    AGENT_PLANNER_ROLLOUT: "deterministic",
    AGENT_UNIFIED_GRAPH_ROLLOUT: "guarded",
    RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
    RAG_LONG_MEMORY_ENABLED: "false",
  });

  try {
    assert.equal(createUnifiedGraphPlannerAdapter().id, UNIFIED_GRAPH_PLANNER_IDS.deterministic);
    process.env.AGENT_PLANNER_ROLLOUT = "llm";
    assert.equal(createUnifiedGraphPlannerAdapter().id, UNIFIED_GRAPH_PLANNER_IDS.llm);
    process.env.AGENT_PLANNER_ROLLOUT = "deterministic";

    // The model returns prose only: the deterministic graph plans the
    // approval-gated action, which parks at its gate.
    const paused = await withProvider(async () => "No plan.", () =>
      runAgentRag({
        accessScope,
        agentRunService,
        capabilityRegistry: registry,
        docIds: [UNIFIED_DOC_ID],
        question: APPROVAL_TASK_QUESTION,
        ragService,
        sessionId: UNIFIED_SESSION_ID,
        unifiedGraphAllowedCapabilityIds: ["task.create"],
        unifiedGraphPlannerAdapter: unifiedGraphLlmPlannerAdapter,
        userId: accessScope.userId,
      })
    );
    const run = await agentRunService.getRun({ accessScope, runId: paused.body.agentRunId });
    const planned = run.events.find((event) => event.type === "unified_graph_planned").payload;

    assert.equal(paused.body.clarification.reason, "capability_approval_required");
    assert.equal(paused.body.approvalGates[0].nodeId, "action");
    assert.equal(writes.length, 0);
    assert.equal(planned.status, "selected");
    assert.equal(planned.planner.fallback, true);
    assert.deepEqual(planned.planner.fallbackReasonCodes, ["invalid_node_shape"]);
    assert.equal(typeof planned.planner.plannerCall.latencyMs, "number");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});

test("the response schema is absent for an empty catalog", () => {
  assert.equal(buildUnifiedGraphPlannerResponseFormat({ capabilities: [] }), null);
});
