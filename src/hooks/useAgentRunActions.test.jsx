import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";
import { useAgentRunActions } from "./useAgentRunActions";

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
  updateConversationTurn: vi.fn(),
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

  it("shows the finalized answer of a unified-graph denial", async () => {
    requestAgentRunActionMock.mockResolvedValue({
      response: {
        agentAnswer: "Create Task was not run: the approval was denied.",
        agentMode: "workspace_action",
        ragSources: [{ docId: "vendor-msa", pageNumber: 2 }],
      },
      run: {
        approvalGates: [{ id: "graph-gate-1", status: "denied" }],
        status: "completed",
        steps: [],
      },
      status: 200,
    });
    const dependencies = createHookDependencies();
    const { result } = renderHook(() => useAgentRunActions(dependencies));

    await act(async () => {
      await result.current.handleAgentApprovalAction({
        action: "deny",
        gate: { approvalObjectHash: APPROVAL_OBJECT_HASH, id: "graph-gate-1" },
        turnIndex: 0,
      });
    });

    const [, update] = dependencies.updateConversationTurn.mock.calls[0];
    expect(update.answer.agentAnswer).toBe(
      "Create Task was not run: the approval was denied."
    );
    expect(update.answer.agentMode).toBe("workspace_action");
    expect(update.answer.agentRunStatus).toBe("completed");
    expect(update.answer.approvalGates).toEqual([
      { id: "graph-gate-1", status: "denied" },
    ]);
    expect(dependencies.setSelectedSource).toHaveBeenCalledWith({
      docId: "vendor-msa",
      pageNumber: 2,
    });
    expect(messageInfo).toHaveBeenCalledWith("app.approvalDenied");
    expect(messageSuccess).not.toHaveBeenCalled();
  });

  it("keeps the generic denial text for a V1 denial that returns the run alone", async () => {
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

    const [, update] = dependencies.updateConversationTurn.mock.calls[0];
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
