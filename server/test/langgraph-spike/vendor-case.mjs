// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langsmith-off.mjs";

import { createEvidenceGatedSkillProposal } from "../../evaluation/trajectory/cases/unified-graph.js";
import {
  buildScopedRagService,
  createEvalTelemetry,
  withEnvironmentOverrides,
} from "../../evaluation/agent-eval-harness.js";
import {
  DEFAULT_ACCESS_SCOPE,
  sameTrajectoryScope,
} from "../../evaluation/trajectory/checks.js";
import { createAgentBudget, getRemainingBudget } from "../../rag/agent-budget.js";
import { normalizeExecutionGraphPayload } from "../../rag/agent-dag-planner-adapter.js";
import { validateExecutionGraph } from "../../rag/agent-execution-graph.js";
import { buildPlan } from "../../rag/agent-intent-planner.js";
import { createAgentRunStepLifecycle } from "../../rag/agent-run-step-lifecycle.js";
import {
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../../rag/agent-runs.js";
import { createAgentSkillTracker } from "../../rag/agent-skill-observability.js";
import { assessUnifiedGraphAdmission } from "../../rag/agent-unified-graph-admission.js";
import { runUnifiedGraphStage } from "../../rag/agent-unified-graph-stage.js";
import { createDefaultCapabilityRegistry } from "../../rag/capabilities/index.js";
import { getActiveDatabaseTenant } from "../../rag/postgres-tenant.js";
import { createDefaultSkillRegistry } from "../../rag/skills/registry.js";
import { buildAuthorizedUnifiedGraphCatalog } from "../../rag/skills/unified-graph-catalog.js";
import { runExecutionGraphOnLangGraph } from "./execution-graph-langgraph-runner.mjs";

// The trajectory case unified_graph_evidence_gated_skill_hand_off, reduced to
// its graph stage so the native runtime and the LangGraph runner can be run on
// exactly the same inputs and compared receipt by receipt.
//
// The proposal comes from the case itself. Its constants and its mock
// ragService are module-private there, so they are reproduced here from
// evaluation/trajectory/cases/unified-graph.js: constants at lines 62-77, the
// webChatService at lines 253-265, createVendorRagService at lines 180-214.
// Keep them in step with the case.

export const ACCESS_SCOPE = Object.freeze({ ...DEFAULT_ACCESS_SCOPE });
export const DOC_ID = "vendor-msa";
export const FILE_NAME = "vendor-msa.pdf";
export const QUESTION =
  "Run a risk review of the vendor notice terms: what notice period does the vendor require?";
export const SESSION_ID = "trajectory-unified-session";
export const DOCUMENT_EXCERPT = "The vendor requires 30 days written notice before renewal.";
export const DOCUMENT_ANSWER = `${DOCUMENT_EXCERPT} [Source 1]`;
export const UNRELATED_EXCERPT = "The agreement covers managed hosting services for the customer.";
export const INSUFFICIENT_ANSWER = "The vendor requires 60 days notice before renewal. [Source 1]";
export const RISK_EXCERPT =
  "The agreement renews automatically unless the customer gives notice before the renewal date.";
export const RISK_TEXT = ["Risk Review", `- Risk: ${RISK_EXCERPT} [Source 1]`].join("\n");
export const WEB_TEXT =
  "Vendor renewal notice: the published terms require 45 days notice before renewal. [Source 1]";
export const RISK_PROMPT_PATTERN = /Perform a concise citation-backed risk review/;
export const UPSTREAM_PATTERN = /Upstream findings from an earlier step/;
export const RUN_ID = "langgraph-spike-vendor-run";

// Every text the mocks can put into a node output. None may reach LangGraph.
export const PRIVATE_TEXTS = Object.freeze([
  DOCUMENT_EXCERPT,
  UNRELATED_EXCERPT,
  INSUFFICIENT_ANSWER,
  RISK_EXCERPT,
  "Risk Review",
  QUESTION,
  FILE_NAME,
]);

/**
 * The case's graph with risk no longer gated on the check: evidence_check and
 * risk both depend only on document, so they share one superstep. Used to
 * exercise the concurrency gate; not part of the trajectory case.
 */
export const createParallelProposal = () => {
  const proposal = createEvidenceGatedSkillProposal();
  const nodes = proposal.nodes.map((node) => {
    if (node.nodeId !== "risk") {
      return node;
    }
    const ungated = { ...node, dependsOn: ["document"] };
    delete ungated.when;
    return ungated;
  });
  return { ...proposal, nodes };
};

/**
 * The case's mock ragService (unified-graph.js:180-214), with two test seams:
 * `onChat({ kind, question })` is awaited before a reply (a barrier for
 * cancellation tests), and every call records the active database tenant.
 */
export const createVendorRagService = ({
  chatTenants = [],
  documentSufficient,
  onChat = null,
  telemetry,
}) =>
  buildScopedRagService({
    chat: async ({ question }) => {
      const kind = RISK_PROMPT_PATTERN.test(question) ? "risk" : "document";
      chatTenants.push({ kind, tenant: getActiveDatabaseTenant() });
      await onChat?.({ kind, question });

      if (kind === "risk") {
        return {
          abstained: false,
          citations: [
            { docId: DOC_ID, excerpt: RISK_EXCERPT, fileName: FILE_NAME, pageNumber: 4 },
          ],
          text: RISK_TEXT,
        };
      }

      // Insufficient: an answer the cited evidence does not support (not an
      // abstention), so its evidence check fails.
      return documentSufficient
        ? {
            abstained: false,
            citations: [
              { docId: DOC_ID, excerpt: DOCUMENT_EXCERPT, fileName: FILE_NAME, pageNumber: 2 },
            ],
            text: DOCUMENT_ANSWER,
          }
        : {
            abstained: false,
            citations: [
              { docId: DOC_ID, excerpt: UNRELATED_EXCERPT, fileName: FILE_NAME, pageNumber: 1 },
            ],
            text: INSUFFICIENT_ANSWER,
          };
    },
    documents: [{ docId: DOC_ID, fileName: FILE_NAME }],
    sameScope: sameTrajectoryScope,
    telemetry,
  });

// unified-graph.js:253-265; this graph never reaches it.
const createVendorWebChatService = (webCalls) => async (webQuestion) => {
  webCalls.push(webQuestion);
  return {
    citations: [
      {
        excerpt: WEB_TEXT.replace(" [Source 1]", ""),
        title: "Vendor terms",
        url: "https://vendor.example/terms",
      },
    ],
    text: WEB_TEXT,
  };
};

/**
 * One fresh world for one run: its own in-memory run store, run, budget,
 * tracker, mocks and the authorized catalog, plus the case's graph after
 * normalization, validation and admission (reported, never thrown, so a test
 * can hand an illegal graph to either runtime).
 */
export const createVendorHarness = ({
  afterExecute = null,
  agentRunService = null,
  beforeExecute = null,
  createRun = true,
  documentSufficient = true,
  onChat = null,
  planOverrides = null,
  proposal = createEvidenceGatedSkillProposal(),
} = {}) => {
  const telemetry = createEvalTelemetry();
  const chatTenants = [];
  const ragService = createVendorRagService({ chatTenants, documentSufficient, onChat, telemetry });
  const webCalls = [];
  const capabilityRegistry = createDefaultCapabilityRegistry({
    ragService,
    webChatService: createVendorWebChatService(webCalls),
  });
  const runService = agentRunService ??
    createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });
  const budgetState = createAgentBudget();
  const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });
  const trace = [];
  const budgetLimitTraces = [];
  const skippedSkills = [];
  const tenantObservations = [];
  const docIds = [DOC_ID];
  const plan = { ...buildPlan({ docIds, question: QUESTION }), ...(planOverrides ?? {}) };
  const registry = createDefaultSkillRegistry();
  const catalog = buildAuthorizedUnifiedGraphCatalog({
    accessScope: ACCESS_SCOPE,
    allowedCapabilityIds: [],
    capabilityRegistry,
    docIds,
    ragService,
    registry,
  });
  const graph = normalizeExecutionGraphPayload(proposal, { version: "v3" });
  const validation = validateExecutionGraph({
    authorizedDocIds: docIds,
    authorizedSkillIds: catalog.skills.map((skill) => skill.id),
    budgetRemaining: getRemainingBudget(budgetState),
    graph,
    registry: catalog.graphRegistry,
  });
  const admission = validation.ok
    ? assessUnifiedGraphAdmission({
        accessScope: ACCESS_SCOPE,
        capabilityApprovals: {},
        capabilityRegistry,
        docIds,
        graph,
        plan,
        registry: catalog.graphRegistry,
      })
    : null;

  // The run row as agent.js creates it (runSnapshot): the recovery assessor
  // binds a continuation to the plan's mode and summary.
  const ready = createRun
    ? runService.createRun({
        accessScope: ACCESS_SCOPE,
        goal: QUESTION,
        input: { docIds, sessionId: SESSION_ID, userId: ACCESS_SCOPE.userId },
        plan: { mode: plan.mode, summary: plan.summary },
        runId: RUN_ID,
      })
    : Promise.resolve(null);
  // What each runtime reported through recordExecutionGraph.
  const graphRecords = [];

  return {
    addBudgetLimitTrace: (entry) => budgetLimitTraces.push(entry),
    addTraceStep: (step) => trace.push(step),
    admission,
    agentRunService: runService,
    budgetLimitTraces,
    budgetState,
    capabilityRegistry,
    catalog,
    chatTenants,
    docIds,
    // The tracker's executor, observed: the tenant every executed node sees,
    // and two awaited barrier seams, `beforeExecute({ skillId })` before the
    // Skill runs and `afterExecute({ skillId })` once it returned (the node is
    // then past every cancellation check of its own but not yet settled).
    executeObservedSkill: async (skill, context, options) => {
      tenantObservations.push({ skillId: skill.id, tenant: getActiveDatabaseTenant() });
      await beforeExecute?.({ skillId: skill.id });
      const result = await tracker.executeObservedSkill(skill, context, options);
      await afterExecute?.({ skillId: skill.id });
      return result;
    },
    graph,
    graphRecords,
    // The catalog's registry and Skills unless a test world adds its own.
    graphRegistry: catalog.graphRegistry,
    plan,
    ragService,
    ready,
    recordExecutionGraph: (entry) => {
      graphRecords.push(structuredClone(entry));
    },
    recordSkippedSkill: (entry) => {
      skippedSkills.push({ skillId: entry.skill?.id ?? null, status: entry.status ?? "skipped" });
      tracker.recordSkippedSkill(entry);
    },
    registry,
    selectedSkills: catalog.skills,
    skippedSkills,
    telemetry,
    tenantObservations,
    trace,
    tracker,
    validation,
    webCalls,
  };
};

const collectOutcome = async (harness, stage) => {
  const runRecord = await harness.agentRunService.getRun({
    accessScope: ACCESS_SCOPE,
    runId: RUN_ID,
  });
  const loaded = await harness.agentRunService.getExecutionGraphCheckpoint({
    accessScope: ACCESS_SCOPE,
    runId: RUN_ID,
  });

  return {
    budget: { ...harness.budgetState.used },
    budgetLimitTraces: harness.budgetLimitTraces,
    chatCalls: harness.telemetry.chatCalls,
    chatTenants: harness.chatTenants,
    checkpoint: loaded?.checkpoint ?? null,
    collected: stage?.collected ?? null,
    error: stage?.error ?? null,
    events: runRecord?.events ?? [],
    graph: harness.graph,
    graphRecords: harness.graphRecords,
    graphRegistry: harness.graphRegistry,
    harness,
    interrupted: stage?.interrupted ?? null,
    plan: harness.plan,
    run: stage?.run ?? null,
    skippedSkills: harness.skippedSkills,
    steps: runRecord?.steps ?? [],
    telemetry: harness.telemetry,
    tenantObservations: harness.tenantObservations,
    trace: harness.trace,
    webCalls: harness.webCalls,
  };
};

/**
 * The native oracle: runUnifiedGraphStage on a fresh in-memory run, wired as
 * test/agent-unified-graph-guarded.test.mjs wires it (unified-graph.md recipe
 * B). A refused or failed stage is returned as `error`, not thrown, so the
 * caller can inspect what it left behind.
 */
export const runNativeStage = async ({
  afterExecute = null,
  beforeExecute = null,
  documentSufficient = true,
  maxConcurrency,
  onChat = null,
  proposal = createEvidenceGatedSkillProposal(),
} = {}) => {
  const harness = createVendorHarness({ afterExecute, beforeExecute, documentSufficient, onChat, proposal });
  await harness.ready;
  let stage;

  try {
    stage = await runUnifiedGraphStage({
      accessScope: ACCESS_SCOPE,
      addBudgetLimitTrace: harness.addBudgetLimitTrace,
      addTraceStep: harness.addTraceStep,
      agentRunId: RUN_ID,
      baseCapabilityRegistry: harness.capabilityRegistry,
      budgetState: harness.budgetState,
      buildSkillTraceDetail: harness.tracker.buildSkillTraceDetail,
      docIds: harness.docIds,
      executeObservedSkill: harness.executeObservedSkill,
      loadExecutionGraphCheckpoint: () =>
        harness.agentRunService.getExecutionGraphCheckpoint({
          accessScope: ACCESS_SCOPE,
          runId: RUN_ID,
        }),
      maxConcurrency,
      plan: harness.plan,
      planned: { graph: harness.graph },
      question: QUESTION,
      ragService: harness.ragService,
      recordExecutionGraph: harness.recordExecutionGraph,
      recordSkillResult: harness.tracker.recordSkillResult,
      recordSkippedSkill: harness.recordSkippedSkill,
      registry: harness.registry,
      saveExecutionGraphCheckpoint: (checkpoint) =>
        harness.agentRunService.saveExecutionGraphCheckpoint({
          accessScope: ACCESS_SCOPE,
          checkpoint,
          runId: RUN_ID,
        }),
      sessionId: SESSION_ID,
      stepLifecycle: createAgentRunStepLifecycle({
        accessScope: ACCESS_SCOPE,
        agentRunService: harness.agentRunService,
        runId: RUN_ID,
      }),
      userId: ACCESS_SCOPE.userId,
    });
  } catch (error) {
    stage = { error };
  }

  return collectOutcome(harness, stage);
};

/**
 * The same request through runExecutionGraphOnLangGraph. Pass `harness` to
 * continue a run (a resume against the same run store); otherwise a fresh one
 * is built. Extra runner options (approval, cancellation, onNodeEvent, ...)
 * pass straight through.
 */
export const runLangGraphStage = async ({
  afterExecute = null,
  beforeExecute = null,
  checkpointer,
  documentSufficient = true,
  harness = null,
  onChat = null,
  proposal = createEvidenceGatedSkillProposal(),
  threadId = `langgraph-spike:${RUN_ID}`,
  ...runnerOptions
} = {}) => {
  const world = harness ??
    createVendorHarness({ afterExecute, beforeExecute, documentSufficient, onChat, proposal });
  await world.ready;
  let stage;

  try {
    stage = await runExecutionGraphOnLangGraph({
      accessScope: ACCESS_SCOPE,
      addBudgetLimitTrace: world.addBudgetLimitTrace,
      addTraceStep: world.addTraceStep,
      agentRunId: RUN_ID,
      agentRunService: world.agentRunService,
      authorizedDocIds: world.docIds,
      budgetState: world.budgetState,
      buildSkillTraceDetail: world.tracker.buildSkillTraceDetail,
      capabilityRegistry: world.capabilityRegistry,
      checkpointer,
      docIds: world.docIds,
      executeObservedSkill: world.executeObservedSkill,
      graph: world.graph,
      plan: world.plan,
      question: QUESTION,
      ragService: world.ragService,
      recordExecutionGraph: world.recordExecutionGraph,
      recordSkillResult: world.tracker.recordSkillResult,
      recordSkippedSkill: world.recordSkippedSkill,
      registry: world.graphRegistry,
      selectedSkills: world.selectedSkills,
      sessionId: SESSION_ID,
      threadId,
      userId: ACCESS_SCOPE.userId,
      ...runnerOptions,
    });
  } catch (error) {
    stage = { error };
  }

  return collectOutcome(world, stage);
};

/**
 * What a recovery worker does before it continues a run: claim the graph at
 * the checkpoint it inspected (agentRunService.claimExecutionGraphResume).
 * Returns the claim id, or null when the run store refused the claim.
 */
export const claimGraphResume = async (agentRunService) => {
  const loaded = await agentRunService.getExecutionGraphCheckpoint({
    accessScope: ACCESS_SCOPE,
    runId: RUN_ID,
  });
  const claim = await agentRunService.claimExecutionGraphResume({
    accessScope: ACCESS_SCOPE,
    checkpointDigest: loaded?.checkpoint?.digest,
    runId: RUN_ID,
  });

  return claim.claimed ? claim.checkpoint.resumeClaim.claimId : null;
};

// --- An approval-gated Capability behind the document node -------------------

export const EFFECT_CAPABILITY_ID = "spike.effect";
export const EFFECT_SKILL_ID = `capability:${EFFECT_CAPABILITY_ID}`;
export const EFFECT_TEXT = "Spike effect recorded for the vendor notice terms.";
export const EFFECT_PUBLIC_GATE = Object.freeze({ gateId: "spike-gate-effect", nodeId: "effect" });

/**
 * The external system the Capability writes to: executions counted per
 * idempotency key, shared by every process of a test. `onExecute` (optional)
 * is called inside each execution and its return value recorded.
 */
export const createEffectLedger = ({ onExecute = null } = {}) => ({
  byKey: new Map(),
  calls: 0,
  observations: [],
  onExecute,
});

/**
 * A test Capability adapter, shaped as capabilities/graph-contract.js shapes
 * one: kind capability, an explicit graph contract, an approval policy, a
 * workspace write that is not parallel-safe, and an answer envelope. It
 * bypasses the capability registry, so the production graph preflight cannot
 * judge it; tests hand the runner an approval double instead.
 */
export const createEffectSkill = (ledger) => ({
  budgetKey: "customSkillCalls",
  effects: "workspace_write",
  execute: async ({ services }) => {
    const key = services?.artifactExecution?.idempotencyKey ?? null;
    ledger.calls += 1;
    ledger.byKey.set(key, (ledger.byKey.get(key) ?? 0) + 1);
    if (ledger.onExecute) {
      ledger.observations.push(ledger.onExecute());
    }
    return { abstained: false, citations: [], text: EFFECT_TEXT };
  },
  id: EFFECT_SKILL_ID,
  idempotency: "adapter_defined",
  inputSchema: { question: { required: true, type: "string" } },
  kind: "capability",
  label: "Spike effect",
  match: () => false,
  outputSchema: {
    abstained: { required: true, type: "boolean" },
    citations: { required: true, type: "citation[]" },
    text: { required: true, type: "string" },
  },
  parallelSafe: false,
  replaySafe: false,
  requiresAccessScope: true,
  requiresApproval: true,
  retryable: false,
  version: "1.0.0",
});

/** document -> effect, the effect bound to the request's question only. */
export const createEffectProposal = () => ({
  nodes: [
    {
      dependsOn: [],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: { field: "docIds", source: "request" },
        question: { field: "question", source: "request" },
      },
      nodeId: "document",
      skillId: "document_rag",
    },
    {
      dependsOn: ["document"],
      failurePolicy: "fail_fast",
      inputBindings: { question: { field: "question", source: "request" } },
      nodeId: "effect",
      skillId: EFFECT_SKILL_ID,
    },
  ],
});

/**
 * The vendor harness for an effect graph: the live catalog plus the test
 * Capability, and the workspace-action intent that admission and projection
 * require of a graph with a Capability node. The run is created with that
 * intent's mode, which saveExecutionGraphCheckpoint binds the graph owner to.
 */
export const createEffectHarness = ({
  ledger,
  proposal = createEffectProposal(),
  ...options
}) => {
  const harness = createVendorHarness({
    ...options,
    planOverrides: { actionCapabilityId: EFFECT_CAPABILITY_ID, mode: "workspace_action" },
    proposal,
  });
  const effectSkill = createEffectSkill(ledger);
  const base = harness.catalog.graphRegistry;

  return {
    ...harness,
    effectSkill,
    graphRegistry: {
      get: (skillId) => (skillId === EFFECT_SKILL_ID ? effectSkill : base.get(skillId)),
      list: () => [...base.list(), effectSkill],
    },
    selectedSkills: [...harness.catalog.skills, effectSkill],
  };
};

/**
 * The approval double: the preflight says the effect node needs a decision;
 * the decision is read back from a Map the test owns, keyed by node id, whose
 * entries are what an approval endpoint stores: { decision, gate } with the
 * gate the paused run showed. `preflightFor(nodeId)` overrides the preflight
 * answer per node. The log counts the wrapper's code before interrupt(),
 * which LangGraph runs again on resume. `observe(where)` (optional) records
 * what each call sees.
 */
export const createEffectApproval = (decisions, { observe = null, preflightFor = null } = {}) => {
  const log = { preflights: [], reads: [] };

  return {
    approval: {
      preflight: ({ node }) => {
        log.preflights.push({ nodeId: node.nodeId, observation: observe?.(`preflight:${node.nodeId}`) ?? null });
        if (preflightFor) {
          return preflightFor(node.nodeId);
        }
        return node.nodeId === "effect"
          ? { needsApproval: true, publicPayload: { ...EFFECT_PUBLIC_GATE } }
          : null;
      },
      readDecision: (request) => {
        log.reads.push({ nodeId: request.nodeId, observation: observe?.(`readDecision:${request.nodeId}`) ?? null, request });
        return decisions.get(request.nodeId) ?? null;
      },
    },
    log,
  };
};

// The dials the trajectory runner pins around every case
// (evaluation/trajectory/run.js:15-23), plus the answer-rate flags
// test/trajectory-eval.test.mjs clears, so an ambient developer setting cannot
// change what the evidence check decides. Unset means the default.
export const VENDOR_CASE_ENVIRONMENT = Object.freeze({
  AGENT_FOLLOW_UP_ORIGINAL_QUESTION: undefined,
  AGENT_SINGLE_DOCUMENT_ROUTING: undefined,
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  RAG_CLAIM_HEADING_CONTEXT: undefined,
  RAG_CLAIM_INFLECTION: undefined,
  RAG_CLAIM_JUDGE: undefined,
  RAG_CLAIM_JUDGE_TEMPERATURE: undefined,
  RAG_CLAIM_SOURCE_INHERITANCE: undefined,
  RAG_LONG_MEMORY_ENABLED: "false",
  RAG_QA_GATE_INFLECTION: undefined,
});

export const withVendorCaseEnvironment = (callback) =>
  withEnvironmentOverrides(VENDOR_CASE_ENVIRONMENT, callback);

const TIMING_FIELDS = new Set([
  "completedAt",
  "createdAt",
  "durationMs",
  "pausedAt",
  "startedAt",
  "updatedAt",
]);

/**
 * A deep copy without wall-clock fields, the only values two runs of the same
 * deterministic request may disagree on. Pass extra keys (a checkpoint
 * digest, which seals durationMs) to drop them too. Maps keep their keys;
 * functions and Errors are kept as they are.
 */
export const maskTimingFields = (value, extraKeys = []) => {
  const drop = new Set([...TIMING_FIELDS, ...extraKeys]);
  const visit = (item) => {
    if (Array.isArray(item)) {
      return item.map(visit);
    }

    if (item instanceof Map) {
      return new Map([...item].map(([key, entry]) => [key, visit(entry)]));
    }

    if (!item || typeof item !== "object" || item instanceof Error) {
      return item;
    }

    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => !drop.has(key))
        .map(([key, entry]) => [key, visit(entry)])
    );
  };

  return visit(value);
};

/**
 * MemorySaver keeps serde output as Uint8Array (checkpoint, metadata and every
 * pending write). Decode all of it into one string, so a test can search
 * everything LangGraph would have persisted.
 */
export const serializeMemorySaver = (saver) => {
  const decoder = new TextDecoder();

  return JSON.stringify(
    { storage: saver.storage, writes: saver.writes },
    (key, value) => (value instanceof Uint8Array ? decoder.decode(value) : value)
  );
};
