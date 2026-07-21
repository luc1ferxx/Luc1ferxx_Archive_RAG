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

test("finalization flow preserves comparison conclusions backed by the matching analysis", async () => {
  const trace = [];
  const response = await finalizeAgentRun({
    addTraceStep: (step) => trace.push(step),
    buildAgentObservability: ({ agentMode }) => ({ agentMode }),
    customSkillResults: [],
    customSkills: [],
    documentRagSkill: {
      id: "document_rag",
      version: "1.0.0",
      label: "Document RAG",
    },
    getAgentSkills: () => [],
    getBudgetSnapshot: () => ({ used: { documentRagCalls: 1 } }),
    plan: { mode: "document" },
    question: "Compare the remote work policies.",
    ragResult: {
      ok: true,
      value: {
        text: [
          "No evidence-backed material differences were found across the selected documents based on the retrieved evidence. [Source 1] [Source 2]",
          "Employees may work remotely 2 days per week with manager approval. [Source 1] [Source 2]",
        ].join("\n"),
        comparisonAnalysisSummary: {
          comparedDocIds: ["doc-alpha", "doc-beta"],
          explicitConflictPairs: [],
          shouldShortCircuitNoMaterialDifference: true,
        },
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            excerpt:
              "Employees may work remotely 2 days per week with manager approval.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            excerpt:
              "Employees may work remotely 2 days per week with manager approval.",
          },
        ],
        abstained: false,
      },
    },
    recordAgentTrace: async () => {},
    recordWorkingMemoryClaimSupport: () => {},
    researchBrief: null,
    shouldRunWeb: false,
    skippedWebBecauseBudget: false,
    trace,
    webResult: null,
    workingMemory: {},
  });

  assert.equal(response.status, 200);
  assert.match(
    response.body.agentAnswer,
    /No evidence-backed material differences were found/i
  );
  assert.equal(
    trace.find((step) => step.type === "answer_finalizer")?.detail.changed,
    false
  );
});

test("finalization flow preserves comparison conclusions from a later custom skill result", async () => {
  const trace = [];
  const response = await finalizeAgentRun({
    addTraceStep: (step) => trace.push(step),
    buildAgentObservability: ({ agentMode }) => ({ agentMode }),
    customSkillResults: [
      {
        ok: true,
        skillId: "extract_timeline",
        skillVersion: "1.0.0",
        label: "Extract Timeline",
        text: "Employees may work remotely 2 days per week with manager approval. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            excerpt:
              "Employees may work remotely 2 days per week with manager approval.",
          },
        ],
        value: {},
      },
      {
        ok: true,
        skillId: "compare_documents",
        skillVersion: "1.0.0",
        label: "Compare Documents",
        text: [
          "No evidence-backed material differences were found across the selected documents based on the retrieved evidence. [Source 1] [Source 2]",
          "Employees may work remotely 2 days per week with manager approval. [Source 1] [Source 2]",
        ].join("\n"),
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            excerpt:
              "Employees may work remotely 2 days per week with manager approval.",
          },
          {
            rank: 2,
            docId: "doc-beta",
            excerpt:
              "Employees may work remotely 2 days per week with manager approval.",
          },
        ],
        value: {
          comparisonAnalysisSummary: {
            comparedDocIds: ["doc-alpha", "doc-beta"],
            explicitConflictPairs: [],
            shouldShortCircuitNoMaterialDifference: true,
          },
        },
      },
    ],
    customSkills: [],
    docIds: ["doc-alpha", "doc-beta"],
    getAgentSkills: () => [],
    getBudgetSnapshot: () => ({ used: { customSkillCalls: 2 } }),
    plan: { mode: "skill_chain" },
    question: "Build a timeline and compare project changes.",
    recordAgentTrace: async () => {},
    recordWorkingMemoryClaimSupport: () => {},
    recordWorkingMemoryGaps: () => {},
    researchBrief: null,
    shouldRunWeb: false,
    skippedWebBecauseBudget: false,
    trace,
    webResult: null,
    workingMemory: {},
  });

  assert.equal(response.status, 200);
  assert.match(
    response.body.agentAnswer,
    /No evidence-backed material differences were found/i
  );
  assert.equal(
    trace.find((step) => step.type === "answer_finalizer")?.detail.changed,
    false
  );
});

test("finalization hydrates rebased custom source ranks without exposing full evidence", async () => {
  const trace = [];
  const response = await finalizeAgentRun({
    addTraceStep: (step) => trace.push(step),
    buildAgentObservability: ({ agentMode }) => ({ agentMode }),
    customSkillResults: [
      {
        ok: true,
        skillId: "extract_timeline",
        skillVersion: "1.0.0",
        label: "Extract Timeline",
        text: "Alpha requires archive-owner approval. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-alpha",
            chunkIndex: 1,
            excerpt: "Alpha background without the approval rule.",
          },
        ],
        value: {
          retrievedContexts: [
            {
              rank: 1,
              docId: "doc-alpha",
              chunkIndex: 1,
              text: "Alpha requires archive-owner approval.",
            },
          ],
        },
      },
      {
        ok: true,
        skillId: "risk_review",
        skillVersion: "1.0.0",
        label: "Risk Review",
        text: "Beta requires security-owner approval. [Source 1]",
        citations: [
          {
            rank: 1,
            docId: "doc-beta",
            chunkIndex: 2,
            excerpt: "Beta background without the approval rule.",
          },
        ],
        value: {
          retrievedContexts: [
            {
              rank: 1,
              docId: "doc-beta",
              chunkIndex: 2,
              text: "Beta requires security-owner approval.",
            },
          ],
        },
      },
    ],
    customSkills: [],
    docIds: ["doc-alpha", "doc-beta"],
    getAgentSkills: () => [],
    getBudgetSnapshot: () => ({ used: { customSkillCalls: 2 } }),
    plan: { mode: "skill_chain" },
    question: "Review both policies.",
    recordAgentTrace: async () => {},
    recordWorkingMemoryClaimSupport: () => {},
    recordWorkingMemoryGaps: () => {},
    researchBrief: null,
    shouldRunWeb: false,
    skippedWebBecauseBudget: false,
    trace,
    webResult: null,
    workingMemory: {},
  });

  assert.equal(response.status, 200);
  assert.match(response.body.agentAnswer, /archive-owner approval/i);
  assert.match(response.body.agentAnswer, /security-owner approval/i);
  assert.deepEqual(
    response.body.ragSources.map((citation) => citation.rank),
    [1, 2]
  );
  assert.ok(
    response.body.ragSources.every(
      (citation) => citation.evidenceText === undefined
    )
  );
  assert.equal(
    trace.find((step) => step.label === "Final Self Check")?.status,
    "completed"
  );
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
