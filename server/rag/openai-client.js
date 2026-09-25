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
    if (cause?.name === "TimeoutError") {
      // Tagged like a socket timeout so the retry policy treats it as transient.
      const error = new Error(`Request timed out after ${timeoutMs} ms.`);
      error.code = "ETIMEDOUT";
      error.cause = cause;
      throw error;
    }

    throw cause;
  }

  if (!response.ok) {
    const errorMessage = parseErrorBody(text);
    const error = new Error(errorMessage);
    error.status = response.status;
    error.retryAfterMs = parseRetryAfterMs(response.headers);
    throw error;
  }

  return JSON.parse(text);
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

export const createChatClient = ({ apiKey, model }) => ({
  async invoke(prompt, { responseFormat } = {}) {
    const baseUrl = resolveBaseUrl();
    let messages;

    if (typeof prompt === "string") {
      messages = [{ role: "user", content: prompt }];
    } else if (Array.isArray(prompt?.messages)) {
      messages = prompt.messages.map((m) => ({
        role: m.role === "system" ? "system" : m.role === "human" ? "user" : "user",
        content: m.content,
      }));
    } else if (Array.isArray(prompt)) {
      messages = prompt.map((m) => ({
        role: m.role === "system" ? "system" : m.role === "human" ? "user" : "user",
        content: typeof m.content === "string" ? m.content : "",
      }));
    } else {
      messages = [{ role: "user", content: String(prompt ?? "") }];
    }

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
});
