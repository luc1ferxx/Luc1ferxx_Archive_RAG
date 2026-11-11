// Uploads whose plaintext begins with a magic the stored-file readers reserve
// (rag/working-files.js startsWithReservedFileMagic): "\0ARTENC" (a tenant
// envelope) or "\0ARTWRK" (a working file). Such a PDF still has %PDF within
// its first 1024 bytes, but every later reader would take it for a damaged
// envelope, so the shared PDF check refuses it like any other non-PDF -- with
// TENANT_ENCRYPTION off (where a "\0ARTWRK" upload used to be a 500) and on.
// The upload routes run the document check (routes/helpers.js
// checkUploadedDocument): with Office formats enabled (the default) such
// bytes are no supported document, with RAG_DOCUMENT_FORMATS=pdf no PDF.
// The trash restore's refusal of such stored bytes is in
// document-trash-postgres.integration.test.mjs.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApp } from "../app.js";
import { hasPdfMagicBytes } from "../routes/helpers.js";
import { TENANT_ENVELOPE_MAGIC } from "../rag/tenant-encryption.js";
import { WORKING_FILE_MAGIC, startsWithReservedFileMagic, writeWorkingFile } from "../rag/working-files.js";

const PDF = Buffer.from(`%PDF-1.4\nreserved-prefix-test\n${"stream text ".repeat(50)}\n%%EOF\n`);
const ENVELOPE_PREFIXED = Buffer.concat([TENANT_ENVELOPE_MAGIC, Buffer.from([1]), PDF]);
const WORKING_PREFIXED = Buffer.concat([WORKING_FILE_MAGIC, Buffer.from([1]), PDF]);

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

const previousEncryption = process.env.TENANT_ENCRYPTION;
const previousFormats = process.env.RAG_DOCUMENT_FORMATS;

const setEncryption = (value) => {
  if (value === undefined) {
    delete process.env.TENANT_ENCRYPTION;
  } else {
    process.env.TENANT_ENCRYPTION = value;
  }
};

const setFormats = (value) => {
  if (value === undefined) {
    delete process.env.RAG_DOCUMENT_FORMATS;
  } else {
    process.env.RAG_DOCUMENT_FORMATS = value;
  }
};

afterEach(() => {
  setEncryption(previousEncryption);
  setFormats(previousFormats);
});

const withTempDirectory = async (callback) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reserved-prefix-"));

  try {
    return await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

test("startsWithReservedFileMagic names both magics and nothing else", () => {
  assert.equal(startsWithReservedFileMagic(ENVELOPE_PREFIXED), true);
  assert.equal(startsWithReservedFileMagic(WORKING_PREFIXED), true);
  assert.equal(startsWithReservedFileMagic(PDF), false);
  assert.equal(startsWithReservedFileMagic(Buffer.concat([Buffer.from("junk"), ENVELOPE_PREFIXED])), false);
  assert.equal(startsWithReservedFileMagic(TENANT_ENVELOPE_MAGIC.subarray(0, 6)), false);
  assert.equal(startsWithReservedFileMagic(null), false);
});

for (const encryption of ["off", "on"]) {
  test(`the PDF check refuses a reserved prefix with TENANT_ENCRYPTION=${encryption}`, async () => {
    setEncryption(encryption);

    await withTempDirectory(async (directory) => {
      const check = async (name, bytes) => {
        const filePath = path.join(directory, name);

        // As multer stores an upload: a working file (encrypted when on).
        await writeWorkingFile(filePath, bytes);
        return hasPdfMagicBytes(filePath);
      };

      assert.equal(await check("plain.pdf", PDF), true);
      assert.equal(await check("envelope.pdf", ENVELOPE_PREFIXED), false);
      // With encryption off this used to throw WORKING_FILE_UNREADABLE (500).
      assert.equal(await check("working.pdf", WORKING_PREFIXED), false);
    });
  });
}

test("a working file another process wrote is no PDF here, not a 500", async () => {
  setEncryption("on");

  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "foreign.pdf");

    // The working-file framing with a ciphertext this process's key did not write.
    await writeFile(filePath, Buffer.concat([WORKING_PREFIXED, Buffer.alloc(32, 7)]));
    assert.equal(await hasPdfMagicBytes(filePath), false);
  });
});

const startApp = async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "reserved-prefix-app-"));
  const uploadsDirectory = path.join(tempRoot, "uploads");
  const ingested = [];

  await mkdir(uploadsDirectory, { recursive: true });

  const app = await createApp({
    healthService: okHealthService,
    ragService: {
      getDocument: () => ({ docId: "doc-1", fileName: "doc.pdf" }),
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      ingestDocument: async (input) => {
        ingested.push(input.docId);
        return { docId: input.docId, fileName: input.fileName };
      },
    },
    uploadSessionDirectory: path.join(tempRoot, "sessions"),
    uploadsDirectory,
  });
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await app.locals?.stop?.();
      await rm(tempRoot, { force: true, recursive: true });
    },
    ingested,
    port: server.address().port,
    uploadsDirectory,
  };
};

const sendFile = (port, method, requestPath, bytes) => {
  const form = new FormData();

  form.append("file", new Blob([bytes], { type: "application/pdf" }), "doc.pdf");
  return fetch(`http://127.0.0.1:${port}${requestPath}`, { body: form, method });
};

// Deliberately changed with Office formats: by default (RAG_DOCUMENT_FORMATS
// names all four) a reserved prefix is refused as no supported document, with
// its code; with RAG_DOCUMENT_FORMATS=pdf the answer is the old "not a valid
// PDF" without one.
const REFUSALS = [
  {
    expected: {
      code: "DOCUMENT_FORMAT_UNSUPPORTED",
      error: "The uploaded file is not a supported document (PDF, Word .docx, PowerPoint .pptx or Excel .xlsx).",
    },
    formats: undefined,
  },
  { expected: { error: "The uploaded file is not a valid PDF." }, formats: "pdf" },
];

for (const encryption of ["off", "on"]) {
  for (const { expected, formats } of REFUSALS) {
    test(`POST /upload and PUT /documents/:docId refuse a reserved prefix as no document (TENANT_ENCRYPTION=${encryption}, RAG_DOCUMENT_FORMATS=${formats ?? "default"})`, async () => {
      setEncryption(encryption);
      setFormats(formats);

      const server = await startApp();

      try {
        for (const bytes of [ENVELOPE_PREFIXED, WORKING_PREFIXED]) {
          for (const [method, requestPath] of [
            ["POST", "/upload"],
            ["PUT", "/documents/doc-1"],
          ]) {
            const response = await sendFile(server.port, method, requestPath, bytes);

            assert.equal(response.status, 400, `${method} ${requestPath}`);
            assert.deepEqual(await response.json(), expected);
          }
        }

        assert.deepEqual(server.ingested, [], "nothing reached the ingest");
        assert.deepEqual(await readdir(server.uploadsDirectory), [], "the refused uploads are removed");

        const accepted = await sendFile(server.port, "POST", "/upload", PDF);

        assert.equal(accepted.status, 201);
        assert.equal(server.ingested.length, 1);
      } finally {
        await server.close();
      }
    });
  }
}
