import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChatResponseSummary,
  buildPlannerResponseSummary,
  getAgentMode,
  getAgentObservability,
  getAgentWorkingMemory,
  getClarification,
  getExecutionPlanner,
  getObservedSkill,
  getRunPhases,
  getSelectedSkillIds,
  getSkillChainIds,
  getTraceTypes,
  hasAgentObservability,
  hasTraceStep,
} from "../evaluation/chat-response-contract.js";

const buildResponse = () => ({
  status: 200,
  body: {
    agentMode: "document",
    agentSkills: [
      {
        skillId: "document_rag",
        skillVersion: "1.0.0",
        label: "Document RAG",
      },
    ],
    agentTrace: [
      {
        type: "plan",
      },
      {
        type: "document_rag",
      },
    ],
    agentObservability: {
      executionPlanner: {
        fallback: false,
        requestedPlannerId: "llm",
        selectedPlannerId: "llm",
        status: "selected",
        stepIds: ["document_rag"],
      },
      selectedSkills: [
        {
          skillId: "document_rag",
          skillVersion: "1.0.0",
          label: "Document RAG",
        },
      ],
      skillChain: [
        {
          skillId: "summarize_contract",
          skillVersion: "1.0.0",
          label: "Contract Summary",
        },
      ],
      skills: [
        {
          skillId: "document_rag",
          skillVersion: "1.0.0",
          attempts: 1,
        },
      ],
      runs: [
        {
          skillId: "document_rag",
          phase: "primary",
          status: "completed",
        },
      ],
      executionLoop: {
        followUpsRun: 1,
      },
      budget: {
        used: {
          documentRagCalls: 1,
        },
      },
    },
    agentWorkingMemory: {
      checkedQueries: [{ queryId: "primary" }],
      unresolvedGaps: [{ type: "unsupported_claim" }],
      resolvedGaps: [{ type: "missing_citation" }],
      unsupportedClaims: [{ text: "Unsupported claim." }],
    },
  },
});

test("chat response contract reads wrapped response fields consistently", () => {
  const response = buildResponse();

  assert.equal(hasAgentObservability(response), true);
  assert.equal(getAgentMode(response), "document");
  assert.deepEqual(getTraceTypes(response), ["plan", "document_rag"]);
  assert.equal(hasTraceStep(response, "document_rag"), true);
  assert.deepEqual(getSelectedSkillIds(response), ["document_rag"]);
  assert.deepEqual(getSkillChainIds(response), ["summarize_contract"]);
  assert.equal(getObservedSkill(response, "document_rag").attempts, 1);
  assert.deepEqual(getRunPhases(response, "document_rag"), ["primary"]);
  assert.deepEqual(getExecutionPlanner(response), {
    fallback: false,
    requestedPlannerId: "llm",
    selectedPlannerId: "llm",
    status: "selected",
    stepIds: ["document_rag"],
  });

  const summary = buildChatResponseSummary({
    response,
    telemetry: {
      chatCalls: [{ question: "Review renewal risk." }],
      listDocumentScopes: [{ userId: "user-1" }],
    },
  });

  assert.deepEqual(summary.workingMemory, {
    checkedQueryCount: 1,
    unresolvedGapCount: 1,
    resolvedGapCount: 1,
    unsupportedClaimCount: 1,
  });
  assert.equal(summary.executionLoop.followUpsRun, 1);
  assert.equal(summary.telemetry.chatCallCount, 1);
  assert.equal(summary.telemetry.listDocumentCallCount, 1);
});

test("planner response summary uses the same observability contract", () => {
  const response = buildResponse();
  const summary = buildPlannerResponseSummary({
    response,
    telemetry: {
      chatCalls: [{ question: "Review renewal risk." }],
      listDocumentScopes: [],
    },
  });

  assert.equal(summary.agentMode, "document");
  assert.deepEqual(summary.traceTypes, ["plan", "document_rag"]);
  assert.equal(summary.planner.selectedPlannerId, "llm");
  assert.deepEqual(summary.selectedSkills.map((skill) => skill.skillId), [
    "document_rag",
  ]);
  assert.deepEqual(summary.skillChain.map((skill) => skill.skillId), [
    "summarize_contract",
  ]);
  assert.equal(summary.telemetry.chatCallCount, 1);
});

test("chat response contract treats missing observability as empty", () => {
  const body = {
    agentMode: "rag",
    agentTrace: null,
    agentObservability: null,
  };

  assert.equal(hasAgentObservability(body), false);
  assert.deepEqual(getAgentObservability(body), {});
  assert.equal(getExecutionPlanner(body), null);
  assert.deepEqual(getSelectedSkillIds(body), []);
  assert.deepEqual(getSkillChainIds(body), []);
  assert.deepEqual(getTraceTypes(body), []);
  assert.equal(hasTraceStep(body, "plan"), false);

  const summary = buildChatResponseSummary({
    response: {
      status: 200,
      body,
    },
  });

  assert.equal(summary.agentMode, "rag");
  assert.equal(summary.executionLoop, null);
  assert.deepEqual(summary.workingMemory, {
    checkedQueryCount: 0,
    unresolvedGapCount: 0,
    resolvedGapCount: 0,
    unsupportedClaimCount: 0,
  });
});

test("chat response contract summarizes clarification and error payloads", () => {
  const response = {
    status: 200,
    body: {
      agentTrace: [
        {
          type: "clarification_gate",
        },
      ],
      agentObservability: {
        agentMode: "clarification",
        executionLoop: {
          stoppedReason: "budget_exhausted",
        },
      },
      agentWorkingMemory: {
        checkedQueries: "not-an-array",
        unresolvedGaps: [
          {
            type: "missing_citation",
          },
        ],
      },
      clarification: {
        needed: true,
        reason: "document_follow_up_budget_exhausted",
        question: "Which section should I inspect?",
      },
      errors: {
        rag: "Document RAG failed.",
        mcp: null,
      },
    },
  };

  assert.equal(getAgentMode(response), "clarification");
  assert.equal(
    getClarification(response).reason,
    "document_follow_up_budget_exhausted"
  );
  assert.deepEqual(getAgentWorkingMemory(response).unresolvedGaps, [
    {
      type: "missing_citation",
    },
  ]);
  assert.equal(hasTraceStep(response, "clarification_gate"), true);

  const summary = buildChatResponseSummary({
    response,
  });

  assert.equal(summary.agentMode, null);
  assert.equal(summary.clarification.needed, true);
  assert.equal(summary.executionLoop.stoppedReason, "budget_exhausted");
  assert.deepEqual(summary.workingMemory, {
    checkedQueryCount: 0,
    unresolvedGapCount: 1,
    resolvedGapCount: 0,
    unsupportedClaimCount: 0,
  });
});
