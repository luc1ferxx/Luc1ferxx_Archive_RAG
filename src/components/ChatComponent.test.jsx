import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { message } from "antd";
import { vi } from "vitest";

let mockStreamChatAnswer;

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

const { speechConstructCount } = vi.hoisted(() => ({
  speechConstructCount: { value: 0 },
}));

vi.mock("speak-tts", () => {
  function MockSpeech() {
    speechConstructCount.value += 1;
    this.init = vi.fn().mockResolvedValue(undefined);
    this.speak = vi.fn().mockResolvedValue(undefined);
    this.cancel = vi.fn();
  }
  return { default: MockSpeech };
});

vi.mock("../archiveApi", () => ({
  streamChatAnswer: (...args) => mockStreamChatAnswer(...args),
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
const { createTranslator } = await import("../archiveI18n");

describe("ChatComponent", () => {
  let handleResp;
  let setIsLoading;

  beforeEach(() => {
    handleResp = vi.fn();
    setIsLoading = vi.fn();
    mockStreamChatAnswer = vi.fn().mockResolvedValue({
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

  test("shows progress and verified drafts while running, then hands over the final answer", async () => {
    let emit;
    let resolveRequest;

    mockStreamChatAnswer = vi.fn(({ onEvent }) => {
      emit = onEvent;
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    });

    renderChat({ t: createTranslator("en") });

    const input = screen.getByRole("searchbox");
    await userEvent.type(input, "What is the renewal term?");
    await userEvent.keyboard("{Enter}");

    await act(async () => {
      emit({ event: "trace_step", data: { step: { label: "Document RAG", type: "document_rag" } } });
      emit({ event: "answer_draft", data: { draft: { index: 0, text: "Renews every 12 months. [Source 1]" } } });
    });

    expect(screen.getByText("Working: Document RAG")).toBeInTheDocument();
    expect(screen.getByText("Renews every 12 months. [Source 1]")).toBeInTheDocument();
    // Drafts are labelled as provisional.
    expect(screen.getByText(/final answer may still change/)).toBeInTheDocument();

    // A retried model call starts the answer over.
    await act(async () => {
      emit({ event: "answer_draft_reset", data: {} });
    });
    expect(screen.queryByText("Renews every 12 months. [Source 1]")).not.toBeInTheDocument();

    await act(async () => {
      resolveRequest({ agentAnswer: "Final answer", ragAnswer: "Final", ragSources: [] });
    });

    await waitFor(() =>
      expect(handleResp).toHaveBeenCalledWith(
        "What is the renewal term?",
        expect.objectContaining({ agentAnswer: "Final answer" })
      )
    );
    // The final answer replaces the live panel.
    expect(screen.queryByTestId("live-answer")).not.toBeInTheDocument();
  });

  test("ignores stream events from a request that has been superseded", async () => {
    const emitters = [];

    mockStreamChatAnswer = vi.fn(({ onEvent }) => {
      emitters.push(onEvent);
      return new Promise(() => {});
    });

    renderChat();

    const input = screen.getByRole("searchbox");
    await userEvent.type(input, "First");
    await userEvent.keyboard("{Enter}");
    await userEvent.clear(input);
    await userEvent.type(input, "Second");
    await userEvent.keyboard("{Enter}");

    await act(async () => {
      emitters[0]({ event: "answer_draft", data: { draft: { index: 0, text: "Stale draft" } } });
    });

    expect(screen.queryByText("Stale draft")).not.toBeInTheDocument();
  });

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

    mockStreamChatAnswer = vi.fn(() => {
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

    expect(mockStreamChatAnswer).toHaveBeenCalledTimes(2);

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

    mockStreamChatAnswer = vi.fn(
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

    expect(mockStreamChatAnswer).toHaveBeenCalledTimes(1);

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

    mockStreamChatAnswer = vi.fn(() => {
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

  test("shows a warning when voice mode is toggled in an unsupported browser", async () => {
    const warnSpy = vi.spyOn(message, "warning").mockImplementation(() => {});

    renderChat({ showQuickActions: true });

    const voiceButton = screen.getByRole("button", { name: "chat.voiceMode" });
    expect(voiceButton).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(voiceButton);

    expect(warnSpy).toHaveBeenCalledWith("chat.voiceUnsupported");
    expect(voiceButton).toHaveAttribute("aria-pressed", "false");

    warnSpy.mockRestore();
  });

  test("does not construct speak-tts on mount", () => {
    const before = speechConstructCount.value;
    renderChat();
    expect(speechConstructCount.value).toBe(before);
  });
});
