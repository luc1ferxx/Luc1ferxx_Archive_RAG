// POST /upload with TENANT_ENCRYPTION=on: multer's file is encrypted as it
// streams in (routes/working-file-storage.js), so the upload never rests on
// disk in plaintext; the PDF check, the content hash and the ingest still see
// the plaintext; and an oversized or cut-off upload leaves nothing behind, as
// with the stock disk storage.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApp } from "../app.js";
import { isWorkingFileEnvelope, readWorkingFile } from "../rag/working-files.js";
import { MAX_DIRECT_UPLOAD_SIZE } from "../upload-policy.js";

const MARKER = "pangolin-marker-5d1e";
const PDF = Buffer.from(`%PDF-1.4\n${MARKER}\n${"stream text ".repeat(400)}\n%%EOF\n`);

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

let previousEncryption;

before(() => {
  previousEncryption = process.env.TENANT_ENCRYPTION;
  process.env.TENANT_ENCRYPTION = "on";
});

after(() => {
  if (previousEncryption === undefined) {
    delete process.env.TENANT_ENCRYPTION;
  } else {
    process.env.TENANT_ENCRYPTION = previousEncryption;
  }
});

const startApp = async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "working-file-upload-"));
  const uploadsDirectory = path.join(tempRoot, "uploads");
  const ingested = [];

  await mkdir(uploadsDirectory, { recursive: true });

  const app = await createApp({
    healthService: okHealthService,
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      ingestDocument: async (input) => {
        ingested.push({
          ...input,
          plaintext: await readWorkingFile(input.filePath),
          stored: await readFile(input.filePath),
        });
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
      await rm(tempRoot, { force: true, recursive: true });
    },
    ingested,
    port: server.address().port,
    uploadsDirectory,
  };
};

const listStoredFiles = async (directory) =>
  (await readdir(directory, { recursive: true })).filter((name) => !name.startsWith("."));

const waitForCleanup = async (directory) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await listStoredFiles(directory)).length === 0) {
      return [];
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return listStoredFiles(directory);
};

const postFile = (port, bytes, name = "doc.pdf") => {
  const form = new FormData();

  form.append("file", new Blob([bytes], { type: "application/pdf" }), name);
  return fetch(`http://127.0.0.1:${port}/upload`, { body: form, method: "POST" });
};

test("the upload rests encrypted; the ingest sees the plaintext and its hash", async () => {
  const server = await startApp();

  try {
    const response = await postFile(server.port, PDF);

    assert.equal(response.status, 201);

    const [ingest] = server.ingested;

    assert.ok(isWorkingFileEnvelope(ingest.stored), "multer's file is a working file");
    assert.ok(!ingest.stored.includes(Buffer.from(MARKER)), "no plaintext on disk");
    assert.deepEqual(ingest.plaintext, PDF);
    assert.equal(ingest.contentSha256, createHash("sha256").update(PDF).digest("hex"));
    assert.deepEqual(await waitForCleanup(server.uploadsDirectory), [], "removed after the request");
  } finally {
    await server.close();
  }
});

test("the PDF check reads the plaintext of the encrypted file", async () => {
  const server = await startApp();

  try {
    const response = await postFile(server.port, Buffer.from("not a pdf at all"));

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not a valid PDF/);
    assert.equal(server.ingested.length, 0);
    assert.deepEqual(await waitForCleanup(server.uploadsDirectory), []);
  } finally {
    await server.close();
  }
});

test("an upload one byte over the limit is a 413 and leaves no file behind", async () => {
  const server = await startApp();

  try {
    const response = await postFile(server.port, Buffer.alloc(MAX_DIRECT_UPLOAD_SIZE + 1), "too-big.pdf");

    assert.equal(response.status, 413);
    assert.deepEqual(await waitForCleanup(server.uploadsDirectory), []);
  } finally {
    await server.close();
  }
});

test("an upload cut off mid-file leaves no partial file behind", async () => {
  const server = await startApp();

  try {
    const boundary = "----archive-rag-encrypted-truncated";
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cut.pdf"\r\n` +
        "Content-Type: application/pdf\r\n\r\n%PDF-1.4\n"
    );
    const body = Buffer.concat([head, Buffer.alloc(256 * 1024, 0x41)]);

    await new Promise((resolve) => {
      const req = httpRequest({
        headers: {
          "Content-Length": String(body.length + 1024 * 1024),
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        host: "127.0.0.1",
        method: "POST",
        path: "/upload",
        port: server.port,
      });

      req.on("error", () => resolve());
      req.on("response", (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.write(body, () => {
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 50);
      });
    });

    assert.deepEqual(await waitForCleanup(server.uploadsDirectory), []);
  } finally {
    await server.close();
  }
});
