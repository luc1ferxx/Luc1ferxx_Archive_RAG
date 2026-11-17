import test from "node:test";
import assert from "node:assert/strict";
import { createAgentBudget } from "../rag/agent-budget.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";
import {
  runArxivImportSkill,
  runInventorySkill,
  runWorkspaceActionSkill,
} from "../rag/agent-built-in-skill-runners.js";
import { runWebSearchSkill } from "../rag/agent-web-runner.js";
import {
  AGENT_SKILL_IDS,
  createBuiltInSkillRegistry,
} from "../rag/skills/registry.js";

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

test("skill runners record arXiv import budget skip without reaching its gate", async () => {
  const budgetState = createAgentBudget({
    maxArxivPaperFetches: 0,
  });
  const trace = [];
  const tracker = createAgentSkillTracker({
    budgetState,
    selectedSkills: [],
  });
  const arxivImportSkill = createSkill({
    budgetKey: "arxivPaperFetches",
    id: "arxiv_import",
    kind: "built_in",
    label: "arXiv Import",
    execute: async () => {
      throw new Error("arXiv import should not execute.");
    },
  });

  const result = await runArxivImportSkill({
    addBudgetLimitTrace: (step) => trace.push(step),
    arxivImportSkill,
    budgetState,
    buildSkillTraceDetail: tracker.buildSkillTraceDetail,
    executeObservedSkill: tracker.executeObservedSkill,
    question: "Fetch 2 arXiv papers about retrieval augmented generation",
    recordSkippedSkill: tracker.recordSkippedSkill,
    recordSkillResult: tracker.recordSkillResult,
  });

  assert.equal(result, null);
  assert.equal(trace[0].tool, "arXiv Import");
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

// A gated Capability never answers inside the outer plan: the approved
// capability_call step runs it (with its own artifact idempotency key). A
// registry that returns anyway fails the Skill instead of answering.
test("a workspace action whose gated Capability returns without pausing fails with the invariant error", async () => {
  const budgetState = createAgentBudget();
  const trace = [];
  const tracker = createAgentSkillTracker({
    budgetState,
    selectedSkills: [],
  });
  const payloads = [];
  const workspaceActionSkill = createBuiltInSkillRegistry().get(
    AGENT_SKILL_IDS.workspaceAction
  );

  const answer = await runWorkspaceActionSkill({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    addTraceStep: (step) => trace.push(step),
    buildSkillTraceDetail: tracker.buildSkillTraceDetail,
    capabilityRegistry: {
      execute: async (capabilityId, payload) => {
        payloads.push({ capabilityId, payload });

        return {
          text: "Summary saved.",
        };
      },
    },
    docIds: ["doc-1"],
    executeObservedSkill: tracker.executeObservedSkill,
    plan: {
      actionCapabilityId: "summary.create",
    },
    question: "Save a summary.",
    recordSkillResult: tracker.recordSkillResult,
    workspaceActionSkill,
  });

  assert.equal(
    answer,
    "Workspace action unavailable: summary.create requires approval and runs only from the approved capability_call step."
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].capabilityId, "summary.create");
  assert.deepEqual(Object.keys(payloads[0].payload).sort(), ["accessScope", "input"]);
  assert.equal(trace[0].status, "failed");
  assert.equal(trace[0].output, null);
  assert.equal(tracker.getSkillRuns()[0].status, "failed");
});

test("a failed workspace action answers with its failure and records a failed trace", async () => {
  const budgetState = createAgentBudget();
  const trace = [];
  const tracker = createAgentSkillTracker({
    budgetState,
    selectedSkills: [],
  });
  const workspaceActionSkill = createSkill({
    id: "workspace_action",
    kind: "built_in",
    label: "Workspace Action",
    execute: async () => {
      throw new Error("registry unavailable");
    },
  });

  const answer = await runWorkspaceActionSkill({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    addTraceStep: (step) => trace.push(step),
    buildSkillTraceDetail: tracker.buildSkillTraceDetail,
    executeObservedSkill: tracker.executeObservedSkill,
    plan: {
      actionCapabilityId: "summary.create",
    },
    question: "Save a summary.",
    recordSkillResult: tracker.recordSkillResult,
    workspaceActionSkill,
  });

  assert.equal(answer, "Workspace action unavailable: registry unavailable");
  assert.equal(trace[0].status, "failed");
});
