import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_SKILL_IDS,
  createBuiltInSkillRegistry,
  executeAgentSkill,
} from "../rag/skills/registry.js";
import {
  hasExplicitExecutionGraphContract,
  validateSkillValues,
} from "../rag/skills/skill-contract.js";

const registry = createBuiltInSkillRegistry();
const documentRag = registry.get(AGENT_SKILL_IDS.documentRag);
const evidenceCheck = registry.get(AGENT_SKILL_IDS.documentEvidenceCheck);
const selectedDocIds = ["doc-a"];
const question = "What does the remote-work policy require?";

const groundedEvidence = () => ({
  text: "Remote work requires manager approval. [Source 1]",
  citations: [{
    docId: "doc-a",
    rank: 1,
    fileName: "policy.pdf",
    pageNumber: 2,
    excerpt: "Remote work requires manager approval.",
  }],
  abstained: false,
  retrievedContexts: [{
    docId: "doc-a",
    rank: 1,
    text: "Remote work requires manager approval.",
  }],
  comparisonAnalysisSummary: null,
});

test("document evidence check is explicitly contracted but never V1-selected", () => {
  assert.equal(hasExplicitExecutionGraphContract(documentRag), true);
  assert.equal(hasExplicitExecutionGraphContract(evidenceCheck), true);
  assert.equal(evidenceCheck.match({ plan: { wantsDocumentRag: true } }), false);
  assert.deepEqual(
    registry.select({
      plan: { wantsDocumentRag: true },
      docIds: selectedDocIds,
    }).map((skill) => skill.id),
    [AGENT_SKILL_IDS.documentRag]
  );
  assert.equal(evidenceCheck.inputSchema.evidence.type, "object");
  assert.equal(documentRag.outputSchema.evidence.type, "object");
  assert.equal(evidenceCheck.outputSchema.followUpRetrievalPlan.type, "object");
  assert.equal(documentRag.inputSchema.retrievalPlan.type, "object");
});

test("document RAG exposes a narrow typed evidence value without replacing its raw value", async () => {
  const rawValue = {
    ...groundedEvidence(),
    evidence: { text: "forged upstream evidence" },
    sessionInternal: "not-bound-to-graph",
  };
  const result = await documentRag.execute({
    ragService: { chat: async () => rawValue },
    docIds: selectedDocIds,
    question,
    accessScope: { userId: "alice", workspaceId: "workspace-a" },
  });

  assert.equal(result.value, rawValue);
  assert.equal(result.text, rawValue.text);
  assert.deepEqual(result.citations, rawValue.citations);
  assert.deepEqual(result.evidence, groundedEvidence());
  assert.equal(Object.hasOwn(result.evidence, "sessionInternal"), false);
  assert.notEqual(result.evidence, rawValue.evidence);
  const validated = validateSkillValues({
    output: result,
    schema: documentRag.outputSchema,
  });
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.output.evidence, result.evidence);
});

test("document RAG rejects a malformed evidence payload before graph binding", async () => {
  await assert.rejects(
    documentRag.execute({
      ragService: {
        chat: async () => ({ text: "answer", citations: "not an array" }),
      },
      docIds: selectedDocIds,
      question,
    }),
    /citations must be an object array/
  );
});

test("document RAG preserves legacy abstention output when citations are absent", async () => {
  const rawValue = { text: "Insufficient evidence.", abstained: true };
  const result = await documentRag.execute({
    ragService: { chat: async () => rawValue },
    docIds: selectedDocIds,
    question,
  });

  assert.equal(result.value, rawValue);
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.evidence.citations, []);
  assert.equal(result.evidence.abstained, true);
});

test("document evidence check verifies grounded citations and emits typed conditions", async () => {
  const result = await executeAgentSkill(evidenceCheck, {
    docIds: selectedDocIds,
    question,
    evidence: groundedEvidence(),
  }, {
    validateOutput: (output) => validateSkillValues({
      output,
      schema: evidenceCheck.outputSchema,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.graphOutput.passed, true);
  assert.equal(result.graphOutput.retryRecommended, false);
  assert.equal(result.graphOutput.followUpQuestion, "");
  assert.equal(Object.hasOwn(result.graphOutput, "followUpRetrievalPlan"), false);
  assert.equal(result.graphOutput.abstained, false);
  assert.equal(result.graphOutput.check.passed, true);
  assert.equal(result.value.text, groundedEvidence().text);
});

test("document evidence check recommends one scoped follow-up for missing support", async () => {
  const result = await evidenceCheck.execute({
    docIds: selectedDocIds,
    question,
    evidence: {
      text: "Remote work requires manager approval.",
      citations: [],
      abstained: false,
    },
  });

  assert.equal(result.passed, false);
  assert.equal(result.retryRecommended, true);
  assert.equal(result.abstained, true);
  assert.match(result.followUpQuestion, /Original question:/);
  assert.match(result.followUpQuestion, /Evidence issue:/);
  assert.equal(result.followUpRetrievalPlan.source, "agent-query-planner");
  assert.equal(result.followUpRetrievalPlan.phase, "follow_up");
  assert.equal(result.followUpRetrievalPlan.retrievalOptions.queryCount, 3);
  assert.deepEqual(
    result.followUpRetrievalPlan.retrievalQueries.map(({ id }) => id),
    ["primary", "follow-up-evidence", "follow-up-source-check"]
  );
  assert.equal(result.followUpRetrievalPlan.retrievalQueries[0].query, result.followUpQuestion.replace(/\s+/g, " ").trim());
  assert.match(result.followUpRetrievalPlan.retrievalQueries[1].query, /lacks citation support/i);
  assert.match(result.followUpRetrievalPlan.retrievalQueries[2].query, /remote-work policy require/i);
  assert.equal(validateSkillValues({
    output: result,
    schema: evidenceCheck.outputSchema,
  }).ok, true);
  assert.deepEqual(
    result.check.gaps.map((gap) => gap.type),
    ["missing_citations", "unsupported_claim"]
  );
});

test("explicit abstention does not schedule a follow-up", async () => {
  const result = await evidenceCheck.execute({
    docIds: selectedDocIds,
    question,
    evidence: {
      text: "Insufficient evidence.",
      citations: [],
      abstained: true,
    },
  });

  assert.equal(result.passed, false);
  assert.equal(result.retryRecommended, false);
  assert.equal(result.followUpQuestion, "");
  assert.equal(Object.hasOwn(result, "followUpRetrievalPlan"), false);
  assert.equal(result.abstained, true);
});

test("document evidence check rejects malformed and out-of-scope evidence", async () => {
  const malformed = [
    null,
    { text: "answer", citations: "not an array", abstained: false },
    { text: 7, citations: [], abstained: false },
    { text: "answer", citations: [null], abstained: false },
    { text: "answer", citations: [], retrievedContexts: "invalid" },
    { text: "answer", citations: [], comparisonAnalysisSummary: "invalid" },
    {
      text: "answer",
      citations: [{ docId: "other-workspace" }],
      abstained: false,
    },
    {
      text: "answer",
      citations: [],
      retrievedContexts: [{ docId: "other-workspace" }],
    },
  ];

  for (const evidence of malformed) {
    await assert.rejects(
      evidenceCheck.execute({ docIds: selectedDocIds, question, evidence }),
      /Document evidence/
    );
  }
  await assert.rejects(
    evidenceCheck.execute({ docIds: [], question, evidence: groundedEvidence() }),
    /requires a question and selected documents/
  );
});
