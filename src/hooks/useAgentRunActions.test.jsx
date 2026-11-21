import { act, render, renderHook, screen } from "@testing-library/react";
import { vi } from "vitest";
import RenderQA from "../components/RenderQA";
import { useAgentRunActions } from "./useAgentRunActions";
import { useChatSession } from "./useChatSession";

const messageError = vi.fn();
const messageInfo = vi.fn();
const messageSuccess = vi.fn();

let fetchAgentRunMock;
let requestAgentRunActionMock;
let requestAgentRunRecoveryActionMock;
let requestAgentRunStepRetryMock;

vi.mock("antd", () => ({
  message: {
    error: (...args) => messageError(...args),
    info: (...args) => messageInfo(...args),
    success: (...args) => messageSuccess(...args),
  },
}));

vi.mock("../archiveApi", () => ({
  fetchAgentRun: (...args) => fetchAgentRunMock(...args),
  requestAgentRunAction: (...args) => requestAgentRunActionMock(...args),
  requestAgentRunRecoveryAction: (...args) =>
    requestAgentRunRecoveryActionMock(...args),
  requestAgentRunStepRetry: (...args) => requestAgentRunStepRetryMock(...args),
}));

const APPROVAL_OBJECT_HASH = `sha256:${"a".repeat(64)}`;

const createHookDependencies = () => ({
  conversation: [
    {
      answer: {
        agentRunId: "run-1",
      },
      question: "Search the web.",
    },
  ],
  refreshAgentRunRecovery: vi.fn().mockResolvedValue([]),
  setIsLoading: vi.fn(),
  setSelectedSource: vi.fn(),
  t: (key) => key,
  updateTurnByRunId: vi.fn(),
});

beforeEach(() => {
  fetchAgentRunMock = vi.fn();
  requestAgentRunActionMock = vi.fn();
  requestAgentRunRecoveryActionMock = vi.fn();
  requestAgentRunStepRetryMock = vi.fn();
  messageError.mockReset();
  messageInfo.mockReset();
  messageSuccess.mockReset();
});

describe("useAgentRunActions capability approval binding", () => {
  it("sends the gate id and approval object hash when approving", async () => {
    requestAgentRunActionMock.mockResolvedValue({
      response: {
        agentAnswer: "Approved result.",
      },
      run: {
        approvalGates: [],
        status: "completed",
        steps: [],
      },
    });
    const dependencies = createHookDependencies();
    const { result } = renderHook(() => useAgentRunActions(dependencies));

    await act(async () => {
      await result.current.handleAgentApprovalAction({
        action: "approve",
        gate: {
          approvalObjectHash: APPROVAL_OBJECT_HASH,
          id: "approval:web.search:1.0.0",
        },
        turnIndex: 0,
      });
    });

    expect(requestAgentRunActionMock).toHaveBeenCalledWith(
      "run-1",
      "approve",
      {
        approvalObjectHash: APPROVAL_OBJECT_HASH,
        gateId: "approval:web.search:1.0.0",
      }
    );
  });

  it("sends the gate id and approval object hash when denying", async () => {
    requestAgentRunActionMock.mockResolvedValue({
      run: {
        approvalGates: [],
        status: "completed",
        steps: [],
      },
    });
    const dependencies = createHookDependencies();
    const { result } = renderHook(() => useAgentRunActions(dependencies));

    await act(async () => {
      await result.current.handleAgentApprovalAction({
        action: "deny",
        gate: {
          approvalObjectHash: APPROVAL_OBJECT_HASH,
          id: "approval:web.search:1.0.0",
        },
        turnIndex: 0,
      });
    });

    expect(requestAgentRunActionMock).toHaveBeenCalledWith("run-1", "deny", {
      approvalObjectHash: APPROVAL_OBJECT_HASH,
      gateId: "approval:web.search:1.0.0",
    });
  });

  it("shows the generic denial text: a denial returns the run alone", async () => {
    requestAgentRunActionMock.mockResolvedValue({
      run: { approvalGates: [], status: "completed", steps: [] },
    });
    const dependencies = createHookDependencies();
    const { result } = renderHook(() => useAgentRunActions(dependencies));

    await act(async () => {
      await result.current.handleAgentApprovalAction({
        action: "deny",
        gate: { approvalObjectHash: APPROVAL_OBJECT_HASH, id: "approval:web.search:1.0.0" },
        turnIndex: 0,
      });
    });

    const [, update] = dependencies.updateTurnByRunId.mock.calls[0];
    const nextTurn = update({ answer: { agentAnswer: "Approve Web Search?" }, question: "q" });
    expect(nextTurn.answer.agentAnswer).toBe("app.approvalDeniedAnswer");
    expect(nextTurn.answer.clarification.needed).toBe(false);
    expect(messageInfo).toHaveBeenCalledWith("app.approvalDenied");
  });

  it.each(["approve", "deny"])(
    "does not send a %s request when the approval object hash is missing",
    async (action) => {
      const dependencies = createHookDependencies();
      const { result } = renderHook(() => useAgentRunActions(dependencies));

      await act(async () => {
        await result.current.handleAgentApprovalAction({
          action,
          gate: {
            id: "approval:web.search:1.0.0",
          },
          turnIndex: 0,
        });
      });

      expect(requestAgentRunActionMock).not.toHaveBeenCalled();
      expect(dependencies.setIsLoading).not.toHaveBeenCalled();
      expect(messageError).toHaveBeenCalledWith("app.approvalMissing");
    }
  );
});

describe("useAgentRunActions with the chat session", () => {
  it("drops an approval that resolves after New chat, so the new turn at its old position is unchanged", async () => {
    let resolveApproval;
    requestAgentRunActionMock.mockReturnValue(
      new Promise((resolve) => {
        resolveApproval = resolve;
      })
    );
    const refreshAgentRunRecovery = vi.fn().mockResolvedValue([]);
    const setSelectedSource = vi.fn();
    const { result } = renderHook(() => {
      const session = useChatSession();

      return {
        actions: useAgentRunActions({
          ...session,
          refreshAgentRunRecovery,
          setSelectedSource,
          t: (key) => key,
        }),
        session,
      };
    });
    const newTurn = {
      answer: { agentAnswer: "New answer.", agentRunId: "run-2" },
      question: "A new question.",
    };
    let approval;

    act(() => {
      result.current.session.addConversationTurn("Search the web.", { agentRunId: "run-1" });
    });
    act(() => {
      approval = result.current.actions.handleAgentApprovalAction({
        action: "approve",
        gate: { approvalObjectHash: APPROVAL_OBJECT_HASH, id: "approval:web.search:1.0.0" },
        turnIndex: 0,
      });
    });
    // New chat empties the conversation; the next answer takes position 0.
    act(() => {
      result.current.session.resetConversation();
    });
    act(() => {
      result.current.session.addConversationTurn(newTurn.question, newTurn.answer);
    });
    await act(async () => {
      resolveApproval({
        response: {
          agentAnswer: "Approved result.",
          agentRunId: "run-1",
          ragSources: [{ docId: "doc-1" }],
        },
        run: { approvalGates: [], status: "completed", steps: [] },
      });
      await approval;
    });

    expect(result.current.session.conversation).toEqual([newTurn]);
    expect(setSelectedSource).not.toHaveBeenCalled();
    expect(messageSuccess).toHaveBeenCalledWith("app.approvalRecorded");
  });
});

describe("useAgentRunActions after a decision fails", () => {
  const PENDING_GATE = {
    approvalObjectHash: APPROVAL_OBJECT_HASH,
    capabilityLabel: "Web Search",
    id: "approval:web.search:1.0.0",
    status: "pending",
  };

  const renderWithSession = () => {
    const refreshAgentRunRecovery = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(() => {
      const session = useChatSession();

      return {
        actions: useAgentRunActions({
          ...session,
          refreshAgentRunRecovery,
          setSelectedSource: vi.fn(),
          t: (key) => key,
        }),
        session,
      };
    });

    act(() => {
      result.current.session.addConversationTurn("Search the web.", {
        agentAnswer: "Approve Web Search?",
        agentRunId: "run-1",
        agentRunStatus: "waiting_for_user",
        approvalGates: [PENDING_GATE],
      });
    });

    return { refreshAgentRunRecovery, result };
  };

  it("shows the run as the server holds it: no gate to decide, the failed step and its reason", async () => {
    const reason = "Web search is not configured: SERPAPI_KEY is not set.";
    const failedStep = {
      error: { message: reason },
      id: "capability:web.search:approval:web.search:1.0.0",
      kind: "capability_call",
      label: "Web Search",
      status: "failed",
      type: "capability_call",
    };
    requestAgentRunActionMock.mockRejectedValue({
      response: { data: { error: reason }, status: 409 },
    });
    fetchAgentRunMock.mockResolvedValue({
      approvalGates: [{ ...PENDING_GATE, status: "approved" }],
      runId: "run-1",
      status: "failed",
      steps: [failedStep],
    });
    const { refreshAgentRunRecovery, result } = renderWithSession();

    await act(async () => {
      await result.current.actions.handleAgentApprovalAction({
        action: "approve",
        gate: PENDING_GATE,
        turnIndex: 0,
      });
    });

    expect(messageError).toHaveBeenCalledWith(reason);
    expect(fetchAgentRunMock).toHaveBeenCalledWith("run-1");
    // The failed run joins the recovery list without a reload.
    expect(refreshAgentRunRecovery).toHaveBeenCalledTimes(1);

    render(
      <RenderQA
        conversation={result.current.session.conversation}
        onApprovalAction={vi.fn()}
        onStepRetry={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("keeps the gate usable while the run still waits, or cannot be read", async () => {
    requestAgentRunActionMock.mockRejectedValue(new Error("Network Error"));
    fetchAgentRunMock.mockResolvedValueOnce({
      approvalGates: [PENDING_GATE],
      runId: "run-1",
      status: "waiting_for_user",
      steps: [],
    });
    fetchAgentRunMock.mockRejectedValueOnce(new Error("Network Error"));
    const { refreshAgentRunRecovery, result } = renderWithSession();

    for (const action of ["approve", "deny"]) {
      await act(async () => {
        await result.current.actions.handleAgentApprovalAction({
          action,
          gate: PENDING_GATE,
          turnIndex: 0,
        });
      });

      const { answer } = result.current.session.conversation[0];

      expect(answer.agentRunStatus).toBe("waiting_for_user");
      expect(answer.approvalGates).toEqual([PENDING_GATE]);
    }

    expect(messageError).toHaveBeenCalledWith("app.approvalMissing");
    expect(fetchAgentRunMock).toHaveBeenCalledTimes(2);
    expect(refreshAgentRunRecovery).toHaveBeenCalledTimes(2);
  });
});
