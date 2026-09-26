// Exposes the archive's planner-free document RAG to external agent runtimes
// (opencode, Claude Code, Cursor, ...) over stdio MCP.
//
// This server deliberately calls `chat()` from server/chat.js rather than the
// HTTP `POST /chat` route: that route runs the AgentRAG planner, and the point
// of this bridge is to let the *calling* agent do the planning while the
// archive supplies grounded, page-cited evidence. Stacking two planners would
// be both slower and harder to attribute.
//
// It is read-only on purpose. The local vector index is a single JSON file
// rewritten wholesale on write (server/rag/vector-store-local.js), so a second
// writer would clobber the workbench's index. Ingestion stays in the web app.
//
// With DOCCOMPARE_STANDALONE=1 it runs against the file-backed registry instead
// of PostgreSQL (server/standalone-profile.js), which is what makes an
// install-and-go product possible. Without it, behaviour is unchanged, so the
// existing web workbench is unaffected either way.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import chat, { initializeDocumentRegistry, listDocuments } from "./chat.js";
import { resetDocumentRegistry } from "./rag/doc-registry.js";
import { runWithDatabaseTenant } from "./rag/postgres-tenant.js";
import { resetVectorStore } from "./rag/vector-store.js";
import {
  applyStandaloneProfile,
  isStandaloneProfileEnabled,
} from "./standalone-profile.js";

import {
  buildEmptyArchiveResult,
  formatAskResult,
  formatDocumentList,
  formatToolError,
  resolveDocIds,
  toMcpTextContent,
} from "./archive-mcp-tools.js";

// Safe to apply here rather than before the imports above: every setting the
// profile touches is read lazily. See the constraint noted in that module.
const standaloneProfile = isStandaloneProfileEnabled()
  ? applyStandaloneProfile()
  : null;

const server = new McpServer({
  name: "archive",
  version: "1.0.0",
});

// The registry and vector index are in-process snapshots, so this server sees
// whatever the archive held when it started. `archive_refresh` reloads both.
const buildAccessScope = () => ({
  userId: process.env.ARCHIVE_MCP_USER_ID?.trim() || null,
  workspaceId: process.env.ARCHIVE_MCP_WORKSPACE_ID?.trim() || null,
});

const loadDocuments = async () => {
  await initializeDocumentRegistry();
  return listDocuments(buildAccessScope());
};

// opencode (and other MCP clients) prefix tool names with the server name, so
// these are registered unprefixed and surface as archive_ask,
// archive_list_documents and archive_refresh.
server.registerTool(
  "ask",
  {
    description:
      "Ask the PDF archive a question and get an answer grounded in page-level citations. " +
      "Returns { abstained, abstainReason, answer, citations[], evidence[] }. " +
      "Each citation carries fileName, pageNumber, chunkIndex, rank, score, excerpt and sectionHeading; " +
      "evidence[] carries the full chunk text. " +
      "Pass two or more docIds to get a structured comparison instead of a single-document answer. " +
      "IMPORTANT: when abstained is true the archive has no sufficient evidence — report abstainReason " +
      "verbatim and do not invent an answer, a page number, or a quotation. Never cite a page that is not " +
      "present in citations[].",
    inputSchema: {
      question: z.string().describe("The question to answer from the archive."),
      docIds: z
        .array(z.string())
        .optional()
        .describe(
          "Restrict the search to these document ids. Omit to search every document. Two or more triggers comparison mode."
        ),
      includeEvidence: z
        .boolean()
        .optional()
        .describe("Include full chunk text in evidence[] (default true)."),
    },
  },
  async ({ question, docIds, includeEvidence = true }) => {
    try {
      const documents = await loadDocuments();
      const resolvedDocIds = resolveDocIds({
        docIds,
        availableDocuments: documents,
      });

      if (resolvedDocIds.length === 0) {
        return toMcpTextContent(buildEmptyArchiveResult());
      }

      // The configured principal is also the database tenant, so retrieval is
      // held to it by row-level security as well as by the registry filter.
      const accessScope = buildAccessScope();
      const response = await runWithDatabaseTenant(accessScope, () =>
        chat(resolvedDocIds, question, {
          includeRetrievedContexts: includeEvidence,
          accessScope,
        })
      );

      return toMcpTextContent(formatAskResult(response));
    } catch (error) {
      return toMcpTextContent(formatToolError(error));
    }
  }
);

server.registerTool(
  "list_documents",
  {
    description:
      "List the documents currently in the archive, with docId, fileName, pageCount and chunkCount. " +
      "Call this first to discover docIds before asking a scoped or comparison question.",
    inputSchema: {},
  },
  async () => {
    try {
      const documents = await loadDocuments();

      return toMcpTextContent({
        documentCount: documents.length,
        documents: formatDocumentList(documents),
      });
    } catch (error) {
      return toMcpTextContent(formatToolError(error));
    }
  }
);

server.registerTool(
  "refresh",
  {
    description:
      "Reload the archive's document registry and vector index from storage. " +
      "Use this after uploading a PDF in the web workbench, otherwise the newly uploaded document " +
      "stays invisible to this session.",
    inputSchema: {},
  },
  async () => {
    try {
      await resetDocumentRegistry();
      resetVectorStore();
      const documents = await loadDocuments();

      return toMcpTextContent({
        refreshed: true,
        documentCount: documents.length,
        documents: formatDocumentList(documents),
      });
    } catch (error) {
      return toMcpTextContent(formatToolError(error));
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    standaloneProfile
      ? "Archive RAG MCP Server running on stdio (standalone: filesystem registry, no PostgreSQL)"
      : "Archive RAG MCP Server running on stdio"
  );
}

main().catch((error) => {
  console.error("Fatal error in archive MCP server:", error);
  process.exit(1);
});

export default server;
