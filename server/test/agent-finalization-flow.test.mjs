import test from "node:test";
import assert from "node:assert/strict";
import {
  finalizeAgentRun,
  resolveAgentMode,
  selectPrimaryCustomResult,
  selectRagSources,
} from "../rag/agent-finalization-flow.js";

test("finalization flow resolves document_web mode only when document abstains and web succeeds", () => {
  assert.equal(
    resolveAgentMode({
      plan: {
        mode: "document",
      },
      ragResult: {
        ok: true,
        value: {
          abstained: true,
        },
      },
      webResult: {
        ok: true,
        value: {
          text: "Web answer.",
        },
      },
    }),
    "document_web"
  );
  assert.equal(
    resolveAgentMode({
      plan: {
        mode: "document",
      },
      ragResult: {
        ok: true,
        value: {
          abstained: false,
        },
      },
      webResult: {
        ok: true,
      },
    }),
    "document"
  );
});

test("finalization flow selects sources from research, document, then custom skills", () => {
  assert.deepEqual(
    selectRagSources({
      researchBrief: {
        citations: [
          {
            docId: "research",
          },
        ],
      },
    }),
    [
      {
        docId: "research",
      },
    ]
  );
  assert.deepEqual(
    selectRagSources({
      ragResult: {
        ok: true,
        value: {
          citations: [
            {
              docId: "rag",
            },
          ],
        },
      },
    }),
    [
      {
        docId: "rag",
      },
    ]
  );
  assert.deepEqual(
    selectRagSources({
      customSkillResults: [
        {
          ok: true,
          citations: [
            {
              docId: "custom",
            },
          ],
        },
      ],
    }),
    [
      {
        docId: "custom",
      },
    ]
  );
});

test("finalization flow finalizes cited document answers and records agent trace", async () => {
  const trace = [];
  const claimSupportRecords = [];
  const recordedAgentTraces = [];
  const response = await finalizeAgentRun({
    addTraceStep: (step) => trace.push(step),
    buildAgentObservability: ({ agentMode }) => ({
      agentMode,
      planMode: "document",
    }),
    customSkillResults: [],
    customSkills: [],
    discoveryAnswer: null,
    documentRagSkill: {
      id: "document_rag",
      version: "1.0.0",
      label: "Document RAG",
    },
    getAgentSkills: () => [
      {
        skillId: "document_rag",
        status: "completed",
      },
    ],
    getBudgetSnapshot: () => ({
      used: {
        documentRagCalls: 1,
      },
    }),
    inventoryAnswer: null,
    plan: {
      mode: "document",
    },
    question: "What is supported?",
    ragResult: {
      ok: true,
      value: {
        text: "Remote work requires manager approval. The stipend is 500 dollars. [Source 1]",
        citations: [
          {
            docId: "doc-1",
            excerpt: "Remote work requires manager approval.",
          },
        ],
        memoryApplied: false,
        resolvedQuery: "What is supported?",
        abstained: false,
      },
    },
    recordAgentTrace: async (event) => recordedAgentTraces.push(event),
    recordWorkingMemoryClaimSupport: (record) => claimSupportRecords.push(record),
    researchBrief: null,
    shouldRunWeb: false,
    skippedWebBecauseBudget: false,
    trace,
    webResult: null,
    workingMemory: {},
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, "document");
  assert.doesNotMatch(response.body.agentAnswer, /500 dollars/i);
  assert.deepEqual(
    trace.map((step) => step.type),
    ["synthesis", "answer_finalizer"]
  );
  assert.equal(claimSupportRecords[0].phase, "final");
  assert.equal(recordedAgentTraces[0].agentMode, "document");
  assert.equal(recordedAgentTraces[0].status, 200);
});

test("finalization flow verifies and finalizes research brief answers", async () => {
  const trace = [];
  const claimSupportRecords = [];
  const gapRecords = [];
  const response = await finalizeAgentRun({
    addTraceStep: (step) => trace.push(step),
    buildAgentObservability: ({ agentMode }) => ({
      agentMode,
      planMode: "research_brief",
    }),
    customSkillResults: [],
    customSkills: [],
    docIds: ["doc-1"],
    getAgentSkills: () => [
      {
        skillId: "research_brief",
        status: "completed",
      },
    ],
    getBudgetSnapshot: () => ({
      used: {
        researchQuestions: 2,
      },
    }),
    plan: {
      mode: "research_brief",
    },
    question: "Create a research brief.",
    recordAgentTrace: async () => {},
    recordWorkingMemoryClaimSupport: (record) => claimSupportRecords.push(record),
    recordWorkingMemoryGaps: (record) => gapRecords.push(record),
    researchBrief: {
      text: [
        "Executive Summary",
        "Refunds require 30 days notice. [Source 1]",
        "CFO approval is required for every refund. [Source 1]",
      ].join("\n"),
      citations: [
        {
          docId: "doc-1",
          excerpt: "Refunds require 30 days notice.",
        },
      ],
      findings: [
        {
          abstained: false,
        },
      ],
    },
    shouldRunWeb: false,
    skippedWebBecauseBudget: false,
    trace,
    webResult: null,
    workingMemory: {},
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.agentMode, "research_brief");
  assert.doesNotMatch(response.body.agentAnswer, /CFO approval/i);
  assert.deepEqual(
    trace.map((step) => step.type),
    ["synthesis", "self_check", "gap_analysis", "answer_finalizer"]
  );
  assert.equal(trace[1].detail.claimSupport.unsupportedClaimCount, 1);
  assert.equal(trace[2].detail.gaps[0].type, "unsupported_claim");
  assert.equal(claimSupportRecords[0].phase, "final");
  assert.equal(gapRecords[0].phase, "final");
});

test("finalization flow picks the first successful custom result", () => {
  assert.deepEqual(
    selectPrimaryCustomResult([
      {
        ok: false,
        skillId: "failed",
      },
      {
        ok: true,
        skillId: "risk_review",
      },
    ]),
    {
      ok: true,
      skillId: "risk_review",
    }
  );
});
