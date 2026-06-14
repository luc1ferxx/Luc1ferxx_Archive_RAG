import { fireEvent, render, screen } from "@testing-library/react";
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
                        maxCustomSkillCalls: 2,
                        maxTraceSteps: 12,
                      },
                      used: {
                        documentRagCalls: 0,
                        webSearchCalls: 0,
                        researchQuestions: 0,
                        customSkillCalls: 0,
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
                    claimSupport: {
                      supportedClaimCount: 0,
                      unsupportedClaimCount: 1,
                      claims: [
                        {
                          text: "The satellite stipend is 500 dollars.",
                          supported: false,
                          missingAnchors: ["500"],
                        },
                      ],
                    },
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
    expect(screen.getByText("Custom")).toBeInTheDocument();
    expect(screen.getAllByText("0 / 2").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Citations")).toBeInTheDocument();
    expect(screen.getByText("Docs")).toBeInTheDocument();
    expect(screen.getAllByText("0 / 1").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Document answer has no citations.")).toBeInTheDocument();
    expect(screen.getByText("Unsupported claims")).toBeInTheDocument();
    expect(
      screen.getByText("The satellite stipend is 500 dollars.")
    ).toBeInTheDocument();
    expect(screen.getByText("Missing anchors: 500")).toBeInTheDocument();
    expect(screen.getByText("document RAG budget exhausted.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Re-check the uploaded documents for cited support before answering."
      )
    ).toBeInTheDocument();
  });

  test("renders agent trace overview for skills, queries, gaps, and finalizer removals", () => {
    render(
      <RenderQA
        conversation={[
          {
            question: "Review renewal risk.",
            answer: {
              agentAnswer: "The agent kept only citation-backed renewal claims.",
              agentMode: "document",
              agentSkills: [
                {
                  skillId: "document_rag",
                  skillVersion: "1.0.0",
                  label: "Document RAG",
                  status: "completed",
                },
              ],
              agentObservability: {
                executionPlanner: {
                  fallback: true,
                  fallbackReason: "Invalid AgentRAG execution plan.",
                  requestedPlannerId: "llm",
                  selectedPlannerId: "deterministic",
                  status: "fallback",
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
                  {
                    skillId: "risk_review",
                    skillVersion: "1.0.0",
                    label: "Risk Review",
                  },
                ],
                skills: [
                  {
                    skillId: "document_rag",
                    skillVersion: "1.0.0",
                    label: "Document RAG",
                    status: "completed",
                    attempts: 2,
                    retryCount: 1,
                    followUpCount: 1,
                    totalDurationMs: 35,
                    citationCount: 2,
                    budgetUsed: 2,
                    budgetLimit: 2,
                  },
                ],
                executionLoop: {
                  followUpsRun: 1,
                  gapsIdentified: 1,
                  stoppedReason: "follow_up_resolved",
                  gaps: [
                    {
                      type: "unsupported_claim",
                      claim: "Automatic renewal notice is 90 days.",
                      skillId: "document_rag",
                      skillVersion: "1.0.0",
                    },
                  ],
                },
              },
              agentWorkingMemory: {
                checkedQueries: [
                  {
                    skillId: "document_rag",
                    skillVersion: "1.0.0",
                    phase: "primary",
                    queryId: "fact-citation",
                    label: "Exact citation evidence",
                    query: "Find exact cited evidence for renewal notice.",
                    primary: false,
                  },
                ],
                unsupportedClaims: [
                  {
                    text: "Automatic renewal notice is 90 days.",
                    missingAnchors: ["90"],
                  },
                ],
                unresolvedGaps: [
                  {
                    type: "unsupported_claim",
                    claim: "Automatic renewal notice is 90 days.",
                    skillId: "document_rag",
                    skillVersion: "1.0.0",
                    phase: "gap_analysis",
                  },
                ],
                resolvedGaps: [
                  {
                    type: "missing_citation",
                    message: "Follow-up found renewal citation.",
                    skillId: "document_rag",
                    skillVersion: "1.0.0",
                    phase: "follow_up",
                  },
                ],
              },
              agentTrace: [
                {
                  id: "1-query-planner",
                  type: "query_planner",
                  label: "Query Planner",
                  status: "completed",
                  summary: "Planned focused retrieval queries.",
                  detail: {
                    source: "agent-query-planner",
                    phase: "primary",
                    intent: "analysis",
                    retrievalQueries: [
                      {
                        id: "analysis-support",
                        label: "Supporting evidence",
                        query:
                          "Find source excerpts that support renewal risk analysis.",
                        primary: false,
                      },
                    ],
                    retrievalOptions: {
                      profile: "broad",
                      topK: 10,
                      topKPerDoc: 4,
                    },
                  },
                },
                {
                  id: "2-gap-analysis",
                  type: "gap_analysis",
                  label: "Gap Analysis",
                  status: "completed",
                  summary: "Identified one unsupported claim.",
                  detail: {
                    skillId: "document_rag",
                    skillVersion: "1.0.0",
                    followUpRecommended: true,
                    gaps: [
                      {
                        type: "unsupported_claim",
                        claim: "Automatic renewal notice is 90 days.",
                        skillId: "document_rag",
                        skillVersion: "1.0.0",
                        missingAnchors: ["90"],
                      },
                    ],
                  },
                },
                {
                  id: "3-answer-finalizer",
                  type: "answer_finalizer",
                  label: "Answer Finalizer",
                  status: "completed",
                  summary: "Removed unsupported claim from the final answer.",
                  detail: {
                    changed: true,
                    abstained: false,
                    removedClaims: ["Automatic renewal notice is 90 days."],
                    claimSupport: {
                      supportedClaimCount: 1,
                      unsupportedClaimCount: 1,
                      claims: [
                        {
                          text: "Automatic renewal notice is 90 days.",
                          supported: false,
                          missingAnchors: ["90"],
                        },
                      ],
                    },
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

    expect(screen.getByText("Agent trace")).toBeInTheDocument();
    expect(screen.getByText("llm -> deterministic")).toBeInTheDocument();
    expect(screen.getAllByText("Selected skills").length).toBeGreaterThan(0);
    expect(screen.getByText("Document RAG@1.0.0")).toBeInTheDocument();
    expect(screen.getByText("Skill chain")).toBeInTheDocument();
    expect(screen.getByText("Contract Summary@1.0.0")).toBeInTheDocument();
    expect(screen.getAllByText("Retrieval queries").length).toBeGreaterThan(0);
    expect(screen.getByText("Exact citation evidence")).toBeInTheDocument();
    expect(
      screen.getByText(/Find exact cited evidence for renewal notice/)
    ).toBeInTheDocument();
    expect(screen.getAllByText("Evidence gaps").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Automatic renewal notice is 90 days.").length
    ).toBeGreaterThan(0);
    expect(screen.getByText("Resolved gaps")).toBeInTheDocument();
    expect(
      screen.getAllByText("Finalizer removed claims").length
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Supporting evidence").length).toBeGreaterThan(0);
    expect(screen.getAllByText("10").length).toBeGreaterThan(0);
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

  test("renders persisted agent run steps in the timeline", () => {
    render(
      <RenderQA
        conversation={[
          {
            question: "Search the web for the current launch date.",
            answer: {
              agentAnswer: "Approved web answer.",
              agentMode: "web",
              agentRunSteps: [
                {
                  id: "1-plan",
                  type: "plan",
                  kind: "plan",
                  label: "Plan",
                  status: "completed",
                  summary: "Planned a web search.",
                },
                {
                  id: "2-approval",
                  type: "capability_approval_gate",
                  kind: "approval_gate",
                  label: "Capability Approval",
                  status: "completed",
                  summary: "Web Search was approved.",
                },
                {
                  id: "capability:web.search:approval:web.search:1.0.0",
                  type: "capability_call",
                  kind: "capability_call",
                  label: "Web Search",
                  status: "completed",
                  summary: "Capability call completed.",
                  attempt: 2,
                },
              ],
              ragAnswer: "Approved web answer.",
              ragSources: [],
              mcpAnswer: "Approved web answer.",
            },
          },
        ]}
      />
    );

    expect(screen.getByText("Run timeline")).toBeInTheDocument();
    expect(screen.getByText("Approval Gate")).toBeInTheDocument();
    expect(screen.getByText("Capability Call")).toBeInTheDocument();
    expect(screen.getByText("Attempt 2")).toBeInTheDocument();
    expect(screen.getByText("Capability call completed.")).toBeInTheDocument();
  });

  test("renders pending capability approval gates without private raw input", () => {
    const handleApprovalAction = jest.fn();

    render(
      <RenderQA
        conversation={[
          {
            question: "Search the web for the current launch date.",
            answer: {
              agentAnswer: "Approve Web Search?",
              agentMode: "clarification",
              agentTrace: [
                {
                  id: "approval:web.search:1.0.0",
                  type: "capability_approval_gate",
                  label: "Capability Approval",
                  status: "needs_input",
                  summary: "Web Search requires approval before execution.",
                  detail: {
                    approvalGates: [
                      {
                        id: "approval:web.search:1.0.0",
                        capabilityId: "web.search",
                        capabilityLabel: "Web Search",
                        status: "pending",
                        reason:
                          "User confirmation is required before this capability can execute.",
                        inputPreview: {
                          question: "Search the web for the current launch date.",
                        },
                        riskFlags: ["external_call"],
                      },
                    ],
                  },
                },
              ],
              approvalGates: [
                {
                  id: "approval:web.search:1.0.0",
                  capabilityId: "web.search",
                  capabilityLabel: "Web Search",
                  status: "pending",
                  reason:
                    "User confirmation is required before this capability can execute.",
                  inputPreview: {
                    question: "Search the web for the current launch date.",
                  },
                  riskFlags: ["external_call"],
                },
              ],
              clarification: {
                needed: true,
                reason: "capability_approval_required",
              },
              ragAnswer: "Approve Web Search?",
              ragSources: [],
              mcpAnswer: "Web search not used: clarification needed.",
            },
          },
        ]}
        onApprovalAction={handleApprovalAction}
      />
    );

    expect(screen.getByText("Pending approval")).toBeInTheDocument();
    expect(screen.getByText("Web Search")).toBeInTheDocument();
    expect(screen.getByText("question")).toBeInTheDocument();
    expect(
      screen.getAllByText("Search the web for the current launch date.").length
    ).toBeGreaterThan(0);
    expect(screen.getByText("External Call")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(handleApprovalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "approve",
        gate: expect.objectContaining({
          id: "approval:web.search:1.0.0",
        }),
        turnIndex: 0,
      })
    );
  });

  test("submits answer feedback with type and optional note", () => {
    const handleFeedback = jest.fn();

    render(
      <RenderQA
        conversation={[
          {
            question: "What does the policy say about remote work?",
            answer: {
              agentAnswer: "Remote work is allowed with manager approval.",
              agentMode: "document",
              ragAnswer: "Remote work is allowed with manager approval.",
              ragSources: [
                {
                  docId: "doc-1",
                  fileName: "policy.pdf",
                  pageNumber: 4,
                  chunkIndex: 2,
                  excerpt: "Remote work requires manager approval.",
                },
              ],
              mcpAnswer: "Web search not used.",
            },
          },
        ]}
        onFeedback={handleFeedback}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Optional feedback note"), {
      target: {
        value: "The cited page points to the wrong section.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Citation error" }));

    expect(handleFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        turnIndex: 0,
        feedbackType: "citation_error",
        note: "The cited page points to the wrong section.",
        question: "What does the policy say about remote work?",
        answer: expect.objectContaining({
          agentAnswer: "Remote work is allowed with manager approval.",
        }),
      })
    );
  });
});
