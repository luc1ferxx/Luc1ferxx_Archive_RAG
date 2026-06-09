import test from "node:test";
import assert from "node:assert/strict";
import { createAgentBudget } from "../rag/agent-budget.js";
import { SKILL_CHAIN_MODE } from "../rag/agent-planner.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import { runInventorySkill } from "../rag/agent-built-in-skill-runners.js";
import { runCustomSkills } from "../rag/agent-custom-skill-runner.js";
import { runWebSearchSkill } from "../rag/agent-web-runner.js";

const createSkill = ({
  budgetKey = "customSkillCalls",
  execute,
  id,
  kind = "custom",
  label,
}) => ({
  id,
  version: "1.0.0",
  label,
  budgetKey,
  kind,
  requiresAccessScope: true,
  match: () => true,
  execute,
});

test("skill runners chain custom skill output into the next custom skill question", async () => {
  const budgetState = createAgentBudget();
  const questions = [];
  const trace = [];
  const tracker = createAgentSkillTracker({
    budgetState,
    selectedSkills: [],
  });
  const firstSkill = createSkill({
    id: "summarize_contract",
    label: "Contract Summary",
    execute: async ({ question }) => {
      questions.push(question);

      return {
        text: "Contract renews annually. [Source 1]",
        citations: [
          {
            docId: "doc-1",
          },
        ],
      };
    },
  });
  const secondSkill = createSkill({
    id: "risk_review",
    label: "Risk Review",
    execute: async ({ question }) => {
      questions.push(question);

      return {
        text: "Renewal notice is a risk. [Source 1]",
        citations: [
          {
            docId: "doc-1",
          },
        ],
      };
    },
  });

  const results = await runCustomSkills({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    addTraceStep: (step) => trace.push(step),
    budgetState,
    buildSkillTraceDetail: tracker.buildSkillTraceDetail,
    customSkills: [firstSkill, secondSkill],
    docIds: ["doc-1"],
    executeObservedSkill: tracker.executeObservedSkill,
    plan: {
      mode: SKILL_CHAIN_MODE,
    },
    question: "Review this contract for risks.",
    ragService: {},
    recordSkippedSkill: tracker.recordSkippedSkill,
    recordSkillResult: tracker.recordSkillResult,
    retrievalPlan: {
      retrievalQueries: [
        {
          id: "primary",
          query: "contract risks",
        },
      ],
    },
    sessionId: "session-1",
    userId: "alice",
  });

  assert.equal(results.length, 2);
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(questions[0], "Review this contract for risks.");
  assert.match(questions[1], /Previous skill outputs/i);
  assert.match(questions[1], /Contract renews annually/i);
  assert.deepEqual(
    trace.map((step) => step.type),
    ["custom_skill", "custom_skill"]
  );
  assert.equal(trace[1].detail.previousSkillCount, 1);
  assert.deepEqual(
    tracker.getSkillRuns().map((run) => run.phase),
    ["primary", "primary"]
  );
});

test("skill runners record web search budget skip without executing web skill", async () => {
  const budgetState = createAgentBudget({
    maxWebSearchCalls: 0,
  });
  const trace = [];
  const tracker = createAgentSkillTracker({
    budgetState,
    selectedSkills: [],
  });
  const webSearchSkill = createSkill({
    budgetKey: "webSearchCalls",
    id: "web_search",
    kind: "built_in",
    label: "Web Search",
    execute: async () => {
      throw new Error("Web search should not execute.");
    },
  });

  const result = await runWebSearchSkill({
    addBudgetLimitTrace: (step) => trace.push(step),
    budgetState,
    buildSkillTraceDetail: tracker.buildSkillTraceDetail,
    executeObservedSkill: tracker.executeObservedSkill,
    plannedWebSearchSkill: webSearchSkill,
    question: "What is current?",
    recordSkippedSkill: tracker.recordSkippedSkill,
    recordSkillResult: tracker.recordSkillResult,
    shouldRunWeb: true,
    webChatService: async () => "unused",
    webSearchSkill,
  });

  assert.equal(result.webResult, null);
  assert.equal(result.skippedWebBecauseBudget, true);
  assert.equal(trace[0].tool, "Web Search");
  assert.equal(tracker.getSkillRuns()[0].status, "skipped");
  assert.equal(tracker.getSkillRuns()[0].phase, "primary");
});

test("skill runners return inventory fallback answer and failed trace", async () => {
  const budgetState = createAgentBudget();
  const trace = [];
  const tracker = createAgentSkillTracker({
    budgetState,
    selectedSkills: [],
  });
  const inventorySkill = createSkill({
    budgetKey: null,
    id: "inventory",
    kind: "built_in",
    label: "Workspace Inventory",
    execute: async () => {
      throw new Error("Registry unavailable");
    },
  });

  const answer = await runInventorySkill({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    addTraceStep: (step) => trace.push(step),
    buildSkillTraceDetail: tracker.buildSkillTraceDetail,
    executeObservedSkill: tracker.executeObservedSkill,
    inventorySkill,
    ragService: {},
    recordSkillResult: tracker.recordSkillResult,
  });

  assert.equal(answer, "Workspace inventory unavailable: Registry unavailable");
  assert.equal(trace[0].type, "inventory");
  assert.equal(trace[0].status, "failed");
  assert.match(trace[0].summary, /Workspace inventory failed/i);
});
