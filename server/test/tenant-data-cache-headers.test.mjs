// Responses that carry one tenant's data must stay out of shared caches.
//
// GET /documents, GET /documents/:docId/file and the three artifact reads
// answer with the caller's own data, chosen by the identity headers
// (Authorization / x-api-key, x-workspace-id, x-user-id). A proxy or CDN that
// cached one of them by URL would hand it to the next tenant asking for the
// same URL, so each sends `Cache-Control: private, no-store` and names the
// identity headers in `Vary`, on success and on error alike, without changing
// any status code or body.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { after, before } from "node:test";

import express from "express";

import { createArtifactsRouter } from "../routes/artifacts.js";
import { createDocumentsRouter } from "../routes/documents.js";
import { TENANT_DATA_VARY_HEADERS } from "../routes/helpers.js";

const PDF = Buffer.from("%PDF-1.4 alice's contract");
const ARTIFACT_BYTES = Buffer.from("# Alice's brief\n");
const ALICE_DOCUMENT = { docId: "doc-a", fileName: "contract.pdf" };

const isAlice = (accessScope) =>
  accessScope?.userId === "alice" && accessScope?.workspaceId === "acme";

const ragService = {
  getDocumentFile: async (docId, accessScope) =>
    docId === ALICE_DOCUMENT.docId && isAlice(accessScope)
      ? {
          document: { version: 2 },
          fileBuffer: PDF,
          fileName: ALICE_DOCUMENT.fileName,
          mimeType: "application/pdf",
        }
      : null,
  listDocuments: (accessScope) => (isAlice(accessScope) ? [ALICE_DOCUMENT] : []),
};

const ARTIFACT = {
  artifactId: "artifact-a",
  artifactType: "research_brief",
  createdAt: "2026-10-01T00:00:00.000Z",
  status: "active",
  title: "Brief",
};

const workspaceArtifactService = {
  getArtifact: async ({ accessScope, artifactId }) =>
    artifactId === ARTIFACT.artifactId && isAlice(accessScope) ? ARTIFACT : null,
  getArtifactDownload: async ({ accessScope, artifactId }) =>
    artifactId === ARTIFACT.artifactId && isAlice(accessScope)
      ? { fileBuffer: ARTIFACT_BYTES, fileName: "brief.md", mimeType: "text/markdown" }
      : null,
  listArtifacts: async ({ accessScope }) => ({
    artifacts: isAlice(accessScope) ? [ARTIFACT] : [],
    total: isAlice(accessScope) ? 1 : 0,
  }),
};

let server;
let baseUrl;

before(async () => {
  const app = express();

  // What requireApiAuth would decide from the identity headers. CORS runs
  // first in the real app and may already have set Vary: Origin.
  app.use((req, res, next) => {
    res.vary("Origin");
    req.accessScope = {
      authenticated: true,
      userId: req.get("x-user-id") ?? "",
      workspaceId: req.get("x-workspace-id") ?? "",
    };
    next();
  });
  app.use(createDocumentsRouter({ ragService }));
  app.use(createArtifactsRouter({ workspaceArtifactService }));

  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
});

const AS_ALICE = { "x-user-id": "alice", "x-workspace-id": "acme" };
const AS_BOB = { "x-user-id": "bob", "x-workspace-id": "globex" };

const request = (path, headers = AS_ALICE) => fetch(`${baseUrl}${path}`, { headers });

const assertTenantDataHeaders = (response, label) => {
  assert.equal(response.headers.get("cache-control"), "private, no-store", label);

  const vary = (response.headers.get("vary") ?? "")
    .split(",")
    .map((field) => field.trim().toLowerCase())
    .filter(Boolean);

  for (const header of TENANT_DATA_VARY_HEADERS) {
    assert.ok(vary.includes(header.toLowerCase()), `${label}: Vary names ${header}`);
  }

  assert.ok(vary.includes("origin"), `${label}: a Vary set earlier is kept`);
  assert.equal(new Set(vary).size, vary.length, `${label}: no field is repeated`);
};

test("the Vary list names the credential, workspace and user headers", () => {
  assert.deepEqual(
    [...TENANT_DATA_VARY_HEADERS],
    ["Authorization", "x-api-key", "x-workspace-id", "x-user-id"]
  );
});

test("GET /documents is not cacheable, for the owner and for anyone else", async () => {
  const alice = await request("/documents");
  assert.equal(alice.status, 200);
  assert.deepEqual(await alice.json(), [ALICE_DOCUMENT]);
  assertTenantDataHeaders(alice, "alice's list");

  const bob = await request("/documents", AS_BOB);
  assert.equal(bob.status, 200);
  assert.deepEqual(await bob.json(), []);
  assertTenantDataHeaders(bob, "bob's list");
});

test("GET /documents/:docId/file is not cacheable on any answer", async () => {
  const file = await request("/documents/doc-a/file");
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
  assert.equal(file.headers.get("content-type"), "application/pdf");
  assertTenantDataHeaders(file, "the PDF");

  const range = await fetch(`${baseUrl}/documents/doc-a/file`, {
    headers: { ...AS_ALICE, range: "bytes=0-3" },
  });
  assert.equal(range.status, 206);
  assert.equal(Buffer.from(await range.arrayBuffer()).toString(), "%PDF");
  assertTenantDataHeaders(range, "a range of the PDF");

  const replaced = await request("/documents/doc-a/file?version=1");
  assert.equal(replaced.status, 409);
  assert.deepEqual(await replaced.json(), {
    currentVersion: 2,
    error:
      "This link is to version 1 of the document, which has been replaced by version 2; its PDF is no longer stored.",
    requestedVersion: 1,
  });
  assertTenantDataHeaders(replaced, "a replaced version");

  const otherTenant = await request("/documents/doc-a/file", AS_BOB);
  assert.equal(otherTenant.status, 404);
  assert.deepEqual(await otherTenant.json(), { error: "Document not found." });
  assertTenantDataHeaders(otherTenant, "another tenant's 404");
});

test("artifact reads and downloads are not cacheable on any answer", async () => {
  const list = await request("/artifacts");
  assert.equal(list.status, 200);
  assert.equal((await list.json()).artifacts.length, 1);
  assertTenantDataHeaders(list, "the artifact list");

  const detail = await request("/artifacts/artifact-a");
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).artifact.artifactId, "artifact-a");
  assertTenantDataHeaders(detail, "the artifact");

  const download = await request("/artifacts/artifact-a/download");
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), ARTIFACT_BYTES);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  assertTenantDataHeaders(download, "the download");

  const missing = await request("/artifacts/artifact-a", AS_BOB);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Workspace artifact not found." });
  assertTenantDataHeaders(missing, "another tenant's artifact");

  const missingDownload = await request("/artifacts/artifact-a/download", AS_BOB);
  assert.equal(missingDownload.status, 404);
  assertTenantDataHeaders(missingDownload, "another tenant's download");
});
