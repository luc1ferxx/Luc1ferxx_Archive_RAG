import {
  getAnswerTraceOverview,
  getAnswerWorkingMemory,
  getObservedSelectedSkills,
} from "./chatResponseContract";

describe("chatResponseContract", () => {
  test("builds the agent trace overview from the shared answer shape", () => {
    const answer = {
      agentSkills: [
        {
          skillId: "document_rag",
          skillVersion: "1.0.0",
          label: "Document RAG",
        },
      ],
      agentObservability: {
        executionPlanner: {
          selectedPlannerId: "llm",
          status: "selected",
        },
        selectedSkills: [
          {
            skillId: "document_rag",
            skillVersion: "1.0.0",
            label: "Document RAG",
          },
        ],
        skills: [
          {
            skillId: "document_rag",
            attempts: 2,
            citationCount: 3,
          },
        ],
        skillChain: [
          {
            skillId: "summarize_contract",
          },
        ],
        executionLoop: {
          followUpsRun: 1,
          gaps: [{ type: "missing_citation" }],
        },
      },
      agentWorkingMemory: {
        checkedQueries: [{ queryId: "primary" }],
        resolvedGaps: [{ type: "missing_citation" }],
        unsupportedClaims: [{ text: "Unsupported claim." }],
      },
      agentTrace: [
        {
          type: "answer_finalizer",
          detail: {
            removedClaims: ["Unsupported claim."],
          },
        },
      ],
    };

    const overview = getAnswerTraceOverview(answer);

    expect(overview.executionPlanner.selectedPlannerId).toBe("llm");
    expect(overview.selectedSkills).toEqual([
      expect.objectContaining({
        skillId: "document_rag",
        attempts: 2,
        citationCount: 3,
      }),
    ]);
    expect(overview.skillChain).toEqual([
      expect.objectContaining({
        skillId: "summarize_contract",
      }),
    ]);
    expect(overview.checkedQueries).toHaveLength(1);
    expect(overview.allGaps).toEqual([{ type: "missing_citation" }]);
    expect(overview.removedClaims).toEqual(["Unsupported claim."]);
  });

  test("falls back to observability working memory and agentSkills", () => {
    const answer = {
      agentSkills: [
        {
          skillId: "inventory",
          label: "Inventory",
        },
      ],
      agentObservability: {
        workingMemory: {
          checkedQueries: [{ queryId: "inventory" }],
        },
      },
    };

    expect(getAnswerWorkingMemory(answer)).toEqual({
      checkedQueries: [{ queryId: "inventory" }],
    });
    expect(getObservedSelectedSkills({ answer })).toEqual([
      {
        skillId: "inventory",
        label: "Inventory",
      },
    ]);
  });
});
