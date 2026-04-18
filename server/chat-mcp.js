import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { PromptTemplate } from "@langchain/core/prompts";
import { completeText } from "./rag/openai.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let client = null;
let transport = null;
let isConnecting = false;
let connectionPromise = null;
const RETRY_DELAYS_MS = [250, 750];

const sleep = (durationMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

const getOpenAIApiKey = () => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    const error = new Error("OPENAI_API_KEY is not configured.");
    error.status = 500;
    throw error;
  }

  return apiKey;
};

const ensureConnected = async () => {
  if (client && transport) {
    return;
  }

  if (isConnecting && connectionPromise) {
    await connectionPromise;
    return;
  }

  isConnecting = true;
  connectionPromise = (async () => {
    try {
      client = new Client({
        name: "chat-client",
        version: "1.0.0",
      });

      const serverPath = join(__dirname, "mcp-server.js");

      transport = new StdioClientTransport({
        command: "node",
        args: [serverPath],
        env: {
          ...process.env,
        },
      });

      await client.connect(transport);
    } finally {
      isConnecting = false;
      connectionPromise = null;
    }
  })();

  await connectionPromise;
};

const withRetry = async (operation) => {
  let lastError = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === RETRY_DELAYS_MS.length) {
        break;
      }

      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError;
};

const chatMCP = async (query) => {
  getOpenAIApiKey();

  try {
    await ensureConnected();

    const toolResult = await withRetry(() =>
      client.callTool({
        name: "search_web",
        arguments: {
          query,
          num: 5,
        },
      })
    );

    const searchResults =
      toolResult.content && toolResult.content.length > 0
        ? toolResult.content[0].text
        : "No search results available";

    const answerTemplate = `Use the search results to answer the user's question.
Be concise and say when the results are insufficient.
When possible, mention the source titles directly in the answer.

Question:
{question}

Search Results:
{searchResults}

Helpful Answer:`;

    const prompt = PromptTemplate.fromTemplate(answerTemplate);
    const formattedPrompt = await prompt.format({
      question: query,
      searchResults,
    });
    const text = await completeText(formattedPrompt);

    return { text };
  } catch (error) {
    if (client) {
      try {
        await client.close();
      } catch (cleanupError) {
        // Ignore cleanup errors so the original failure is preserved.
      }
      client = null;
      transport = null;
    }

    throw error;
  }
};

export default chatMCP;
