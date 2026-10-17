// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import assert from "node:assert/strict";
import test from "node:test";

import { runWithAgentEventSink } from "../rag/agent-event-stream.js";
import {
  AGENT_EXECUTION_CONDITIONS,
  AGENT_EXECUTION_STEP_IDS,
  validateAgentExecutionPlan,
} from "../rag/agent-execution-plan.js";
import {
  createAgentExecutionPlanStages,
  isAgentExecutionPlanStageStaticallyInert,
  runAgentExecutionPlan,
} from "../rag/agent-execution-plan-runner.js";
import { runAgentExecutionPlanOnLangGraph } from "../rag/langgraph/execution-plan-graph.js";
import {
  REQUEST_CANCELLATION_REASONS,
  createRequestCancellation,
  runWithRequestCancellation,
} from "../rag/request-deadline.js";
import { AGENT_SKILL_IDS, createDefaultSkillRegistry } from "../rag/skills/registry.js";

// The outer plan on LangGraph does not schedule a built-in stage whose Skill
// was not selected (isAgentExecutionPlanStageStaticallyInert,
// rag/langgraph/execution-plan-graph.js). That is behaviour-free only if
// such a stage body, run natively, does nothing at all. Here every
// collaborator the stage bodies close over -- the step lifecycle (steps and
// run events), the trace callbacks, the budget state, the Skill callbacks,
// the services, the run-store hooks -- is a tripwire that records any
// access, and the agent event sink records any event. Each of the five stages
// must touch none of them, emit nothing, leave the execution state as it was
// built, and look up exactly the Skill id the predicate looks up, through the
// same getSelectedSkill. A positive control shows the tripwires fire once the
// Skill is selected, so the empty records are not vacuous.

const ACCESS_SCOPE = Object.freeze({ userId: "alice", workspaceId: "workspace-a" });
const INERT_STAGES = Object.freeze([
  [AGENT_EXECUTION_STEP_IDS.arxivImport, AGENT_SKILL_IDS.arxivImport, "arxivImportAnswer"],
  [AGENT_EXECUTION_STEP_IDS.workspaceAction, AGENT_SKILL_IDS.workspaceAction, "actionAnswer"],
  [AGENT_EXECUTION_STEP_IDS.researchBrief, AGENT_SKILL_IDS.researchBrief, "researchBrief"],
  [AGENT_EXECUTION_STEP_IDS.inventory, AGENT_SKILL_IDS.inventory, "inventoryAnswer"],
  [AGENT_EXECUTION_STEP_IDS.documentDiscovery, AGENT_SKILL_IDS.documentDiscovery, "discoveryAnswer"],
]);
const RUNTIME_DECIDED_STAGES = Object.freeze([
  AGENT_EXECUTION_STEP_IDS.customSkills,
  AGENT_EXECUTION_STEP_IDS.documentRag,
  AGENT_EXECUTION_STEP_IDS.webSearch,
]);

// A Proxy over `target` recording every trap: a call, a property read or
// write, an `in` check, a key listing. Reading a property of a tripwire hands
// back the real value, so a positive control can proceed (or fail) normally.
const createTripwires = () => {
  const touches = [];
  const record = (entry) => touches.push(entry);
  const make = (name, target = function tripwire() {}) =>
    new Proxy(target, {
      apply(fn, thisArg, args) {
        record(`${name}()`);
        return Reflect.apply(fn, thisArg, args);
      },
      construct(fn, args, newTarget) {
        record(`new ${name}()`);
        return Reflect.construct(fn, args, newTarget);
      },
      defineProperty(object, key, descriptor) {
        record(`${name}.${String(key)}=`);
        return Reflect.defineProperty(object, key, descriptor);
      },
      deleteProperty(object, key) {
        record(`delete ${name}.${String(key)}`);
        return Reflect.deleteProperty(object, key);
      },
      get(object, key, receiver) {
        record(`${name}.${String(key)}`);
        return Reflect.get(object, key, receiver);
      },
      getOwnPropertyDescriptor(object, key) {
        record(`${name}#${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
      has(object, key) {
        record(`${String(key)} in ${name}`);
        return Reflect.has(object, key);
      },
      ownKeys(object) {
        record(`keys(${name})`);
        return Reflect.ownKeys(object);
      },
      set(object, key, value, receiver) {
        record(`${name}.${String(key)}=`);
        return Reflect.set(object, key, value, receiver);
      },
    });

  return { make, touches };
};

// Every option createAgentExecutionPlanStages reads, as a tripwire, except
// the access scope (the LangGraph runner reads it for the thread id, which is
// no effect), the registry and the selected Skills (the plan's validation
// reads both before any stage runs), and the lookup under test.
const createStageOptions = ({ executionPlan, getSelectedSkill }) => {
  const tripwires = createTripwires();
  const { make } = tripwires;
  const options = {
    accessScope: ACCESS_SCOPE,
    addBudgetLimitTrace: make("addBudgetLimitTrace"),
    addTraceStep: make("addTraceStep"),
    agentRunId: "run-pruning",
    arxivImportService: make("arxivImportService", {}),
    budgetState: make("budgetState", { limits: {}, used: {} }),
    buildSkillTraceDetail: make("buildSkillTraceDetail"),
    capabilityRegistry: make("capabilityRegistry", {}),
    dagPlannerAdapter: make("dagPlannerAdapter", {}),
    docIds: make("docIds", ["doc-1"]),
    executeObservedSkill: make("executeObservedSkill"),
    executionLoop: make("executionLoop", {}),
    executionPlan,
    getSelectedSkill,
    loadExecutionGraphCheckpoint: make("loadExecutionGraphCheckpoint"),
    plan: make("plan", { wantsWeb: false }),
    question: "What does remote work require?",
    ragService: make("ragService", {}),
    recordExecutionGaps: make("recordExecutionGaps"),
    recordExecutionGraph: make("recordExecutionGraph"),
    recordSkillResult: make("recordSkillResult"),
    recordSkippedSkill: make("recordSkippedSkill"),
    recordWorkingMemoryClaimSupport: make("recordWorkingMemoryClaimSupport"),
    recordWorkingMemoryGaps: make("recordWorkingMemoryGaps"),
    registry: createDefaultSkillRegistry(),
    replanAdapter: make("replanAdapter", {}),
    resolveWorkingMemoryGaps: make("resolveWorkingMemoryGaps"),
    retrievalPlan: make("retrievalPlan", {}),
    returnClarification: make("returnClarification"),
    saveExecutionGraphCheckpoint: make("saveExecutionGraphCheckpoint"),
    selectedSkills: [],
    sessionId: "session-1",
    stepLifecycle: make("stepLifecycle", {}),
    taskMemory: make("taskMemory", {}),
    userId: "alice",
    webChatService: make("webChatService"),
  };

  return { options, touches: tripwires.touches };
};

// getSelectedSkill as agent-bootstrap.js builds it, recording every lookup.
const createLookup = (selectedSkills = []) => {
  const lookups = [];
  const getSelectedSkill = (skillId) => {
    lookups.push(skillId);
    return selectedSkills.find((skill) => skill.id === skillId) ?? null;
  };

  return { getSelectedSkill, lookups };
};

// The execution state a plan starts from, as createAgentExecutionPlanStages
// builds it for these options (no tripwire is armed by building it).
const buildInitialState = (options) => structuredClone(createAgentExecutionPlanStages(options).state);

const collectAgentEvents = async (work) => {
  const events = [];
  const result = await runWithAgentEventSink((event) => events.push(event), work);

  return { events, result };
};

for (const [stageId, skillId, stateField] of INERT_STAGES) {
  test(`${stageId} without its Skill does nothing at all natively, and the predicate says so through the same lookup`, async () => {
    const executionPlan = [stageId];
    const stateLookup = createLookup();
    const initialState = buildInitialState(
      createStageOptions({ executionPlan, getSelectedSkill: stateLookup.getSelectedSkill }).options
    );
    const { getSelectedSkill, lookups } = createLookup();
    const { options, touches } = createStageOptions({ executionPlan, getSelectedSkill });
    const { executionPlan: validatedPlan, getStage, state } = createAgentExecutionPlanStages(options);
    const [step] = validatedPlan;

    assert.equal(step.condition, AGENT_EXECUTION_CONDITIONS.selectedSkill);
    assert.deepStrictEqual(touches, [], "building the stages touches no collaborator");

    // The stage body exactly as the native loop calls it.
    const { events, result } = await collectAgentEvents(() => getStage(step)(step));

    assert.equal(result, undefined);
    assert.equal(state[stateField], null, "the runner returned null");
    assert.deepStrictEqual(touches, [], "no step, run event, trace step, budget charge or service call");
    assert.deepStrictEqual(events, [], "no agent event");
    assert.deepStrictEqual(state, initialState, "the execution state is unchanged");
    assert.deepStrictEqual(lookups, [skillId], "the stage body looks up its own Skill once");

    // The predicate, over the same options: the same lookup, and inert.
    const predicateLookup = createLookup();

    assert.equal(
      isAgentExecutionPlanStageStaticallyInert(step, {
        ...options,
        getSelectedSkill: predicateLookup.getSelectedSkill,
      }),
      true
    );
    assert.deepStrictEqual(predicateLookup.lookups, lookups);
    assert.deepStrictEqual(touches, []);
  });

  test(`${stageId} with its Skill selected is not inert, and its body then reaches its collaborators (positive control)`, async () => {
    const skill = createDefaultSkillRegistry().get(skillId);
    const executionPlan = [stageId];
    const { getSelectedSkill, lookups } = createLookup([skill]);
    const { options, touches } = createStageOptions({ executionPlan, getSelectedSkill });
    const { executionPlan: validatedPlan, getStage } = createAgentExecutionPlanStages({
      ...options,
      selectedSkills: [skill],
    });
    const [step] = validatedPlan;

    assert.ok(skill, `${skillId} is registered`);
    assert.equal(isAgentExecutionPlanStageStaticallyInert(step, options), false);

    // The tripwires hand back stand-ins, so the body may fail anywhere after
    // its first access; only that it reached a collaborator matters here.
    await collectAgentEvents(() => getStage(step)(step)).catch(() => null);

    assert.ok(touches.length > 0, `${stageId} with its Skill reached no collaborator`);
    assert.ok(lookups.includes(skillId));
  });
}

test("the native loop and the LangGraph runner run a plan of unselected built-in stages without any effect, and return the same state", async () => {
  const executionPlan = INERT_STAGES.map(([stageId]) => stageId);
  const initialState = buildInitialState(
    createStageOptions({ executionPlan, getSelectedSkill: createLookup().getSelectedSkill }).options
  );
  const results = {};

  for (const [runtime, run] of [
    ["native", runAgentExecutionPlan],
    ["langgraph", runAgentExecutionPlanOnLangGraph],
  ]) {
    const { getSelectedSkill, lookups } = createLookup();
    const { options, touches } = createStageOptions({ executionPlan, getSelectedSkill });
    const { events, result } = await collectAgentEvents(() => run(options));

    assert.deepStrictEqual(touches, [], runtime);
    assert.deepStrictEqual(events, [], runtime);
    assert.deepStrictEqual(result, initialState, runtime);
    results[runtime] = { lookups, result };
  }

  // Natively each stage body looks up its Skill. On LangGraph the predicate
  // looks up all five, and the one stage a plan of inert stages keeps (its
  // first) looks its Skill up once more when it runs.
  assert.deepStrictEqual(
    results.native.lookups,
    INERT_STAGES.map(([, skillId]) => skillId)
  );
  assert.deepStrictEqual(results.langgraph.lookups, [
    ...INERT_STAGES.map(([, skillId]) => skillId),
    AGENT_SKILL_IDS.arxivImport,
  ]);
  assert.deepStrictEqual(results.langgraph.result, results.native.result);
});

test("a cancellation before an unselected built-in stage ends both runtimes with the same error and no effect", async () => {
  const executionPlan = INERT_STAGES.map(([stageId]) => stageId);

  for (const reason of Object.values(REQUEST_CANCELLATION_REASONS)) {
    const outcomes = {};

    for (const [runtime, run] of [
      ["native", runAgentExecutionPlan],
      ["langgraph", runAgentExecutionPlanOnLangGraph],
    ]) {
      const { getSelectedSkill } = createLookup();
      const { options, touches } = createStageOptions({ executionPlan, getSelectedSkill });
      const cancellation = createRequestCancellation({ deadlineAt: Date.now() + 60_000 });

      cancellation.cancel(reason);

      const { events, result } = await collectAgentEvents(() =>
        runWithRequestCancellation(cancellation, () => run(options))
          .then(
            () => ({ error: null }),
            (error) => ({ error })
          )
          .finally(cancellation.dispose)
      );

      assert.deepStrictEqual(touches, [], `${runtime} ${reason}`);
      assert.deepStrictEqual(events, [], `${runtime} ${reason}`);
      outcomes[runtime] = {
        code: result.error?.code,
        name: result.error?.name,
        reason: result.error?.reason,
        status: result.error?.status,
      };
    }

    assert.equal(outcomes.native.reason, reason);
    assert.deepStrictEqual(outcomes.langgraph, outcomes.native, reason);
  }
});

test("the predicate is never true for a stage that decides at run time, an unvalidated step, or a lookup it cannot make", () => {
  const plan = validateAgentExecutionPlan({
    accessScope: ACCESS_SCOPE,
    executionPlan: [...INERT_STAGES.map(([stageId]) => stageId), ...RUNTIME_DECIDED_STAGES],
    registry: createDefaultSkillRegistry(),
    selectedSkills: [],
  });
  const nothingSelected = { getSelectedSkill: () => null };

  for (const step of plan) {
    const runtimeDecided = RUNTIME_DECIDED_STAGES.includes(step.id);

    assert.equal(
      isAgentExecutionPlanStageStaticallyInert(step, nothingSelected),
      !runtimeDecided,
      step.id
    );
    // No lookup, or a lookup that throws: the stage runs (and fails) as
    // natively.
    assert.equal(isAgentExecutionPlanStageStaticallyInert(step, {}), false, step.id);
    assert.equal(
      isAgentExecutionPlanStageStaticallyInert(step, {
        getSelectedSkill: () => {
          throw new Error("lookup failed");
        },
      }),
      false,
      step.id
    );
  }

  const [inventoryStep] = plan.filter((step) => step.id === AGENT_EXECUTION_STEP_IDS.inventory);

  // Only a validated step carries the condition the stage body relies on.
  assert.equal(
    isAgentExecutionPlanStageStaticallyInert({ id: inventoryStep.id }, nothingSelected),
    false
  );
  assert.equal(
    isAgentExecutionPlanStageStaticallyInert(
      { ...inventoryStep, condition: AGENT_EXECUTION_CONDITIONS.always },
      nothingSelected
    ),
    false
  );

  for (const id of ["constructor", "__proto__", "toString", "unknown_stage", undefined]) {
    assert.equal(
      isAgentExecutionPlanStageStaticallyInert(
        { condition: AGENT_EXECUTION_CONDITIONS.selectedSkill, id },
        nothingSelected
      ),
      false,
      String(id)
    );
  }

  assert.equal(isAgentExecutionPlanStageStaticallyInert(null, nothingSelected), false);
  assert.equal(isAgentExecutionPlanStageStaticallyInert(undefined), false);
});
