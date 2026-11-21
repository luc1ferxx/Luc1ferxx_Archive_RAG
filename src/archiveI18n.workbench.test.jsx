import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { message } from "antd";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TRANSLATIONS, createTranslator } from "./archiveI18n";
import AgentRunCenter from "./components/AgentRunCenter";
import PdfPreview from "./components/PdfPreview";
import RenderQA from "./components/RenderQA";
import WorkspaceSidebar from "./components/WorkspaceSidebar";
import { useArxivEnrichment } from "./hooks/useArxivEnrichment";
import { useWorkspaceDocuments } from "./hooks/useWorkspaceDocuments";

const api = vi.hoisted(() => ({
  fetchDocumentArxivSuggestions: vi.fn(),
  fetchDocumentFile: vi.fn(),
  fetchDocuments: vi.fn(),
  fetchSavedArxivSuggestions: vi.fn(),
  requestDocumentArxivImport: vi.fn(),
  requestDocumentClear: vi.fn(),
  requestDocumentDelete: vi.fn(),
}));

vi.mock("./archiveApi", () => api);

const zh = createTranslator("zh");

const wordsIn = (text) => String(text ?? "").match(/[A-Za-z]{2,}/g) ?? [];

// English the Chinese UI keeps on purpose: the terms its own strings use
// (Agent, RAG, arXiv, ID, PDF...) and the duration unit.
const KEPT_WORDS = new Set([
  ...Object.values(TRANSLATIONS.zh).flatMap((value) =>
    wordsIn(value.replace(/\{\w+\}/g, ""))
  ),
  "ms",
]);

const dataStrings = (value) => {
  if (typeof value === "string") {
    return value ? [value] : [];
  }

  if (value && typeof value === "object") {
    return Object.values(value).flatMap(dataStrings);
  }

  return [];
};

/**
 * The English words a Chinese reader would still see in the container: its
 * text and its aria-label, title and placeholder attributes, less the terms
 * above and the data the panel shows as it is (what the server sends, file
 * names, ids). The data is cut out whole, so a code the panel turns into
 * English words ("document_rag" as "Document Rag") still counts.
 */
const findEnglish = (container, data) => {
  // Longest first, so a value is not cut short by one it contains.
  const shownData = dataStrings(data).sort((a, b) => b.length - a.length);
  const cutData = (text) =>
    shownData.reduce((rest, value) => rest.split(value).join(" "), String(text ?? ""));
  const texts = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);

  while (walker.nextNode()) {
    texts.push(walker.currentNode.nodeValue);
  }

  // An antd icon's aria-label is its English icon name, set by antd.
  container
    .querySelectorAll("[aria-label]:not(.anticon), [title], [placeholder]")
    .forEach((element) => {
      ["aria-label", "title", "placeholder"].forEach((name) =>
        texts.push(element.getAttribute(name))
      );
    });

  return [...new Set(texts.map(cutData).flatMap(wordsIn).filter((word) => !KEPT_WORDS.has(word)))].sort();
};

const GAP = {
  claim: "通知期为九十天。",
  missingAnchors: ["90"],
  phase: "gap_analysis",
  skillId: "document_rag",
  skillVersion: "1.0.0",
  type: "unsupported_claim",
};

const AGENT_TURN = {
  question: "续约条款是什么？",
  answer: {
    agentAnswer: "续约需要提前通知。",
    agentMode: "research_brief",
    agentRunId: "r-12345678901234",
    agentRunStatus: "waiting_for_user",
    approvalGates: [
      {
        capabilityLabel: "网页搜索",
        id: "gate-1",
        inputPreview: { 问题: "发布日期" },
        reason: "执行前需要确认。",
        riskFlags: ["external_call", "writes_workspace"],
        status: "pending",
      },
    ],
    agentRunSteps: [
      {
        attempt: 2,
        id: "s-1",
        input: { 问题: "续约" },
        kind: "tool_call",
        label: "检索文档",
        output: { 引用: 2 },
        status: "completed",
        summary: "找到两条引用。",
      },
      {
        error: "超时。",
        id: "s-2",
        kind: "capability_call",
        label: "网页搜索",
        status: "failed",
        type: "capability_call",
      },
      { id: "s-3", kind: "observation", label: "复核", status: "pending" },
    ],
    agentObservability: {
      executionLoop: { followUpsRun: 1 },
      executionPlanner: {
        fallback: true,
        fallbackReason: "计划无效。",
        requestedPlannerId: "llm",
        selectedPlannerId: "deterministic",
        status: "completed",
      },
      selectedSkills: [
        { label: "文档检索", skillId: "document_rag", skillVersion: "1.0.0" },
        { label: "风险审查", skillId: "risk_review", status: "not_run" },
      ],
      skillChain: [{ label: "风险审查", skillId: "risk_review" }],
      skills: [
        {
          attempts: 2,
          budgetLimit: 2,
          budgetUsed: 2,
          citationCount: 2,
          followUpCount: 1,
          label: "文档检索",
          retryCount: 1,
          skillId: "document_rag",
          status: "completed",
          totalDurationMs: 35,
        },
      ],
    },
    agentWorkingMemory: {
      checkedQueries: [
        { phase: "follow_up", primary: true, query: "查找通知期", skillId: "document_rag" },
      ],
      resolvedGaps: [{ message: "已找到引用。", type: "missing_citations" }],
      unresolvedGaps: [GAP],
      unsupportedClaims: [{ missingAnchors: ["90"], text: "通知期为九十天。" }],
    },
    agentTrace: [
      {
        detail: {
          actions: [{ summary: "回答文档问题。" }],
          budget: {
            limits: { maxDocumentRagCalls: 2, maxTraceSteps: 12 },
            traceTruncated: true,
            used: { documentRagCalls: 1, traceSteps: 12 },
          },
          docIds: ["d-1"],
        },
        id: "t-1",
        label: "规划",
        status: "completed",
        summary: "使用文档流程。",
        type: "plan",
      },
      {
        detail: {
          intent: "analysis",
          phase: "follow_up",
          retrievalOptions: { profile: "broad", topK: 10, topKPerDoc: 4 },
          retrievalQueries: [{ query: "通知期" }],
        },
        id: "t-2",
        label: "查询规划",
        status: "completed",
        summary: "规划了查询。",
        type: "query_planner",
      },
      {
        detail: { skills: [{ label: "风险审查" }] },
        id: "t-3",
        label: "技能链",
        status: "completed",
        summary: "排好了技能。",
        type: "skill_chain",
      },
      {
        detail: { questions: [{ question: "期限多久？" }] },
        id: "t-4",
        label: "研究计划",
        status: "completed",
        summary: "拆分了问题。",
        type: "research_plan",
      },
      {
        detail: { abstained: false, citations: 2, error: "无" },
        id: "t-5",
        label: "研究问题",
        status: "completed",
        summary: "回答了问题。",
        type: "research_question",
      },
      {
        detail: {
          abstained: false,
          citations: 2,
          durationMs: 40,
          gaps: [GAP],
          retrievalQueries: [{ query: "续约" }],
          riskQuestion: "有哪些风险？",
          selectedDocumentCount: 1,
          skillId: "document_rag",
          skillVersion: "1.0.0",
        },
        id: "t-6",
        label: "文档检索",
        status: "completed",
        summary: "检索完成。",
        type: "document_rag",
      },
      {
        detail: {
          citationCount: 1,
          citedDocCount: 1,
          claimSupport: {
            claims: [{ missingAnchors: ["90"], supported: false }],
            supportedClaimCount: 1,
            unsupportedClaimCount: 1,
          },
          passed: false,
          reasons: ["缺少引用。"],
          requiredCitationCount: 2,
          requiredDocCoverage: 1,
          retryRecommended: true,
        },
        id: "t-7",
        label: "自检",
        status: "failed",
        summary: "证据不足。",
        type: "self_check",
      },
      {
        detail: { followUpRecommended: true, gaps: [{ type: "insufficient_evidence" }] },
        id: "t-8",
        label: "缺口分析",
        status: "completed",
        summary: "找到一个缺口。",
        type: "gap_analysis",
      },
      {
        detail: { clarificationQuestion: "指哪份合同？", reason: "范围不明。" },
        id: "t-9",
        label: "澄清",
        status: "completed",
        summary: "需要澄清。",
        type: "clarification_gate",
      },
      {
        detail: { abstained: false, changed: true, removedClaims: [null] },
        id: "t-10",
        label: "定稿",
        status: "completed",
        summary: "删除了一条论断。",
        type: "answer_finalizer",
      },
      {
        detail: { reason: "预算用完。", tool: "检索" },
        id: "t-11",
        label: "预算上限",
        status: "skipped",
        summary: "跳过重试。",
        type: "budget_limit",
      },
      // The approval flow's steps, with the fields the server records.
      {
        detail: {
          approvalGate: { id: "gate-1" },
          clarificationQuestion: "批准网页搜索吗？",
          reason: "capability_approval_required",
        },
        id: "t-12",
        label: "能力审批",
        status: "needs_input",
        summary: "等待审批。",
        type: "capability_approval_gate",
      },
      {
        detail: {
          approvalDelegated: true,
          approvalGateId: "approval:web.search:1.0.0:h",
          approvalObjectHash: "sha256:h",
          attempt: 1,
          capabilityId: "web.search",
          delegatedStepId: "capability:web.search:approval:web.search:1.0.0:h",
          interruptType: "capability_approval_required",
          kind: "tool_call",
          retryOfStepId: null,
          traceStatus: "skipped",
        },
        id: "t-13",
        label: "网页搜索",
        status: "skipped",
        summary: "已交给批准后的调用。",
        type: "web_search",
      },
    ],
    errors: { mcp: "超时。" },
    mcpAnswer: "网页回答内容。",
    ragAnswer: "续约需要提前九十天通知。",
    ragEvidenceSummary: {
      confident: false,
      docCoverage: { coveredDocIds: ["d-1"], selectedDocIds: ["d-1", "d-2"] },
      reasons: ["证据不足。"],
      requirements: [{ id: "q-1", label: "通知期" }, { id: "q-2" }],
      retrievedCount: 6,
      scoreRange: { max: 0.82 },
      usableCount: 2,
    },
    ragGapPlan: {
      missingAspects: [{ label: "通知方式" }],
      supplementalSearches: [
        { label: "补充检索一", query: "通知", resultCount: 3 },
        { label: "补充检索二", query: "期限" },
      ],
    },
    ragMemoryApplied: true,
    ragSources: [
      {
        chunkIndex: 2,
        docId: "d-1",
        excerpt: "提前九十天书面通知。",
        fileName: "合同.pdf",
        pageNumber: 4,
        rank: 1,
        score: 0.82,
      },
    ],
    researchBrief: {
      citations: [{}],
      questions: [{ id: "rq-1", question: "期限多久？", status: "completed" }],
    },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the workbench in Chinese", () => {
  test("an answer, its run panel, trace and evidence read in Chinese", () => {
    // A document answer without an evidence summary counts its citations.
    const documentTurn = {
      answer: {
        mcpAnswer: "没有网页回答。",
        ragAnswer: "期限为三年。",
        ragSources: AGENT_TURN.answer.ragSources,
      },
      question: "合同期限多久？",
    };
    const conversation = [AGENT_TURN, documentTurn];
    const { container } = render(
      <RenderQA
        activeTurnIndex={1}
        conversation={conversation}
        isLoading
        onApprovalAction={vi.fn()}
        onContinueRun={vi.fn()}
        onFeedback={vi.fn()}
        onStepRetry={vi.fn()}
        t={zh}
      />
    );

    expect(findEnglish(container, conversation)).toEqual([]);
    expect(screen.getByText("第 1 问")).toBeInTheDocument();
    expect(screen.getByText("已关联来源")).toBeInTheDocument();
    expect(screen.getByText("证据链")).toBeInTheDocument();
    expect(screen.getByText("调用外部服务")).toBeInTheDocument();
    expect(screen.getByText("继续运行")).toBeInTheDocument();
    expect(screen.getByText("第 2 次尝试")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "引用有误" })).toHaveLength(2);
    expect(screen.getAllByPlaceholderText("反馈备注（可选）")).toHaveLength(2);
    expect(screen.getByText("正在生成回答…")).toBeInTheDocument();
    expect(container.querySelector(".archive-answer-chip-agent")).toHaveTextContent("研究简报");
    expect(screen.getAllByText("需要审批").length).toBeGreaterThan(0);
    // An approval step shows no internal id or hash.
    expect(container.textContent).not.toMatch(/sha256|approval:web\.search/);
  });

  test("the preview reads in Chinese, empty, loading, failed and on every tab", async () => {
    const source = AGENT_TURN.answer.ragSources[0];
    const { container, rerender } = render(<PdfPreview source={null} t={zh} />);

    expect(screen.getByText("未选择来源")).toBeInTheDocument();
    expect(findEnglish(container, {})).toEqual([]);

    rerender(<PdfPreview source={source} t={zh} />);
    expect(screen.getByText("来源 · 第 4 页")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在来源中搜索" }));
    fireEvent.change(screen.getByPlaceholderText("搜索当前来源"), {
      target: { value: "通知" },
    });
    expect(screen.getByText("已预览“通知”的 1 处匹配")).toBeInTheDocument();
    expect(findEnglish(container, source)).toEqual([]);

    for (const tab of ["片段", "元数据", "引用"]) {
      fireEvent.click(screen.getByRole("button", { name: tab }));
      expect(findEnglish(container, source)).toEqual([]);
    }
    expect(screen.getByText("所选引用")).toBeInTheDocument();

    const protectedSource = { ...source, filePath: "documents/d-1/file" };

    api.fetchDocumentFile.mockReturnValueOnce(new Promise(() => {}));
    rerender(<PdfPreview source={{ ...protectedSource, docId: "d-2" }} t={zh} />);
    expect(await screen.findByText("正在加载安全预览…")).toBeInTheDocument();

    api.fetchDocumentFile.mockRejectedValueOnce(new Error("offline"));
    rerender(<PdfPreview source={{ ...protectedSource, docId: "d-3" }} t={zh} />);
    expect(await screen.findByText("文档无法加载，或不是有效的 PDF。")).toBeInTheDocument();

    rerender(<PdfPreview source={{ ...protectedSource, docId: "" }} t={zh} />);
    expect(screen.getByText("所选来源未标明对应的文档。")).toBeInTheDocument();
    expect(findEnglish(container, protectedSource)).toEqual([]);
  });

  test("the run center reads in Chinese", () => {
    const tasks = [
      {
        id: "task-1",
        items: [{ id: "p-1", status: "completed" }],
        requiredUserAction: "approve_deliverables",
        result: {
          approvalGates: [
            {
              approvalObjectHash: "h",
              capabilityLabel: "导出",
              id: "g-1",
              inputPreview: {},
              riskFlags: ["writes_workspace"],
              status: "pending",
            },
          ],
          goalPlan: {
            completedIterations: 3,
            counts: { completed: 1, total: 3 },
            deliverables: { items: [{ id: "dl-1", output: { documentCount: 2 } }] },
            goalCompletion: { checks: [{ id: "c-1", label: "已引用", passed: true }] },
            maxIterations: 4,
            overBudgetIterations: 1,
            researchTask: { phases: [{ id: "ph-1" }] },
            status: "running",
          },
        },
        status: "waiting_for_user",
        type: "agent_goal",
      },
      { id: "task-2", requiredUserAction: "continue_task", status: "paused", type: "agent_goal" },
      {
        id: "external_recommendation:arxiv:d-1",
        items: [
          { id: "p-2", label: "检索增强生成", result: { status: "" }, status: "waiting_for_user", summary: "waiting_for_user" },
          { id: "p-3", label: "文档问答", result: { status: "already_indexed" }, status: "completed", summary: "already_indexed" },
        ],
        label: "arXiv 推荐",
        status: "waiting_for_user",
        type: "external_recommendation",
      },
      {
        id: "task-3",
        result: {
          goalPlan: {
            deliverables: { items: [{ id: "dl-2", label: "报告", status: "waiting_for_approval" }] },
            goalCompletion: { checks: [{ id: "c-2", label: "无待办", passed: false }], status: "blocked" },
          },
        },
        status: "waiting_for_user",
        type: "agent_goal",
      },
    ];
    const { container } = render(<AgentRunCenter t={zh} tasks={tasks} />);

    expect(findEnglish(container, tasks)).toEqual([]);
    expect(screen.getByText("Agent 运行中心")).toBeInTheDocument();
    expect(screen.getByText("已在索引中")).toBeInTheDocument();
    expect(screen.getByText("等待审批")).toBeInTheDocument();
    expect(screen.getByText("受阻")).toBeInTheDocument();
    expect(screen.getByText("已运行 2/4 轮 · 审批后 1 轮")).toBeInTheDocument();
    expect(screen.getByText("2 个文档")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准交付物" })).toBeInTheDocument();
    // antd spaces out a two-character Chinese button label.
    expect(screen.getByRole("button", { name: "继 续" })).toBeInTheDocument();
  });

  test("the sidebar reads in Chinese: corpus, scope, arXiv panel, quality and recovery", () => {
    const data = {
      activeDocuments: [
        { docId: "d-12345678", fileName: "合同.pdf", pageCount: 3 },
        {
          docId: "x-87654321",
          fileName: "论文.pdf",
          pageCount: 9,
          profile: { source: { arxivId: "2401.00001v1", sourceType: "arxiv" } },
        },
      ],
      arxivSuggestion: {
        document: { docId: "d-12345678" },
        papers: [
          { arxivId: "2401.00002v1", title: "检索增强生成" },
          { arxivId: "2401.00003v1", title: "文档问答" },
        ],
        selectionToken: "tok",
        topic: "检索",
      },
      qualityHistory: {
        qualityGate: {
          checks: [{ delta: -0.05, metric: "overallPassPercent", status: "warn" }],
          status: "warn",
          summary: "门控摘要。",
        },
        recoveryGate: { recovery: {}, status: "pass" },
        runs: [{ fileName: "f", metrics: { overallPassPercent: 90 }, runId: "q-1", status: "pass" }],
      },
      qualityReport: {
        failedCases: [],
        recommendations: [],
        status: "warn",
        summary: { metrics: { overallPassPercent: 80, qaPageHitPercent: 75 }, runId: "q-1" },
      },
      recoveryRuns: [
        {
          goal: "整理合同",
          recovery: {
            actions: [
              {
                safety: {
                  label: "网页搜索",
                  reasonCodes: ["non_idempotent"],
                  stepType: "capability_call",
                },
                stepId: "s-1",
                type: "retry_failed_step",
              },
              { type: "cancel" },
            ],
            reason: "failed_step_ready",
            requestedMode: "manual",
          },
          runId: "r-1",
          status: "failed",
        },
        {
          goal: "整理合同",
          recovery: { actions: [{ type: "cancel" }], reason: "graph_checkpoint_missing" },
          runId: "r-2",
          status: "running",
        },
      ],
      savedArxivSuggestionsByDocId: { "d-12345678": { papers: [{}, {}] } },
    };
    const { container, rerender } = render(
      <WorkspaceSidebar
        {...data}
        activeNavItem="drive"
        conversationCount={2}
        onClearDocuments={vi.fn()}
        onRemoveDocument={vi.fn()}
        t={zh}
        totalPages={12}
      />
    );

    expect(findEnglish(container, data)).toEqual([]);
    expect(screen.getByText("文件库")).toBeInTheDocument();
    expect(screen.getByText("2 个文档 · 12 页")).toBeInTheDocument();
    expect(screen.getByText("为“检索”找到 2 篇论文，请选择要导入的论文。")).toBeInTheDocument();
    expect(screen.getByText("已选 0/2 篇")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试失败的步骤" })).toBeInTheDocument();
    expect(screen.getByText("没有保存的检查点")).toBeInTheDocument();
    expect(screen.getByText("-5 个百分点")).toBeInTheDocument();
    expect(screen.getByText("无日期")).toBeInTheDocument();

    rerender(
      <WorkspaceSidebar
        {...data}
        conversationCount={2}
        isArxivSuggestionLoading
        onClearDocuments={vi.fn()}
        onRemoveDocument={vi.fn()}
        t={zh}
        totalPages={12}
      />
    );
    expect(screen.getByText("正在查找相关论文…")).toBeInTheDocument();
  });

  test("the arXiv and document toasts read in Chinese", async () => {
    const success = vi.spyOn(message, "success").mockImplementation(() => {});
    const error = vi.spyOn(message, "error").mockImplementation(() => {});
    const suggestion = {
      document: { docId: "d-1" },
      papers: [{ arxivId: "2401.00002v1", title: "检索增强生成" }],
      selectionToken: "tok",
    };

    api.fetchDocumentArxivSuggestions.mockResolvedValue(suggestion);
    api.fetchSavedArxivSuggestions.mockResolvedValue({ suggestions: [] });
    api.requestDocumentArxivImport.mockResolvedValue({ importedCount: 1, skippedCount: 2 });
    api.fetchDocuments.mockResolvedValue([]);
    api.requestDocumentDelete.mockResolvedValue({});
    api.requestDocumentClear.mockRejectedValue(new Error("offline"));

    const arxiv = renderHook(() => useArxivEnrichment({ t: zh }));

    await act(() => arxiv.result.current.requestSuggestions({ docId: "d-1" }));
    await act(() => arxiv.result.current.importSuggestion(["2401.00002v1"]));
    expect(success).toHaveBeenCalledWith(
      "已导入 1 篇 arXiv 论文；另有 2 篇 arXiv 论文已在索引中。"
    );

    const documents = renderHook(() => useWorkspaceDocuments({ t: zh }));

    await waitFor(() => expect(api.fetchDocuments).toHaveBeenCalled());
    await act(() => documents.result.current.removeDocument("d-1"));
    await act(() => documents.result.current.clearDocuments());
    expect(success).toHaveBeenCalledWith("文档已移除。");
    expect(error).toHaveBeenCalledWith("无法清空文档。");
  });
});
