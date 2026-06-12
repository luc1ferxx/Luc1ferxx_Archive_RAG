import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildArxivPdfFileName,
  importArxivPapers,
  importArxivTopic,
} from "../rag/arxiv-importer.js";

const createPaper = (overrides = {}) => ({
  arxivId: "2401.00001v1",
  title: "Retrieval Augmented Generation for Archives",
  summary: "A paper about RAG.",
  authors: ["Alice Author"],
  absUrl: "https://arxiv.org/abs/2401.00001v1",
  pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
  published: "2024-01-01T00:00:00Z",
  updated: "2024-01-03T00:00:00Z",
  primaryCategory: "cs.IR",
  categories: ["cs.IR"],
  ...overrides,
});

test("arxiv importer downloads PDFs into scoped document ingestion", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "arxiv-importer-"));
  const ingested = [];
  const pdfBuffer = Buffer.from("%PDF-1.7 fake");
  const paper = createPaper();

  try {
    const result = await importArxivTopic({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      arxivService: {
        search: async ({ maxResults, topic }) => {
          assert.equal(topic, "retrieval augmented generation");
          assert.equal(maxResults, 1);
          return [paper];
        },
        downloadPdf: async (requestedPaper) => {
          assert.equal(requestedPaper.arxivId, paper.arxivId);
          return pdfBuffer;
        },
      },
      delayMs: 0,
      maxResults: 1,
      ragService: {
        ingestDocument: async ({
          docId,
          fileName,
          filePath,
          ownerUserId,
          workspaceId,
        }) => {
          ingested.push({
            content: await readFile(filePath, "utf8"),
            docId,
            fileName,
            ownerUserId,
            workspaceId,
          });

          return {
            docId,
            fileName,
          };
        },
        listDocuments: () => [],
      },
      tempDirectory,
      topic: "retrieval augmented generation",
    });

    assert.equal(result.importedCount, 1);
    assert.equal(result.failedCount, 0);
    assert.equal(ingested[0].content, "%PDF-1.7 fake");
    assert.equal(ingested[0].ownerUserId, "alice");
    assert.equal(ingested[0].workspaceId, "workspace-a");
    assert.equal(ingested[0].fileName, buildArxivPdfFileName(paper));
  } finally {
    await rm(tempDirectory, {
      recursive: true,
      force: true,
    });
  }
});

test("arxiv importer imports provided papers without running search", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "arxiv-importer-"));
  const paper = createPaper();
  const ingested = [];

  try {
    const result = await importArxivPapers({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      arxivService: {
        search: async () => {
          throw new Error("search should not run for selected papers");
        },
        downloadPdf: async (requestedPaper) => {
          assert.equal(requestedPaper.arxivId, paper.arxivId);
          return Buffer.from("%PDF-1.7 selected");
        },
      },
      delayMs: 0,
      maxResults: 1,
      papers: [paper],
      ragService: {
        ingestDocument: async ({ docId, fileName, ownerUserId, workspaceId }) => {
          ingested.push({
            docId,
            fileName,
            ownerUserId,
            workspaceId,
          });

          return {
            docId,
            fileName,
          };
        },
        listDocuments: () => [],
      },
      tempDirectory,
      topic: "retrieval augmented generation",
    });

    assert.equal(result.foundCount, 1);
    assert.equal(result.importedCount, 1);
    assert.equal(ingested[0].fileName, buildArxivPdfFileName(paper));
    assert.equal(ingested[0].ownerUserId, "alice");
    assert.equal(ingested[0].workspaceId, "workspace-a");
  } finally {
    await rm(tempDirectory, {
      recursive: true,
      force: true,
    });
  }
});

test("arxiv importer skips papers already indexed in scope", async () => {
  const paper = createPaper();
  const fileName = buildArxivPdfFileName(paper);
  let downloadCalled = false;

  const result = await importArxivTopic({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    arxivService: {
      search: async () => [paper],
      downloadPdf: async () => {
        downloadCalled = true;
        return Buffer.from("%PDF-1.7 fake");
      },
    },
    delayMs: 0,
    ragService: {
      ingestDocument: async () => {
        throw new Error("ingest should not run for existing papers");
      },
      listDocuments: () => [
        {
          docId: "doc-existing",
          fileName,
        },
      ],
    },
    topic: "retrieval augmented generation",
  });

  assert.equal(downloadCalled, false);
  assert.equal(result.importedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.skippedPapers[0].docId, "doc-existing");
});
