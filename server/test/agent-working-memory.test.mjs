import test from "node:test";
import assert from "node:assert/strict";
import { createAgentWorkingMemory } from "../rag/agent-working-memory.js";

const documentSkill = {
  id: "document_rag",
  version: "1.0.0",
};

test("agent working memory dedupes retrieval queries by normalized text", () => {
  const memory = createAgentWorkingMemory({
    question: "What does remote work require?",
    docIds: ["doc-1"],
    maxFollowUps: 1,
  });

  memory.recordWorkingMemoryQueries({
    skill: documentSkill,
    phase: "primary",
    retrievalPlan: {
      retrievalQueries: [
        {
          id: "primary",
          label: "Original request",
          query: "What does remote work require?",
          primary: true,
        },
        {
          id: "duplicate",
          label: "Duplicate",
          query: "  What does remote work require?  ",
        },
      ],
    },
  });

  assert.deepEqual(
    memory.workingMemory.checkedQueries.map((query) => query.queryId),
    ["primary"]
  );
});

test("agent working memory replaces unsupported claims when later evidence supports them", () => {
  const memory = createAgentWorkingMemory({
    question: "What does remote work require?",
    docIds: ["doc-1"],
    maxFollowUps: 1,
  });

  memory.recordWorkingMemoryClaimSupport({
    skill: documentSkill,
    phase: "primary",
    check: {
      claimSupport: {
        claims: [
          {
            text: "Remote work requires manager approval.",
            supported: false,
            missingAnchors: ["manager"],
          },
        ],
      },
    },
  });
  memory.recordWorkingMemoryClaimSupport({
    skill: documentSkill,
    phase: "follow_up",
    check: {
      claimSupport: {
        claims: [
          {
            text: "Remote work requires manager approval.",
            supported: true,
            anchors: ["manager"],
          },
        ],
      },
    },
  });

  assert.equal(memory.workingMemory.unsupportedClaims.length, 0);
  assert.equal(memory.workingMemory.supportedClaims.length, 1);
  assert.equal(memory.workingMemory.supportedClaims[0].phase, "follow_up");
});

test("agent working memory records and resolves execution gaps by skill", () => {
  const memory = createAgentWorkingMemory({
    question: "What does remote work require?",
    docIds: ["doc-1"],
    maxFollowUps: 1,
  });
  const gaps = memory.recordExecutionGaps({
    skill: documentSkill,
    check: {
      gaps: [
        {
          type: "unsupported_claim",
          claim: "The satellite stipend is 500 dollars.",
        },
      ],
    },
  });

  assert.equal(memory.executionLoop.gapsIdentified, 1);
  assert.equal(gaps[0].skillId, "document_rag");
  assert.equal(memory.workingMemory.unresolvedGaps.length, 1);

  memory.resolveWorkingMemoryGaps({
    skill: documentSkill,
    phase: "follow_up",
  });

  assert.equal(memory.workingMemory.unresolvedGaps.length, 0);
  assert.equal(memory.workingMemory.resolvedGaps.length, 1);
  assert.equal(memory.workingMemory.resolvedGaps[0].resolvedPhase, "follow_up");
});
