// The tenant export (rag/tenant-lifecycle.js) with stored bytes that cannot
// be decrypted -- a key destroyed by a standalone `tenant:keys destroy`, a
// changed byte, or plaintext that only begins with the envelope magic: the
// record is exported with those bytes null and the code in `unreadableBytes`,
// counted in the summary's `unreadableRecords`, the export is `partial`, and
// every later record and store is still exported. It used to end the export
// at the first such document.
import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryTaskStore } from "../rag/tasks.js";
import { createTenantLifecycleService } from "../rag/tenant-lifecycle.js";
import {
  TENANT_ENVELOPE_MAGIC,
  decryptTenantRecordBytesForExport,
  documentFileContext,
} from "../rag/tenant-encryption.js";

const A = Object.freeze({ userId: "alice", workspaceId: "acme" });
const PDF = Buffer.from("%PDF-1.4\nexportable\n%%EOF\n");
// The envelope magic and version, then bytes no envelope has: a header
// length out of range (TENANT_ENVELOPE_MALFORMED on every read).
const NOT_AN_ENVELOPE = Buffer.concat([TENANT_ENVELOPE_MAGIC, Buffer.from([1]), PDF]);

const contextOf = (docId) => documentFileContext({ docId, userId: A.userId, workspaceId: A.workspaceId });

test("decryptTenantRecordBytesForExport keeps the record and names the code of bytes that do not decrypt", async () => {
  assert.deepEqual(await decryptTenantRecordBytesForExport({ doc_id: "d1", file_bytes: PDF }, "file_bytes", contextOf("d1")), {
    doc_id: "d1",
    file_bytes: PDF,
  });
  assert.deepEqual(
    await decryptTenantRecordBytesForExport({ doc_id: "d2", file_bytes: NOT_AN_ENVELOPE }, "file_bytes", contextOf("d2")),
    { doc_id: "d2", file_bytes: null, unreadableBytes: { file_bytes: "TENANT_ENVELOPE_MALFORMED" } }
  );
});

test("an unreadable document does not end the export: it is marked, counted and the rest follows", async () => {
  const taskStore = createInMemoryTaskStore();

  await taskStore.upsert({
    accessScope: A,
    task: { id: "task-1", label: "after the documents", status: "waiting_for_user", type: "external_recommendation" },
  });

  const documentRows = [
    { doc_id: "doc-1", file_bytes: PDF, owner_user_id: A.userId, workspace_id: A.workspaceId },
    { doc_id: "doc-2", file_bytes: NOT_AN_ENVELOPE, owner_user_id: A.userId, workspace_id: A.workspaceId },
    { doc_id: "doc-3", file_bytes: PDF, owner_user_id: A.userId, workspace_id: A.workspaceId },
  ];
  // The documents store as the PostgreSQL registry's export runs it: each
  // row through its mapRow.
  const documentStore = {
    async *iterateTenantRecords() {
      for (const row of documentRows) {
        yield {
          record: await decryptTenantRecordBytesForExport(row, "file_bytes", contextOf(row.doc_id)),
          table: "documents",
        };
      }
    },
  };
  const notConfigured = () => ({ status: "not_configured", store: null });
  const service = createTenantLifecycleService({
    claimJudge: null,
    documents: {
      count: async () => ({ chunks: {}, documents: documentRows }),
      erase: async () => ({ chunks: {}, documents: [] }),
      resolveRecordStore: () => ({ status: "ok", store: documentStore }),
    },
    longMemory: notConfigured,
    semanticCache: null,
    sessionMemory: notConfigured,
    taskStore,
    tenantKeys: null,
    tenantRegistry: null,
    tenantUsageStore: null,
  });
  const lines = [];

  for await (const line of service.exportTenant({ ...A })) {
    lines.push(JSON.parse(line));
  }

  const documents = lines.filter((line) => line.type === "record" && line.table === "documents");
  const summary = lines.at(-1);

  assert.equal(lines.some((line) => line.type === "error"), false, "no error line");
  assert.deepEqual(
    documents.map(({ record }) => [record.doc_id, record.file_bytes === null ? null : "bytes", record.unreadableBytes ?? null]),
    [
      ["doc-1", "bytes", null],
      ["doc-2", null, { file_bytes: "TENANT_ENVELOPE_MALFORMED" }],
      ["doc-3", "bytes", null],
    ]
  );
  assert.ok(lines.some((line) => line.type === "record" && line.table === "tasks"), "the next store still exports");
  assert.equal(summary.type, "summary");
  assert.equal(summary.status, "partial");
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.unreadableRecords, { documents: 1 });
  assert.equal(summary.counts.documents, 3);
});
