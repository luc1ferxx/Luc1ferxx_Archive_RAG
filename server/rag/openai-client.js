const DEFAULT_TIMEOUT_MS = 120000;
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

const fetchJson = async (url, options) => {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  const text = await response.text();

  if (!response.ok) {
    const errorMessage = parseErrorBody(text);
    const error = new Error(errorMessage);
    error.status = response.status;
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
      const result = await fetchJson(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input: batch, model }),
      });
      const sorted = result.data.sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        allVectors.push(item.embedding);
      }
    }

    return allVectors;
  },

  async embedQuery(text) {
    const baseUrl = resolveBaseUrl();
    const result = await fetchJson(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: text, model }),
    });
    return result.data[0].embedding;
  },
});

export const createChatClient = ({ apiKey, model }) => ({
  async invoke(prompt) {
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

    const result = await fetchJson(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
    });

    return {
      content: result.choices?.[0]?.message?.content ?? "",
      usage: result.usage ?? null,
    };
  },
});
