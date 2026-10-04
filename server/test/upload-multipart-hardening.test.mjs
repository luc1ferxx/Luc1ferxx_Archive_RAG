// Multipart uploads after the multer 2 upgrade: the public size limits answer
// 413 exactly above the maximum, and a request that is oversized or cut off
// mid-file leaves nothing behind in the uploads directory.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApp } from "../app.js";
import { MAX_DIRECT_UPLOAD_SIZE } from "../upload-policy.js";

const okHealthService = {
  buildHealthReport: async () => ({ status: "ok", checks: {} }),
  runStartupHealthChecks: async () => ({ status: "ok", checks: {} }),
};

const startApp = async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentai-multipart-"));
  const uploadsDirectory = path.join(tempRoot, "uploads");
  await mkdir(uploadsDirectory, { recursive: true });
  const app = await createApp({
    healthService: okHealthService,
    uploadSessionDirectory: path.join(tempRoot, "sessions"),
    uploadsDirectory,
    ragService: {
      initializeDocumentRegistry: async () => [],
      initializeSessionMemory: async () => true,
      ingestDocument: async () => ({ docId: "unexpected" }),
    },
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: server.address().port,
    uploadsDirectory,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
};

const listStoredFiles = async (directory) =>
  (await readdir(directory, { recursive: true })).filter((name) => !name.startsWith("."));

const waitForCleanup = async (directory) => {
  // multer removes a partial file asynchronously after the request ends.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await listStoredFiles(directory)).length === 0) {
      return [];
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return listStoredFiles(directory);
};

test("a direct upload one byte over the limit is a 413 and leaves no file behind", async () => {
  const server = await startApp();

  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.alloc(MAX_DIRECT_UPLOAD_SIZE + 1)], { type: "application/pdf" }),
      "too-big.pdf"
    );
    const response = await fetch(`http://127.0.0.1:${server.port}/upload`, {
      method: "POST",
      body: form,
    });

    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /size limit/i);
    assert.deepEqual(await waitForCleanup(server.uploadsDirectory), []);
  } finally {
    await server.close();
  }
});

test("a direct upload cut off mid-file leaves no partial file behind", async () => {
  const server = await startApp();

  try {
    const boundary = "----archive-rag-truncated";
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
        // The client disappears before the declared body is complete.
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
