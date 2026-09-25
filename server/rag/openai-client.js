import { getLlmRequestTimeoutMs } from "./config.js";
import { guardModelCall } from "./model-call-guard.js";

const EMBEDDING_BATCH_SIZE = 512;

const resolveBaseUrl = () => {
  const envUrl = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE;
  if (envUrl) return envUrl.replace(/\/+$/, "");
  return "https://api.openai.com/v1";
};

const parseErrorBody = (body) => {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message || parsed?.message || body;
  } catch {
    return body;
  }
};

// How long the server asked us to wait, from retry-after-ms (milliseconds) or
// retry-after (seconds or an HTTP date). Null when it did not say.
export const parseRetryAfterMs = (headers, now = Date.now()) => {
  // Presence first: Number(null) is 0, which would read a missing header as
  // "retry immediately".
  const rawMilliseconds = String(headers?.get?.("retry-after-ms") ?? "").trim();
  const milliseconds = rawMilliseconds ? Number(rawMilliseconds) : NaN;

  if (Number.isFinite(milliseconds) && milliseconds >= 0) {
    return milliseconds;
  }

  const retryAfter = String(headers?.get?.("retry-after") ?? "").trim();

  if (!retryAfter) {
    return null;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(retryAfter);

  return Number.isFinite(date) ? Math.max(0, date - now) : null;
};

// Tagged like a socket timeout so the retry policy treats it as transient.
const toTimeoutError = (cause, timeoutMs) => {
  if (cause?.name !== "TimeoutError") {
    return cause;
  }

  const error = new Error(`Request timed out after ${timeoutMs} ms.`);
  error.code = "ETIMEDOUT";
  error.cause = cause;
  return error;
};

const toHttpError = (response, text) => {
  const error = new Error(parseErrorBody(text));
  error.status = response.status;
  error.retryAfterMs = parseRetryAfterMs(response.headers);
  return error;
};

const fetchJson = async (url, options) => {
  const timeoutMs = getLlmRequestTimeoutMs();
  let response;
  let text;

  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The same signal also bounds reading the body.
    text = await response.text();
  } catch (cause) {
    throw toTimeoutError(cause, timeoutMs);
  }

  if (!response.ok) {
    throw toHttpError(response, text);
  }

  return JSON.parse(text);
};

/**
 * Reads an OpenAI-style chat completion stream (server-sent `data:` lines,
 * ending with `data: [DONE]`), calling onDelta with each piece of content as it
 * arrives, and resolves with the same shape a non-streaming call returns. The
 * request timeout bounds the whole stream, not just the first byte.
 */
const fetchChatStream = async (url, options, onDelta) => {
  const timeoutMs = getLlmRequestTimeoutMs();
  let content = "";
  let finishReason = null;
  let usage = null;

  const handleLine = (line) => {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) {
      return;
    }

    const payload = trimmed.slice(5).trim();

    if (!payload || payload === "[DONE]") {
      return;
    }

    const chunk = JSON.parse(payload);
    const choice = chunk.choices?.[0];
    const delta = choice?.delta?.content;

    if (typeof delta === "string" && delta.length > 0) {
      content += delta;
      onDelta?.(delta);
    }

    finishReason = choice?.finish_reason ?? finishReason;
    usage = chunk.usage ?? usage;
  };

  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw toHttpError(response, await response.text());
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      lines.forEach(handleLine);
    }

    handleLine(buffer + decoder.decode());
  } catch (cause) {
    throw toTimeoutError(cause, timeoutMs);
  }

  return { content, finishReason, usage };
};

export const createEmbeddingsClient = ({ apiKey, model }) => ({
  async embedDocuments(texts) {
    const baseUrl = resolveBaseUrl();
    const allVectors = [];

    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
      const result = await guardModelCall(`${baseUrl}|${model}`, () =>
        fetchJson(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ input: batch, model }),
        })
      );
      const sorted = result.data.sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        allVectors.push(item.embedding);
      }
    }

    return allVectors;
  },

  async embedQuery(text) {
    const baseUrl = resolveBaseUrl();
    const result = await guardModelCall(`${baseUrl}|${model}`, () =>
      fetchJson(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input: text, model }),
      })
    );
    return result.data[0].embedding;
  },
});

const toChatMessages = (prompt) => {
  if (typeof prompt === "string") {
    return [{ role: "user", content: prompt }];
  }

  if (Array.isArray(prompt?.messages)) {
    return prompt.messages.map((m) => ({
      role: m.role === "system" ? "system" : m.role === "human" ? "user" : "user",
      content: m.content,
    }));
  }

  if (Array.isArray(prompt)) {
    return prompt.map((m) => ({
      role: m.role === "system" ? "system" : m.role === "human" ? "user" : "user",
      content: typeof m.content === "string" ? m.content : "",
    }));
  }

  return [{ role: "user", content: String(prompt ?? "") }];
};

export const createChatClient = ({ apiKey, model }) => ({
  async invoke(prompt, { responseFormat } = {}) {
    const baseUrl = resolveBaseUrl();
    const messages = toChatMessages(prompt);

    // Every request, including each retry, passes the endpoint's circuit and
    // concurrency cap; see model-call-guard.js.
    const result = await guardModelCall(`${baseUrl}|${model}`, () =>
      fetchJson(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          ...(responseFormat ? { response_format: responseFormat } : {}),
        }),
      })
    );

    return {
      content: result.choices?.[0]?.message?.content ?? "",
      finishReason: result.choices?.[0]?.finish_reason ?? null,
      usage: result.usage ?? null,
    };
  },

  // Same request with `stream: true`. include_usage asks for a final usage
  // chunk; servers that ignore it leave usage null and LLMOps estimates it.
  async invokeStream(prompt, { onDelta, responseFormat } = {}) {
    const baseUrl = resolveBaseUrl();

    return guardModelCall(`${baseUrl}|${model}`, () =>
      fetchChatStream(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: toChatMessages(prompt),
            stream: true,
            stream_options: { include_usage: true },
            ...(responseFormat ? { response_format: responseFormat } : {}),
          }),
        },
        onDelta
      )
    );
  },
});
