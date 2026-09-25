import { afterEach, describe, expect, test, vi } from "vitest";
import { parseServerSentEvents, streamChat, streamChatAnswer } from "./archiveApi";

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// A fetch response whose body arrives in the given chunks, split anywhere --
// including in the middle of an event -- as a real network read can be.
const streamingResponse = (chunks, { ok = true, status = 200, json = null } = {}) => ({
  body: new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  }),
  json: async () => json,
  ok,
  status,
});

const stubFetch = (response) => {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const request = { docIds: ["doc-1"], question: "Q?", sessionId: "s", userId: "u" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseServerSentEvents", () => {
  test("returns complete events and keeps an unfinished tail for the next read", () => {
    const { events, rest } = parseServerSentEvents(
      `: keep-alive\n\n${sse("trace_step", { step: { type: "plan" } })}event: answer_draft\ndata: {"dra`
    );

    expect(events).toEqual([{ data: { step: { type: "plan" } }, event: "trace_step" }]);
    expect(rest).toBe('event: answer_draft\ndata: {"dra');
  });
});

describe("streamChat", () => {
  test("hands every progress and draft event to onEvent and resolves with the result", async () => {
    const payload = [
      sse("trace_step", { step: { label: "Plan" }, type: "trace_step" }),
      sse("answer_draft", { draft: { index: 0, text: "Renews every 12 months." }, type: "answer_draft" }),
      sse("result", { body: { agentAnswer: "Final" }, status: 200 }),
      sse("done", {}),
    ].join("");
    const fetchMock = stubFetch(streamingResponse([payload.slice(0, 37), payload.slice(37, 90), payload.slice(90)]));
    const onEvent = vi.fn();

    const result = await streamChat({ ...request, onEvent });

    expect(result).toEqual({ body: { agentAnswer: "Final" }, status: 200 });
    expect(onEvent.mock.calls.map(([event]) => event.event)).toEqual(["trace_step", "answer_draft"]);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/chat\/stream$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      docIds: "doc-1",
      question: "Q?",
      sessionId: "s",
      userId: "u",
    });
  });

  test("rejects with an axios-style response when the stream reports an error", async () => {
    stubFetch(
      streamingResponse([
        sse("error", { error: { message: "Model unavailable." }, status: 503 }),
        sse("done", {}),
      ])
    );

    await expect(streamChat(request)).rejects.toMatchObject({
      message: "Model unavailable.",
      response: { data: { error: { message: "Model unavailable." } }, status: 503 },
      status: 503,
    });
  });

  test("rejects before any stream when the request itself is refused", async () => {
    stubFetch(streamingResponse([], { json: { error: { message: "No access." } }, ok: false, status: 403 }));

    await expect(streamChat(request)).rejects.toMatchObject({
      response: { data: { error: { message: "No access." } }, status: 403 },
      status: 403,
    });
  });

  test("a stream that ends without a result is an error, not an empty answer", async () => {
    stubFetch(streamingResponse([sse("trace_step", { step: {} }), sse("done", {})]));

    await expect(streamChat(request)).rejects.toThrow(/without a result/);
  });
});

describe("streamChatAnswer", () => {
  test("resolves with the /chat body", async () => {
    stubFetch(streamingResponse([sse("result", { body: { agentAnswer: "Final" }, status: 200 })]));

    await expect(streamChatAnswer(request)).resolves.toEqual({ agentAnswer: "Final" });
  });

  test("rejects a non-2xx result like requestChat would", async () => {
    stubFetch(
      streamingResponse([sse("result", { body: { error: { message: "Bad scope." } }, status: 400 })])
    );

    await expect(streamChatAnswer(request)).rejects.toMatchObject({
      message: "Bad scope.",
      response: { data: { error: { message: "Bad scope." } }, status: 400 },
    });
  });
});
