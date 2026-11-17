import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";
import { useAgentRunActions } from "./useAgentRunActions";
import { useChatSession } from "./useChatSession";

const messageError = vi.fn();
const messageInfo = vi.fn();
const messageSuccess = vi.fn();

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
