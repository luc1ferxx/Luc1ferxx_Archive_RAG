// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import { createAgentBudget } from "../rag/agent-budget.js";
import { resumeAgentExecutionGraphRun } from "../rag/agent.js";
import {
  CUSTOM_SKILL_STAGE_MODES,
  runCustomSkillStage,
} from "../rag/agent-custom-skill-stage.js";
import {
  EXECUTION_GRAPH_FAILURE_POLICIES,
  createExecutionGraph,
} from "../rag/agent-execution-graph.js";
import { EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY } from "../rag/agent-execution-graph-checkpoint.js";
import {
  createExecutionGraphNodeStates,
  orderExecutionGraphNodeStatesByLayer,
} from "../rag/agent-execution-graph-node.js";
import { admitExecutionGraphRun } from "../rag/agent-execution-graph-runner.js";
import { AGENT_INTERRUPT_TYPES, AgentRunInterruptError } from "../rag/agent-interrupts.js";
import { SKILL_CHAIN_MODE } from "../rag/agent-planner.js";
import { REPLAN_DECISIONS } from "../rag/agent-replanner.js";
import { createAgentRunRecoveryService } from "../rag/agent-run-recovery.js";
import {
  createAgentRunStepLifecycle,
  getAgentRunStepLifecycleTarget,
} from "../rag/agent-run-step-lifecycle.js";
import {
  LANGGRAPH_CHECKPOINT_RESULT_KEY,
  createAgentRunCursor,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import {
  LANGGRAPH_CHECKPOINT_RETENTION,
  RunStoreCheckpointSaver,
} from "../rag/langgraph/checkpointer.js";
import {
  ExecutionGraphReceiptState,
  encodeExecutionGraphNodeName,
} from "../rag/langgraph/compile-execution-graph.js";
import { createExecutionGraphConcurrencyGate } from "../rag/langgraph/concurrency-gate.js";
import { LANGSMITH_TRACING_ENABLED_CODE } from "../rag/langgraph/langsmith-guard.js";
import { runExecutionGraphOnLangGraph } from "../rag/langgraph/run-execution-graph.js";
import {
  REQUEST_CANCELLATION_REASONS,
  createRequestCancellation,
  runWithRequestCancellation,
} from "../rag/request-deadline.js";
import { CUSTOM_RAG_SKILL_CONTRACT } from "../rag/skills/custom/custom-skill-contract.js";
import { createSkillRegistry } from "../rag/skills/registry.js";
import {
  SKILL_EFFECTS,
  SKILL_IDEMPOTENCY,
  SKILL_VALUE_TYPES,
} from "../rag/skills/skill-contract.js";
import {
  assertMatchesGraphGolden,
  assertMatchesGraphGoldenDigest,
  canonicalizeGraphGolden,
} from "./langgraph-support/graph-goldens.mjs";

// The custom-Skill DAG runs on LangGraph.js with the shared node code
// (docs/adr/0001-langgraph-runtime.md, phase 2). Most tests here were a
// parity harness: the same scenario ran once on the native scheduler and
// once on LangGraph, each on a fresh in-memory run service, and everything
// the run leaves behind had to be deepStrictEqual -- the stage's results or
// error, node runs, persisted steps, run events, trace, budget, per-Skill
// observations, the order in which Skills were called, and the v1 graph
// checkpoint. Phase 6 deleted the native scheduler; its side of every such
// comparison was frozen first, in
// test/fixtures/graph-goldens/langgraph-execution-graph-runtime/
// (test/langgraph-support/graph-goldens.mjs), and LangGraph is now compared
// with that. Only wall-clock times, durations, random ids and the graph
// checkpoint's seal (a hash over those durations) are masked. LangGraph's own
// thread record is private to the run row (never in a public projection)
// and is checked on its own: it must exist and hold no text. The superstep
// barrier's known differences from the native scheduler are pinned as such
// ("known difference" tests), against the native run as frozen.
//
// Concurrency is sequenced with barriers and deferred promises, never with
// elapsed time (a few negative checks wait a fixed number of event-loop
// turns). Where two nodes run at once, their completions are ordered by a
// deferred (the second waits for the first node's durable checkpoint), so
// the run store is written in one order and the comparison is exact.

const accessScope = Object.freeze({ userId: "alice", workspaceId: "workspace-a" });
const QUESTION = "Compare these contracts and flag the risks.";
const DOC_IDS = Object.freeze(["doc-1", "doc-2"]);
const SESSION_ID = "session-1";
const USER_ID = "alice";
const RUN_ID = "langgraph-parity-run";
const RETRIEVAL_PLAN = Object.freeze({
  retrievalQueries: [{ id: "primary", query: "contract risks" }],
});

const GOLDEN_SUITE = "langgraph-execution-graph-runtime";

// The canonical form the goldens are stored in (sorted keys, tagged
// undefined), so a LangGraph value can be projected the way a test projects
// it and compared with a projection of the golden.
const canonical = (value) => canonicalizeGraphGolden(value);

/**
 * The native run's frozen result of `caseName`, in canonical form, for the
 * comparisons that project it (the superstep and known-difference tests).
 * Those goldens describe what the native scheduler did differently, so no
 * LangGraph run may rewrite them: they are only ever read.
 */
const readGolden = (caseName) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/graph-goldens/${GOLDEN_SUITE}/${caseName}.json`, import.meta.url),
      "utf8"
    )
  );

// A LangGraph result that must equal the native one exactly
// (UPDATE_GRAPH_GOLDENS=1 rewrites it from this run; see the helper's rules).
const assertMatchesNativeGolden = (caseName, maskedValue) =>
  assertMatchesGraphGolden(GOLDEN_SUITE, caseName, maskedValue);

// ---------------------------------------------------------------------------
// Harness
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

const createBarrier = (size) => {
  const arrivals = [];
  const opened = createDeferred();

  return {
    arrivals,
    arrive: (name) => {
      arrivals.push(name);

      if (arrivals.length >= size) {
        opened.resolve();
      }

      return opened.promise;
    },
  };
};

const turns = async (count = 20) => {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const withEnv = async (overrides, work) => {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((name) => [name, process.env[name]])
  );

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  try {
    return await work();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

/**
 * Per-scenario probes shared by its Skills: the order of every Skill start
 * and end (with the inputs the Skill was given), and how many ran at once.
 */
const createProbe = () => {
  const journal = [];
  let active = 0;
  let maxActive = 0;
  const activeIds = new Set();
  const overlaps = [];

  return {
    enter(skillId, context) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      overlaps.push([skillId, [...activeIds].sort()]);
      activeIds.add(skillId);
      journal.push({
        docIds: context.docIds,
        event: "start",
        priorFindings: context.priorFindings ?? null,
        question: context.question,
        skillId,
      });
    },
    exit(skillId) {
      active -= 1;
      activeIds.delete(skillId);
      journal.push({ event: "end", skillId });
    },
    journal,
    get maxActive() {
      return maxActive;
    },
    // [skillId, the Skills already running when it started], in start order.
    overlaps,
  };
};

const answer = (skillId, context) => ({
  abstained: false,
  citations: [{ docId: context.docIds?.[0] ?? DOC_IDS[0], page: 1 }],
  text: `${skillId} answered.`,
});

const createScriptedSkill = ({
  effects,
  id,
  probe,
  respond = async (context) => answer(id, context),
  ...overrides
}) => ({
  ...CUSTOM_RAG_SKILL_CONTRACT,
  budgetKey: "customSkillCalls",
  execute: async (context) => {
    probe.enter(id, context);

    try {
      return await respond(context);
    } finally {
      probe.exit(id);
    }
  },
  id,
  kind: "custom",
  label: id,
  match: () => true,
  requiresAccessScope: true,
  version: "1.0.0",
  ...(effects === undefined
    ? {}
    : {
        effects,
        idempotency: SKILL_IDEMPOTENCY.nondeterministic,
        parallelSafe: false,
        replaySafe: false,
      }),
  ...overrides,
});

const requestField = (field) => ({ field, source: "request" });
const nodeOutput = (nodeId, output) => ({ nodeId, output, source: "node" });

const graphNode = ({
  dependsOn = [],
  failurePolicy = EXECUTION_GRAPH_FAILURE_POLICIES.continue,
  inputBindings,
  nodeId,
  scope,
  skillId,
  when,
}) => ({
  dependsOn,
  failurePolicy,
  inputBindings: inputBindings ?? {
    docIds: requestField("docIds"),
    question: requestField("question"),
  },
  nodeId,
  rationale: `Run ${nodeId}.`,
  skillId,
  ...(scope === undefined ? {} : { scope }),
  ...(when === undefined ? {} : { when }),
});

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEAL = /^[0-9a-f]{64}$/;

// Masks wall-clock times, durations and random ids, and the graph
// checkpoint's seal, which hashes the node results' durations along with
// everything else. The typed-output digests are content hashes and stay.
const mask = (value, key = null) => {
  if (Array.isArray(value)) {
    return value.map((item) => mask(item));
  }

  if (value instanceof Error) {
    return {
      ...mask({ ...value }),
      message: value.message,
      name: value.name,
    };
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        mask(entryValue, entryKey),
      ])
    );
  }

  if (key === "durationMs" && typeof value === "number") {
    return "<duration>";
  }

  if (key === "digest" && typeof value === "string" && SEAL.test(value)) {
    return "<seal>";
  }

  if (typeof value === "string" && ISO_TIME.test(value)) {
    return "<time>";
  }

  if (typeof value === "string" && UUID.test(value)) {
    return "<uuid>";
  }

  return value;
};

const describeError = (error) => ({
  code: error?.code ?? null,
  executionGraphNodeRuns: error?.executionGraphNodeRuns ?? null,
  message: error?.message ?? null,
  name: error?.name ?? null,
  reason: error?.reason ?? null,
  retryable: error?.retryable ?? null,
  status: error?.status ?? null,
  type: error?.type ?? null,
});

const settleOutcome = async (work) => {
  try {
    return { result: await work() };
  } catch (error) {
    return { error: describeError(error) };
  }
};

const createRunHarness = async ({ skills }) => {
  const agentRunStore = createInMemoryAgentRunStore();
  const agentRunService = createAgentRunService({ agentRunStore });

  await agentRunService.createRun({
    accessScope,
    goal: QUESTION,
    input: { docIds: [...DOC_IDS], sessionId: SESSION_ID, userId: USER_ID },
    plan: {
      mode: SKILL_CHAIN_MODE,
      selectedSkills: skills.map((skill) => ({
        skillId: skill.id,
        skillVersion: skill.version,
      })),
    },
    runId: RUN_ID,
  });

  return { agentRunService, agentRunStore, runCursor: createAgentRunCursor() };
};

const collectRun = async ({ agentRunService, budgetState, extra, probe, tracker, trace }) => {
  const run = await agentRunService.getRun({ accessScope, runId: RUN_ID });
  const loaded = await agentRunService.getExecutionGraphCheckpoint({
    accessScope,
    runId: RUN_ID,
  });
  const record = await agentRunService.getLangGraphCheckpointRecord({
    accessScope,
    runId: RUN_ID,
  });

  return {
    langGraphRecord: record?.record ?? null,
    observed: mask({
      budget: {
        limits: budgetState.limits,
        traceTruncated: budgetState.traceTruncated,
        used: budgetState.used,
      },
      checkpoint: loaded?.checkpoint ?? null,
      events: run.events,
      journal: probe.journal,
      runError: run.error ?? null,
      runStatus: run.status,
      skillRuns: tracker.getSkillRuns(),
      steps: run.steps,
      trace,
      ...extra,
    }),
    probe,
  };
};

/**
 * One scenario through runCustomSkillStage: a stub planner proposes `nodes`,
 * the stage writes the v1 graph checkpoint into a fresh run, and the node
 * steps go through the real step lifecycle and run cursor, as agent.js wires
 * them.
 */
const runStageScenario = async ({ scenario }) => {
  const {
    budget = { maxCustomSkillCalls: 8 },
    maxConcurrency,
    nodes,
    onCheckpointSaved = () => {},
    probe,
    replanAdapter = null,
    skills,
    wrap = (work) => work(),
  } = scenario;
  const { agentRunService, runCursor } = await createRunHarness({ skills });
  const budgetState = createAgentBudget(budget);
  const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });
  const trace = [];
  const graphEvents = [];
  const budgetLimits = [];
  const outcome = await settleOutcome(() =>
    wrap(() =>
      runCustomSkillStage({
        accessScope,
        addBudgetLimitTrace: (step) => budgetLimits.push(step),
        addTraceStep: (step) => trace.push(step),
        authorizedCustomSkills: skills,
        authorizedDocIds: [...DOC_IDS],
        budgetState,
        buildSkillTraceDetail: tracker.buildSkillTraceDetail,
        customSkills: skills,
        docIds: [...DOC_IDS],
        executeObservedSkill: tracker.executeObservedSkill,
        loadExecutionGraphCheckpoint: () =>
          agentRunService.getExecutionGraphCheckpoint({ accessScope, runCursor, runId: RUN_ID }),
        maxConcurrency,
        mode: CUSTOM_SKILL_STAGE_MODES.guarded,
        plan: { mode: SKILL_CHAIN_MODE },
        plannerAdapter: { createExecutionGraph: () => ({ nodes }), id: "parity_planner" },
        question: QUESTION,
        ragService: {},
        recordExecutionGraph: (event) => {
          graphEvents.push(structuredClone(event));
        },
        recordSkillResult: tracker.recordSkillResult,
        recordSkippedSkill: tracker.recordSkippedSkill,
        registry: createSkillRegistry(skills),
        replanAdapter,
        retrievalPlan: RETRIEVAL_PLAN,
        // Leaves out the settling save's dropLangGraphRecord (agent.js
        // forwards it), so a scenario can still read the LangGraph thread
        // after the stage; the drop itself is pinned by "the stage schedules
        // on LangGraph ..." below and by the /chat suites.
        saveExecutionGraphCheckpoint: async (checkpoint) => {
          const saved = await agentRunService.saveExecutionGraphCheckpoint({
            accessScope,
            checkpoint,
            runCursor,
            runId: RUN_ID,
          });

          onCheckpointSaved(checkpoint);
          return saved;
        },
        sessionId: SESSION_ID,
        stepLifecycle: createAgentRunStepLifecycle({
          accessScope,
          agentRunService,
          runCursor,
          runId: RUN_ID,
        }),
        userId: USER_ID,
      })
    )
  );

  return {
    ...(await collectRun({
      agentRunService,
      budgetState,
      extra: { budgetLimits, graphEvents, outcome },
      probe,
      tracker,
      trace,
    })),
    agentRunService,
  };
};

/**
 * One scenario straight through the executor, runExecutionGraphOnLangGraph
 * with the run's checkpointer. There is no graph checkpoint here (no stage),
 * so steps use the plain lifecycle and the checkpointer's writer holds no
 * claim.
 */
const runExecutorScenario = async ({ scenario }) => {
  const {
    budget = { maxCustomSkillCalls: 8 },
    completedNodeRuns = [],
    docIds = [...DOC_IDS],
    graph,
    maxConcurrency,
    preflightNode = null,
    probe,
    skills,
    wrap = (work) => work(),
  } = scenario;
  const { agentRunService, runCursor } = await createRunHarness({ skills });
  const budgetState = createAgentBudget(budget);
  const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });
  const trace = [];
  const budgetLimits = [];
  const settled = [];
  const outcome = await settleOutcome(() =>
    wrap(() =>
      runExecutionGraphOnLangGraph({
        agentRunId: RUN_ID,
        agentRunService,
        runCursor,
        accessScope,
        addBudgetLimitTrace: (step) => budgetLimits.push(step),
        addTraceStep: (step) => trace.push(step),
        authorizedDocIds: [...DOC_IDS],
        authorizedSkillIds: skills.map((skill) => skill.id),
        budgetState,
        buildSkillTraceDetail: tracker.buildSkillTraceDetail,
        completedNodeRuns,
        docIds,
        executeObservedSkill: tracker.executeObservedSkill,
        graph,
        maxConcurrency,
        onNodeSettled: ({ nodeRun }) => {
          settled.push(nodeRun);
        },
        ...(preflightNode ? { preflightNode } : {}),
        question: QUESTION,
        ragService: {},
        recordSkillResult: tracker.recordSkillResult,
        recordSkippedSkill: tracker.recordSkippedSkill,
        registry: createSkillRegistry(skills),
        retrievalPlan: RETRIEVAL_PLAN,
        sessionId: SESSION_ID,
        stepLifecycle: createAgentRunStepLifecycle({
          accessScope,
          agentRunService,
          runCursor,
          runId: RUN_ID,
        }),
        userId: USER_ID,
      })
    )
  );

  return {
    ...(await collectRun({
      agentRunService,
      budgetState,
      extra: { budgetLimits, outcome, settled },
      probe,
      tracker,
      trace,
    })),
    agentRunService,
  };
};

// Text that must never reach LangGraph's thread record.
const assertRecordHoldsNoText = (record, texts) => {
  const serialized = JSON.stringify(record);
  const decoded = serialized.replace(/"d":"([^"]*)"/g, (whole, data) => {
    try {
      return `${whole} ${Buffer.from(data, "base64").toString("utf8")}`;
    } catch {
      return whole;
    }
  });

  for (const text of [QUESTION, ...DOC_IDS, ...texts]) {
    assert.equal(decoded.includes(text), false, `the LangGraph record holds ${text}`);
  }
};

// The latest LangGraph checkpoint of the run's thread, read through a saver
// bound to the run (reads are not fenced).
const readThread = async (agentRunService) => {
  const saver = new RunStoreCheckpointSaver({ accessScope, agentRunService, runId: RUN_ID });
  const checkpoints = [];

  for await (const tuple of saver.list({ configurable: { thread_id: saver.threadId } })) {
    checkpoints.push(tuple);
  }

  const stored = checkpoints[0]?.checkpoint?.channel_values?.receipts ?? null;

  return {
    checkpointCount: checkpoints.length,
    // LangGraph's step of each retained checkpoint, newest first.
    steps: checkpoints.map((tuple) => tuple.metadata?.step ?? null),
    // Back to nodeId keys for the assertions; the stored keys are
    // "node:" + nodeId.
    receipts: stored === null
      ? null
      : Object.fromEntries(
          Object.entries(stored).map(([key, receipt]) => {
            assert.ok(key.startsWith("node:"), key);
            return [key.slice("node:".length), receipt];
          })
        ),
    storedPrototype: stored === null ? null : Object.getPrototypeOf(stored),
  };
};

const sortSkillRuns = (observed) => ({
  ...observed,
  skillRuns: [...observed.skillRuns].sort((left, right) =>
    JSON.stringify(left) < JSON.stringify(right) ? -1 : 1
  ),
});

/**
 * Runs `build()` on LangGraph and holds its masked `observed` to `golden`,
 * the native scheduler's frozen result of the same scenario. With
 * `goldenDigest` only its sha256 is kept, in the suite's digests.json (large
 * sweeps). With skillRunOrder "superstep" the per-Skill observations must
 * come in another order than natively and be equal once sorted (known
 * difference 3 in rag/langgraph/run-execution-graph.js: a skip the native
 * loop recorded in the same pass as its cause, a dependant of a node it had
 * just skipped, is recorded by LangGraph one superstep later, after the
 * sibling that ran meanwhile); that golden is only read. Returns the run for
 * scenario-specific assertions.
 */
const assertParity = async ({
  build,
  golden,
  goldenDigest = false,
  level = "stage",
  skillRunOrder = "exact",
}) => {
  if (typeof golden !== "string" || golden.length === 0) {
    throw new TypeError("assertParity needs the name of its golden fixture.");
  }

  if (goldenDigest && skillRunOrder !== "exact") {
    throw new TypeError("A digest golden can only be compared exactly.");
  }

  const langgraph = level === "stage"
    ? await runStageScenario({ scenario: build() })
    : await runExecutorScenario({ scenario: build() });

  if (goldenDigest) {
    assertMatchesGraphGoldenDigest(GOLDEN_SUITE, golden, langgraph.observed);
  } else if (skillRunOrder === "superstep") {
    const frozen = readGolden(golden);
    const observed = canonical(langgraph.observed);

    assert.notDeepStrictEqual(observed.skillRuns, frozen.skillRuns, `golden ${golden}`);
    assert.deepStrictEqual(sortSkillRuns(observed), sortSkillRuns(frozen), `golden ${golden}`);
  } else {
    assertMatchesNativeGolden(golden, langgraph.observed);
  }

  return { langgraph };
};

// ---------------------------------------------------------------------------
// The stage's executor
// ---------------------------------------------------------------------------

// The AGENT_RUNTIME dial is gone (phase 6): the stage takes no runtime and
// AGENT_RUNTIME selects nothing; a removed value is only refused, at start-up
// and again by the stage and the executor before anything runs
// (test/agent-runtime-removed.test.mjs).
test("the stage schedules on LangGraph, and the settling save leaves only the null tombstone", async () => {
  // A LangGraph run that settled holds the null tombstone its settling
  // checkpoint save left (the record key, with no thread behind it).
  const probe = createProbe();
  const skills = [createScriptedSkill({ id: "compare_documents", probe })];
  const { agentRunService, agentRunStore, runCursor } = await createRunHarness({ skills });
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 4 });
  const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });
  const recordsWritten = [];

  await runCustomSkillStage({
    accessScope,
    budgetState,
    buildSkillTraceDetail: tracker.buildSkillTraceDetail,
    customSkills: skills,
    docIds: [...DOC_IDS],
    executeObservedSkill: async (...args) => {
      // The thread exists while the node runs: the graph is on LangGraph.
      recordsWritten.push(
        (await agentRunService.getLangGraphCheckpointRecord({ accessScope, runId: RUN_ID })).record
      );
      return tracker.executeObservedSkill(...args);
    },
    loadExecutionGraphCheckpoint: () =>
      agentRunService.getExecutionGraphCheckpoint({ accessScope, runCursor, runId: RUN_ID }),
    mode: CUSTOM_SKILL_STAGE_MODES.guarded,
    plan: { mode: SKILL_CHAIN_MODE },
    plannerAdapter: {
      createExecutionGraph: () => ({
        nodes: [graphNode({ nodeId: "compare", skillId: "compare_documents" })],
      }),
      id: "parity_planner",
    },
    question: QUESTION,
    ragService: {},
    recordSkillResult: tracker.recordSkillResult,
    recordSkippedSkill: tracker.recordSkippedSkill,
    registry: createSkillRegistry(skills),
    // Forwards the settling save's drop, as agent.js wires the stage (the
    // parity harness's hook above leaves it out, so its scenarios can read
    // the thread after the stage).
    saveExecutionGraphCheckpoint: (checkpoint, { dropLangGraphRecord = false } = {}) =>
      agentRunService.saveExecutionGraphCheckpoint({
        accessScope,
        checkpoint,
        dropLangGraphRecord,
        runCursor,
        runId: RUN_ID,
      }),
    sessionId: SESSION_ID,
    stepLifecycle: createAgentRunStepLifecycle({
      accessScope,
      agentRunService,
      runCursor,
      runId: RUN_ID,
    }),
    userId: USER_ID,
  });

  const record = await agentRunService.getLangGraphCheckpointRecord({
    accessScope,
    runId: RUN_ID,
  });
  const stored = await agentRunStore.get({ accessScope, runId: RUN_ID });

  assert.equal(recordsWritten.length, 1);
  assert.notEqual(recordsWritten[0], null);
  // No thread outlives the settled graph.
  assert.equal(record.record, null);
  assert.equal(Object.hasOwn(stored.result, LANGGRAPH_CHECKPOINT_RESULT_KEY), true);
  assert.equal(stored.result[LANGGRAPH_CHECKPOINT_RESULT_KEY], null);
  assert.equal(stored.result[EXECUTION_GRAPH_CHECKPOINT_RESULT_KEY].phase, "completed");
  assert.equal(probe.journal.filter((entry) => entry.event === "start").length, 1);
});

test("the step lifecycle names its run for the checkpointer, and nothing else does", async () => {
  const agentRunService = createAgentRunService({ agentRunStore: createInMemoryAgentRunStore() });
  const runCursor = createAgentRunCursor();
  const lifecycle = createAgentRunStepLifecycle({
    accessScope,
    agentRunService,
    runCursor,
    runId: RUN_ID,
  });
  const target = getAgentRunStepLifecycleTarget(lifecycle);

  assert.equal(target.agentRunService, agentRunService);
  assert.equal(target.runCursor, runCursor);
  assert.equal(target.runId, RUN_ID);
  assert.equal(target.accessScope, accessScope);
  assert.equal(Object.isFrozen(target), true);
  // The lifecycle object itself is unchanged: the target is kept beside it.
  assert.deepEqual(Object.keys(lifecycle).sort(), [
    "completeGraphStep",
    "completeStep",
    "failGraphStep",
    "failStep",
    "pauseGraphStep",
    "pauseStep",
    "startGraphStep",
    "startStep",
  ]);
  // No run, no target; a copy or a hand-built lifecycle has none either.
  assert.equal(
    getAgentRunStepLifecycleTarget(createAgentRunStepLifecycle({ accessScope, agentRunService })),
    null
  );
  assert.equal(getAgentRunStepLifecycleTarget({ ...lifecycle }), null);
  assert.equal(getAgentRunStepLifecycleTarget(undefined), null);
  assert.equal(getAgentRunStepLifecycleTarget("lifecycle"), null);
});

// ---------------------------------------------------------------------------
// Parity: scheduling
// ---------------------------------------------------------------------------

test("parity: parallel-safe nodes run at once and a join waits for both", async () => {
  const { langgraph } = await assertParity({
    golden: "parallel-safe-join",
    build: () => {
      const probe = createProbe();
      const barrier = createBarrier(2);
      const firstSaved = createDeferred();
      const skills = [
        createScriptedSkill({
          id: "risk_review",
          probe,
          respond: async (context) => {
            await barrier.arrive("risk");
            return answer("risk_review", context);
          },
        }),
        createScriptedSkill({
          id: "extract_timeline",
          probe,
          respond: async (context) => {
            await barrier.arrive("timeline");
            // Completes only once the first node's checkpoint is durable, so
            // the run store is written in one order.
            await firstSaved.promise;
            return answer("extract_timeline", context);
          },
        }),
        createScriptedSkill({ id: "summarize_contract", probe }),
      ];

      return {
        maxConcurrency: 3,
        nodes: [
          graphNode({ nodeId: "risk", skillId: "risk_review" }),
          graphNode({ nodeId: "timeline", skillId: "extract_timeline" }),
          graphNode({
            dependsOn: ["risk", "timeline"],
            inputBindings: {
              docIds: requestField("docIds"),
              priorFindings: nodeOutput("risk", "text"),
              question: requestField("question"),
            },
            nodeId: "summary",
            skillId: "summarize_contract",
          }),
        ],
        onCheckpointSaved: (checkpoint) => {
          if (checkpoint.nodeRuns?.some((run) => run.nodeId === "risk")) {
            firstSaved.resolve();
          }
        },
        probe,
        skills,
      };
    },
  });

  assert.equal(langgraph.probe.maxActive, 2);
  assert.deepEqual(langgraph.probe.overlaps.slice(0, 2), [
    ["risk_review", []],
    ["extract_timeline", ["risk_review"]],
  ]);

  assert.equal(langgraph.observed.outcome.result.length, 3);
  assert.equal(langgraph.observed.journal.at(-2).priorFindings, "risk_review answered.");
  assert.equal(langgraph.observed.checkpoint.phase, "completed");

  // LangGraph checkpointed its thread into the same run, receipts only.
  assert.ok(langgraph.langGraphRecord);
  assertRecordHoldsNoText(langgraph.langGraphRecord, ["answered", "contract risks"]);
  const thread = await readThread(langgraph.agentRunService);

  assert.deepEqual(Object.keys(thread.receipts).sort(), ["risk", "summary", "timeline"]);
  assert.deepEqual(
    Object.values(thread.receipts).map(({ reason, status }) => ({ reason, status })),
    [
      { reason: null, status: "completed" },
      { reason: null, status: "completed" },
      { reason: null, status: "completed" },
    ]
  );
  assert.match(thread.receipts.risk.outputDigest, /^v1:sha256:[0-9a-f]{64}$/);
});

test("parity: a side-effecting node runs alone and blocks the nodes declared after it", async () => {
  const { langgraph } = await assertParity({
    golden: "side-effect-runs-alone",
    build: () => {
      const probe = createProbe();
      const skills = [
        createScriptedSkill({ id: "risk_review", probe }),
        createScriptedSkill({
          effects: SKILL_EFFECTS.workspaceWrite,
          id: "publish_report",
          probe,
        }),
        createScriptedSkill({ id: "extract_timeline", probe }),
      ];

      return {
        maxConcurrency: 3,
        nodes: [
          graphNode({ nodeId: "risk", skillId: "risk_review" }),
          graphNode({ nodeId: "publish", skillId: "publish_report" }),
          graphNode({ nodeId: "timeline", skillId: "extract_timeline" }),
        ],
        probe,
        skills,
      };
    },
  });

  assert.equal(langgraph.probe.maxActive, 1);
  assert.deepEqual(
    langgraph.probe.journal.map(({ event, skillId }) => `${event}:${skillId}`),
    [
      "start:risk_review",
      "end:risk_review",
      "start:publish_report",
      "end:publish_report",
      "start:extract_timeline",
      "end:extract_timeline",
    ]
  );
});

test("parity: a concurrency cap of 1 runs every node, one at a time, in declaration order", async () => {
  // LangGraph 1.5.0 loses tasks when its own maxConcurrency is below a
  // superstep's width; the cap must come from the in-process gate, and every
  // node of the three-wide superstep must still run.
  const { langgraph } = await assertParity({
    golden: "cap-one-declaration-order",
    build: () => {
      const probe = createProbe();
      const ids = ["timeline_review", "risk_review", "compare_documents"];

      return {
        maxConcurrency: 1,
        nodes: ids.map((id) => graphNode({ nodeId: `n_${id}`, skillId: id })),
        probe,
        skills: ids.map((id) => createScriptedSkill({ id, probe })),
      };
    },
  });

  assert.equal(langgraph.probe.maxActive, 1);
  assert.deepEqual(
    langgraph.probe.journal.filter(({ event }) => event === "start").map(({ skillId }) => skillId),
    ["timeline_review", "risk_review", "compare_documents"]
  );
});

// ---------------------------------------------------------------------------
// Parity: failure policies and skips
// ---------------------------------------------------------------------------

test("parity: fail_fast skips what has not started and fails the dependants", async () => {
  const { langgraph } = await assertParity({
    golden: "fail-fast-skips",
    build: () => {
      const probe = createProbe();
      const skills = [
        createScriptedSkill({
          id: "risk_review",
          probe,
          respond: async () => {
            throw new Error("risk review failed");
          },
        }),
        createScriptedSkill({ id: "extract_timeline", probe }),
        createScriptedSkill({ id: "summarize_contract", probe }),
      ];

      return {
        // Cap 1 keeps the independent node queued behind the failing one.
        maxConcurrency: 1,
        nodes: [
          graphNode({
            failurePolicy: EXECUTION_GRAPH_FAILURE_POLICIES.failFast,
            nodeId: "risk",
            skillId: "risk_review",
          }),
          graphNode({ nodeId: "timeline", skillId: "extract_timeline" }),
          graphNode({ dependsOn: ["risk"], nodeId: "summary", skillId: "summarize_contract" }),
        ],
        probe,
        skills,
      };
    },
  });

  assert.deepEqual(
    langgraph.observed.graphEvents[0].nodeRuns.map(({ nodeId, reason, status }) => ({ nodeId, reason, status })),
    [
      { nodeId: "risk", reason: null, status: "failed" },
      { nodeId: "timeline", reason: "aborted_after_failure", status: "skipped" },
      { nodeId: "summary", reason: "dependency_failed", status: "skipped" },
    ]
  );
  assert.equal(langgraph.observed.checkpoint.phase, "partial");
});

test("parity: a continue failure skips only its dependants while siblings finish", async () => {
  const { langgraph } = await assertParity({
    golden: "continue-failure-skips-dependants",
    build: () => {
      const probe = createProbe();
      const failedSaved = createDeferred();
      const skills = [
        createScriptedSkill({
          id: "risk_review",
          probe,
          respond: async () => ({ abstained: false, citations: "not-an-array", text: 7 }),
        }),
        createScriptedSkill({
          id: "extract_timeline",
          probe,
          respond: async (context) => {
            await failedSaved.promise;
            return answer("extract_timeline", context);
          },
        }),
        createScriptedSkill({ id: "summarize_contract", probe }),
      ];

      return {
        maxConcurrency: 3,
        nodes: [
          graphNode({ nodeId: "risk", skillId: "risk_review" }),
          graphNode({ nodeId: "timeline", skillId: "extract_timeline" }),
          graphNode({ dependsOn: ["risk"], nodeId: "summary", skillId: "summarize_contract" }),
        ],
        onCheckpointSaved: (checkpoint) => {
          if (checkpoint.nodeRuns?.some((run) => run.nodeId === "risk")) {
            failedSaved.resolve();
          }
        },
        probe,
        skills,
      };
    },
  });

  assert.deepEqual(
    langgraph.observed.graphEvents[0].nodeRuns.map(({ nodeId, reason, status }) => ({ nodeId, reason, status })),
    [
      { nodeId: "risk", reason: null, status: "failed" },
      { nodeId: "timeline", reason: null, status: "completed" },
      { nodeId: "summary", reason: "dependency_failed", status: "skipped" },
    ]
  );
  // The malformed output failed the output gate, not the Skill call.
  assert.match(langgraph.observed.steps[0].error.message, /output/i);
});

test("parity: a false condition skips its node and its dependants as dependency_skipped", async () => {
  // A condition is a v2 graph feature (the stage's planner emits v1 graphs,
  // which cannot declare one), so this runs straight through the executor.
  const { langgraph } = await assertParity({
    golden: "false-condition-skips",
    level: "executor",
    skillRunOrder: "superstep",
    build: () => {
      const probe = createProbe();
      const skills = [
        createScriptedSkill({
          id: "compare_documents",
          outputSchema: {
            ...CUSTOM_RAG_SKILL_CONTRACT.outputSchema,
            proceed: { required: true, type: SKILL_VALUE_TYPES.boolean },
          },
          probe,
          respond: async (context) => ({ ...answer("compare_documents", context), proceed: false }),
        }),
        createScriptedSkill({ id: "risk_review", probe }),
        createScriptedSkill({ id: "summarize_contract", probe }),
        createScriptedSkill({ id: "extract_timeline", probe }),
      ];

      return {
        graph: createExecutionGraph({
          nodes: [
            graphNode({ nodeId: "compare", skillId: "compare_documents" }),
            graphNode({
              dependsOn: ["compare"],
              nodeId: "risk",
              skillId: "risk_review",
              when: { equals: true, nodeId: "compare", output: "proceed" },
            }),
            graphNode({ dependsOn: ["risk"], nodeId: "summary", skillId: "summarize_contract" }),
            graphNode({ dependsOn: ["compare"], nodeId: "timeline", skillId: "extract_timeline" }),
          ],
          version: "v2",
        }),
        probe,
        skills,
      };
    },
  });

  assert.deepEqual(
    langgraph.observed.outcome.result.nodeRuns.map(({ reason, status }) => ({ reason, status })),
    [
      { reason: null, status: "completed" },
      { reason: "condition_not_met", status: "skipped" },
      { reason: "dependency_skipped", status: "skipped" },
      { reason: null, status: "completed" },
    ]
  );
  // Decisions, not failures: the graph completed, and neither skipped node
  // opened a step or spent budget.
  assert.equal(langgraph.observed.outcome.result.status, "completed");
  assert.deepEqual(
    langgraph.observed.steps.map(({ id }) => id),
    ["custom_skill:compare", "custom_skill:timeline"]
  );
  assert.equal(langgraph.observed.budget.used.customSkillCalls, 2);

  const thread = await readThread(langgraph.agentRunService);

  assert.deepEqual(thread.receipts.risk, {
    outputDigest: null,
    reason: "condition_not_met",
    status: "skipped",
  });
  assert.deepEqual(thread.receipts.summary, {
    outputDigest: null,
    reason: "dependency_skipped",
    status: "skipped",
  });
  assertRecordHoldsNoText(langgraph.langGraphRecord, ["answered", "proceed"]);
});

test("parity: a node the budget cannot fund is skipped without a step", async () => {
  // Below the planner (which refuses a graph larger than the remaining
  // budget): the executor itself must reserve before it launches.
  const { langgraph } = await assertParity({
    golden: "budget-cannot-fund",
    level: "executor",
    build: () => {
      const probe = createProbe();
      const skills = [
        createScriptedSkill({ id: "risk_review", probe }),
        createScriptedSkill({ id: "extract_timeline", probe }),
        createScriptedSkill({ id: "compare_documents", probe }),
      ];

      return {
        budget: { maxCustomSkillCalls: 2 },
        graph: createExecutionGraph({
          nodes: [
            graphNode({ nodeId: "risk", skillId: "risk_review" }),
            graphNode({ nodeId: "timeline", skillId: "extract_timeline" }),
            graphNode({ nodeId: "compare", skillId: "compare_documents" }),
          ],
        }),
        maxConcurrency: 1,
        probe,
        skills,
      };
    },
  });

  assert.deepEqual(
    langgraph.observed.outcome.result.nodeRuns.map(({ reason, status }) => ({ reason, status })),
    [
      { reason: null, status: "completed" },
      { reason: null, status: "completed" },
      { reason: "budget_exhausted", status: "skipped" },
    ]
  );
  assert.equal(langgraph.observed.budgetLimits.length, 1);
  assert.equal(langgraph.observed.steps.length, 2);
  assert.equal(langgraph.observed.budget.used.customSkillCalls, 2);
});

test("parity: an input that fails its gate fails the node without calling the Skill or charging budget", async () => {
  const { langgraph } = await assertParity({
    golden: "input-gate-fails",
    level: "executor",
    build: () => {
      const probe = createProbe();
      const skills = [
        createScriptedSkill({ id: "risk_review", probe }),
        createScriptedSkill({ id: "extract_timeline", probe }),
      ];

      return {
        docIds: ["doc-1"],
        graph: createExecutionGraph({
          nodes: [
            // The node narrows to a document the request did not ask for: its
            // scoped docIds come out empty, which the input gate refuses.
            graphNode({ nodeId: "risk", scope: { docIds: ["doc-2"] }, skillId: "risk_review" }),
            graphNode({ dependsOn: ["risk"], nodeId: "timeline", skillId: "extract_timeline" }),
          ],
        }),
        probe,
        skills,
      };
    },
  });

  assert.deepEqual(langgraph.probe.journal, []);
  assert.deepEqual(
    langgraph.observed.outcome.result.nodeRuns.map(({ reason, status }) => ({ reason, status })),
    [
      { reason: null, status: "failed" },
      { reason: "dependency_failed", status: "skipped" },
    ]
  );
  assert.match(langgraph.observed.outcome.result.nodeRuns[0].result.error.message, /at least one document/);
  assert.equal(langgraph.observed.budget.used.customSkillCalls, 0);
  assert.deepEqual(
    langgraph.observed.steps.map(({ id, status }) => ({ id, status })),
    [{ id: "custom_skill:risk", status: "failed" }]
  );
});

test("known difference: a fail_fast failure in a superstep skips a dependant the native loop had already launched", async () => {
  // Pinned, not removed: a node is decided when its whole superstep has
  // finished. Here `summary` depends only on the fast `timeline`; the native
  // loop launches it while the slow fail_fast `risk` is still running, and
  // LangGraph decides it after `risk` failed, so it is skipped. Native took
  // the same branch whenever the failure landed before `timeline` settled.
  const probe = createProbe();
  const timelineSaved = createDeferred();
  const skills = [
    createScriptedSkill({
      id: "risk_review",
      probe,
      respond: async () => {
        await timelineSaved.promise;
        // Long enough for the native loop to have launched summary meanwhile.
        await turns(10);
        throw new Error("risk review failed");
      },
    }),
    createScriptedSkill({ id: "extract_timeline", probe }),
    createScriptedSkill({ id: "summarize_contract", probe }),
  ];
  const langgraph = await runStageScenario({
    scenario: {
      maxConcurrency: 3,
      nodes: [
        graphNode({
          failurePolicy: EXECUTION_GRAPH_FAILURE_POLICIES.failFast,
          nodeId: "risk",
          skillId: "risk_review",
        }),
        graphNode({ nodeId: "timeline", skillId: "extract_timeline" }),
        graphNode({ dependsOn: ["timeline"], nodeId: "summary", skillId: "summarize_contract" }),
      ],
      onCheckpointSaved: (checkpoint) => {
        if (checkpoint.nodeRuns?.some((run) => run.nodeId === "timeline")) {
          timelineSaved.resolve();
        }
      },
      probe,
      skills,
    },
  });
  const statuses = (run) =>
    run.observed.graphEvents[0].nodeRuns.map(({ nodeId, reason, status }) => ({ nodeId, reason, status }));

  assert.deepEqual(statuses(langgraph), [
    { nodeId: "risk", reason: null, status: "failed" },
    { nodeId: "timeline", reason: null, status: "completed" },
    { nodeId: "summary", reason: "aborted_after_failure", status: "skipped" },
  ]);

  // Against the native run as frozen: its statuses (the native launch of
  // summary), and LangGraph ran nothing it did not, apart from that node.
  const frozen = readGolden("known-difference-fail-fast-superstep");

  assert.deepEqual(statuses({ observed: frozen }), [
    { nodeId: "risk", reason: null, status: "failed" },
    { nodeId: "timeline", reason: null, status: "completed" },
    { nodeId: "summary", reason: null, status: "completed" },
  ]);
  assert.deepStrictEqual(
    canonical(langgraph.observed.journal),
    frozen.journal.filter(({ skillId }) => skillId !== "summarize_contract")
  );
});

test("parity: an illegal graph is rejected whole before anything runs or is written", async () => {
  for (const variant of ["out_of_scope_request", "cycle"]) {
    const { langgraph } = await assertParity({
      golden: `illegal-graph-${variant}`,
      level: "executor",
      build: () => {
        const probe = createProbe();
        const skills = [
          createScriptedSkill({ id: "risk_review", probe }),
          createScriptedSkill({ id: "extract_timeline", probe }),
        ];

        return variant === "cycle"
          ? {
              graph: createExecutionGraph({
                nodes: [
                  graphNode({ dependsOn: ["timeline"], nodeId: "risk", skillId: "risk_review" }),
                  graphNode({ dependsOn: ["risk"], nodeId: "timeline", skillId: "extract_timeline" }),
                ],
              }),
              probe,
              skills,
            }
          : {
              docIds: ["doc-1", "doc-9"],
              graph: createExecutionGraph({
                nodes: [graphNode({ nodeId: "risk", skillId: "risk_review" })],
              }),
              probe,
              skills,
            };
      },
    });

    assert.equal(langgraph.observed.outcome.result.status, "rejected", variant);
    assert.deepEqual(langgraph.observed.steps, [], variant);
    assert.deepEqual(langgraph.probe.journal, [], variant);
    // No tombstone and no thread: nothing touched the run row.
    assert.equal(langgraph.langGraphRecord, null, variant);
    assert.equal(
      langgraph.observed.events.length,
      1,
      `${variant}: only run_created`
    );
  }
});

test("parity: a graph checkpoint failure stops scheduling, and the node waiting for a slot never launches", async () => {
  const { langgraph } = await assertParity({
    golden: "checkpoint-failure-stops",
    build: () => {
      const probe = createProbe();
      let failed = false;

      return {
        // Cap 1: timeline waits for the slot compare holds while its
        // checkpoint write fails.
        maxConcurrency: 1,
        nodes: [
          graphNode({ nodeId: "compare", skillId: "compare_documents" }),
          graphNode({ nodeId: "timeline", skillId: "extract_timeline" }),
        ],
        onCheckpointSaved: (checkpoint) => {
          if (!failed && checkpoint.nodeRuns?.some((run) => run.nodeId === "compare")) {
            failed = true;
            throw new Error("graph checkpoint write failed");
          }
        },
        probe,
        skills: [
          createScriptedSkill({ id: "compare_documents", probe }),
          createScriptedSkill({ id: "extract_timeline", probe }),
        ],
      };
    },
  });

  assert.equal(langgraph.observed.outcome.error.message, "graph checkpoint write failed");
  assert.deepEqual(
    langgraph.observed.steps.map(({ id, status }) => ({ id, status })),
    [{ id: "custom_skill:compare", status: "completed" }]
  );
  assert.deepEqual(
    langgraph.probe.journal.map(({ event, skillId }) => `${event}:${skillId}`),
    ["start:compare_documents", "end:compare_documents"]
  );
});

// ---------------------------------------------------------------------------
// Parity: node ids LangGraph could not take as names
// ---------------------------------------------------------------------------

test("parity: node ids LangGraph refuses as raw node names run under encoded names", async () => {
  // ":" and "|" are refused by StateGraph.addNode, "__start__" is reserved,
  // "receipts" is the state key, and "__proto__" is an inherited name. The
  // native validator accepts every one of them.
  const nodeIds = ["risk:v2|draft", "__start__", "receipts", "__proto__"];
  const { langgraph } = await assertParity({
    golden: "encoded-node-names",
    build: () => {
      const probe = createProbe();
      const ids = ["risk_review", "extract_timeline", "compare_documents", "summarize_contract"];

      return {
        nodes: [
          graphNode({ nodeId: nodeIds[0], skillId: ids[0] }),
          graphNode({ dependsOn: [nodeIds[0]], nodeId: nodeIds[1], skillId: ids[1] }),
          graphNode({ nodeId: nodeIds[2], skillId: ids[2] }),
          graphNode({
            dependsOn: [nodeIds[1], nodeIds[2]],
            inputBindings: {
              docIds: requestField("docIds"),
              priorFindings: nodeOutput(nodeIds[1], "text"),
              question: requestField("question"),
            },
            nodeId: nodeIds[3],
            skillId: ids[3],
          }),
        ],
        probe,
        skills: ids.map((id) => createScriptedSkill({ id, probe })),
      };
    },
  });

  assert.deepEqual(
    langgraph.observed.checkpoint.nodeRuns.map(({ nodeId, status }) => ({ nodeId, status })),
    nodeIds.map((nodeId) => ({ nodeId, status: "completed" }))
  );
  // Steps are recorded in start order: both dependency-free nodes first.
  assert.deepEqual(
    langgraph.observed.steps.map(({ id }) => id),
    [nodeIds[0], nodeIds[2], nodeIds[1], nodeIds[3]].map((nodeId) => `custom_skill:${nodeId}`)
  );

  const thread = await readThread(langgraph.agentRunService);

  // "__proto__" included: read back from the thread, the receipts object
  // keeps its own prototype.
  assert.deepEqual(Object.keys(thread.receipts).sort(), [...nodeIds].sort());
  assert.equal(thread.storedPrototype, Object.prototype);
});

test("encoded node names are valid LangGraph names that sort in declaration order", () => {
  const nodeIds = [
    "z", "a:b|c", "__start__", "__end__", "receipts", "__proto__", "10", "2", "", "  ",
    "x".repeat(80), "風險", "node_00_x",
  ];
  const names = nodeIds.map((nodeId, index) =>
    encodeExecutionGraphNodeName({ index, nodeCount: nodeIds.length, nodeId })
  );

  assert.equal(new Set(names).size, names.length);
  assert.deepEqual([...names].sort(), names);

  for (const name of names) {
    assert.doesNotMatch(name, /[:|]/);
    assert.equal(name.startsWith("__"), false);
    assert.notEqual(name, "receipts");
  }

  // Every one is accepted by StateGraph.addNode.
  const builder = new StateGraph(ExecutionGraphReceiptState);

  for (const name of names) {
    builder.addNode(name, () => ({}));
    builder.addEdge(START, name);
    builder.addEdge(name, END);
  }

  assert.ok(builder.compile({ checkpointer: false }));
});

test("LangGraph enters a superstep's nodes in node-name order (pins the declaration-order queue)", async () => {
  // The gate is first come, first served, and arrival order is LangGraph's
  // task order: candidateNodes sorts triggered names (pregel/algo.js). If an
  // upgrade changes that, the declaration-order queue changes with it.
  const builder = new StateGraph(ExecutionGraphReceiptState);
  const entered = [];
  const declared = ["zeta", "alpha", "mu", "beta", "omega", "kappa", "a", "b", "c", "d", "e", "f"];

  declared.forEach((nodeId, index) => {
    const name = encodeExecutionGraphNodeName({ index, nodeCount: declared.length, nodeId });

    builder.addNode(name, async () => {
      entered.push(nodeId);
      return { receipts: { [nodeId]: { outputDigest: null, reason: null, status: "completed" } } };
    });
    builder.addEdge(START, name);
    builder.addEdge(name, END);
  });

  await builder
    .compile({ checkpointer: false })
    .invoke({ receipts: {} }, { configurable: { thread_id: "order" } });

  assert.deepEqual(entered, declared);
});

// ---------------------------------------------------------------------------
// Parity: replan, approval interrupt, recovery
// ---------------------------------------------------------------------------

test("parity: a bounded replan runs a fresh LangGraph invocation that reuses the settled nodes", async () => {
  const { langgraph } = await assertParity({
    golden: "bounded-replan",
    build: () => {
      const probe = createProbe();
      const skills = [
        createScriptedSkill({ id: "compare_documents", probe }),
        createScriptedSkill({
          id: "risk_review",
          probe,
          respond: async () => ({ abstained: true, citations: [], text: "" }),
        }),
        createScriptedSkill({
          id: "extract_timeline",
          probe,
          respond: async () => ({ abstained: true, citations: [], text: "" }),
        }),
      ];

      return {
        nodes: [
          graphNode({ nodeId: "compare", skillId: "compare_documents" }),
          graphNode({ nodeId: "risk", skillId: "risk_review" }),
        ],
        probe,
        replanAdapter: {
          createPatch: () => ({
            addNodes: [graphNode({ nodeId: "timeline", skillId: "extract_timeline" })],
          }),
          id: "parity_replanner",
        },
        skills,
      };
    },
  });

  assert.deepEqual(
    langgraph.observed.graphEvents[0].replans.map((replan) => replan.decision),
    [REPLAN_DECISIONS.applied, REPLAN_DECISIONS.abstain]
  );
  assert.deepEqual(
    langgraph.probe.journal.filter(({ event }) => event === "start").map(({ skillId }) => skillId),
    ["compare_documents", "risk_review", "extract_timeline"]
  );
  assert.equal(langgraph.observed.budget.used.customSkillCalls, 3);

  // The thread holds the second invocation only: the first one's record was
  // tombstoned, and the settled nodes came back as reused receipts.
  const thread = await readThread(langgraph.agentRunService);

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(thread.receipts).map(([nodeId, { status }]) => [nodeId, status])
    ),
    { compare: "reused", risk: "reused", timeline: "completed" }
  );
  // The second invocation's newest checkpoints only. It writes three (the
  // input, LangGraph's own __start__ superstep, the graph's single layer);
  // since phase 4 the executor's saver keeps LANGGRAPH_CHECKPOINT_RETENTION
  // (2) per namespace, so the input checkpoint is pruned and two remain
  // (was 3 before retention was wired). Their steps say they are this
  // invocation's: the __start__ superstep at 0 and the layer at 1. Without
  // the tombstone the first invocation's thread would have continued, and
  // the newest steps would be past 1.
  assert.equal(thread.checkpointCount, LANGGRAPH_CHECKPOINT_RETENTION);
  assert.deepEqual(thread.steps, [1, 0]);
});

test("parity: an approval interrupt inside a node pauses its step and leaves the graph", async () => {
  const { langgraph } = await assertParity({
    golden: "approval-interrupt",
    build: () => {
      const probe = createProbe();
      const skills = [
        createScriptedSkill({ id: "compare_documents", probe }),
        createScriptedSkill({
          id: "risk_review",
          probe,
          respond: async () => {
            throw new AgentRunInterruptError({
              detail: { skillId: "risk_review" },
              type: AGENT_INTERRUPT_TYPES.capabilityApprovalRequired,
            });
          },
        }),
        createScriptedSkill({ id: "extract_timeline", probe }),
        createScriptedSkill({ id: "summarize_contract", probe }),
      ];

      return {
        maxConcurrency: 1,
        nodes: [
          graphNode({ nodeId: "compare", skillId: "compare_documents" }),
          graphNode({ nodeId: "risk", skillId: "risk_review" }),
          graphNode({ nodeId: "timeline", skillId: "extract_timeline" }),
          graphNode({ dependsOn: ["risk"], nodeId: "summary", skillId: "summarize_contract" }),
        ],
        probe,
        skills,
      };
    },
  });

  const { error } = langgraph.observed.outcome;

  assert.equal(error.type, AGENT_INTERRUPT_TYPES.capabilityApprovalRequired);
  // The interrupted node is handed back pending, and the native loop's next
  // pass then settles every v2 node that can no longer run: the interrupted
  // node and its independent sibling as aborted_after_failure, its dependant
  // as dependency_skipped. LangGraph reproduces that decision inside the
  // interrupted node (compile-execution-graph.js).
  assert.deepEqual(
    error.executionGraphNodeRuns.map(({ nodeId, reason, status }) => ({ nodeId, reason, status })),
    [
      { nodeId: "compare", reason: null, status: "completed" },
      { nodeId: "risk", reason: "aborted_after_failure", status: "skipped" },
      { nodeId: "timeline", reason: "aborted_after_failure", status: "skipped" },
      { nodeId: "summary", reason: "dependency_skipped", status: "skipped" },
    ]
  );
  assert.deepEqual(
    langgraph.observed.steps.map(({ id, status }) => ({ id, status })),
    [
      { id: "custom_skill:compare", status: "completed" },
      { id: "custom_skill:risk", status: "paused" },
    ]
  );
  // The interrupted node's reservation was handed back.
  assert.equal(langgraph.observed.budget.used.customSkillCalls, 1);
  assert.equal(langgraph.observed.graphEvents[0].status, "interrupted");
});

// A guarded two-node custom-Skill graph whose process exits right after the
// first node's checkpoint save, then startup recovery in a new process. With
// `dropThreadAfterCrash` the crashed attempt's LangGraph thread is removed
// below every fence before the recovery, which is what a run the native
// scheduler crashed before phase 6 looks like: a graph checkpoint and no
// thread.
const runStartupRecoveryScenario = async ({ dropThreadAfterCrash = false } = {}) => {
  const probe = createProbe();
  // What the run's thread holds while risk runs in the recovery
  // worker's invocation: the settling save drops the thread once the
  // graph completes, so this is where it can still be read.
  const threadSeenByRisk = [];
  const skills = [
    createScriptedSkill({
      effects: SKILL_EFFECTS.workspaceWrite,
      id: "compare_documents",
      probe,
    }),
    createScriptedSkill({
      id: "risk_review",
      probe,
      respond: async (context) => {
        threadSeenByRisk.push({
          raw: (await store.get({ accessScope, runId: RUN_ID }))
            ?.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY] ?? null,
          thread: await readThread(agentRunService),
        });
        return answer("risk_review", context);
      },
    }),
  ];
  const registry = createSkillRegistry(skills);
  const store = createInMemoryAgentRunStore();
  let agentRunService = createAgentRunService({ agentRunStore: store });

  await agentRunService.createRun({
    accessScope,
    goal: QUESTION,
    input: { docIds: [...DOC_IDS], sessionId: SESSION_ID, userId: USER_ID },
    plan: {
      mode: SKILL_CHAIN_MODE,
      selectedSkills: skills.map((skill) => ({ skillId: skill.id, skillVersion: skill.version })),
    },
    runId: RUN_ID,
  });
  await agentRunService.appendRunEvent({
    accessScope,
    payload: { planner: { stepIds: ["custom_skills"] } },
    runId: RUN_ID,
    type: "execution_planned",
  });

  const budgetState = createAgentBudget({ maxCustomSkillCalls: 3 });
  const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });
  let crashed = false;
  const first = await settleOutcome(() =>
    runCustomSkillStage({
      accessScope,
      authorizedCustomSkills: skills,
      authorizedDocIds: [...DOC_IDS],
      budgetState,
      buildSkillTraceDetail: tracker.buildSkillTraceDetail,
      customSkills: skills,
      docIds: [...DOC_IDS],
      executeObservedSkill: tracker.executeObservedSkill,
      loadExecutionGraphCheckpoint: () =>
        agentRunService.getExecutionGraphCheckpoint({ accessScope, runId: RUN_ID }),
      mode: CUSTOM_SKILL_STAGE_MODES.guarded,
      plan: { mode: SKILL_CHAIN_MODE },
      plannerAdapter: {
        createExecutionGraph: () => ({
          nodes: [
            graphNode({ nodeId: "compare", skillId: "compare_documents" }),
            graphNode({
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
        }),
        id: "parity_planner",
      },
      question: QUESTION,
      ragService: {},
      recordSkillResult: tracker.recordSkillResult,
      recordSkippedSkill: tracker.recordSkippedSkill,
      registry,
      saveExecutionGraphCheckpoint: async (checkpoint) => {
        await agentRunService.saveExecutionGraphCheckpoint({
          accessScope,
          checkpoint,
          runId: RUN_ID,
        });

        if (!crashed && checkpoint.nodeRuns.length === 1) {
          crashed = true;
          throw new Error("simulated process exit");
        }
      },
      sessionId: SESSION_ID,
      stepLifecycle: createAgentRunStepLifecycle({ accessScope, agentRunService, runId: RUN_ID }),
      userId: USER_ID,
    })
  );

  assert.equal(first.error?.message, "simulated process exit");
  const crashedRecord = (await store.get({ accessScope, runId: RUN_ID }))
    ?.result?.[LANGGRAPH_CHECKPOINT_RESULT_KEY] ?? null;

  if (dropThreadAfterCrash) {
    const crashedRun = await store.get({ accessScope, runId: RUN_ID });

    await store.update({
      accessScope,
      expectedRevision: crashedRun.revision,
      patch: { result: { [LANGGRAPH_CHECKPOINT_RESULT_KEY]: null } },
      runId: RUN_ID,
    });
  }

  // A new process: new services over the same store.
  agentRunService = createAgentRunService({ agentRunStore: store });
  const recovery = createAgentRunRecoveryService({
    agentRunService,
    recordRecoveryTrace: async () => {},
    resumeExecutionGraph: (args) =>
      resumeAgentExecutionGraphRun({
        ...args,
        agentRunService,
        ragService: { getDocument: (docId) => ({ docId }) },
        skillRegistry: registry,
      }),
  });
  const outcome = await recovery.recoverOnStartup({ mode: "auto" });
  const run = await agentRunService.getRun({ accessScope, runId: RUN_ID });
  const loaded = await agentRunService.getExecutionGraphCheckpoint({ accessScope, runId: RUN_ID });
  const record = await agentRunService.getLangGraphCheckpointRecord({ accessScope, runId: RUN_ID });

  const stored = await store.get({ accessScope, runId: RUN_ID });

  return {
    agentRunService,
    crashedRecord,
    langGraphRecord: record.record,
    storedRecordKey: Object.hasOwn(stored.result, LANGGRAPH_CHECKPOINT_RESULT_KEY),
    threadSeenByRisk,
    observed: mask({
      checkpoint: loaded.checkpoint,
      events: run.events,
      journal: probe.journal,
      outcome: {
        autoRecoveredCount: outcome.autoRecoveredCount,
        manualRecoveredCount: outcome.manualRecoveredCount,
      },
      result: run.result,
      status: run.status,
      steps: run.steps,
    }),
  };
};

test("parity: startup recovery resumes the graph and never repeats a completed node", async () => {
  const langgraph = await runStartupRecoveryScenario();

  assertMatchesNativeGolden("startup-recovery", langgraph.observed);
  assert.equal(langgraph.observed.status, "completed");
  assert.equal(langgraph.observed.outcome.autoRecoveredCount, 1);
  assert.deepEqual(
    langgraph.observed.journal.filter(({ event }) => event === "start").map(({ skillId }) => skillId),
    ["compare_documents", "risk_review"]
  );
  assert.equal(langgraph.observed.journal[2].priorFindings, "compare_documents answered.");
  // The crash left the attempt's thread on the run row.
  assert.notEqual(langgraph.crashedRecord, null);

  // The recovery worker's invocation replaced the crashed attempt's thread:
  // while risk ran (its superstep not committed yet), the thread held
  // compare as reused from the graph checkpoint, and risk ran once. Read
  // inside risk because, since phase 4, the save that settles the graph
  // drops the thread (before, the finished run kept it and this read the
  // receipts after recovery, risk "completed" included).
  assert.equal(langgraph.threadSeenByRisk.length, 1);
  const [{ raw, thread }] = langgraph.threadSeenByRisk;

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(thread.receipts).map(([nodeId, { status }]) => [nodeId, status])
    ),
    { compare: "reused" }
  );
  assertRecordHoldsNoText(raw, ["answered"]);
  // The settled run keeps no thread: the null tombstone of the drop.
  assert.equal(langgraph.langGraphRecord, null);
  assert.equal(langgraph.storedRecordKey, true);
});

test("a graph checkpoint whose run holds no thread (a crash the native scheduler left before phase 6) is recovered as an uninterrupted one", async () => {
  // Until phase 6 this crashed a graph on one runtime and recovered it on the
  // other, the AGENT_RUNTIME=native rollback included. No runtime is left to
  // roll back to; what stays is the rolled-forward half: a run the native
  // scheduler crashed holds a graph checkpoint and no LangGraph thread, and
  // LangGraph must recover it exactly as the uninterrupted recovery above
  // (the "startup-recovery" golden): a fresh invocation seeds compare as
  // reused from the graph checkpoint, risk runs once, and the settling save
  // leaves the null tombstone.
  const recovered = await runStartupRecoveryScenario({ dropThreadAfterCrash: true });

  assertMatchesNativeGolden("startup-recovery", recovered.observed);
  assert.deepEqual(
    recovered.observed.checkpoint.nodeRuns.map(({ nodeId, status }) => [nodeId, status]),
    [["compare", "reused"], ["risk", "completed"]]
  );
  assert.equal(recovered.threadSeenByRisk.length, 1);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(recovered.threadSeenByRisk[0].thread.receipts).map(([nodeId, { status }]) => [nodeId, status])
    ),
    { compare: "reused" }
  );
  assert.equal(recovered.langGraphRecord, null);
  assert.equal(recovered.storedRecordKey, true);
});

// ---------------------------------------------------------------------------
// Parity: cancellation is a drain
// ---------------------------------------------------------------------------

for (const reason of [
  REQUEST_CANCELLATION_REASONS.clientCancelled,
  REQUEST_CANCELLATION_REASONS.deadlineExceeded,
]) {
  test(`parity: a ${reason} cancellation stops the graph at the next node boundary`, async () => {
    const { langgraph } = await assertParity({
      golden: `cancellation-${reason}`,
      build: () => {
        const probe = createProbe();
        const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });
        const skills = [
          createScriptedSkill({
            id: "compare_documents",
            probe,
            respond: async (context) => {
              // The request ends while this node runs: the node still
              // settles, nothing after it starts.
              cancellation.cancel(reason);
              return answer("compare_documents", context);
            },
          }),
          createScriptedSkill({ id: "risk_review", probe }),
        ];

        return {
          nodes: [
            graphNode({ nodeId: "compare", skillId: "compare_documents" }),
            graphNode({ dependsOn: ["compare"], nodeId: "risk", skillId: "risk_review" }),
          ],
          probe,
          skills,
          wrap: async (work) => {
            try {
              return await runWithRequestCancellation(cancellation, work);
            } finally {
              cancellation.dispose();
            }
          },
        };
      },
    });

    assert.equal(
      langgraph.observed.outcome.error.code,
      reason === REQUEST_CANCELLATION_REASONS.clientCancelled
        ? "AGENT_CLIENT_CANCELLED"
        : "AGENT_DEADLINE_EXCEEDED"
    );
    assert.equal(langgraph.observed.outcome.error.reason, reason);
    assert.deepEqual(
      langgraph.observed.steps.map(({ id, status }) => ({ id, status })),
      [{ id: "custom_skill:compare", status: "completed" }]
    );
    assert.deepEqual(
      langgraph.observed.checkpoint.nodeRuns.map(({ nodeId, status }) => ({ nodeId, status })),
      [{ nodeId: "compare", status: "completed" }]
    );
    assert.equal(langgraph.observed.checkpoint.phase, "running");
  });
}

test("parity: a request cancelled before the graph starts launches nothing", async () => {
  const { langgraph } = await assertParity({
    golden: "cancelled-before-start",
    build: () => {
      const probe = createProbe();
      const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });

      cancellation.cancel(REQUEST_CANCELLATION_REASONS.deadlineExceeded);

      return {
        nodes: [
          graphNode({ nodeId: "compare", skillId: "compare_documents" }),
          graphNode({ nodeId: "risk", skillId: "risk_review" }),
        ],
        probe,
        skills: [
          createScriptedSkill({ id: "compare_documents", probe }),
          createScriptedSkill({ id: "risk_review", probe }),
        ],
        wrap: async (work) => {
          try {
            return await runWithRequestCancellation(cancellation, work);
          } finally {
            cancellation.dispose();
          }
        },
      };
    },
  });

  assert.equal(langgraph.observed.outcome.error.code, "AGENT_DEADLINE_EXCEEDED");
  assert.deepEqual(langgraph.observed.steps, []);
  assert.deepEqual(langgraph.probe.journal, []);
  assert.equal(langgraph.observed.budget.used.customSkillCalls, 0);
  // The graph checkpoint was written before the first launch, and holds no
  // node: recovery has nothing to reuse and nothing to distrust.
  assert.deepEqual(langgraph.observed.checkpoint.nodeRuns, []);
});

test("parity: a cancelled node at the gate drains while its sibling in flight settles first", async () => {
  const releaseTimeline = createDeferred();
  const cancelled = createDeferred();
  // Both Skills are running before the request ends: a node that has not
  // reached its Skill yet would stop at that safe point instead.
  const barrier = createBarrier(2);
  const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });
  let rejectedAt = null;
  const probe = createProbe();
  const skills = [
    createScriptedSkill({
      id: "compare_documents",
      probe,
      respond: async (context) => {
        await barrier.arrive("compare");
        cancellation.cancel(REQUEST_CANCELLATION_REASONS.clientCancelled);
        cancelled.resolve();
        return answer("compare_documents", context);
      },
    }),
    createScriptedSkill({
      id: "extract_timeline",
      probe,
      respond: async (context) => {
        await barrier.arrive("timeline");
        await releaseTimeline.promise;
        return answer("extract_timeline", context);
      },
    }),
    createScriptedSkill({ id: "risk_review", probe }),
  ];
  const running = runStageScenario({
    scenario: {
      // Cap 2: risk waits at the gate behind the two running nodes and is
      // the next to launch once compare settles.
      maxConcurrency: 2,
      nodes: [
        graphNode({ nodeId: "compare", skillId: "compare_documents" }),
        graphNode({ nodeId: "timeline", skillId: "extract_timeline" }),
        graphNode({ nodeId: "risk", skillId: "risk_review" }),
      ],
      probe,
      skills,
      wrap: (work) =>
        runWithRequestCancellation(cancellation, work).then(
          (value) => {
            rejectedAt = "resolved";
            return value;
          },
          (error) => {
            rejectedAt = probe.journal.length;
            throw error;
          }
        ),
    },
  });

  await cancelled.promise;
  await turns();
  // Still waiting for the timeline node in flight.
  assert.equal(rejectedAt, null, "failed before its node in flight settled");
  releaseTimeline.resolve();
  const langgraph = await running;
  cancellation.dispose();
  // It failed only after the timeline node had ended.
  assert.equal(rejectedAt, 4);

  assertMatchesNativeGolden("cancelled-at-gate", langgraph.observed);
  assert.equal(langgraph.observed.outcome.error.code, "AGENT_CLIENT_CANCELLED");
  assert.deepEqual(
    langgraph.observed.steps.map(({ id, status }) => ({ id, status })),
    [
      { id: "custom_skill:compare", status: "completed" },
      { id: "custom_skill:timeline", status: "completed" },
    ]
  );
  // risk launched nothing: no step, no call, no budget.
  assert.equal(langgraph.observed.budget.used.customSkillCalls, 2);
  assert.equal(langgraph.probe.journal.some(({ skillId }) => skillId === "risk_review"), false);
});

test("parity: a graph whose every node is reused finishes even for a cancelled request", async () => {
  // Nothing is left to launch, so no safe point is reached: the executor
  // returns the reused result without starting an invocation that a drain
  // could stop (the native loop returned it without a pass).
  const buildGraph = () => {
    const probe = createProbe();
    const skills = [
      createScriptedSkill({ id: "compare_documents", probe }),
      createScriptedSkill({ id: "risk_review", probe }),
    ];

    return {
      graph: createExecutionGraph({
        nodes: [
          graphNode({ nodeId: "compare", skillId: "compare_documents" }),
          graphNode({ dependsOn: ["compare"], nodeId: "risk", skillId: "risk_review" }),
        ],
      }),
      probe,
      skills,
    };
  };
  const seedOn = (execute) => {
    const seed = buildGraph();

    return execute({
      accessScope,
      authorizedDocIds: [...DOC_IDS],
      budgetState: createAgentBudget(),
      docIds: [...DOC_IDS],
      executeObservedSkill: createAgentSkillTracker({
        budgetState: createAgentBudget(),
        selectedSkills: [],
      }).executeObservedSkill,
      graph: seed.graph,
      question: QUESTION,
      registry: createSkillRegistry(seed.skills),
    });
  };
  // The seed's masked result is the native seed's (the golden), so the
  // reused node runs are the ones the native scenario reused.
  const seeded = await seedOn(runExecutionGraphOnLangGraph);
  const completedNodeRuns = seeded.nodeRuns;

  assert.equal(seeded.ok, true);
  assertMatchesNativeGolden("all-reused-cancelled-seed", mask(seeded));

  const { langgraph } = await assertParity({
    golden: "all-reused-cancelled",
    level: "executor",
    build: () => {
      const scenario = buildGraph();
      const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });

      cancellation.cancel(REQUEST_CANCELLATION_REASONS.clientCancelled);

      return {
        ...scenario,
        completedNodeRuns,
        wrap: async (work) => {
          try {
            return await runWithRequestCancellation(cancellation, work);
          } finally {
            cancellation.dispose();
          }
        },
      };
    },
  });

  assert.deepEqual(
    langgraph.observed.outcome.result.nodeRuns.map(({ status }) => status),
    ["reused", "reused"]
  );
  assert.deepEqual(langgraph.probe.journal, []);
  assert.equal(langgraph.langGraphRecord, null);
});

test("known difference: a cancellation before a superstep of skips stops LangGraph, the native loop records them", async () => {
  // Pinned, not removed (docs/adr/0001-langgraph-runtime.md): the drain
  // stops at the superstep boundary, and every node checks the request on
  // entry. The native loop reaches a safe point only when it launches, so a
  // node it can settle without launching (here a false condition) is
  // settled and the graph completed. Both end with the same completed node
  // and the same step; the LangGraph run fails with the cancellation.
  const probe = createProbe();
  const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });
  const skills = [
    createScriptedSkill({
      id: "compare_documents",
      outputSchema: {
        ...CUSTOM_RAG_SKILL_CONTRACT.outputSchema,
        proceed: { required: true, type: SKILL_VALUE_TYPES.boolean },
      },
      probe,
      respond: async (context) => {
        cancellation.cancel(REQUEST_CANCELLATION_REASONS.clientCancelled);
        return { ...answer("compare_documents", context), proceed: false };
      },
    }),
    createScriptedSkill({ id: "risk_review", probe }),
  ];

  const langgraph = await runExecutorScenario({
    scenario: {
      graph: createExecutionGraph({
        nodes: [
          graphNode({ nodeId: "compare", skillId: "compare_documents" }),
          graphNode({
            dependsOn: ["compare"],
            nodeId: "risk",
            skillId: "risk_review",
            when: { equals: true, nodeId: "compare", output: "proceed" },
          }),
        ],
        version: "v2",
      }),
      probe,
      skills,
      wrap: async (work) => {
        try {
          return await runWithRequestCancellation(cancellation, work);
        } finally {
          cancellation.dispose();
        }
      },
    },
  });

  assert.equal(langgraph.observed.outcome.error.code, "AGENT_CLIENT_CANCELLED");

  // Against the native run as frozen: it completed, and recorded the same
  // steps, events, trace, Skill calls, budget and settled nodes.
  const goldenName = "known-difference-cancellation-before-skips";
  const frozen = readGolden(goldenName);

  assert.deepEqual(
    frozen.outcome.result.nodeRuns.map(({ reason, status }) => ({ reason, status })),
    [
      { reason: null, status: "completed" },
      { reason: "condition_not_met", status: "skipped" },
    ]
  );
  for (const key of ["steps", "events", "trace", "journal", "budget", "settled"]) {
    assert.deepStrictEqual(canonical(langgraph.observed[key]), frozen[key], `golden ${goldenName}: ${key}`);
  }
});

// ---------------------------------------------------------------------------
// LangSmith
// ---------------------------------------------------------------------------

test("the LangGraph runtime refuses to run while LangSmith tracing is on, before anything is written", async () => {
  for (const variable of ["LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING"]) {
    // At the executor's entry.
    const probe = createProbe();
    const skills = [createScriptedSkill({ id: "risk_review", probe })];
    const { agentRunService, runCursor } = await createRunHarness({ skills });
    const before = await agentRunService.getRun({ accessScope, runId: RUN_ID });

    await withEnv({ [variable]: "true" }, () =>
      assert.rejects(
        runExecutionGraphOnLangGraph({
          accessScope,
          agentRunId: RUN_ID,
          agentRunService,
          authorizedDocIds: [...DOC_IDS],
          budgetState: createAgentBudget(),
          docIds: [...DOC_IDS],
          executeObservedSkill: async () => assert.fail("no Skill may run"),
          graph: createExecutionGraph({
            nodes: [graphNode({ nodeId: "risk", skillId: "risk_review" })],
          }),
          question: QUESTION,
          registry: createSkillRegistry(skills),
          runCursor,
          stepLifecycle: createAgentRunStepLifecycle({
            accessScope,
            agentRunService,
            runCursor,
            runId: RUN_ID,
          }),
        }),
        { code: LANGSMITH_TRACING_ENABLED_CODE }
      )
    );

    const after = await agentRunService.getRun({ accessScope, runId: RUN_ID });

    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.steps, []);

    // At the stage, before the graph checkpoint exists.
    const staged = await withEnv({ [variable]: "true" }, () =>
      runStageScenario({
        scenario: {
          nodes: [graphNode({ nodeId: "risk", skillId: "risk_review" })],
          probe,
          skills,
        },
      })
    );

    assert.equal(staged.observed.outcome.error.code, LANGSMITH_TRACING_ENABLED_CODE);
    assert.equal(staged.observed.checkpoint, null);
    assert.deepEqual(staged.observed.steps, []);
    assert.equal(staged.langGraphRecord, null);
    assert.deepEqual(probe.journal, []);
  }
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("the concurrency gate admits in arrival order, caps holders, and runs an exclusive holder alone", async () => {
  const gate = createExecutionGraphConcurrencyGate(2);
  const granted = [];
  const acquire = (name, exclusive = false) =>
    gate.acquire({ exclusive }).then((release) => {
      granted.push(name);
      return release;
    });

  const a = acquire("a");
  const b = acquire("b");
  const w = acquire("w", true);
  const c = acquire("c");

  await turns(2);
  assert.deepEqual(granted, ["a", "b"]);
  assert.equal(gate.waiting, 2);

  (await a)();
  await turns(2);
  // w is next and exclusive: it waits for b, and c may not overtake it.
  assert.deepEqual(granted, ["a", "b"]);

  const releaseB = await b;

  releaseB();
  releaseB();
  await turns(2);
  assert.deepEqual(granted, ["a", "b", "w"]);
  assert.equal(gate.active, 1);

  (await w)();
  await turns(2);
  assert.deepEqual(granted, ["a", "b", "w", "c"]);
  (await c)();
  assert.equal(gate.active, 0);
  assert.equal(gate.maxActive, 2);
  assert.throws(() => createExecutionGraphConcurrencyGate(0), TypeError);
});

// ---------------------------------------------------------------------------
// Typed outputs never reach LangGraph state
// ---------------------------------------------------------------------------

test("a typed output that carries a boolean flag reaches dependants through the graph checkpoint only", async () => {
  // A node whose output schema adds a field a condition reads: the flag is
  // bound in-process from the validated output, and LangGraph only sees the
  // digest of it.
  const { langgraph } = await assertParity({
    golden: "typed-output-flag",
    level: "executor",
    build: () => {
      const probe = createProbe();
      const gateSkill = createScriptedSkill({
        id: "risk_review",
        outputSchema: {
          ...CUSTOM_RAG_SKILL_CONTRACT.outputSchema,
          proceed: { required: true, type: SKILL_VALUE_TYPES.boolean },
        },
        probe,
        respond: async (context) => ({ ...answer("risk_review", context), proceed: true }),
      });

      return {
        graph: createExecutionGraph({
          nodes: [
            graphNode({ nodeId: "gate", skillId: "risk_review" }),
            graphNode({
              dependsOn: ["gate"],
              nodeId: "follow",
              skillId: "extract_timeline",
              when: { equals: true, nodeId: "gate", output: "proceed" },
            }),
          ],
          version: "v2",
        }),
        probe,
        skills: [gateSkill, createScriptedSkill({ id: "extract_timeline", probe })],
      };
    },
  });

  assert.deepEqual(
    langgraph.observed.outcome.result.nodeRuns.map(({ status }) => status),
    ["completed", "completed"]
  );
  assertRecordHoldsNoText(langgraph.langGraphRecord, ["answered", "proceed"]);
});

// ---------------------------------------------------------------------------
// Queue order: the layer-order queue, and skip turns
// ---------------------------------------------------------------------------

const queueOf = ({ graph, skills }) => {
  const registry = createSkillRegistry(skills);
  const admission = admitExecutionGraphRun({
    authorizedDocIds: [...DOC_IDS],
    authorizedSkillIds: skills.map((skill) => skill.id),
    docIds: [...DOC_IDS],
    graph,
    registry,
  });

  assert.equal(admission.rejected, null);

  const { states } = createExecutionGraphNodeStates({ graph, registry });

  return orderExecutionGraphNodeStatesByLayer({ compiled: admission.compiled, states }).map(
    (state) => state.node.nodeId
  );
};

// Phase 5 (docs/adr/0001-langgraph-runtime.md). Until then this place pinned
// canScheduleExecutionGraphOnLangGraph: which graphs LangGraph could schedule
// with the native queue's decisions (declared in layer order, or never
// holding a ready node back), the rest being handed to the native scheduler.
// Both schedulers now queue in the validator's layer order, which makes that
// predicate true for every graph admission accepts, so it and the hand-over
// were removed. What is pinned instead is the shared queue itself.
test("the scheduler queues the nodes in the validator's layer order, declaration order within a layer", () => {
  const probe = createProbe();
  const skills = ["risk_review", "extract_timeline", "summarize_contract", "compare_documents"].map(
    (id) => createScriptedSkill({ id, probe })
  );
  const writer = createScriptedSkill({
    effects: SKILL_EFFECTS.workspaceWrite,
    id: "publish_report",
    probe,
  });
  const risk = graphNode({ nodeId: "risk", skillId: "risk_review" });
  const timeline = graphNode({ nodeId: "timeline", skillId: "extract_timeline" });
  const summary = graphNode({ dependsOn: ["risk"], nodeId: "summary", skillId: "summarize_contract" });
  const compare = graphNode({
    dependsOn: ["summary", "timeline"],
    nodeId: "compare",
    skillId: "compare_documents",
  });
  const publish = graphNode({ nodeId: "publish", skillId: "publish_report" });
  const queue = (nodes) =>
    queueOf({ graph: createExecutionGraph({ nodes, version: "v2" }), skills: [...skills, writer] });

  // Declared in layer order: the queue is the declaration.
  assert.deepEqual(queue([risk, timeline, summary, compare]), ["risk", "timeline", "summary", "compare"]);
  assert.deepEqual(queue([publish, risk, summary]), ["publish", "risk", "summary"]);
  // The graphs that used to be handed to the native scheduler: a forward
  // reference, a later layer declared before an earlier one, a node behind
  // an exclusive one. A later layer never comes first.
  assert.deepEqual(queue([summary, risk, timeline]), ["risk", "timeline", "summary"]);
  assert.deepEqual(queue([risk, summary, timeline]), ["risk", "timeline", "summary"]);
  assert.deepEqual(queue([risk, summary, timeline, compare]), ["risk", "timeline", "summary", "compare"]);
  assert.deepEqual(queue([compare, summary, timeline, risk]), ["timeline", "risk", "summary", "compare"]);
  assert.deepEqual(queue([risk, summary, publish]), ["risk", "publish", "summary"]);
  // Ids resolve as the validator's (trimmed); the states keep them as written.
  assert.deepEqual(
    queue([
      graphNode({ dependsOn: ["risk"], nodeId: " summary", skillId: "summarize_contract" }),
      graphNode({ nodeId: "risk ", skillId: "risk_review" }),
    ]),
    ["risk ", " summary"]
  );

  // A compiled order that does not belong to the states is refused.
  const graph = createExecutionGraph({ nodes: [risk, summary], version: "v2" });
  const { states } = createExecutionGraphNodeStates({ graph, registry: createSkillRegistry(skills) });

  for (const order of [["risk"], ["risk", "summary", "timeline"], ["risk", "risk"], ["risk", "other"]]) {
    assert.throws(
      () => orderExecutionGraphNodeStatesByLayer({ compiled: { order }, states }),
      /compiled order does not match/
    );
  }
});

// The scenarios that used to be handed to the native scheduler (cap 1, a
// later layer declared first, under budget or fail_fast pressure). This test
// pinned the hand-over: the native journal (risk, then summary, which the
// declaration-order queue reached first) and no LangGraph record. It now pins
// the phase-5 behaviour: LangGraph schedules them itself (its thread holds a
// receipt for every node), the parity check is the same exact
// deepStrictEqual as before, and the native journal is the layer order
// (risk, timeline, then summary). That is the native behaviour change for a
// graph not declared in layer order: the budget now funds timeline instead of
// summary, and a fail_fast summary no longer aborts timeline, which already
// ran.
test("parity: a graph whose declaration order puts a later layer first runs on LangGraph in layer order, as natively", async () => {
  for (const order of ["forward_reference", "later_layer_first"]) {
    for (const pressure of ["budget", "fail_fast"]) {
      const { langgraph } = await assertParity({
        golden: `later-layer-first-${order}-${pressure}`,
        level: "executor",
        build: () => {
          const probe = createProbe();
          const skills = [
            createScriptedSkill({ id: "risk_review", probe }),
            createScriptedSkill({ id: "extract_timeline", probe }),
            createScriptedSkill({
              id: "summarize_contract",
              probe,
              ...(pressure === "fail_fast"
                ? {
                    respond: async () => {
                      throw new Error("summary failed");
                    },
                  }
                : {}),
            }),
          ];
          const risk = graphNode({ nodeId: "risk", skillId: "risk_review" });
          const timeline = graphNode({ nodeId: "timeline", skillId: "extract_timeline" });
          const summary = graphNode({
            dependsOn: ["risk"],
            failurePolicy: pressure === "fail_fast"
              ? EXECUTION_GRAPH_FAILURE_POLICIES.failFast
              : EXECUTION_GRAPH_FAILURE_POLICIES.continue,
            nodeId: "summary",
            skillId: "summarize_contract",
          });

          return {
            budget: { maxCustomSkillCalls: pressure === "budget" ? 2 : 8 },
            graph: createExecutionGraph({
              nodes: order === "forward_reference"
                ? [summary, risk, timeline]
                : [risk, summary, timeline],
            }),
            maxConcurrency: 1,
            probe,
            skills,
          };
        },
      });
      const label = `${order}/${pressure}`;
      const expected = {
        risk: "completed",
        summary: pressure === "budget" ? "skipped/budget_exhausted" : "failed",
        timeline: "completed",
      };

      assert.deepEqual(
        langgraph.observed.journal.filter(({ event }) => event === "start").map(({ skillId }) => skillId),
        pressure === "budget"
          ? ["risk_review", "extract_timeline"]
          : ["risk_review", "extract_timeline", "summarize_contract"],
        label
      );
      assert.deepEqual(
        Object.fromEntries(
          langgraph.observed.outcome.result.nodeRuns.map(({ nodeId, reason, status }) => [
            nodeId,
            reason ? `${status}/${reason}` : status,
          ])
        ),
        expected,
        label
      );

      // Scheduled by LangGraph, not handed over: only LangGraph writes the
      // thread, and it holds every node's receipt.
      const { receipts } = await readThread(langgraph.agentRunService);

      assert.deepEqual(
        Object.fromEntries(
          Object.entries(receipts).map(([nodeId, { reason, status }]) => [
            nodeId,
            reason ? `${status}/${reason}` : status,
          ])
        ),
        expected,
        label
      );
    }
  }
});

// Every validator-accepted shape of one five-node graph runs on LangGraph
// with native-equal results: each of the 120 declaration orders, with the
// queue held back by the cap (cap 1) or by exclusivity (every node a
// workspace write, cap 3), and with no pressure, a budget that funds three
// nodes, or a fail_fast failure in the middle layer. Nothing runs beside
// anything else here, so the races of the superstep barrier (known
// differences 1 and 2) cannot happen and the comparison is assertParity's
// exact one; known difference 3 is the only one a sequential graph could
// show, and it does not (skillRunOrder "exact" holds for all of them).
test("parity: every declaration order of a five-node graph runs on LangGraph in layer order, held back by the cap or by exclusivity", async () => {
  const permutations = (items) =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, index) =>
          permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
            item,
            ...rest,
          ])
        );
  const SKILLS = {
    compare: "compare_documents",
    review: "timeline_review",
    risk: "risk_review",
    summary: "summarize_contract",
    timeline: "extract_timeline",
  };
  const DEPENDS_ON = {
    compare: ["summary", "review"],
    review: ["timeline"],
    risk: [],
    summary: ["risk"],
    timeline: [],
  };
  const LAYERS = [["risk", "timeline"], ["summary", "review"], ["compare"]];
  // The queue: layer by layer, declaration order within a layer.
  const queueFor = (declared) =>
    LAYERS.flatMap((layer) => declared.filter((nodeId) => layer.includes(nodeId)));
  // What the layer-order queue does, one node at a time.
  const expectOutcome = ({ declared, pressure }) => {
    const queue = queueFor(declared);

    if (pressure === "budget") {
      // Budget 3: the first three of the queue; the fourth (the other node
      // of the middle layer) is not funded, so compare has a skipped
      // dependency.
      return Object.fromEntries(
        queue.map((nodeId, index) => [
          nodeId,
          index < 3
            ? "completed"
            : nodeId === "compare"
              ? "skipped/dependency_skipped"
              : "skipped/budget_exhausted",
        ])
      );
    }

    if (pressure === "fail_fast") {
      // summary fails fast: what the queue has behind it is aborted, and
      // compare has a failed dependency.
      const failedAt = queue.indexOf("summary");

      return Object.fromEntries(
        queue.map((nodeId, index) => [
          nodeId,
          index < failedAt
            ? "completed"
            : nodeId === "summary"
              ? "failed"
              : nodeId === "compare"
                ? "skipped/dependency_failed"
                : "skipped/aborted_after_failure",
        ])
      );
    }

    return Object.fromEntries(queue.map((nodeId) => [nodeId, "completed"]));
  };
  const describeNodeRuns = (nodeRuns) =>
    Object.fromEntries(
      nodeRuns.map(({ nodeId, reason, status }) => [nodeId, reason ? `${status}/${reason}` : status])
    );
  let scenarios = 0;

  for (const declared of permutations(LAYERS.flat())) {
    for (const holdBack of ["cap", "exclusive"]) {
      for (const pressure of ["none", "budget", "fail_fast"]) {
        const label = `${declared.join(",")}/${holdBack}/${pressure}`;
        const { langgraph } = await assertParity({
          // 720 scenarios: their goldens are digests only, plus the full
          // goldens of the reversed declaration below.
          golden: `five-node-sweep:${label}`,
          goldenDigest: true,
          level: "executor",
          build: () => {
            const probe = createProbe();

            return {
              budget: { maxCustomSkillCalls: pressure === "budget" ? 3 : 8 },
              graph: createExecutionGraph({
                nodes: declared.map((nodeId) =>
                  graphNode({
                    dependsOn: DEPENDS_ON[nodeId],
                    failurePolicy: pressure === "fail_fast" && nodeId === "summary"
                      ? EXECUTION_GRAPH_FAILURE_POLICIES.failFast
                      : EXECUTION_GRAPH_FAILURE_POLICIES.continue,
                    nodeId,
                    skillId: SKILLS[nodeId],
                  })
                ),
              }),
              maxConcurrency: holdBack === "cap" ? 1 : 3,
              probe,
              skills: Object.entries(SKILLS).map(([nodeId, id]) =>
                createScriptedSkill({
                  ...(holdBack === "exclusive" ? { effects: SKILL_EFFECTS.workspaceWrite } : {}),
                  id,
                  probe,
                  ...(pressure === "fail_fast" && nodeId === "summary"
                    ? {
                        respond: async () => {
                          throw new Error("summary failed");
                        },
                      }
                    : {}),
                })
              ),
            };
          },
        });
        const outcome = expectOutcome({ declared, pressure });

        if (declared.join(",") === [...LAYERS.flat()].reverse().join(",")) {
          // A handful of full goldens beside the digests: every later layer
          // declared first, under each hold-back and pressure.
          const example = `five-node-sweep-reversed-${holdBack}-${pressure}`;

          assertMatchesNativeGolden(example, langgraph.observed);
        }

        assert.equal(langgraph.probe.maxActive, 1, label);
        assert.deepEqual(
          langgraph.observed.journal.filter(({ event }) => event === "start").map(({ skillId }) => skillId),
          queueFor(declared)
            .filter((nodeId) => outcome[nodeId] === "completed" || outcome[nodeId] === "failed")
            .map((nodeId) => SKILLS[nodeId]),
          label
        );
        assert.deepEqual(describeNodeRuns(langgraph.observed.outcome.result.nodeRuns), outcome, label);
        // Node runs keep declaration order.
        assert.deepEqual(
          langgraph.observed.outcome.result.nodeRuns.map(({ nodeId }) => nodeId),
          declared,
          label
        );
        // LangGraph scheduled it: its thread holds every node's receipt.
        assert.deepEqual(
          describeNodeRuns(
            Object.entries((await readThread(langgraph.agentRunService)).receipts).map(
              ([nodeId, receipt]) => ({ nodeId, ...receipt })
            )
          ),
          outcome,
          label
        );
        scenarios += 1;
      }
    }
  }

  assert.equal(scenarios, 120 * 2 * 3);
});

test("a graph not declared in layer order runs on a fresh LangGraph thread after the run's earlier one is dropped", async () => {
  // As after a replan: the run already holds the thread of a graph LangGraph
  // ran, and the next graph is not declared in layer order. Until phase 5
  // this pinned that such a call went to the native scheduler and left no
  // record (the earlier thread was dropped first). It is now scheduled on
  // LangGraph in layer order: the earlier thread is still dropped before the
  // new invocation (no receipt of `first` survives), and the new thread holds
  // the second graph's receipts. Under the cap of 1, `c` (layer 0) now runs
  // before `b` (layer 1), where the declaration-order queue ran b first.
  const probe = createProbe();
  const skills = ["risk_review", "extract_timeline", "summarize_contract"].map((id) =>
    createScriptedSkill({ id, probe })
  );
  const { agentRunService, runCursor } = await createRunHarness({ skills });
  const budgetState = createAgentBudget({ maxCustomSkillCalls: 8 });
  const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });
  const run = (graph) =>
    runExecutionGraphOnLangGraph({
      accessScope,
      agentRunId: RUN_ID,
      agentRunService,
      authorizedDocIds: [...DOC_IDS],
      budgetState,
      docIds: [...DOC_IDS],
      executeObservedSkill: tracker.executeObservedSkill,
      graph,
      maxConcurrency: 1,
      question: QUESTION,
      ragService: {},
      recordSkillResult: tracker.recordSkillResult,
      recordSkippedSkill: tracker.recordSkippedSkill,
      registry: createSkillRegistry(skills),
      runCursor,
      sessionId: SESSION_ID,
      stepLifecycle: createAgentRunStepLifecycle({
        accessScope,
        agentRunService,
        runCursor,
        runId: RUN_ID,
      }),
      userId: USER_ID,
    });

  const first = await run(createExecutionGraph({
    nodes: [graphNode({ nodeId: "first", skillId: "risk_review" })],
  }));

  assert.equal(first.status, "completed");
  assert.deepEqual(Object.keys((await readThread(agentRunService)).receipts), ["first"]);

  const second = await run(createExecutionGraph({
    nodes: [
      graphNode({ dependsOn: ["a"], nodeId: "b", skillId: "summarize_contract" }),
      graphNode({ nodeId: "a", skillId: "extract_timeline" }),
      graphNode({ nodeId: "c", skillId: "risk_review" }),
    ],
  }));

  assert.equal(second.status, "completed");
  assert.deepEqual(second.nodeRuns.map(({ nodeId }) => nodeId), ["b", "a", "c"]);

  const thread = await readThread(agentRunService);

  assert.deepEqual(Object.keys(thread.receipts).sort(), ["a", "b", "c"]);
  assert.deepEqual(
    Object.values(thread.receipts).map(({ status }) => status),
    ["completed", "completed", "completed"]
  );
  assert.deepEqual(
    probe.journal.filter(({ event }) => event === "start").map(({ skillId }) => skillId),
    ["risk_review", "extract_timeline", "risk_review", "summarize_contract"]
  );
});

test("parity: a skip is recorded where the native pass reaches it, never ahead of a node the cap holds back", async () => {
  // Cap 1. Once `x` failed, the native pass starts `a`, and only the pass
  // after `a` reaches `b` (it starts) and then `c` (skipped: its dependency
  // failed). LangGraph enters a, b and c together; c takes its turn behind
  // b, so its skip comes after a ran and b started, as natively.
  const { langgraph } = await assertParity({
    golden: "skip-at-native-pass",
    level: "executor",
    build: () => {
      const probe = createProbe();
      const skills = [
        createScriptedSkill({ id: "risk_review", probe }),
        createScriptedSkill({
          id: "extract_timeline",
          probe,
          respond: async () => {
            throw new Error("timeline failed");
          },
        }),
        createScriptedSkill({ id: "compare_documents", probe }),
        createScriptedSkill({ id: "summarize_contract", probe }),
        createScriptedSkill({ id: "timeline_review", probe }),
      ];

      return {
        graph: createExecutionGraph({
          nodes: [
            graphNode({ nodeId: "y", skillId: "risk_review" }),
            graphNode({ nodeId: "x", skillId: "extract_timeline" }),
            graphNode({ dependsOn: ["y"], nodeId: "a", skillId: "compare_documents" }),
            graphNode({ dependsOn: ["y"], nodeId: "b", skillId: "summarize_contract" }),
            graphNode({ dependsOn: ["x"], nodeId: "c", skillId: "timeline_review" }),
          ],
        }),
        maxConcurrency: 1,
        probe,
        skills,
      };
    },
  });

  assert.deepEqual(
    langgraph.observed.skillRuns.map(({ skillId, status }) => `${skillId}:${status}`),
    [
      "risk_review:completed",
      "extract_timeline:failed",
      "compare_documents:completed",
      "timeline_review:skipped",
      "summarize_contract:completed",
    ]
  );
});

test("parity: a dependency written with surrounding spaces leaves its node pending, as natively", async () => {
  // The validator resolves ids trimmed and accepts these graphs; the node
  // code looks dependencies up as written, so natively the dependant never
  // counts its dependency as settled. LangGraph must compile the graph (its
  // edges resolve as the validator's) and come to the same result.
  for (const [spacedCase, nodeId, dependencyId] of [
    ["spaced-dependency", "risk", " risk "],
    ["spaced-node", " risk ", "risk"],
  ]) {
    const { langgraph } = await assertParity({
      golden: spacedCase,
      level: "executor",
      build: () => {
        const probe = createProbe();

        return {
          graph: createExecutionGraph({
            nodes: [
              graphNode({ nodeId, skillId: "risk_review" }),
              graphNode({ dependsOn: [dependencyId], nodeId: "timeline", skillId: "extract_timeline" }),
            ],
          }),
          probe,
          skills: [
            createScriptedSkill({ id: "risk_review", probe }),
            createScriptedSkill({ id: "extract_timeline", probe }),
          ],
        };
      },
    });

    assert.equal(langgraph.observed.outcome.result.status, "partial");
    assert.deepEqual(
      langgraph.observed.outcome.result.nodeRuns.map(({ status }) => status),
      ["completed", "pending"]
    );
    assert.deepEqual(
      Object.values((await readThread(langgraph.agentRunService)).receipts).map(({ status }) => status),
      ["completed", "pending"]
    );
  }
});

test("known difference: a dependant starts only after the slowest node of the superstep before it", async () => {
  // Pinned, not removed: `summary` depends only on the fast `timeline`. The
  // native loop starts it while the slow `risk` still runs; LangGraph enters
  // it once the whole superstep (risk included) has finished. Every node
  // still runs and settles the same way; what changes is the order of
  // Skill calls, steps, run events and observations, the latency, and the
  // per-Skill budgetDelta, which counts the budget other nodes reserved
  // while that Skill ran.
  const probe = createProbe();
  const summaryDone = createDeferred();
  const skills = [
    createScriptedSkill({
      id: "risk_review",
      probe,
      respond: async (context) => {
        // Natively summary finished meanwhile; on LangGraph it cannot start
        // before this returns, so the wait ends after a bounded number of
        // turns instead.
        await Promise.race([summaryDone.promise, turns(50)]);
        await turns(1);
        return answer("risk_review", context);
      },
    }),
    createScriptedSkill({ id: "extract_timeline", probe }),
    createScriptedSkill({
      id: "summarize_contract",
      probe,
      respond: async (context) => {
        summaryDone.resolve();
        return answer("summarize_contract", context);
      },
    }),
  ];

  const langgraph = await runStageScenario({
    scenario: {
      maxConcurrency: 3,
      nodes: [
        graphNode({ nodeId: "risk", skillId: "risk_review" }),
        graphNode({ nodeId: "timeline", skillId: "extract_timeline" }),
        graphNode({ dependsOn: ["timeline"], nodeId: "summary", skillId: "summarize_contract" }),
      ],
      probe,
      skills,
    },
  });

  const order = (run) => run.observed.journal.map(({ event, skillId }) => `${event}:${skillId}`);
  const NATIVE_ORDER = [
    "start:risk_review",
    "start:extract_timeline",
    "end:extract_timeline",
    "start:summarize_contract",
    "end:summarize_contract",
    "end:risk_review",
  ];

  assert.deepEqual(order(langgraph), [
    "start:risk_review",
    "start:extract_timeline",
    "end:extract_timeline",
    "end:risk_review",
    "start:summarize_contract",
    "end:summarize_contract",
  ]);
  const withoutBudgetDelta = (run) =>
    sortSkillRuns(run.observed).skillRuns.map(({ budgetDelta, ...skillRun }) => skillRun);
  const budgetDeltas = (run) =>
    Object.fromEntries(
      run.observed.skillRuns.map(({ budgetDelta, skillId }) => [skillId, budgetDelta])
    );

  assert.deepStrictEqual(budgetDeltas(langgraph), {
    extract_timeline: {},
    risk_review: {},
    summarize_contract: {},
  });
  // The same events apart from their order (an event id is its position).
  const eventSet = (run) =>
    run.observed.events.map(({ eventId, ...event }) => JSON.stringify(event)).sort();

  // Against the native run as frozen: the same outcome, recorded in another
  // order; natively summary reserved its call while risk ran.
  const golden = { observed: readGolden("known-difference-slowest-superstep") };
  const observed = { observed: canonical(langgraph.observed) };

  assert.deepEqual(order(golden), NATIVE_ORDER);
  assert.deepStrictEqual(observed.observed.checkpoint.nodeRuns, golden.observed.checkpoint.nodeRuns);
  assert.deepStrictEqual(withoutBudgetDelta(observed), withoutBudgetDelta(golden));
  assert.deepStrictEqual(budgetDeltas(golden), {
    extract_timeline: {},
    risk_review: { customSkillCalls: 1 },
    summarize_contract: {},
  });
  assert.notDeepStrictEqual(observed.observed.events, golden.observed.events);
  assert.deepStrictEqual(eventSet(observed), eventSet(golden));
  assert.deepEqual(
    golden.observed.checkpoint.nodeRuns.map(({ status }) => status),
    ["completed", "completed", "completed"]
  );
});

test("known difference: a budget that cannot fund every node funds what the superstep barrier reaches first", async () => {
  // Pinned, not removed: the same race as fail_fast. `risk` is slow; the
  // native loop funds `timeline`'s chain (follow-up, then summary) while
  // risk runs, so `escalate` (after risk) finds the budget spent. LangGraph
  // funds the whole second superstep (escalate and follow-up) first, so
  // summary finds it spent. Native funded escalate too whenever risk finished
  // first. (This test never compared the runtimes: each had its own literal
  // expectation, and native's went with it: escalate skipped, summary
  // completed.)
  const probe = createProbe();
  const summaryDone = createDeferred();
  const skills = [
    createScriptedSkill({
      id: "risk_review",
      probe,
      respond: async (context) => {
        await Promise.race([summaryDone.promise, turns(50)]);
        await turns(1);
        return answer("risk_review", context);
      },
    }),
    createScriptedSkill({ id: "extract_timeline", probe }),
    createScriptedSkill({ id: "compare_documents", probe }),
    createScriptedSkill({ id: "timeline_review", probe }),
    createScriptedSkill({
      id: "summarize_contract",
      probe,
      respond: async (context) => {
        summaryDone.resolve();
        return answer("summarize_contract", context);
      },
    }),
  ];

  const langgraph = await runExecutorScenario({
    scenario: {
      budget: { maxCustomSkillCalls: 4 },
      graph: createExecutionGraph({
        nodes: [
          graphNode({ nodeId: "risk", skillId: "risk_review" }),
          graphNode({ nodeId: "timeline", skillId: "extract_timeline" }),
          graphNode({ dependsOn: ["risk"], nodeId: "escalate", skillId: "compare_documents" }),
          graphNode({ dependsOn: ["timeline"], nodeId: "follow_up", skillId: "timeline_review" }),
          graphNode({ dependsOn: ["follow_up"], nodeId: "summary", skillId: "summarize_contract" }),
        ],
      }),
      maxConcurrency: 3,
      probe,
      skills,
    },
  });

  const statuses = (run) =>
    Object.fromEntries(
      run.observed.outcome.result.nodeRuns.map(({ nodeId, reason, status }) => [
        nodeId,
        reason ? `${status}/${reason}` : status,
      ])
    );

  assert.deepEqual(statuses(langgraph), {
    escalate: "completed",
    follow_up: "completed",
    risk: "completed",
    summary: "skipped/budget_exhausted",
    timeline: "completed",
  });
  assert.equal(langgraph.observed.budget.used.customSkillCalls, 4);
});

test("the gate's turns hold no slot, wait behind a held-back start, and decide before the starts resume", async () => {
  const gate = createExecutionGraphConcurrencyGate(1);
  const order = [];
  const release = await gate.acquire();

  // Nothing ahead of it: the turn is taken at once, with the cap reached.
  assert.equal(await gate.awaitTurn(() => "free"), "free");

  const blocked = gate.acquire().then((releaseBlocked) => {
    order.push("start resumed");
    return releaseBlocked;
  });
  const turn = gate.awaitTurn(() => {
    order.push("turn decided");
    return "decided";
  });

  await turns(2);
  // Behind a start the cap holds back, the turn waits with it.
  assert.deepEqual(order, []);
  assert.equal(gate.waiting, 2);

  release();
  // Decided in the same turn as the start ahead of it was granted, before
  // that start resumed.
  assert.deepEqual(order, ["turn decided"]);
  assert.equal(await turn, "decided");

  const releaseBlocked = await blocked;

  assert.deepEqual(order, ["turn decided", "start resumed"]);
  releaseBlocked();

  // An exclusive holder: nothing is decided beside it.
  const releaseExclusive = await gate.acquire({ exclusive: true });
  let decidedBeside = false;
  const afterExclusive = gate.awaitTurn(() => {
    decidedBeside = true;
  });

  await turns(2);
  assert.equal(decidedBeside, false);
  releaseExclusive();
  await afterExclusive;
  assert.equal(decidedBeside, true);

  // A turn whose decision throws rejects, and the gate keeps going.
  await assert.rejects(
    gate.awaitTurn(() => {
      throw new Error("decision failed");
    }),
    /decision failed/
  );
  assert.equal(gate.active, 0);
  assert.equal(gate.waiting, 0);
});

// ---------------------------------------------------------------------------
// Fences on a live graph
// ---------------------------------------------------------------------------

// The stage over a two-node graph (risk after compare) on a fresh store,
// started but not awaited. `hooks` reach into the run while it is live.
const startFencedStage = async ({ onCheckpointSaved = async () => {}, skills }) => {
  const store = createInMemoryAgentRunStore();
  const agentRunService = createAgentRunService({ agentRunStore: store });
  const registry = createSkillRegistry(skills);

  await agentRunService.createRun({
    accessScope,
    goal: QUESTION,
    input: { docIds: [...DOC_IDS], sessionId: SESSION_ID, userId: USER_ID },
    plan: {
      mode: SKILL_CHAIN_MODE,
      selectedSkills: skills.map((skill) => ({ skillId: skill.id, skillVersion: skill.version })),
    },
    runId: RUN_ID,
  });
  await agentRunService.appendRunEvent({
    accessScope,
    payload: { planner: { stepIds: ["custom_skills"] } },
    runId: RUN_ID,
    type: "execution_planned",
  });

  const budgetState = createAgentBudget({ maxCustomSkillCalls: 3 });
  const tracker = createAgentSkillTracker({ budgetState, selectedSkills: [] });
  const outcome = settleOutcome(() =>
    runCustomSkillStage({
      accessScope,
      authorizedCustomSkills: skills,
      authorizedDocIds: [...DOC_IDS],
      budgetState,
      buildSkillTraceDetail: tracker.buildSkillTraceDetail,
      customSkills: skills,
      docIds: [...DOC_IDS],
      executeObservedSkill: tracker.executeObservedSkill,
      loadExecutionGraphCheckpoint: () =>
        agentRunService.getExecutionGraphCheckpoint({ accessScope, runId: RUN_ID }),
      mode: CUSTOM_SKILL_STAGE_MODES.guarded,
      plan: { mode: SKILL_CHAIN_MODE },
      plannerAdapter: {
        createExecutionGraph: () => ({
          nodes: [
            graphNode({ nodeId: "compare", skillId: "compare_documents" }),
            graphNode({ dependsOn: ["compare"], nodeId: "risk", skillId: "risk_review" }),
          ],
        }),
        id: "parity_planner",
      },
      question: QUESTION,
      ragService: {},
      recordSkillResult: tracker.recordSkillResult,
      recordSkippedSkill: tracker.recordSkippedSkill,
      registry,
      saveExecutionGraphCheckpoint: async (checkpoint) => {
        await agentRunService.saveExecutionGraphCheckpoint({
          accessScope,
          checkpoint,
          runId: RUN_ID,
        });
        await onCheckpointSaved(checkpoint);
      },
      sessionId: SESSION_ID,
      stepLifecycle: createAgentRunStepLifecycle({ accessScope, agentRunService, runId: RUN_ID }),
      userId: USER_ID,
    })
  );

  // Another worker's view of the same rows.
  return { other: createAgentRunService({ agentRunStore: store }), outcome };
};

test("a recovery claim between supersteps stops the stale worker before its next node, at its next thread write", async () => {
  // compare has settled and its node run is durable; before risk starts, a
  // recovery worker claims the graph. The native scheduler stopped the stale
  // worker by the fenced start of risk's step ("Execution graph node
  // transition conflicts with the persisted graph owner."). LangGraph stops
  // it one write earlier: it records compare's superstep in the run's thread
  // before risk can be entered, and that write is fenced on the same claim.
  // risk never starts.
  const probe = createProbe();
  const compareSaved = createDeferred();
  const release = createDeferred();
  const skills = [
    createScriptedSkill({ id: "compare_documents", probe }),
    createScriptedSkill({ id: "risk_review", probe }),
  ];
  const { other, outcome } = await startFencedStage({
    onCheckpointSaved: async (checkpoint) => {
      if (checkpoint.nodeRuns.length === 1) {
        compareSaved.resolve();
        await release.promise;
      }
    },
    skills,
  });

  await compareSaved.promise;

  const loaded = await other.getExecutionGraphCheckpoint({ accessScope, runId: RUN_ID });
  const claim = await other.claimExecutionGraphResume({
    accessScope,
    checkpointDigest: loaded.checkpoint.digest,
    runId: RUN_ID,
  });

  assert.equal(claim.claimed, true);
  release.resolve();

  const { error } = await outcome;
  const run = await other.getRun({ accessScope, runId: RUN_ID });

  assert.equal(error?.code, "AGENT_GRAPH_EXECUTION_FENCED");
  assert.deepEqual(
    probe.journal.filter(({ event }) => event === "start").map(({ skillId }) => skillId),
    ["compare_documents"]
  );
  assert.deepEqual(run.steps.map(({ id, status }) => `${id}:${status}`), ["custom_skill:compare:completed"]);
  // Which fence fired.
  assert.equal(error.message, "LangGraph checkpoint writer does not own the run's running graph.");
});

test("parity: manual recovery while a node runs fences that node's settlement, as natively", async () => {
  // compare is inside its Skill when an operator takes the run. Its
  // completion is the stale worker's next write, the fenced step settlement
  // (as it was natively); LangGraph never records the superstep.
  const probe = createProbe();
  const compareStarted = createDeferred();
  const release = createDeferred();
  const skills = [
    createScriptedSkill({
      id: "compare_documents",
      probe,
      respond: async (context) => {
        compareStarted.resolve();
        await release.promise;
        return answer("compare_documents", context);
      },
    }),
    createScriptedSkill({ id: "risk_review", probe }),
  ];
  const { other, outcome } = await startFencedStage({ skills });

  await compareStarted.promise;

  const marked = await other.markManualRecovery({
    accessScope,
    recovery: { reason: "operator_required" },
    runId: RUN_ID,
  });

  assert.equal(marked.marked, true);
  release.resolve();

  const { error } = await outcome;
  const run = await other.getRun({ accessScope, runId: RUN_ID });
  // Every receipt LangGraph holds for the run, committed or pending.
  const saver = new RunStoreCheckpointSaver({ accessScope, agentRunService: other, runId: RUN_ID });
  const receiptKeys = [];
  let threadCheckpoints = 0;

  for await (const tuple of saver.list({ configurable: { thread_id: saver.threadId } })) {
    threadCheckpoints += 1;
    receiptKeys.push(...Object.keys(tuple.checkpoint.channel_values?.receipts ?? {}));

    for (const [, channel, value] of tuple.pendingWrites ?? []) {
      if (channel === "receipts") {
        receiptKeys.push(...Object.keys(value ?? {}));
      }
    }
  }

  const result = mask({
    error,
    events: run.events.map(({ eventId, ...event }) => event),
    starts: probe.journal.filter(({ event }) => event === "start").map(({ skillId }) => skillId),
    status: run.status,
    steps: run.steps.map(({ id, status }) => `${id}:${status}`),
  });

  assertMatchesNativeGolden("manual-recovery-fences-settlement", result);
  assert.equal(result.error.code, "AGENT_GRAPH_EXECUTION_FENCED");
  assert.equal(
    result.error.message,
    "Execution graph node transition conflicts with the persisted graph owner."
  );
  assert.deepEqual(result.steps, ["custom_skill:compare:running"]);
  assert.deepEqual(result.starts, ["compare_documents"]);
  // LangGraph recorded nothing of compare: its receipt never reached the
  // thread, committed or pending, once the run was taken.
  assert.ok(threadCheckpoints > 0);
  assert.deepEqual(receiptKeys, []);
});

// ---------------------------------------------------------------------------
// A node's preflight grant (ported from the phase-0 spike)
// ---------------------------------------------------------------------------

test("parity: only a Capability's preflight may park or reject a node; the same answer for a custom Skill stops the run before its budget, step or call", async () => {
  // The node code (agent-execution-graph-node.js) refuses a preflight answer
  // for anything but a Capability: a custom Skill can be neither parked for
  // approval nor failed by a preflight. Both answers stop the run with the
  // same error as natively, after the upstream node settled and before
  // the refused node reserved budget, opened a step or called its Skill.
  for (const answer of [
    { awaitingApproval: true },
    { rejectedInput: new Error("not a Capability") },
  ]) {
    const label = Object.keys(answer)[0];
    const { langgraph } = await assertParity({
      golden: `preflight-${label}`,
      level: "executor",
      build: () => {
        const probe = createProbe();
        const preflights = [];

        return {
          graph: createExecutionGraph({
            nodes: [
              graphNode({ nodeId: "compare", skillId: "compare_documents" }),
              graphNode({ dependsOn: ["compare"], nodeId: "risk", skillId: "risk_review" }),
            ],
          }),
          preflightNode: ({ node }) => {
            preflights.push(node.nodeId);
            return node.nodeId === "risk" ? answer : null;
          },
          preflights,
          probe,
          skills: [
            createScriptedSkill({ id: "compare_documents", probe }),
            createScriptedSkill({ id: "risk_review", probe }),
          ],
        };
      },
    });

    assert.equal(
      langgraph.observed.outcome.error?.message,
      "Only a trusted Capability preflight may provide node runtime grants.",
      label
    );
    assert.deepEqual(
      langgraph.probe.journal.filter(({ event }) => event === "start").map(({ skillId }) => skillId),
      ["compare_documents"],
      label
    );
    assert.equal(langgraph.observed.budget.used.customSkillCalls, 1, label);
    assert.deepEqual(
      langgraph.observed.steps.map(({ id, status }) => ({ id, status })),
      [{ id: "custom_skill:compare", status: "completed" }],
      label
    );
  }
});

// ---------------------------------------------------------------------------
// Pinned LangGraph 1.5.0 behaviour the executor is built around (ported from
// the phase-0 spike). These pin the library, not this code: they say why
// run-execution-graph.js passes LangGraph a maxConcurrency equal to the node
// count and holds the runtime cap in its own gate (concurrency-gate.js). If
// a LangGraph upgrade makes either one fail, the defect is gone and the
// workaround can be re-evaluated; until then the parity tests above prove
// the workaround.
// ---------------------------------------------------------------------------

const createWideGraph = ({ calls, failFirst = null }) => {
  const node = (name) => async () => {
    calls[name] = (calls[name] ?? 0) + 1;
    // A real await, so every task is genuinely in flight at once.
    await new Promise((resolve) => setImmediate(resolve));
    if (name === failFirst && calls[name] === 1) {
      throw new Error("first attempt fails");
    }
    return { receipts: { [name]: "ok" } };
  };
  const State = Annotation.Root({
    receipts: Annotation({ default: () => ({}), reducer: (left, right) => ({ ...left, ...right }) }),
  });

  return new StateGraph(State)
    .addNode("a", node("a"))
    .addNode("b", node("b"))
    .addNode("c", node("c"))
    .addNode("d", node("d"))
    .addNode("join", node("join"))
    .addEdge(START, "a")
    .addEdge(START, "b")
    .addEdge(START, "c")
    .addEdge(START, "d")
    .addEdge(["a", "b", "c", "d"], "join")
    .addEdge("join", END)
    .compile({ checkpointer: new MemorySaver() });
};

test("pinned LangGraph 1.5.0 defect: maxConcurrency 1 below a superstep's width ends the step after one task and invoke resolves as if finished", async () => {
  const calls = {};
  const app = createWideGraph({ calls });
  const config = {
    configurable: { thread_id: "langgraph-pin:width-1" },
    durability: "sync",
    maxConcurrency: 1,
  };

  const output = await app.invoke({ receipts: {} }, config);

  // b, c, d and join never ran, no error was raised, and even a's receipt is
  // missing from the result.
  assert.deepStrictEqual(calls, { a: 1 });
  assert.deepStrictEqual(output.receipts, {});
  assert.deepStrictEqual((await app.getState(config)).next, ["b", "c", "d"]);
});

test("pinned LangGraph 1.5.0 defect: with maxConcurrency below the width, a failing task gets its unstarted siblings committed as __no_writes__, and a resume never runs them", async () => {
  const run = async (maxConcurrency) => {
    const calls = {};
    const app = createWideGraph({ calls, failFirst: "a" });
    const config = {
      configurable: { thread_id: `langgraph-pin:width-fail-${maxConcurrency ?? "none"}` },
      durability: "sync",
      ...(maxConcurrency ? { maxConcurrency } : {}),
    };

    await assert.rejects(app.invoke({ receipts: {} }, config), /first attempt fails/);
    const firstCalls = { ...calls };
    const resumed = await app.invoke(null, config);
    return { calls, firstCalls, resumed, next: (await app.getState(config)).next };
  };

  const throttled = await run(2);
  assert.deepStrictEqual(throttled.firstCalls, { a: 1, b: 1 });
  // c and d never ran in either invoke; join never fired; nothing is "next".
  assert.deepStrictEqual(throttled.calls, { a: 2, b: 2 });
  assert.deepStrictEqual(Object.keys(throttled.resumed.receipts).sort(), ["a", "b"]);
  assert.deepStrictEqual(throttled.next, []);

  // Unthrottled, every sibling had started, so each got an error write and
  // the resume ran the whole superstep and the join. This is what the
  // executor relies on (it passes maxConcurrency = node count and caps in
  // its gate).
  const unthrottled = await run(undefined);
  assert.deepStrictEqual(unthrottled.firstCalls, { a: 1, b: 1, c: 1, d: 1 });
  assert.deepStrictEqual(unthrottled.calls, { a: 2, b: 2, c: 2, d: 2, join: 1 });
  assert.equal(unthrottled.resumed.receipts.join, "ok");
});
