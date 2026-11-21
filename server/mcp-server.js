import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getJson } from "serpapi";

const SERPAPI_KEY = process.env.SERPAPI_KEY;

const server = new McpServer({
  name: "serpapi-search",
  version: "1.0.0",
});

const formatSearchResults = (query, results, limit) => {
  const answerBox = results.answer_box
    ? {
        title: results.answer_box.title ?? null,
        answer:
          results.answer_box.answer ??
          results.answer_box.snippet ??
          results.answer_box.highlighted_words?.join(", ") ??
          null,
        source: results.answer_box.source ?? null,
        link: results.answer_box.link ?? null,
      }
    : null;

  const organicResults = (results.organic_results ?? [])
    .slice(0, limit)
    .map((result, index) => ({
      rank: index + 1,
      title: result.title ?? "Untitled result",
      link: result.link ?? null,
      snippet: result.snippet ?? null,
      source: result.source ?? null,
    }));

  return {
    query,
    answerBox,
    organicResults,
  };
};

server.registerTool(
  "search_web",
  {
    description:
      "Search the web using SerpAPI. Returns a compact list of top search results.",
    inputSchema: {
      query: z.string().describe("The search query to execute"),
      num: z
        .number()
        .optional()
        .describe("Number of results to return (default: 5)"),
    },
  },
  // An isError result's text is the reason the web search step fails with
  // (chat-mcp.js); the model never answers it.
  async ({ query, num = 5 }) => {
    if (!SERPAPI_KEY) {
      return {
        content: [
          {
            type: "text",
            text: "Web search is not configured: SERPAPI_KEY is not set.",
          },
        ],
        isError: true,
      };
    }

    try {
      const results = await getJson({
        engine: "google",
        q: query,
        num,
        api_key: SERPAPI_KEY,
      });

      const formattedResults = formatSearchResults(query, results, num);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formattedResults, null, 2),
          },
        ],
      };
    } catch (error) {
      // The reason is the user's (chat-mcp.js fails the step with it), so it
      // names the kind of failure only: serpapi rejects an answer other than
      // 200 (a bad key, no searches left) with SerpAPI's body, anything else
      // (a network error naming hosts, a timeout) with an Error. The cause
      // goes to this process's stderr, which is the server's.
      console.error("SerpAPI search failed.", error);

      return {
        content: [
          {
            type: "text",
            text: `Error performing web search: ${
              error instanceof Error ? "the request to SerpAPI failed." : "SerpAPI answered with an error."
            }`,
          },
        ],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SerpAPI MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in MCP server:", error);
  process.exit(1);
});

export default server;
