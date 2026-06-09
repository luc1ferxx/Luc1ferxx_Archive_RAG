import test from "node:test";
import assert from "node:assert/strict";
import { createAgentBudget } from "../rag/agent-budget.js";
import { createAgentSkillTracker } from "../rag/agent-skill-observability.js";

test("agent skill tracker records selected skill runs and working-memory queries", async () => {
  const recordedQueries = [];
  const skill = {
    id: "document_rag",
    version: "1.0.0",
    label: "Document RAG",
    budgetKey: "documentRagCalls",
    execute: async () => ({
      text: "Remote work requires manager approval.",
      citations: [
        {
          docId: "doc-1",
        },
      ],
      abstained: false,
    }),
  };
  const tracker = createAgentSkillTracker({
    budgetState: createAgentBudget(),
    selectedSkills: [skill],
    recordWorkingMemoryQueries: (event) => recordedQueries.push(event),
  });

  const result = await tracker.executeObservedSkill(
    skill,
    {
      retrievalPlan: {
        retrievalQueries: [
          {
            id: "primary",
            query: "What does remote work require?",
          },
        ],
      },
    },
    {
      phase: "primary",
    }
  );

  tracker.recordSkillResult(result);

  assert.equal(result.skillId, "document_rag");
  assert.equal(recordedQueries.length, 1);
  assert.equal(recordedQueries[0].skill.id, "document_rag");
  assert.deepEqual(tracker.getAgentSkills(), [
    {
      skillId: "document_rag",
      skillVersion: "1.0.0",
      label: "Document RAG",
      status: "completed",
    },
  ]);

  const observation = tracker.getSkillObservations()[0];
  assert.equal(observation.selected, true);
  assert.equal(observation.status, "completed");
  assert.equal(observation.attempts, 1);
  assert.equal(observation.citationCount, 1);
  assert.equal(tracker.getSkillRuns()[0].phase, "primary");
});
