import test from "node:test";
import assert from "node:assert/strict";

import {
  clearDocuments,
  createDocumentRegistryStore,
  configureDocumentRegistryStore,
  deleteDocument,
  getDocument,
  getDocumentFile,
  getDocuments,
  getStoredDocument,
  hasDocument,
  initializeDocumentRegistry,
  listDocuments,
  normalizeDocIds,
  registerDocument,
  resetDocumentRegistryStore,
} from "../rag/doc-registry.js";

const normalizeId = (docId) => String(docId ?? "").trim();

const documentMatchesScope = (document = {}, accessScope = {}) => {
  const userId = String(accessScope.userId ?? "").trim();
  const workspaceId = String(accessScope.workspaceId ?? "").trim();

  if (!userId && !workspaceId) {
    return true;
  }

  if (!document.ownerUserId && !document.workspaceId) {
    return false;
  }

  if (document.ownerUserId && document.ownerUserId !== userId) {
    return false;
  }

  if (document.workspaceId && document.workspaceId !== workspaceId) {
    return false;
  }

  return true;
};

const createRegistryStore = (seedDocuments = []) => {
  const calls = [];
  const documents = new Map(
    seedDocuments.map((document) => [normalizeId(document.docId), document])
  );

  return {
    calls,
    async clear(accessScope = {}) {
      calls.push(["clear", accessScope]);

      for (const [docId, document] of documents.entries()) {
        if (documentMatchesScope(document, accessScope)) {
          documents.delete(docId);
        }
      }

      return true;
    },
    async delete(docId, accessScope = {}) {
      calls.push(["delete", normalizeId(docId), accessScope]);
      const normalizedDocId = normalizeId(docId);
      const document = documents.get(normalizedDocId);

      if (!document || !documentMatchesScope(document, accessScope)) {
        return null;
      }

      documents.delete(normalizedDocId);
      return document;
    },
    async getFile(docId, accessScope = {}) {
      calls.push(["getFile", normalizeId(docId), accessScope]);
      const document = documents.get(normalizeId(docId));

      if (!document || !documentMatchesScope(document, accessScope)) {
        return null;
      }

      return {
        document,
        fileBuffer: Buffer.from(`file:${document.docId}`),
        fileName: document.fileName,
        fileSize: Number(document.fileSize) || 0,
        mimeType: document.mimeType ?? "application/pdf",
      };
    },
    async initialize() {
      calls.push(["initialize"]);
      return true;
    },
    async list(accessScope = {}) {
      calls.push(["list", accessScope]);
      return [...documents.values()].filter((document) =>
        documentMatchesScope(document, accessScope)
      );
    },
    async reset() {
      calls.push(["reset"]);
      documents.clear();
    },
    async upsert(document) {
      calls.push(["upsert", document]);
      const normalizedDocument = {
        ...document,
        docId: normalizeId(document.docId),
        fileName: String(document.fileName ?? "").trim(),
      };

      documents.set(normalizedDocument.docId, normalizedDocument);
      return normalizedDocument;
    },
  };
};

test("document registry normalizes public documents and enforces access scope", async () => {
  const store = createRegistryStore([
    {
      docId: " doc-b ",
      fileName: "Beta.pdf",
      filePath: "/private/beta.pdf",
      fileSize: "20",
      chunkCount: "2",
      pageCount: "1",
      ownerUserId: "bob",
      workspaceId: "workspace-b",
      uploadedAt: "2024-02-01T00:00:00.000Z",
      profile: {
        summary: "Beta summary",
        tags: ["beta", "beta", ""],
        entities: ["Vendor"],
      },
    },
    {
      docId: "doc-a",
      fileName: " Alpha.pdf ",
      mimeType: "",
      fileSize: "bad",
      chunkCount: "4",
      pageCount: "3",
      ownerUserId: "alice",
      workspaceId: "workspace-a",
      uploadedAt: "2024-01-01T00:00:00.000Z",
      source: {
        sourceType: "arxiv",
        arxivId: "2401.00001v1",
        absUrl: "https://arxiv.org/abs/2401.00001v1",
        pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
        relatedToDocId: "source-doc",
        titleHash: "hash-1",
        importedByUserConfirmation: true,
      },
      summary: "Alpha summary",
      tags: ["alpha", "risk", "alpha", " "],
      entities: ["Alice", "Alice", "Policy"],
    },
    {
      docId: "doc-public",
      fileName: "Public.pdf",
      source: "not-an-object",
      uploadedAt: "2024-03-01T00:00:00.000Z",
    },
  ]);
  configureDocumentRegistryStore(store);

  try {
    const initializedDocuments = await initializeDocumentRegistry();

    assert.deepEqual(
      initializedDocuments.map((document) => document.docId),
      ["doc-a", "doc-b", "doc-public"]
    );
    assert.equal(initializedDocuments[0].fileName, "Alpha.pdf");
    assert.equal(initializedDocuments[0].filePath, "documents/doc-a/file");
    assert.equal(initializedDocuments[0].publicFilePath, "documents/doc-a/file");
    assert.equal(initializedDocuments[0].mimeType, "application/pdf");
    assert.equal(initializedDocuments[0].fileSize, 0);
    assert.deepEqual(initializedDocuments[0].tags, ["alpha", "risk"]);
    assert.deepEqual(initializedDocuments[0].entities, ["Alice", "Policy"]);
    assert.equal(initializedDocuments[0].storageBackend, "postgresql");
    assert.equal("ownerUserId" in initializedDocuments[0], false);
    assert.deepEqual(initializedDocuments[0].source, {
      sourceType: "arxiv",
      arxivId: "2401.00001v1",
      absUrl: "https://arxiv.org/abs/2401.00001v1",
      pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
      relatedToDocId: "source-doc",
      titleHash: "hash-1",
      importedByUserConfirmation: true,
    });
    assert.deepEqual(normalizeDocIds(" doc-a,doc-a,, doc-b "), [
      "doc-a",
      "doc-b",
    ]);
    assert.deepEqual(normalizeDocIds(["doc-a", " ", "doc-a", "doc-b"]), [
      "doc-a",
      "doc-b",
    ]);
    assert.deepEqual(normalizeDocIds(null), []);
    assert.equal(getDocument("doc-public").source, null);
    assert.equal(hasDocument(" doc-a "), true);
    assert.equal(
      getDocument("doc-a", {
        userId: "alice",
        workspaceId: "workspace-a",
      }).summary,
      "Alpha summary"
    );
    assert.equal(
      getDocument("doc-a", {
        userId: "bob",
        workspaceId: "workspace-b",
      }),
      null
    );
    assert.equal(
      getDocument("doc-a", {
        userId: "alice",
        workspaceId: "workspace-b",
      }),
      null
    );
    assert.equal(
      getStoredDocument("doc-b", {
        userId: "alice",
        workspaceId: "workspace-a",
      }),
      null
    );
    assert.deepEqual(
      getDocuments("doc-a,doc-b,missing,doc-a", {
        userId: "alice",
        workspaceId: "workspace-a",
      }).map((document) => document.docId),
      ["doc-a"]
    );
    assert.deepEqual(
      listDocuments({
        userId: "bob",
        workspaceId: "workspace-b",
      }).map((document) => document.docId),
      ["doc-b"]
    );
  } finally {
    await resetDocumentRegistryStore();
  }
});

test("document registry writes, files, deletes, and clears through the configured store", async () => {
  const store = createRegistryStore([
    {
      docId: "doc-a",
      fileName: "Alpha.pdf",
      ownerUserId: "alice",
      workspaceId: "workspace-a",
      uploadedAt: "2024-01-01T00:00:00.000Z",
    },
    {
      docId: "doc-b",
      fileName: "Beta.pdf",
      ownerUserId: "bob",
      workspaceId: "workspace-b",
      uploadedAt: "2024-02-01T00:00:00.000Z",
    },
  ]);
  configureDocumentRegistryStore(store);

  try {
    await initializeDocumentRegistry();

    const registeredDocument = await registerDocument({
      docId: " doc-c ",
      fileName: " Gamma.pdf ",
      fileSize: "bad",
      chunkCount: "2",
      pageCount: "3",
      ownerUserId: "alice",
      workspaceId: "workspace-a",
      tags: ["gamma", "gamma", "risk"],
      uploadedAt: "2024-03-01T00:00:00.000Z",
    });

    assert.equal(registeredDocument.docId, "doc-c");
    assert.equal(registeredDocument.fileName, "Gamma.pdf");
    assert.equal(registeredDocument.fileSize, 0);
    assert.deepEqual(registeredDocument.tags, ["gamma", "risk"]);
    assert.equal(store.calls.some((call) => call[0] === "upsert"), true);

    const storedFile = await getDocumentFile("doc-c", {
      userId: "alice",
      workspaceId: "workspace-a",
    });

    assert.equal(storedFile.fileName, "Gamma.pdf");
    assert.equal(storedFile.fileBuffer.toString("utf8"), "file:doc-c");

    assert.equal(
      await deleteDocument("doc-c", {
        userId: "bob",
        workspaceId: "workspace-b",
      }),
      null
    );
    assert.equal(hasDocument("doc-c"), true);

    const deletedDocument = await deleteDocument("doc-c", {
      userId: "alice",
      workspaceId: "workspace-a",
    });

    assert.equal(deletedDocument.docId, "doc-c");
    assert.equal(hasDocument("doc-c"), false);
    assert.deepEqual(
      store.calls
        .filter((call) => call[0] === "delete")
        .map((call) => [call[1], call[2].userId]),
      [["doc-c", "alice"]]
    );

    const clearedDocuments = await clearDocuments({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
    });

    assert.deepEqual(
      clearedDocuments.map((document) => document.docId),
      ["doc-a"]
    );
    assert.equal(getDocument("doc-a"), null);
    assert.equal(getDocument("doc-b").docId, "doc-b");

    const allClearedDocuments = await clearDocuments();

    assert.deepEqual(
      allClearedDocuments.map((document) => document.docId),
      ["doc-b"]
    );
    assert.deepEqual(listDocuments(), []);
  } finally {
    await resetDocumentRegistryStore();
  }
});

test("PostgreSQL document registry store applies migrations, legacy import, and scoped SQL operations", async () => {
  const queryCalls = [];
  const migrationCalls = [];
  let existingLegacyDocIds = null;
  let emptyLegacyDocIds = null;
  const rows = new Map([
    [
      "alice-doc",
      {
        doc_id: "alice-doc",
        file_name: "Alice.pdf",
        mime_type: "application/pdf",
        file_size: 12,
        file_bytes: Buffer.from("alice-pdf"),
        chunk_count: 2,
        page_count: 3,
        owner_user_id: "alice",
        workspace_id: "workspace-a",
        profile: {
          summary: "Alice summary",
        },
        uploaded_at: "2024-01-01T00:00:00.000Z",
      },
    ],
    [
      "bob-doc",
      {
        doc_id: "bob-doc",
        file_name: "Bob.pdf",
        mime_type: "application/pdf",
        file_size: 10,
        file_bytes: Buffer.from("bob-pdf"),
        chunk_count: 1,
        page_count: 1,
        owner_user_id: "bob",
        workspace_id: "workspace-b",
        profile: {},
        uploaded_at: "2024-02-01T00:00:00.000Z",
      },
    ],
  ]);
  const toRow = (values) => ({
    doc_id: values[0],
    file_name: values[1],
    mime_type: values[2],
    file_size: values[3],
    file_bytes: values[4],
    chunk_count: values[5],
    page_count: values[6],
    owner_user_id: values[7],
    workspace_id: values[8],
    profile: values[9],
    uploaded_at: values[10],
  });
  const store = createDocumentRegistryStore({
    createDocumentLegacyImporter: () => ({
      importMissingDocuments: async ({ getExistingDocIds, upsertDocument }) => {
        emptyLegacyDocIds = await getExistingDocIds([]);
        existingLegacyDocIds = await getExistingDocIds([
          "alice-doc",
          "legacy-doc",
        ]);
        await upsertDocument({
          docId: "legacy-doc",
          fileName: "Legacy.pdf",
          fileBuffer: Buffer.from("legacy-pdf"),
          ownerUserId: "alice",
          workspaceId: "workspace-a",
          uploadedAt: "2024-03-01T00:00:00.000Z",
        });
      },
    }),
    getDocumentsTable: () => "rag_documents",
    queryPostgres: async (sql, values = []) => {
      queryCalls.push({
        sql: sql.trim(),
        values,
      });

      if (/SELECT doc_id\s+FROM rag_documents\s+WHERE doc_id = ANY/.test(sql)) {
        return {
          rows: values[0]
            .filter((docId) => rows.has(docId))
            .map((docId) => ({
              doc_id: docId,
            })),
        };
      }

      if (/INSERT INTO rag_documents/.test(sql)) {
        const row = toRow(values);
        rows.set(row.doc_id, row);
        return {
          rows: [row],
        };
      }

      if (/SELECT doc_id, file_name, mime_type, file_size, file_bytes/.test(sql)) {
        return {
          rows: rows.has(values[0]) ? [rows.get(values[0])] : [],
        };
      }

      if (/SELECT doc_id, file_name, mime_type, file_size, chunk_count/.test(sql)) {
        return {
          rows: [...rows.values()],
        };
      }

      if (/DELETE FROM rag_documents\s+WHERE doc_id = ANY/.test(sql)) {
        for (const docId of values[0]) {
          rows.delete(docId);
        }
        return {
          rows: [],
        };
      }

      if (/DELETE FROM rag_documents\s+WHERE doc_id = \$1\s+RETURNING/.test(sql)) {
        const row = rows.get(values[0]);
        rows.delete(values[0]);
        return {
          rows: row ? [row] : [],
        };
      }

      if (/DELETE FROM rag_documents/.test(sql)) {
        rows.clear();
        return {
          rows: [],
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
    readFile: async (filePath) => Buffer.from(`read:${filePath}`),
    runMigrations: async () => {
      migrationCalls.push("run");
    },
  });

  await store.initialize();
  await store.initialize();

  assert.deepEqual(migrationCalls, ["run", "run"]);
  assert.deepEqual([...emptyLegacyDocIds], []);
  assert.deepEqual([...existingLegacyDocIds].sort(), ["alice-doc"]);
  assert.equal(rows.has("legacy-doc"), true);
  assert.equal(rows.get("legacy-doc").file_size, Buffer.byteLength("legacy-pdf"));

  const aliceDocuments = await store.list({
    userId: "alice",
    workspaceId: "workspace-a",
  });

  assert.deepEqual(
    aliceDocuments.map((document) => document.docId),
    ["alice-doc", "legacy-doc"]
  );

  const sourceDocument = await store.upsert({
    docId: "source-doc",
    fileName: "Source.pdf",
    sourceFilePath: "/tmp/source.pdf",
    ownerUserId: "alice",
    workspaceId: "workspace-a",
    uploadedAt: "2024-04-01T00:00:00.000Z",
  });

  assert.equal(sourceDocument.fileSize, Buffer.byteLength("read:/tmp/source.pdf"));

  const uint8Document = await store.upsert({
    docId: "uint8-doc",
    fileName: "Bytes.pdf",
    fileBuffer: new Uint8Array([1, 2, 3]),
    ownerUserId: "alice",
    workspaceId: "workspace-a",
    uploadedAt: "2024-04-02T00:00:00.000Z",
  });

  assert.equal(uint8Document.fileSize, 3);
  await assert.rejects(
    () =>
      store.upsert({
        docId: "",
        fileName: "Missing.pdf",
        fileBuffer: Buffer.from("pdf"),
      }),
    /docId and fileName/
  );

  const storedFile = await store.getFile("source-doc", {
    userId: "alice",
    workspaceId: "workspace-a",
  });

  assert.equal(storedFile.fileName, "Source.pdf");
  assert.equal(storedFile.fileBuffer.toString("utf8"), "read:/tmp/source.pdf");
  assert.equal(await store.getFile(""), null);
  assert.equal(await store.getFile("missing-doc"), null);
  assert.equal(
    await store.getFile("source-doc", {
      userId: "bob",
      workspaceId: "workspace-b",
    }),
    null
  );

  const deletedDocument = await store.delete("source-doc", {
    userId: "alice",
    workspaceId: "workspace-a",
  });

  assert.equal(deletedDocument.docId, "source-doc");
  assert.equal(rows.has("source-doc"), false);
  assert.equal(await store.delete(""), null);
  assert.equal(await store.delete("missing-doc"), null);

  await store.clear({
    userId: "nobody",
    workspaceId: "workspace-z",
  });

  await store.clear({
    userId: "alice",
    workspaceId: "workspace-a",
  });

  assert.equal(rows.has("alice-doc"), false);
  assert.equal(rows.has("legacy-doc"), false);
  assert.equal(rows.has("bob-doc"), true);

  await store.clear();

  assert.equal(rows.size, 0);
  assert.equal(
    queryCalls.some((call) => /DELETE FROM rag_documents\s+WHERE doc_id = ANY/.test(call.sql)),
    true
  );
  assert.equal(
    queryCalls.some((call) => call.sql === "DELETE FROM rag_documents"),
    true
  );

  const invalidStore = createDocumentRegistryStore({
    getDocumentsTable: () => "bad-documents-table",
    queryPostgres: async () => ({
      rows: [],
    }),
    runMigrations: async () => {},
  });

  await assert.rejects(
    () => invalidStore.list(),
    /DOCUMENTS_POSTGRES_TABLE.*simple PostgreSQL identifier/
  );
});
