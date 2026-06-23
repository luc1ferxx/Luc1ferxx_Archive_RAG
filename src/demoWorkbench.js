export const DEMO_PREVIEW_SOURCE = {
  docId: "demo-finance-policy",
  fileName: "Finance Policy Manual.pdf",
  pageNumber: 42,
  chunkIndex: 1,
  filePath: "",
  excerpt:
    "International travel must be pre-approved by the employee's department head and booked through the corporate travel program.",
  demoPreview: {
    added: "May 12, 2025",
    description: "Company-wide finance policies and procedures.",
    pageRange: "42-45",
    tags: ["policy", "finance", "travel", "per-diem"],
    type: "PDF",
  },
};

export const DEMO_DOCUMENTS = [
  {
    docId: "demo-finance-policy",
    fileName: "Finance Policy Manual.pdf",
    pageCount: 182,
    previewSource: DEMO_PREVIEW_SOURCE,
    profile: {
      tags: ["policy", "finance", "travel"],
      summary: "Company-wide finance policies and procedures.",
    },
    version: "v2",
    age: "2d ago",
    type: "pdf",
    status: "ready",
  },
  {
    docId: "demo-expense-policy",
    fileName: "Expense Reimbursement Policy.pdf",
    pageCount: 24,
    profile: {
      tags: ["expense", "reimbursement"],
      summary: "Expense limits, receipts, approvals, and reimbursement rules.",
    },
    version: "v1",
    age: "5d ago",
    type: "pdf",
    status: "ready",
  },
  {
    docId: "demo-travel-policy",
    fileName: "Travel & Entertainment Policy.pdf",
    pageCount: 18,
    profile: {
      tags: ["travel", "entertainment"],
      summary: "Travel booking, class restrictions, insurance, and per diem notes.",
    },
    version: "v1",
    age: "7d ago",
    type: "pdf",
    status: "ready",
  },
  {
    docId: "demo-procurement",
    fileName: "Procurement Guidelines.docx",
    pageCount: 45,
    profile: {
      tags: ["procurement", "vendor"],
      summary: "Vendor onboarding, approval thresholds, and purchase controls.",
    },
    version: "v3",
    age: "9d ago",
    type: "docx",
    status: "ready",
  },
  {
    docId: "demo-vendor-management",
    fileName: "Vendor Management Policy.pdf",
    pageCount: 31,
    profile: {
      tags: ["vendor", "risk"],
      summary: "Vendor reviews, renewal cadence, and risk checks.",
    },
    version: "v1",
    age: "9d ago",
    type: "pdf",
    status: "idle",
  },
];

export const DEMO_RELEVANT_DOCUMENTS = DEMO_DOCUMENTS.slice(0, 3).map(
  (document, index) => ({
    ...document,
    pages: index === 0 ? [42, 43, 44, 45] : index === 1 ? [11] : [6, 8],
    previewSource: document.previewSource ?? {
      docId: document.docId,
      fileName: document.fileName,
      filePath: "",
      pageNumber: index === 0 ? 42 : index === 1 ? 11 : 6,
      excerpt: document.profile.summary,
    },
  })
);

export const DEMO_CONVERSATION = [
  {
    question:
      "What are the rules for international travel expenses and daily per diem limits?",
    answer: {
      demoWorkbench: true,
      agentMode: "document_rag",
      agentAnswer:
        "International travel must be pre-approved by your department head and booked through the corporate travel program. Economy class is required for flights under 8 hours; business class requires VP approval. Per diem limits are based on the location's cost tier as defined in the policy.",
      ragAnswer:
        "International travel must be pre-approved and booked through the corporate travel program. Economy class is required for flights under 8 hours. Business class requires VP approval. Per diem limits are tiered by location cost.",
      ragSources: [
        {
          ...DEMO_PREVIEW_SOURCE,
          rank: 1,
          excerpt:
            "International travel must be pre-approved. Economy class is required for flights under 8 hours.",
        },
        {
          docId: "demo-travel-policy",
          fileName: "Travel & Entertainment Policy.pdf",
          filePath: "",
          pageNumber: 6,
          chunkIndex: 2,
          rank: 2,
          excerpt:
            "Business class requires VP approval. Non-refundable tickets are discouraged unless necessary.",
        },
        {
          docId: "demo-expense-policy",
          fileName: "Expense Reimbursement Policy.pdf",
          filePath: "",
          pageNumber: 11,
          chunkIndex: 4,
          rank: 3,
          excerpt:
            "Receipts are required for expenses over $75. Alcohol is not reimbursable.",
        },
      ],
      ragEvidenceSummary: {
        confident: true,
        retrievedCount: 12,
        usableCount: 5,
        docCoverage: {
          coveredDocIds: ["demo-finance-policy", "demo-travel-policy"],
          selectedDocIds: ["demo-finance-policy", "demo-travel-policy"],
        },
        scoreRange: {
          max: 0.91,
        },
        requirements: [
          { id: "grounded", label: "Groundedness 91%" },
          { id: "coverage", label: "Context coverage 92%" },
        ],
        reasons: ["All answer claims are backed by retrieved policy sections."],
      },
      agentObservability: {
        executionPlanner: {
          selectedPlannerId: "deterministic",
          status: "selected",
          stepIds: ["document_rag", "self_check", "answer_finalizer"],
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
            skillVersion: "1.0.0",
            label: "Document RAG",
            status: "completed",
            attempts: 1,
            followUpCount: 1,
            citationCount: 5,
            totalDurationMs: 2800,
          },
        ],
        skillChain: [
          {
            skillId: "summarize_contract",
            skillVersion: "1.0.0",
            label: "Policy Summary",
          },
        ],
        executionLoop: {
          followUpsRun: 1,
          gaps: [],
        },
      },
      agentWorkingMemory: {
        checkedQueries: [
          {
            skillId: "document_rag",
            skillVersion: "1.0.0",
            phase: "primary",
            queryId: "travel-expense-rules",
            label: "Travel expense rules",
            query: "Find international travel expense approval and booking rules.",
            primary: true,
          },
          {
            skillId: "document_rag",
            skillVersion: "1.0.0",
            phase: "follow_up",
            queryId: "per-diem-tier-evidence",
            label: "Per diem tier evidence",
            query: "Find daily per diem limits by location cost tier.",
            primary: false,
          },
        ],
        resolvedGaps: [
          {
            type: "missing_citation",
            message: "Follow-up retrieval found the per diem tier table.",
            skillId: "document_rag",
            skillVersion: "1.0.0",
            phase: "follow_up",
          },
        ],
        unresolvedGaps: [],
        unsupportedClaims: [],
      },
      agentTrace: [
        {
          id: "demo-query",
          label: "Query understanding",
          status: "completed",
          summary: "Detected travel expense and per diem policy intent.",
        },
        {
          id: "demo-retrieval",
          label: "Retrieval Top-12",
          status: "completed",
          summary: "Searched finance, travel, and reimbursement policy chunks.",
        },
        {
          id: "demo-ranking",
          label: "Ranking Top-5",
          status: "completed",
          summary: "Prioritized policy pages with direct travel and per diem rules.",
        },
        {
          id: "demo-generate",
          label: "Generate Answer",
          status: "completed",
          summary: "Synthesized the grounded answer from selected citations.",
        },
        {
          id: "demo-guardrails",
          label: "Guardrails",
          status: "completed",
          summary: "Verified support and removed unsupported claims.",
        },
      ],
      mcpAnswer:
        "Web search was not needed because the workspace documents fully answered this policy question.",
    },
  },
];

export const DEMO_QUALITY_REPORT = {
  status: "ok",
  summary: {
    runId: "demo-policy-rag",
    metrics: {
      overallPassPercent: 92,
      qaPageHitPercent: 94,
      averageCitationCount: 3.7,
    },
  },
  failedCases: [],
  recommendations: [
    { label: "Completeness 94" },
    { label: "Groundedness 91" },
    { label: "Consistency 93" },
    { label: "Freshness 90" },
  ],
};

export const DEMO_QUALITY_HISTORY = {
  qualityGate: {
    status: "pass",
    summary:
      "Regression passed. Recovery observability passed 5 cases; replay failures 0, manual action failures 0.",
    checks: [
      {
        status: "pass",
        metric: "overallPassPercent",
        delta: 0.03,
      },
      {
        status: "pass",
        metric: "recoveryStepReplayFailureCount",
        currentValue: 0,
      },
    ],
  },
  regressionGate: {
    status: "pass",
    summary: "Regression passed against the previous synthetic baseline.",
    checks: [
      {
        status: "pass",
        metric: "overallPassPercent",
        delta: 0.03,
      },
    ],
  },
  recoveryGate: {
    status: "pass",
    skipped: false,
    currentRunId: "demo-recovery-observability",
    summary:
      "Recovery observability passed 5 cases; replay failures 0, manual action failures 0, primary lifecycle 2/1/1, auto replay success rate 1.",
    recovery: {
      autoReplaySuccessRate: 1,
      manualRecoveryActionFailureCount: 0,
      primaryStepCompletedCount: 1,
      primaryStepFailedCount: 1,
      primaryStepStartedCount: 2,
      stepReplayFailureCount: 0,
    },
  },
  runs: [
    {
      runId: "demo-policy-rag",
      fileName: "latest.json",
      status: "ok",
      createdAt: "2025-05-12T10:42:00Z",
      metrics: {
        overallPassPercent: 92,
      },
    },
  ],
};
