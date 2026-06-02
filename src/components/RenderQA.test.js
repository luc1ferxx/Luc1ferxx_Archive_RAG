import { render, screen } from "@testing-library/react";
import RenderQA from "./RenderQA";

describe("RenderQA", () => {
  test("renders agent trace details for plan, evidence checks, budgets, and retry", () => {
    render(
      <RenderQA
        conversation={[
          {
            question: "What does the archive say about renewal timing?",
            answer: {
              agentAnswer: "Renewals should be reviewed before the end date.",
              agentMode: "document",
              agentTrace: [
                {
                  id: "1-plan",
                  type: "plan",
                  label: "Plan",
                  status: "completed",
                  summary: "Use the document workflow.",
                  detail: {
                    mode: "document",
                    docIds: ["doc-1"],
                    actions: [
                      {
                        id: "document_rag",
                        label: "Run document RAG",
                        summary: "Answer from uploaded document chunks.",
                      },
                    ],
                    budget: {
                      limits: {
                        maxDocumentRagCalls: 2,
                        maxWebSearchCalls: 1,
                        maxResearchQuestions: 3,
                        maxTraceSteps: 12,
                      },
                      used: {
                        documentRagCalls: 0,
                        webSearchCalls: 0,
                        researchQuestions: 0,
                        traceSteps: 1,
                      },
                      traceTruncated: false,
                    },
                  },
                },
                {
                  id: "2-self-check",
                  type: "self_check",
                  label: "Self Check",
                  status: "failed",
                  summary: "Evidence check needs attention.",
                  detail: {
                    passed: false,
                    retryRecommended: true,
                    reasons: ["Document answer has no citations."],
                    citationCount: 0,
                    citedDocCount: 0,
                    requiredCitationCount: 1,
                    requiredDocCoverage: 1,
                  },
                },
                {
                  id: "3-budget-limit",
                  type: "budget_limit",
                  label: "Budget Limit",
                  status: "skipped",
                  summary: "Skipped Document retry: document RAG budget exhausted.",
                  detail: {
                    tool: "Document retry",
                    reason: "document RAG budget exhausted.",
                  },
                },
                {
                  id: "4-document-retry",
                  type: "document_retry",
                  label: "Document Retry",
                  status: "completed",
                  summary: "Focused retry returned 1 citation.",
                  detail: {
                    retryQuestion:
                      "Re-check the uploaded documents for cited support before answering.",
                  },
                },
              ],
              ragAnswer: "Document answer",
              ragSources: [],
              mcpAnswer: "Web answer",
            },
          },
        ]}
      />
    );

    expect(screen.getByText("Run document RAG")).toBeInTheDocument();
    expect(screen.getByText("Doc RAG")).toBeInTheDocument();
    expect(screen.getByText("0 / 2")).toBeInTheDocument();
    expect(screen.getByText("Citations")).toBeInTheDocument();
    expect(screen.getByText("Docs")).toBeInTheDocument();
    expect(screen.getAllByText("0 / 1").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Document answer has no citations.")).toBeInTheDocument();
    expect(screen.getByText("document RAG budget exhausted.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Re-check the uploaded documents for cited support before answering."
      )
    ).toBeInTheDocument();
  });

  test("renders document evidence scoring summary", () => {
    render(
      <RenderQA
        conversation={[
          {
            question: "When does the refund policy take effect?",
            answer: {
              ragAnswer: "The refund policy takes effect on July 1, 2026.",
              ragSources: [],
              ragEvidenceSummary: {
                mode: "qa",
                confident: true,
                retrievedCount: 3,
                usableCount: 2,
                scoreRange: {
                  max: 0.91,
                },
                docCoverage: {
                  selectedDocIds: ["refund"],
                  coveredDocIds: ["refund"],
                  missingDocIds: [],
                },
                requirements: [
                  {
                    id: "requirement-1",
                    label: "When does the refund policy take effect",
                    query: "When does the refund policy take effect",
                  },
                  {
                    id: "requirement-2",
                    label: "which regions does the refund policy apply to",
                    query: "which regions does the refund policy apply to",
                  },
                ],
                reasons: ["Evidence passed with 2 usable sources."],
              },
              mcpAnswer: "Web search not used.",
            },
          },
        ]}
      />
    );

    expect(screen.getByText("Evidence")).toBeInTheDocument();
    expect(screen.getByText("Confident")).toBeInTheDocument();
    expect(screen.getByText("Retrieved")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("0.91")).toBeInTheDocument();
    expect(
      screen.getByText("which regions does the refund policy apply to")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Evidence passed with 2 usable sources.")
    ).toBeInTheDocument();
  });
});
