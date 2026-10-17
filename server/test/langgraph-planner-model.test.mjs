import "./langgraph-support/langsmith-off.mjs";

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";

import {
  assertMatchesGraphGolden,
  assertMatchesGraphGoldenDigest,
} from "./langgraph-support/graph-goldens.mjs";

// The five planners' model call (rag/langgraph/planner-model.js) runs through
// ArchiveRagChatModel. Until phase 6 of docs/adr/0001-langgraph-runtime.md
// AGENT_RUNTIME=native called completeTextWithMetadata directly instead, and
// every scenario below ran the same planner input on both paths and required
// deepStrictEqual on everything the two can differ in: the planner's result
// or decision record, every call the provider (or the HTTP backend) receives,
// every LLMOps event, what the run is charged, and the thrown error. Only
// clock fields (latencyMs, durationMs, timestamp) are masked.
//
// The direct path's side of each comparison was frozen before it was
// deleted, in test/fixtures/graph-goldens/langgraph-planner-model/: the
// sha256 of each compared value's canonical form in digests.json, and the
// five planners' whole decisions in full (decide-<planner>.json). The values
// are masked as they are compared; see test/langgraph-support/graph-goldens.mjs.
// So every scenario now runs once and is compared with what the direct call
// produced.
//
// The suite also shows which path ran. hooks.mjs sends planner-model.js's
// import of model.js to a counting stand-in (model-tap.mjs) and reports every
// @langchain module loaded from outside node_modules, so a call that never
// reached the adapter, or a LangSmith-variable call that loaded LangChain,
// fails.

const tap = (globalThis.__archiveRagPlannerModelTap = { generations: [], loads: 0, models: [] });
const langChainLoads = [];
const loadReports = new MessageChannel();

loadReports.port1.on("message", (message) => langChainLoads.push(message));
loadReports.port1.unref();

register("./langgraph-planner-model/hooks.mjs", import.meta.url, {
  data: {
    modelUrl: new URL("../rag/langgraph/model.js", import.meta.url).href,
    plannerModelUrl: new URL("../rag/langgraph/planner-model.js", import.meta.url).href,
    port: loadReports.port2,
    tapUrl: new URL("./langgraph-planner-model/model-tap.mjs", import.meta.url).href,
  },
  transferList: [loadReports.port2],
});

// Imported after the hook is registered, so nothing below loads unobserved.
const {
  buildIntentPlanCandidates,
  createAgentIntentPlanResult,
  llmIntentPlannerAdapter,
} = await import("../rag/agent-intent-planner.js");
const {
  AGENT_EXECUTION_CONDITIONS,
  AGENT_EXECUTION_STEP_IDS,
  createAgentExecutionPlanResult,
} = await import("../rag/agent-execution-plan.js");
const { llmPlannerAdapter } = await import("../rag/agent-llm-planner-adapter.js");
const {
  buildDagPlanningContext,
  createAgentExecutionGraphResult,
  dagPlannerAdapter,
} = await import("../rag/agent-dag-planner-adapter.js");
const { EXECUTION_GRAPH_FAILURE_POLICIES, EXECUTION_GRAPH_LIMITS, createExecutionGraph } =
  await import("../rag/agent-execution-graph.js");
const { buildReplanContext, createReplanResult } = await import("../rag/agent-replanner.js");
const { replanAdapter } = await import("../rag/agent-replan-adapter.js");
const { createUnifiedAgentExecutionGraphResult } = await import("../rag/agent-unified-dag-planner.js");
const { deterministicUnifiedGraphPlannerAdapter, unifiedGraphLlmPlannerAdapter } = await import(
  "../rag/agent-unified-dag-planner-adapter.js"
);
const { assessUnifiedGraphAdmission } = await import("../rag/agent-unified-graph-admission.js");
const { createAgentBudget } = await import("../rag/agent-budget.js");
const { AGENT_SKILL_IDS, CUSTOM_SKILL_IDS, createDefaultSkillRegistry, createSkillRegistry } =
  await import("../rag/skills/registry.js");
const {
  DOCUMENT_LOOP_QUESTION,
  UNIFIED_ACCESS_SCOPE,
  UNIFIED_DOC_ID,
  createDocumentLoopRagService,
  createTaskCapabilityRegistry,
} = await import("./fixtures/unified-graph-run-fixtures.mjs");
const { PLANNER_MODEL_ERROR_CODES, completePlannerText } = await import(
  "../rag/langgraph/planner-model.js"
);
const { MODEL_CAPABILITIES, MODEL_ROUTE_IDS } = await import("../rag/model-providers/index.js");
const { configureOpenAIProvider, resetOpenAIProvider } = await import("../rag/openai.js");
const {
  RequestCancelledError,
  createRequestCancellation,
  runWithRequestCancellation,
  runWithRequestDeadline,
} = await import("../rag/request-deadline.js");
const { createRunUsage, getRunPromptUsage, runWithRunUsage } = await import("../rag/run-usage.js");
const { parseFirstJsonValue } = await import("../rag/structured-output.js");
const { withSpan } = await import("../rag/tracing.js");

// Each scenario's one side is keyed by the path it ran on: the chat model
// (LangGraph's adapter). The golden is the deleted direct path's.
const SIDE = "langgraph";

const withEnv = async (values, action) => {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const apply = (entries) => {
    for (const [name, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  apply(values);

  try {
    return await action();
  } finally {
    apply(saved);
  }
};

// Settings that move the openai.js path elsewhere (a gateway, Redis, other
// limits, prompt-only JSON); cleared so the developer's shell cannot.
const ISOLATED_MODEL_ENV = Object.freeze({
  AGENT_OUTER_PLAN_RUNTIME: undefined,
  MODEL_GATEWAY_URL: undefined,
  OPENAI_API_BASE: undefined,
  RAG_LLM_CIRCUIT_COOLDOWN_MS: undefined,
  RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: undefined,
  RAG_LLM_MAX_CONCURRENCY: undefined,
  RAG_SHARED_STATE: undefined,
  RAG_STRUCTURED_OUTPUT_ENABLED: undefined,
});

// LLMOps events as the real recorder writes them (JSONL).
const withLlmOpsEvents = async (action) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "langgraph-planner-model-"));
  const eventsPath = path.join(directory, "events.jsonl");
  const readEvents = async () =>
    (await readFile(eventsPath, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.eventType === "llmops_metric");

  try {
    return await withEnv(
      {
        ...ISOLATED_MODEL_ENV,
        RAG_OBSERVABILITY_ENABLED: "true",
        RAG_OBSERVABILITY_EVENTS_PATH: eventsPath,
      },
      () => action(readEvents)
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

// --- Comparison -------------------------------------------------------------

const CLOCK_KEYS = new Set(["durationMs", "latencyMs", "timestamp"]);

const isPlainObject = (value) => {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const describeError = (error) => ({
  className: error?.constructor?.name ?? null,
  code: error?.code,
  keys: Object.keys(error ?? {}).sort(),
  message: error?.message,
  name: error?.name,
  plannerCall: error?.plannerCall === undefined ? undefined : mask(error.plannerCall),
  reason: error?.reason,
  retryAfterMs: error?.retryAfterMs,
  retryable: error?.retryable,
  status: error?.status,
  upstreamStatus: error?.upstreamStatus,
});

// A structural copy with clock fields masked. Non-enumerable own properties
// (the planners attach modelRoute and promptTemplate that way) are kept under
// a visible name, so deepStrictEqual compares them too.
function mask(value) {
  if (value instanceof Error) {
    return describeError(value);
  }

  if (value instanceof AbortSignal) {
    return { abortSignal: true, aborted: value.aborted };
  }

  // Functions are made per call (the unified planner returns its graph
  // registry's methods); only their presence and name are comparable.
  if (typeof value === "function") {
    return { function: value.name };
  }

  if (!Array.isArray(value) && !isPlainObject(value)) {
    return value;
  }

  const copy = Array.isArray(value) ? [] : {};

  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const name = descriptor.enumerable || typeof key === "symbol" ? key : `[[hidden]] ${key}`;
    const inner = "value" in descriptor ? descriptor.value : descriptor.get?.call(value);

    copy[name] = CLOCK_KEYS.has(key) ? "<masked>" : mask(inner);
  }

  return copy;
}

// One planner call, under its own run meter: what it returned
// or threw, what the provider received, the LLMOps events it added, what the
// run was charged, and what the LangChain adapter saw.
const runSide = async ({ call, calls, readEvents }) => {
  const eventsBefore = (await readEvents()).length;
  const callsBefore = calls.length;
  const generationsBefore = tap.generations.length;
  const runUsage = createRunUsage({
    limits: { maxCostUsd: 0, maxDurationMs: 0, maxTokens: 0 },
    startedAt: 0,
  });
  let result;
  let error = null;

  try {
    result = await runWithRunUsage(runUsage, call);
  } catch (caught) {
    error = caught;
  }

  return {
    adapterCalls: tap.generations.slice(generationsBefore),
    comparable: mask({
      calls: calls.slice(callsBefore),
      error,
      events: (await readEvents()).slice(eventsBefore),
      promptUsage: getRunPromptUsage(runUsage),
      result,
      used: runUsage.used,
    }),
    error,
    result,
  };
};

const createRecordingProvider = (respond) => {
  const calls = [];

  return {
    calls,
    provider: {
      completeText: async (input, options) => {
        calls.push({ input, options: { ...options } });
        return respond(input, options);
      },
    },
  };
};

// Runs `call` once against the stand-in provider and returns its side keyed
// SIDE. `respond` gets the prompt and options and returns the reply (or
// throws).
const runPlannerCall = ({ call, respond }) =>
  withLlmOpsEvents(async (readEvents) => {
    const recording = createRecordingProvider(respond);

    configureOpenAIProvider(recording.provider);

    try {
      return { [SIDE]: await runSide({ call, calls: recording.calls, readEvents }) };
    } finally {
      resetOpenAIProvider();
    }
  });

const GOLDEN_SUITE = "langgraph-planner-model";

// Two things in a compared value vary between processes and Node versions
// though both sides of one comparison share them, so a golden holds them
// normalized: the fake OpenAI server's ephemeral port (inside the circuit
// breaker's key, which reaches error messages), and the " (line L column C)"
// suffix V8 adds to a JSON.parse SyntaxError's message on newer Node versions
// only (Node 20 has none, Node 24 has it).
const EPHEMERAL_LOOPBACK_ORIGIN = /http:\/\/127\.0\.0\.1:\d+/g;
const V8_JSON_POSITION_SUFFIX = / \(line \d+ column \d+\)/g;

const toPortableGoldenValue = (value) => {
  if (typeof value === "string") {
    return value
      .replace(EPHEMERAL_LOOPBACK_ORIGIN, "http://127.0.0.1:<port>")
      .replace(V8_JSON_POSITION_SUFFIX, "");
  }

  if (Array.isArray(value)) {
    return Array.from(value, (item) => toPortableGoldenValue(item));
  }

  if (isPlainObject(value)) {
    const copy = Object.getPrototypeOf(value) === null ? Object.create(null) : {};

    for (const key of Reflect.ownKeys(value)) {
      copy[key] = toPortableGoldenValue(value[key]);
    }

    return copy;
  }

  return value;
};

// The compared value against the native golden `golden` (a digests.json
// entry, or the whole <golden>.json with `full`). UPDATE_GRAPH_GOLDENS=1
// rewrites it from this side (see the helper's rules).
const assertMatchesNativeGolden = (golden, comparedValue, { full = false } = {}) => {
  assert.equal(typeof golden, "string", "every comparison names its native golden");
  const assertGolden = full ? assertMatchesGraphGolden : assertMatchesGraphGoldenDigest;

  try {
    assertGolden(GOLDEN_SUITE, golden, toPortableGoldenValue(comparedValue));
  } catch (error) {
    error.message = `${golden}: ${error.message}`;
    throw error;
  }
};

// The call matches the direct path's golden, and it reached the adapter once
// per model call, as a root LangChain run with no LangChain signal.
const assertPlannerCall = (sides, label, { full = false, golden, modelCalls = 1 } = {}) => {
  assertMatchesNativeGolden(golden, sides.langgraph.comparable, { full });
  assert.equal(
    sides.langgraph.adapterCalls.length,
    modelCalls,
    `${label}: langgraph called the model through the adapter`
  );

  for (const generation of sides.langgraph.adapterCalls) {
    assert.equal(generation.ambientConfig, false, `${label}: a root LangChain run`);
    assert.equal(generation.signal, false, `${label}: no LangChain signal`);
    assert.equal(generation.messageCount, 1, `${label}: one string prompt`);
  }
};

const waitForLoadReports = async () => {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

// --- Planner inputs ---------------------------------------------------------

const ACCESS_SCOPE = Object.freeze({ userId: "planner-user", workspaceId: "planner-workspace" });

// A reply the way a local model writes one: prose holding [..] and {..}, then
// the JSON in a fence. The planners' parsers take the fence; the
// parseFirstJsonValue that withStructuredOutput uses would not.
const fencedAfterBracketProse = (prose, value) =>
  [prose, "```json", JSON.stringify(value), "```"].join("\n");

const INTENT_DOC_IDS = Object.freeze(["policy-1"]);
const INTENT_QUESTION = "Review this policy for risks and gaps.";

const intentCandidates = () =>
  buildIntentPlanCandidates({ docIds: [...INTENT_DOC_IDS], question: INTENT_QUESTION });

const INTENT_REPLY = fencedAfterBracketProse("Plan [draft] for {risk}:", {
  reason: "Risk wording should use the risk-review skill.",
  selectedIntentId: CUSTOM_SKILL_IDS.riskReview,
});

const DOCUMENT_RAG_SKILL = Object.freeze({
  budgetKey: "documentRagCalls",
  id: AGENT_SKILL_IDS.documentRag,
  kind: "built_in",
  label: "Document RAG",
  requiresAccessScope: true,
});

const executionContext = () => ({
  docIds: ["policy-1"],
  plan: { mode: "document", wantsWeb: false },
  question: "What does the policy require?",
  selectedSkills: [{ ...DOCUMENT_RAG_SKILL }],
});

const EXECUTION_REPLY = fencedAfterBracketProse("Steps [1 of 1] for {document}:", {
  steps: [
    {
      condition: AGENT_EXECUTION_CONDITIONS.selectedSkill,
      id: AGENT_EXECUTION_STEP_IDS.documentRag,
      reason: "Use document evidence first.",
      skillId: AGENT_SKILL_IDS.documentRag,
    },
  ],
});

// The DAG planner's test Skills (as test/agent-dag-planner-adapter.test.mjs).
const createTestSkill = ({ effects = "read_only", id, parallelSafe = true }) => ({
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
  label: id,
  match: () => true,
  outputSchema: {
    abstained: { type: "boolean" },
    citations: { type: "citation[]" },
    text: { type: "string" },
  },
  parallelSafe,
  plannerSummary: `Summary for ${id}.`,
  requiresAccessScope: true,
  retryable: true,
  version: "1.0.0",
});

const requestField = (field) => ({ field, source: "request" });

const graphNode = ({ dependsOn = [], nodeId, skillId, ...rest }) => ({
  dependsOn,
  failurePolicy: EXECUTION_GRAPH_FAILURE_POLICIES.failFast,
  inputBindings: { docIds: requestField("docIds"), question: requestField("question") },
  nodeId,
  rationale: `Run ${nodeId}.`,
  skillId,
  ...rest,
});

const dagSkills = () => [
  createTestSkill({ id: "compare_documents" }),
  createTestSkill({ id: "risk_review" }),
];

const dagOptions = () => {
  const selectedSkills = dagSkills();

  return {
    accessScope: ACCESS_SCOPE,
    authorizedDocIds: ["doc-1", "doc-2"],
    plannerAdapter: dagPlannerAdapter,
    plannerContext: {
      docIds: ["doc-1", "doc-2"],
      plan: { mode: "skill_chain", summary: "Compare and review risk." },
      question: "Compare the two contracts and review the risks.",
      selectedSkills,
    },
    registry: createSkillRegistry([
      ...dagSkills(),
      createTestSkill({ effects: "external_write", id: "publish_report", parallelSafe: false }),
    ]),
    selectedSkills,
  };
};

const dagContext = () => {
  const { authorizedDocIds, plannerContext, selectedSkills } = dagOptions();

  return buildDagPlanningContext({
    authorizedDocIds,
    docIds: plannerContext.docIds,
    limits: EXECUTION_GRAPH_LIMITS,
    plan: plannerContext.plan,
    question: plannerContext.question,
    selectedSkills,
  });
};

const DAG_REPLY = fencedAfterBracketProse("Use {compare} first, then [risk_a, risk_b].", {
  nodes: [
    graphNode({ nodeId: "compare", skillId: "compare_documents" }),
    graphNode({ nodeId: "risk_a", scope: { docIds: ["doc-1"] }, skillId: "risk_review" }),
    graphNode({ nodeId: "risk_b", scope: { docIds: ["doc-2"] }, skillId: "risk_review" }),
  ],
});

// The unified planner's request (as test/agent-unified-dag-planner-adapter.test.mjs).
const RISK_REVIEW_PLAN = Object.freeze({ mode: "risk_review", summary: "risk", wantsRiskReview: true });

const planUnifiedGraph = async (plannerAdapter) => {
  const ragService = createDocumentLoopRagService({ primary: "supported" });
  const { registry: capabilityRegistry } = await createTaskCapabilityRegistry({ ragService });
  const plan = { ...RISK_REVIEW_PLAN };

  return createUnifiedAgentExecutionGraphResult({
    accessScope: UNIFIED_ACCESS_SCOPE,
    allowedCapabilityIds: ["task.create"],
    assessGraph: ({ graph, graphRegistry }) =>
      assessUnifiedGraphAdmission({
        accessScope: UNIFIED_ACCESS_SCOPE,
        capabilityApprovals: {},
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
    registry: createDefaultSkillRegistry(),
  });
};

const unifiedReply = async () => {
  const proposal = await planUnifiedGraph(deterministicUnifiedGraphPlannerAdapter);

  return fencedAfterBracketProse("Graph [v3] for {risk_review}:", {
    nodes: proposal.graph.nodes.map((node) => ({ ...node, rationale: null, when: node.when ?? null })),
  });
};

// The replanner's request (as test/agent-replanner.test.mjs): both nodes
// abstained, so a replan is triggered and the model is asked for a patch.
const replanOptions = () => ({
  authorizedDocIds: ["doc-1", "doc-2"],
  graph: createExecutionGraph({
    nodes: [
      graphNode({ nodeId: "compare", skillId: "compare_documents" }),
      graphNode({ nodeId: "risk", skillId: "risk_review" }),
    ],
  }),
  nodeRuns: ["compare_documents", "risk_review"].map((skillId) => ({
    citationCount: 0,
    dependsOn: [],
    effects: "read_only",
    idempotency: "read_only_rag",
    nodeId: skillId === "compare_documents" ? "compare" : "risk",
    parallelSafe: true,
    reason: null,
    result: { abstained: true, citations: [], ok: true, skillId, text: "" },
    skillId,
    status: "completed",
    stepId: `custom_skill:${skillId}`,
  })),
  question: "Compare the two contracts and review the risks.",
  registry: createSkillRegistry([
    ...dagSkills(),
    createTestSkill({ id: "extract_timeline" }),
  ]),
  replanAdapter,
  selectedSkills: [...dagSkills(), createTestSkill({ id: "extract_timeline" })],
});

const replanContext = () =>
  buildReplanContext({
    authorizedDocIds: ["doc-1"],
    graph: { nodes: [{ dependsOn: [], nodeId: "compare", skillId: "compare_documents" }], revision: 0 },
    nodeRuns: [{ citationCount: 0, nodeId: "compare", skillId: "compare_documents", status: "succeeded" }],
    question: "Compare the two contracts.",
    selectedSkills: [{ id: "compare_documents", label: "Compare documents" }],
    trigger: "insufficient_evidence",
  });

const REPLAN_REPLY = fencedAfterBracketProse("Revision [r1]: add {timeline}.", {
  addNodes: [graphNode({ nodeId: "timeline", skillId: "extract_timeline" })],
  rationale: "Both nodes abstained; widen the evidence with a timeline pass.",
});

// Each planner's whole decision (the orchestrator around the adapter) and its
// bare adapter call (which throws the provider's error unchanged).
const PLANNERS = Object.freeze([
  {
    adapterCall: () =>
      llmIntentPlannerAdapter.selectIntentPlan({
        candidates: intentCandidates(),
        docIds: [...INTENT_DOC_IDS],
        question: INTENT_QUESTION,
      }),
    decide: () =>
      createAgentIntentPlanResult({
        docIds: [...INTENT_DOC_IDS],
        plannerAdapter: llmIntentPlannerAdapter,
        question: INTENT_QUESTION,
      }),
    isSelected: (result) => result.planner.status === "selected" && !result.planner.fallback,
    name: "intent",
    reply: async () => INTENT_REPLY,
    sendsSchema: true,
  },
  {
    adapterCall: () => llmPlannerAdapter.createExecutionPlan(executionContext()),
    decide: () =>
      createAgentExecutionPlanResult({
        accessScope: ACCESS_SCOPE,
        plannerAdapter: llmPlannerAdapter,
        plannerContext: executionContext(),
        selectedSkills: [{ ...DOCUMENT_RAG_SKILL }],
      }),
    isSelected: (result) => result.planner.status === "selected" && !result.planner.fallback,
    name: "execution",
    reply: async () => EXECUTION_REPLY,
    sendsSchema: true,
  },
  {
    adapterCall: () => dagPlannerAdapter.createExecutionGraph(dagContext()),
    decide: () => createAgentExecutionGraphResult(dagOptions()),
    isSelected: (result) => result.planner.status === "selected" && !result.planner.fallback,
    name: "dag",
    reply: async () => DAG_REPLY,
    sendsSchema: true,
  },
  {
    // An empty context: the prompt the descriptor is fingerprinted from, and
    // no catalog, hence no schema.
    adapterCall: () => unifiedGraphLlmPlannerAdapter.createExecutionGraph({}),
    decide: () => planUnifiedGraph(unifiedGraphLlmPlannerAdapter),
    isSelected: (result) => result.planner.status === "selected" && !result.planner.fallback,
    name: "unified",
    reply: unifiedReply,
    sendsSchema: true,
  },
  {
    adapterCall: () => replanAdapter.createPatch(replanContext()),
    decide: () => createReplanResult(replanOptions()),
    isSelected: (result) => result.decision === "applied",
    name: "replan",
    reply: async () => REPLAN_REPLY,
    sendsSchema: false,
  },
]);

const createProviderError = (fields) => Object.assign(new Error("Upstream model failed."), fields);

const PROVIDER_FAILURES = Object.freeze([
  { label: "an unavailable model (503)", fields: { code: "MODEL_UPSTREAM_UNAVAILABLE", status: 503 } },
  { label: "a refused request (400)", fields: { status: 400 } },
  { label: "an open circuit", fields: { code: "CIRCUIT_OPEN", retryable: false, status: 503 } },
  { label: "a timeout", fields: { code: "ETIMEDOUT" } },
]);

// --- Tests ------------------------------------------------------------------

// A LangSmith tracing variable keeps the planner call on the direct path, so
// the LLM planners (the default dials) still plan with the model and a
// request that builds no LangGraph graph answers as it did before the
// migration (AGENTS.md, "Deliberate difference"); nothing goes through
// LangChain, so there is no run a tracer could attach to. First in the file,
// so it can show that this path loads no LangChain module at all.
test("a LangSmith tracing variable keeps every planner on the direct call: it decides as natively and loads no LangChain", async () => {
  for (const planner of PLANNERS) {
    for (const [kind, call] of [
      ["adapter", planner.adapterCall],
      ["decision", planner.decide],
    ]) {
      const label = `${planner.name} ${kind} under LANGSMITH_TRACING=true`;
      const sides = await withEnv({ LANGSMITH_TRACING: "true" }, () =>
        runPlannerCall({ call, respond: planner.reply })
      );
      const side = sides.langgraph;

      assertMatchesNativeGolden(`langsmith/${planner.name} ${kind}`, side.comparable);
      assert.equal(side.adapterCalls.length, 0, `${label}: the chat model never ran`);
      assert.equal(side.error, null, label);
      assert.equal(side.comparable.calls.length, 1, `${label}: the model was called once`);
      assert.equal(side.comparable.events.length, 1, `${label}: one LLMOps event`);

      if (kind === "decision") {
        assert.ok(planner.isSelected(side.result), `${label}: the model's plan was used`);
      }
    }
  }

  await waitForLoadReports();
  assert.deepStrictEqual(langChainLoads, [], "no @langchain module was loaded");
  assert.equal(tap.loads, 0, "model.js was not loaded");
  assert.deepStrictEqual(tap.models, [], "no chat model was built");
});

test("every planner decides as natively, with each call through the adapter", async () => {
  const replies = Object.fromEntries(
    await Promise.all(PLANNERS.map(async (planner) => [planner.name, await planner.reply()]))
  );

  // The replies are the shape withStructuredOutput would have refused.
  for (const reply of Object.values(replies)) {
    assert.equal(parseFirstJsonValue(reply), undefined);
  }

  const sidesByPlanner = {};

  await withLlmOpsEvents(async (readEvents) => {
    const recording = createRecordingProvider(() => {
      const planner = PLANNERS.find(({ name }) => recording.current === name);
      assert.ok(planner, "a planner is running");
      return replies[planner.name];
    });

    configureOpenAIProvider(recording.provider);

    try {
      // Nothing has loaded LangChain yet (the LangSmith test above ran on the
      // direct path), so the load check below is this test's.
      await waitForLoadReports();
      assert.deepStrictEqual(langChainLoads, [], "no @langchain module was loaded yet");
      assert.equal(tap.loads, 0, "model.js was not loaded yet");

      for (const planner of PLANNERS) {
        recording.current = planner.name;
        sidesByPlanner[planner.name] = {
          [SIDE]: await runSide({ call: planner.decide, calls: recording.calls, readEvents }),
        };
      }
    } finally {
      resetOpenAIProvider();
    }
  });

  for (const planner of PLANNERS) {
    const sides = sidesByPlanner[planner.name];

    // The whole decision in full where it is small enough to read (the
    // unified planner's result carries its graph registry and catalog, about
    // 370 KB, so it keeps a digest).
    assertPlannerCall(sides, planner.name, {
      full: planner.name !== "unified",
      golden: planner.name === "unified" ? "decide/unified" : `decide-${planner.name}`,
    });
    assert.equal(sides.langgraph.error, null, planner.name);
    assert.ok(planner.isSelected(sides.langgraph.result), `${planner.name}: the model's plan was used`);

    const [providerCall] = sides.langgraph.comparable.calls;

    assert.equal(typeof providerCall.input, "string", `${planner.name}: a string prompt`);
    assert.equal(
      providerCall.options.responseFormat?.json_schema?.strict === true,
      planner.sendsSchema,
      `${planner.name}: a strict schema exactly when the planner builds one`
    );
    assert.equal(sides.langgraph.comparable.events.length, 1, `${planner.name}: one LLMOps event`);
    assert.equal(sides.langgraph.comparable.used.modelCalls, 1, `${planner.name}: one model call charged`);
  }

  // The replan sends no schema at all.
  assert.equal(sidesByPlanner.replan.langgraph.comparable.calls[0].options.responseFormat, null);

  // Loaded once, from the planner helper; two models (one per route).
  await waitForLoadReports();
  assert.equal(tap.loads, 1);
  assert.ok(
    langChainLoads.some(({ parentURL }) => parentURL.endsWith("/rag/langgraph/planner-model.js")),
    "the planner helper loaded LangChain"
  );
  assert.deepStrictEqual(
    tap.models.map(({ capability, routeId }) => [capability, routeId]).sort(),
    [
      [MODEL_CAPABILITIES.executionPlanner, MODEL_ROUTE_IDS.executionPlannerDefault],
      [MODEL_CAPABILITIES.intentPlanner, MODEL_ROUTE_IDS.intentPlannerDefault],
    ].sort()
  );
});

test("the intent planner without candidates sends no schema, as natively", async () => {
  const sides = await runPlannerCall({
    call: () =>
      llmIntentPlannerAdapter.selectIntentPlan({
        candidates: [],
        docIds: [],
        question: INTENT_QUESTION,
      }),
    respond: async () => '{"selectedIntentId":"","reason":"No candidate fits."}',
  });

  assertPlannerCall(sides, "no candidates", { golden: "intent-no-candidates" });
  assert.equal(sides.langgraph.error, null);
  assert.equal(sides.langgraph.comparable.calls[0].options.responseFormat, null);
  assert.equal(sides.langgraph.adapterCalls[0].responseFormat, null);
});

test("a malformed, empty or missing reply fails each planner as natively", async () => {
  const replies = [
    { label: "prose with brackets and no JSON", reply: "I cannot plan [this] request {now}." },
    { label: "an empty reply", reply: "" },
    { label: "no reply at all", reply: undefined },
  ];

  for (const planner of PLANNERS) {
    for (const { label, reply } of replies) {
      const adapter = await runPlannerCall({ call: planner.adapterCall, respond: async () => reply });
      const decision = await runPlannerCall({ call: planner.decide, respond: async () => reply });

      assertPlannerCall(adapter, `${planner.name} adapter, ${label}`, {
        golden: `unusable-reply/${planner.name} adapter, ${label}`,
      });
      assertPlannerCall(decision, `${planner.name} decision, ${label}`, {
        golden: `unusable-reply/${planner.name} decision, ${label}`,
      });
      assert.ok(adapter.langgraph.error, `${planner.name}: ${label} is refused by the planner's parser`);
      assert.equal(
        planner.isSelected(decision.langgraph.result),
        false,
        `${planner.name}: ${label} does not become the plan`
      );
    }
  }
});

test("a provider failure reaches each planner as the same error object, and the same fallback, as natively", async () => {
  for (const planner of PLANNERS) {
    for (const { fields, label } of PROVIDER_FAILURES) {
      const thrown = [];
      const respond = async () => {
        const error = createProviderError(fields);
        thrown.push(error);
        throw error;
      };
      const adapter = await runPlannerCall({ call: planner.adapterCall, respond });

      assertPlannerCall(adapter, `${planner.name} adapter, ${label}`, {
        golden: `provider-failure/${planner.name} adapter, ${label}`,
      });
      assert.equal(thrown.length, 1);
      // The very object the provider threw, unwrapped.
      assert.equal(adapter.langgraph.error, thrown[0], `${planner.name}, ${label}`);
      assert.equal(adapter.langgraph.comparable.events[0].status, "error");

      const decision = await runPlannerCall({ call: planner.decide, respond });

      assertPlannerCall(decision, `${planner.name} decision, ${label}`, {
        golden: `provider-failure/${planner.name} decision, ${label}`,
      });
      assert.equal(planner.isSelected(decision.langgraph.result), false, `${planner.name}, ${label}`);
    }
  }
});

// The provider honours the abort signal openai.js hands it, as a real client
// does. The planner passes no signal of its own: it gets the bound request's.
const createGatedResponder = () => {
  const state = { signals: [], started: null };
  let notifyStarted = () => {};

  state.reset = () => {
    state.started = new Promise((resolve) => {
      notifyStarted = resolve;
    });
  };
  state.respond = (input, options) => {
    state.signals.push(options.signal);
    notifyStarted();

    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }
      options.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };
  state.reset();

  return state;
};

test("a cancelled request and a passed deadline stop each planner's call as natively", async () => {
  for (const planner of PLANNERS) {
    const gate = createGatedResponder();
    const cancellations = [];
    const cancelled = await runPlannerCall({
      call: async () => {
        const cancellation = createRequestCancellation();
        cancellations.push(cancellation);
        gate.reset();

        const pending = runWithRequestCancellation(cancellation, planner.adapterCall);

        await gate.started;
        cancellation.cancel();

        return pending;
      },
      respond: gate.respond,
    });

    assertPlannerCall(cancelled, `${planner.name}, client cancelled`, {
      golden: `cancelled/${planner.name} adapter, client cancelled`,
    });

    const { error } = cancelled.langgraph;

    assert.equal(cancellations.length, 1, planner.name);
    assert.ok(error instanceof RequestCancelledError, planner.name);
    assert.equal(error, cancellations[0].signal.reason, `${planner.name}: the request's own error`);
    assert.equal(gate.signals[0], cancellations[0].signal, `${planner.name}: the request's signal`);

    const deadlineGate = createGatedResponder();
    const expired = await runPlannerCall({
      call: () => runWithRequestDeadline({ deadlineAt: Date.now() + 25 }, planner.adapterCall),
      respond: deadlineGate.respond,
    });

    assertPlannerCall(expired, `${planner.name}, deadline`, {
      golden: `cancelled/${planner.name} adapter, deadline`,
    });
    assert.ok(expired.langgraph.error instanceof RequestCancelledError);
    assert.equal(expired.langgraph.error.code, "AGENT_DEADLINE_EXCEEDED");
  }
});

test("an option the planner call cannot carry is refused before the model is called", async () => {
  for (const options of [
    { signal: new AbortController().signal },
    { modelName: "other-model" },
    { onTextDelta: () => {} },
  ]) {
    const sides = await runPlannerCall({
      call: () => completePlannerText("plan", { promptTemplate: null, ...options }),
      respond: async () => "{}",
    });

    assertMatchesNativeGolden(
      `unsupported-option/${Object.keys(options).join(",")}`,
      sides.langgraph.comparable
    );
    assert.equal(sides.langgraph.error.code, PLANNER_MODEL_ERROR_CODES.unsupportedOption);
    assert.deepStrictEqual(sides.langgraph.comparable.calls, []);
    assert.equal(sides.langgraph.adapterCalls.length, 0);
  }
});

// Inside a LangGraph node (the DAG planner and the replanner run inside the
// outer plan graph's custom_skills node under AGENT_OUTER_PLAN_RUNTIME=
// langgraph) the call is still a root LangChain run: the node's config and its
// run signal do not reach the model.
test("inside a LangGraph node the planner call stays a root run and decides as natively", async () => {
  const { Annotation, END, START, StateGraph } = await import("@langchain/langgraph");
  const dag = PLANNERS.find(({ name }) => name === "dag");
  const State = Annotation.Root({ planned: Annotation({ default: () => null, reducer: (_, next) => next }) });
  const graph = new StateGraph(State)
    .addNode("plan", async () => ({ planned: mask(await dag.decide()) }))
    .addEdge(START, "plan")
    .addEdge("plan", END)
    .compile();
  const sides = await runPlannerCall({
    call: async () =>
      (await graph.invoke({}, { configurable: { thread_id: "planner-node" }, signal: new AbortController().signal }))
        .planned,
    respond: dag.reply,
  });

  assertPlannerCall(sides, "dag inside a LangGraph node", { golden: "langgraph-node/dag decision" });
  assert.equal(dag.isSelected(sides.langgraph.result), true);
});

// --- Over HTTP: the real client path (retries, circuit breaker, timeouts) ----

const startFakeOpenAI = async () => {
  const requests = [];
  let respond = () => ({ content: "{}", status: 200 });
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ body, method: request.method, url: request.url });

      const payload = JSON.parse(body);
      const answer = respond(payload);

      setTimeout(() => {
        if (response.destroyed) return;
        if (answer.status !== 200) {
          response.writeHead(answer.status, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Upstream refused." } }));
          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [
              { finish_reason: "stop", index: 0, message: { content: answer.content, role: "assistant" } },
            ],
            model: payload.model,
            usage: { completion_tokens: 9, prompt_tokens: 31, total_tokens: 40 },
          })
        );
      }, answer.delayMs ?? 0).unref();
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
    requests,
    setResponder: (next) => {
      respond = next;
    },
  };
};

const withFakeOpenAI = async (env, action) => {
  const server = await startFakeOpenAI();

  try {
    return await withLlmOpsEvents((readEvents) =>
      withEnv(
        {
          OPENAI_API_KEY: "planner-model-test",
          OPENAI_BASE_URL: server.baseUrl,
          OPENAI_CHAT_FALLBACK_MODEL: "",
          OPENAI_CHAT_MODEL: "planner-primary",
          RAG_LLM_REQUEST_TIMEOUT_MS: "5000",
          ...env,
        },
        () => action({ readEvents, server })
      )
    );
  } finally {
    resetOpenAIProvider();
    await server.close();
  }
};

// The call starts from fresh clients and closed circuits (resetOpenAIProvider)
// and keeps only the requests it sent.
const runHttpPlannerCall = async ({ call, readEvents, server, warmUp = null }) => {
  resetOpenAIProvider();

  if (warmUp) {
    await warmUp().catch(() => {});
  }

  const before = server.requests.length;
  const side = await runSide({ call, calls: [], readEvents });

  return {
    [SIDE]: {
      ...side,
      comparable: { ...side.comparable, requests: server.requests.slice(before) },
    },
  };
};

test("over HTTP each planner sends the native requests byte for byte and decides as natively", async () => {
  const replies = Object.fromEntries(
    await Promise.all(PLANNERS.map(async (planner) => [planner.name, await planner.reply()]))
  );

  await withFakeOpenAI({}, async ({ readEvents, server }) => {
    for (const planner of PLANNERS) {
      server.setResponder(() => ({ content: replies[planner.name], status: 200 }));

      const sides = await runHttpPlannerCall({ call: planner.decide, readEvents, server });

      assertPlannerCall(sides, `${planner.name} over HTTP`, { golden: `http/${planner.name} decision` });
      assert.equal(sides.langgraph.error, null, planner.name);
      assert.ok(planner.isSelected(sides.langgraph.result), planner.name);
      assert.equal(sides.langgraph.comparable.requests.length, 1, planner.name);

      const body = JSON.parse(sides.langgraph.comparable.requests[0].body);

      assert.equal(body.messages.length, 1, planner.name);
      assert.equal(body.messages[0].role, "user", planner.name);
      assert.equal(Boolean(body.response_format), planner.sendsSchema, planner.name);
    }
  });
});

test("over HTTP a refusal, an outage that opens the circuit, an open circuit and a timeout fail as natively", async () => {
  const intent = PLANNERS.find(({ name }) => name === "intent");
  const cases = [
    {
      env: {},
      expect: (error, requests) => {
        assert.equal(error.status, 400);
        assert.equal(requests.length, 1, "a 400 is not retried");
      },
      label: "a 400",
      respond: () => ({ status: 400 }),
    },
    {
      env: { RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "1" },
      expect: (error, requests) => {
        assert.equal(error.code, "CIRCUIT_OPEN");
        assert.equal(requests.length, 1, "the retry meets the open circuit");
      },
      label: "a 503 that opens the circuit",
      respond: () => ({ status: 503 }),
    },
    {
      env: { RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "1" },
      expect: (error, requests) => {
        assert.equal(error.code, "CIRCUIT_OPEN");
        assert.equal(requests.length, 0, "an open circuit sends nothing");
      },
      label: "an already open circuit",
      respond: () => ({ status: 503 }),
      // Opens the circuit first, outside the compared call.
      warmUp: () => intent.adapterCall(),
    },
    {
      env: { RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "1", RAG_LLM_REQUEST_TIMEOUT_MS: "40" },
      expect: (error, requests) => {
        assert.equal(error.code, "CIRCUIT_OPEN");
        assert.equal(requests.length, 1, "the timed-out request, then the open circuit");
      },
      label: "a timeout",
      respond: () => ({ content: INTENT_REPLY, delayMs: 400, status: 200 }),
    },
  ];

  for (const { env, expect, label, respond, warmUp } of cases) {
    await withFakeOpenAI(env, async ({ readEvents, server }) => {
      server.setResponder(respond);

      const adapter = await runHttpPlannerCall({ call: intent.adapterCall, readEvents, server, warmUp });

      assertPlannerCall(adapter, `intent adapter, ${label}`, {
        golden: `http-failure/intent adapter, ${label}`,
      });
      expect(adapter.langgraph.error, adapter.langgraph.comparable.requests);

      const decision = await runHttpPlannerCall({ call: intent.decide, readEvents, server, warmUp });

      assertPlannerCall(decision, `intent decision, ${label}`, {
        golden: `http-failure/intent decision, ${label}`,
      });
      assert.equal(decision.langgraph.result.planner.fallback, true, label);
    });
  }
});

test("over HTTP a request cancelled mid-flight stops the call as natively", async () => {
  const dag = PLANNERS.find(({ name }) => name === "dag");

  await withFakeOpenAI({ RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "1" }, async ({ readEvents, server }) => {
    server.setResponder(() => ({ content: DAG_REPLY, delayMs: 5000, status: 200 }));

    const cancellations = [];
    const sides = await runHttpPlannerCall({
      call: async () => {
        const cancellation = createRequestCancellation();
        const before = server.requests.length;
        cancellations.push(cancellation);

        const pending = runWithRequestCancellation(cancellation, dag.adapterCall);

        while (server.requests.length === before) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        cancellation.cancel();

        return pending;
      },
      readEvents,
      server,
    });

    assertPlannerCall(sides, "dag cancelled over HTTP", { golden: "http-cancelled/dag adapter" });
    assert.equal(cancellations.length, 1);
    assert.equal(sides.langgraph.error, cancellations[0].signal.reason);
    assert.equal(sides.langgraph.comparable.requests.length, 1);
  });
});

// Last: registering the tracing SDK is process-wide.
test("the model span nests under the planner span as natively", async (t) => {
  const { InMemorySpanExporter } = await import("@opentelemetry/sdk-trace-node");
  const { startTracing } = await import("../otel.js");
  const exporter = new InMemorySpanExporter();
  const provider = startTracing({ batch: false, exporters: [exporter] });
  t.after(() => provider.shutdown());

  const projectSpans = (spans) => {
    const nameById = new Map(spans.map((span) => [span.spanContext().spanId, span.name]));
    const parentOf = (span) => span.parentSpanContext?.spanId ?? span.parentSpanId;

    return spans.map((span) => ({
      attributes: mask(span.attributes),
      events: span.events.map((event) => ({ attributes: mask(event.attributes ?? {}), name: event.name })),
      kind: span.kind,
      name: span.name,
      parent: nameById.get(parentOf(span)) ?? null,
      status: span.status,
    }));
  };

  for (const planner of PLANNERS) {
    const reply = await planner.reply();
    let spans = null;

    await runPlannerCall({
      call: async () => {
        exporter.reset();
        const result = await withSpan(`agent.plan ${planner.name}`, {}, () => planner.decide());

        await provider.forceFlush();
        spans = projectSpans(exporter.getFinishedSpans());

        return result;
      },
      respond: async () => reply,
    });

    assertMatchesNativeGolden(`spans/${planner.name} decision`, spans);

    const chat = spans.find((span) => span.attributes["gen_ai.operation.name"] === "chat");

    assert.ok(chat, `${planner.name}: a model span`);
    assert.equal(chat.parent, `agent.plan ${planner.name}`, `${planner.name}: under the planner span`);
  }
});
