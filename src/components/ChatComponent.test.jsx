import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

let mockRequestChat;

vi.mock("react-speech-recognition", () => ({
  __esModule: true,
  default: {
    startListening: vi.fn(),
    stopListening: vi.fn(),
  },
  useSpeechRecognition: () => ({
    transcript: "",
    listening: false,
    resetTranscript: vi.fn(),
  }),
}));

vi.mock("speak-tts", () => {
  function MockSpeech() {
    this.init = vi.fn().mockResolvedValue(undefined);
    this.speak = vi.fn().mockResolvedValue(undefined);
    this.cancel = vi.fn();
  }
  return { default: MockSpeech };
});

vi.mock("../archiveApi", () => ({
  requestChat: (...args) => mockRequestChat(...args),
}));

vi.mock("../demoWorkbench", () => ({
  DEMO_CONVERSATION: [
    {
      question: "Demo question",
      answer: {
        agentAnswer: "Demo answer",
        ragAnswer: "Demo document answer",
        ragSources: [],
      },
    },
  ],
}));

const { default: ChatComponent } = await import("./ChatComponent");

describe("ChatComponent", () => {
  let handleResp;
  let setIsLoading;

  beforeEach(() => {
    handleResp = vi.fn();
    setIsLoading = vi.fn();
    mockRequestChat = vi.fn().mockResolvedValue({
      agentAnswer: "Answer",
      ragAnswer: "Document answer",
      ragSources: [],
    });
  });

  const renderChat = (overrides = {}) =>
    render(
      <ChatComponent
        docIds={["doc-1"]}
        docLabel="1 document"
        sessionId="session-1"
        userId="user-1"
        handleResp={handleResp}
        isLoading={false}
        setIsLoading={setIsLoading}
        {...overrides}
      />
    );

  test("only applies the last response when requests resolve out of order", async () => {
    let resolveFirst;
    let resolveSecond;

    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const secondPromise = new Promise((resolve) => {
      resolveSecond = resolve;
    });

    let callCount = 0;

    mockRequestChat = vi.fn(() => {
      callCount += 1;

      if (callCount === 1) {
        return firstPromise;
      }

      return secondPromise;
    });

    renderChat();

    const input = screen.getByRole("searchbox");

    await userEvent.clear(input);
    await userEvent.type(input, "First question");
    await userEvent.keyboard("{Enter}");

    await userEvent.clear(input);
    await userEvent.type(input, "Second question");
    await userEvent.keyboard("{Enter}");

    expect(mockRequestChat).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond({
        agentAnswer: "Second answer",
        ragAnswer: "Second document answer",
        ragSources: [],
      });
    });

    await waitFor(() =>
      expect(handleResp).toHaveBeenCalledWith(
        "Second question",
        expect.objectContaining({ agentAnswer: "Second answer" })
      )
    );

    await act(async () => {
      resolveFirst({
        agentAnswer: "First answer (stale)",
        ragAnswer: "First document answer (stale)",
        ragSources: [],
      });
    });

    expect(handleResp).toHaveBeenCalledTimes(1);
    expect(handleResp).not.toHaveBeenCalledWith(
      "First question",
      expect.objectContaining({ agentAnswer: "First answer (stale)" })
    );
  });

  test("does not show error for deliberately aborted requests", async () => {
    let rejectRequest;

    mockRequestChat = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        })
    );

    const { unmount } = renderChat();

    const input = screen.getByRole("searchbox");

    await userEvent.clear(input);
    await userEvent.type(input, "Question before unmount");
    await userEvent.keyboard("{Enter}");

    expect(mockRequestChat).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      const abortError = new DOMException("The operation was aborted.", "AbortError");
      rejectRequest(abortError);
    });

    expect(handleResp).not.toHaveBeenCalled();
  });

  test("clears loading state only for the current request sequence", async () => {
    let resolveFirst;
    let resolveSecond;

    let callCount = 0;

    mockRequestChat = vi.fn(() => {
      callCount += 1;

      if (callCount === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }

      return new Promise((resolve) => {
        resolveSecond = resolve;
      });
    });

    renderChat();

    const input = screen.getByRole("searchbox");

    await userEvent.clear(input);
    await userEvent.type(input, "First");
    await userEvent.keyboard("{Enter}");

    await userEvent.clear(input);
    await userEvent.type(input, "Second");
    await userEvent.keyboard("{Enter}");

    setIsLoading.mockClear();

    await act(async () => {
      resolveFirst({ agentAnswer: "Stale", ragAnswer: "Stale", ragSources: [] });
    });

    const setLoadingCallsAfterStale = setIsLoading.mock.calls.filter(
      ([value]) => value === false
    );
    expect(setLoadingCallsAfterStale).toHaveLength(0);

    await act(async () => {
      resolveSecond({ agentAnswer: "Current", ragAnswer: "Current", ragSources: [] });
    });

    await waitFor(() =>
      expect(setIsLoading).toHaveBeenCalledWith(false)
    );
  });
});
