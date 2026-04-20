import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.js";

const startServer = async (app) => {
  const server = createServer(app);

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
};

test("upload flow stores chunks, completes ingestion, and deletes documents", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentai-app-test-"));
  const uploadsDirectory = path.join(tempRoot, "uploads");
  const uploadSessionDirectory = path.join(tempRoot, "upload-sessions");
  const documents = new Map();
  let mergedContent = null;

  const ragService = {
    chat: async () => ({
      text: "stub",
      citations: [],
    }),
    clearDocuments: async () => {
      const cleared = [...documents.values()];
      documents.clear();
      return cleared;
    },
    clearSessionMemory: () => true,
    deleteDocument: async (docId) => {
      const document = documents.get(docId) ?? null;
      documents.delete(docId);
      return document;
    },
    getDocument: (docId) => documents.get(docId) ?? null,
    ingestDocument: async ({ docId, filePath, fileName }) => {
      mergedContent = await readFile(filePath, "utf8");
      const document = {
        docId,
        fileName,
        filePath,
        publicFilePath: `uploads/${path.basename(filePath)}`,
        pageCount: 1,
        chunkCount: 1,
        uploadedAt: new Date().toISOString(),
      };

      documents.set(docId, document);
      return document;
    },
    listDocuments: () => [...documents.values()],
  };

  const app = await createApp({
    ragService,
    chatMcp: async () => ({
      text: "web",
    }),
    uploadSessionDirectory,
    uploadsDirectory,
  });
  const server = await startServer(app);

  try {
    const fileId = "test-file-id";
    const content = "fake-pdf-content";

    let response = await fetch(`${server.baseUrl}/upload/init`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileId,
        fileName: "notes.pdf",
        fileSize: content.length,
        lastModified: 0,
        totalChunks: 2,
        chunkSize: 8,
      }),
    });

    assert.equal(response.status, 201);

    const chunkOne = new FormData();
    chunkOne.append("fileId", fileId);
    chunkOne.append("chunkIndex", "0");
    chunkOne.append("totalChunks", "2");
    chunkOne.append("chunk", new Blob([content.slice(0, 8)]), "notes.pdf.part-0");

    response = await fetch(`${server.baseUrl}/upload/chunk`, {
      method: "POST",
      body: chunkOne,
    });

    assert.equal(response.status, 201);

    const chunkTwo = new FormData();
    chunkTwo.append("fileId", fileId);
    chunkTwo.append("chunkIndex", "1");
    chunkTwo.append("totalChunks", "2");
    chunkTwo.append("chunk", new Blob([content.slice(8)]), "notes.pdf.part-1");

    response = await fetch(`${server.baseUrl}/upload/chunk`, {
      method: "POST",
      body: chunkTwo,
    });

    assert.equal(response.status, 201);

    response = await fetch(`${server.baseUrl}/upload/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileId,
      }),
    });

    assert.equal(response.status, 201);
    const uploadedDocument = await response.json();
    assert.equal(uploadedDocument.fileName, "notes.pdf");
    assert.equal(mergedContent, content);

    response = await fetch(`${server.baseUrl}/documents`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).length, 1);

    response = await fetch(
      `${server.baseUrl}/documents/${uploadedDocument.docId}`,
      {
        method: "DELETE",
      }
    );

    assert.equal(response.status, 200);
    assert.equal(documents.size, 0);
  } finally {
    await server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("chat endpoint exposes explicit rag abstain fields", async () => {
  const documents = new Map([
    [
      "doc-1",
      {
        docId: "doc-1",
        fileName: "notes.pdf",
      },
    ],
  ]);
  const app = await createApp({
    ragService: {
      chat: async () => ({
        text: "I couldn't find enough grounded evidence that specifically addresses NULPAR-DZ in the uploaded documents.",
        citations: [],
        abstained: true,
        abstainReason:
          "I couldn't find enough grounded evidence that specifically addresses NULPAR-DZ in the uploaded documents.",
        resolvedQuery: "What is the NULPAR-DZ allocation amount?",
        memoryApplied: false,
      }),
      clearDocuments: async () => [],
      clearSessionMemory: () => true,
      deleteDocument: async () => null,
      getDocument: (docId) => documents.get(docId) ?? null,
      ingestDocument: async () => null,
      listDocuments: () => [...documents.values()],
    },
    chatMcp: async () => ({
      text: "web",
    }),
  });
  const server = await startServer(app);

  try {
    const response = await fetch(`${server.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        docId: "doc-1",
        question: "What is the NULPAR-DZ allocation amount?",
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.ragAbstained, true);
    assert.match(body.ragAbstainReason, /NULPAR-DZ/);
    assert.equal(body.ragResolvedQuestion, "What is the NULPAR-DZ allocation amount?");
  } finally {
    await server.close();
  }
});
