import { createHash } from "node:crypto";

import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";

// The tenant-isolation demo kit (docs/demo-tenant-isolation.md): the demo
// personas of deploy/demo/hardened.env, the seed (workspaces, members and a
// few sample documents) and the walkthrough checklist. Everything goes over
// HTTP to a running server with the profile's tokens, the way a client would;
// nothing here touches the database. server/demo-tenants.mjs is the command
// line (`npm run demo:seed`, `npm run demo:walkthrough`), and
// test/tenant-isolation-hardened.e2e.test.mjs runs the same seed and checks
// against a real `node server.js` started with the profile.
//
// DEMO ONLY: the tokens below are fixed public values, the same ones
// deploy/demo/hardened.env maps to these users (test/demo-tenants.test.mjs
// keeps the two equal).

export const DEMO_WORKSPACES = Object.freeze([
  Object.freeze({ id: "alpha", plan: "demo" }),
  Object.freeze({ id: "beta", plan: "demo" }),
  // The noisy neighbour: the rate-limit, storage-quota and suspension checks
  // run against it, so alpha and beta keep working whatever they do to it.
  Object.freeze({ id: "gamma", plan: "demo" }),
]);

// `workspaceId` is the x-workspace-id a request sends by default: none for a
// credential bound to one workspace by its token (alice, bob, the alpha
// library) or for a platform credential, the membership's workspace for a
// user-only token.
//
// A document belongs to the (user, workspace) pair that uploaded it
// (doc-registry.js documentMatchesAccessScope and the row policy of migration
// 013): another member of the same workspace does not see it. A credential
// bound to a workspace without a user (alphaLibrary, a workspace service
// account) uploads documents with no owner, which every member of that
// workspace sees.
export const DEMO_PERSONAS = Object.freeze({
  alice: Object.freeze({
    principal: Object.freeze({ userId: "alice", workspaceId: "alpha" }),
    token: "demo-alice-token",
    workspaceId: null,
  }),
  alphaLibrary: Object.freeze({
    principal: Object.freeze({ workspaceId: "alpha" }),
    token: "demo-alpha-library-token",
    workspaceId: null,
  }),
  anna: Object.freeze({
    principal: Object.freeze({ userId: "anna" }),
    token: "demo-anna-token",
    workspaceId: "alpha",
  }),
  bob: Object.freeze({
    principal: Object.freeze({ userId: "bob", workspaceId: "beta" }),
    token: "demo-bob-token",
    workspaceId: null,
  }),
  ben: Object.freeze({
    principal: Object.freeze({ userId: "ben" }),
    token: "demo-ben-token",
    workspaceId: "beta",
  }),
  carol: Object.freeze({
    principal: Object.freeze({ userId: "carol", workspaces: Object.freeze(["alpha", "beta"]) }),
    token: "demo-carol-token",
    workspaceId: null,
  }),
  dave: Object.freeze({
    principal: Object.freeze({ userId: "dave" }),
    token: "demo-dave-token",
    workspaceId: "gamma",
  }),
  platformAdmin: Object.freeze({
    principal: Object.freeze({ roles: Object.freeze(["admin.owner"]), userId: "platform-admin" }),
    token: "demo-platform-admin-token",
    workspaceId: null,
  }),
  tenantManager: Object.freeze({
    principal: Object.freeze({ roles: Object.freeze(["admin.tenant_manager"]), userId: "tenant-manager" }),
    token: "demo-tenant-manager-token",
    workspaceId: null,
  }),
});

export const DEMO_MEMBERSHIPS = Object.freeze([
  Object.freeze({ roles: Object.freeze(["workspace.admin"]), userId: "alice", workspaceId: "alpha" }),
  Object.freeze({ roles: Object.freeze(["workspace.viewer"]), userId: "anna", workspaceId: "alpha" }),
  Object.freeze({ roles: Object.freeze(["workspace.member"]), userId: "carol", workspaceId: "alpha" }),
  Object.freeze({ roles: Object.freeze(["workspace.admin"]), userId: "bob", workspaceId: "beta" }),
  Object.freeze({ roles: Object.freeze(["workspace.member"]), userId: "ben", workspaceId: "beta" }),
  Object.freeze({ roles: Object.freeze(["workspace.member"]), userId: "carol", workspaceId: "beta" }),
  Object.freeze({ roles: Object.freeze(["workspace.admin"]), userId: "dave", workspaceId: "gamma" }),
]);

// Small generated PDFs (the upload routes take PDFs only). Each states one
// fact no other tenant's document states, so an answer or an export that
// carries it shows where it came from.
export const DEMO_DOCUMENTS = Object.freeze([
  Object.freeze({
    answer: /twelve paid annual leave days/u,
    fileName: "alpha-leave-policy.pdf",
    lines: Object.freeze(["Alpha Corp employee handbook.", "Alpha employees receive twelve paid annual leave days each year."]),
    question: "How many paid annual leave days do Alpha employees receive?",
    uploader: "alice",
    workspaceId: "alpha",
  }),
  Object.freeze({
    answer: /five minutes/u,
    // Through the resumable upload routes rather than POST /upload.
    chunked: true,
    fileName: "alpha-security-standard.pdf",
    lines: Object.freeze(["Alpha Corp security standard.", "Alpha laptops lock the screen after five minutes of inactivity."]),
    question: "After how many minutes of inactivity do Alpha laptops lock the screen?",
    uploader: "carol",
    workspaceId: "alpha",
  }),
  Object.freeze({
    answer: /Compass review/u,
    fileName: "alpha-shared-glossary.pdf",
    lines: Object.freeze(["Alpha Corp shared glossary.", "Alpha calls its quarterly planning meeting the Compass review."]),
    question: "What does Alpha call its quarterly planning meeting?",
    uploader: "alphaLibrary",
    workspaceId: "alpha",
  }),
  Object.freeze({
    answer: /economy class/u,
    fileName: "beta-travel-policy.pdf",
    lines: Object.freeze(["Beta Industries travel policy.", "Beta travellers book economy class for flights under six hours."]),
    question: "Which class do Beta travellers book for flights under six hours?",
    uploader: "bob",
    workspaceId: "beta",
  }),
  Object.freeze({
    answer: /thirty days/u,
    fileName: "beta-expense-policy.pdf",
    lines: Object.freeze(["Beta Industries expense policy.", "Beta employees submit expense reports within thirty days."]),
    question: "Within how many days do Beta employees submit expense reports?",
    uploader: "ben",
    workspaceId: "beta",
  }),
  // carol's own document in her second workspace, so she can ask in beta too
  // (the long-term memory check).
  Object.freeze({
    answer: /Tuesday mornings/u,
    fileName: "beta-onboarding-checklist.pdf",
    lines: Object.freeze(["Beta Industries onboarding checklist.", "Beta new hires collect their badges on Tuesday mornings."]),
    question: "When do Beta new hires collect their badges?",
    uploader: "carol",
    workspaceId: "beta",
  }),
]);

// The storage-quota check uploads these to gamma until the quota refuses one.
// The bytes are fixed, so a second walkthrough resolves the ones already
// stored as duplicates (RAG_INGEST_DEDUP), which the quota does not count.
export const DEMO_QUOTA_PROBE_LIMIT = 12;
const buildQuotaProbeDocument = (index) => ({
  fileName: `gamma-quota-probe-${String(index).padStart(2, "0")}.pdf`,
  lines: [`Gamma quota probe ${index}.`, `Gamma probe document number ${index} only fills the storage quota.`],
});

export const DEMO_DEFAULT_BASE_URL = "http://127.0.0.1:5001";

const userOf = (personaName) => DEMO_PERSONAS[personaName]?.principal.userId ?? "";

/** Whether a demo document is shared by its whole workspace (uploaded without a user). */
export const isWorkspaceSharedDemoDocument = (document) => !userOf(document.uploader);

/**
 * The demo documents `personaName` sees in `workspaceId`: its own uploads
 * there and the workspace's shared ones (documentMatchesAccessScope).
 */
export const demoDocumentsVisibleTo = (personaName, workspaceId) =>
  DEMO_DOCUMENTS.filter(
    (document) =>
      document.workspaceId === workspaceId &&
      (isWorkspaceSharedDemoDocument(document) || userOf(document.uploader) === userOf(personaName))
  );

/** The API_AUTH_TOKENS map of deploy/demo/hardened.env. */
export const buildDemoApiAuthTokens = () =>
  Object.fromEntries(
    Object.values(DEMO_PERSONAS).map((persona) => [persona.token, JSON.parse(JSON.stringify(persona.principal))])
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A small HTTP client that speaks as one persona per call:
 * client.call("alice", "/documents", { method, json, form, workspace }).
 * `workspace` undefined sends the persona's default x-workspace-id, null sends
 * none, a string sends that one. Resolves { status, headers, json, text }
 * (json is null when the body is not JSON); never throws on an HTTP status.
 */
export const createDemoClient = ({ baseUrl = DEMO_DEFAULT_BASE_URL, fetchImpl = fetch, timeoutMs = 60_000 } = {}) => {
  const base = String(baseUrl).replace(/\/+$/u, "");

  const call = async (personaName, pathname, { form, headers = {}, json, method = "GET", workspace } = {}) => {
    const persona = personaName ? DEMO_PERSONAS[personaName] : null;

    if (personaName && !persona) {
      throw new Error(`Unknown demo persona: ${personaName}`);
    }

    const workspaceId = workspace === undefined ? persona?.workspaceId : workspace;
    const requestHeaders = {
      ...(persona ? { "x-api-key": persona.token } : {}),
      ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    };
    const response = await fetchImpl(`${base}${pathname}`, {
      body: form ?? (json !== undefined ? JSON.stringify(json) : undefined),
      headers: requestHeaders,
      method,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed = null;

    if (/json/u.test(response.headers.get("content-type") ?? "")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    return { headers: response.headers, json: parsed, status: response.status, text };
  };

  return { baseUrl: base, call };
};

const describeResponse = (response) =>
  `${response.status}${response.json?.code ? ` ${response.json.code}` : ""}`;

const buildPdfBytes = ({ fileName, lines }) =>
  buildTextPdf({ pages: [[...lines]], title: fileName.replace(/\.pdf$/u, "") });

const buildPdfForm = (document) => {
  const form = new FormData();

  form.append("file", new Blob([buildPdfBytes(document)], { type: "application/pdf" }), document.fileName);

  return form;
};

// The resumable path the workbench uses for large files (POST /upload/init,
// /upload/chunk, /upload/complete), in one chunk: its session store and the
// tenant binding it re-mounts after multer are a different code path from
// POST /upload. Resolves the /upload/complete response, or the first refusal.
const uploadInChunks = async (client, personaName, document, { workspace } = {}) => {
  const bytes = buildPdfBytes(document);
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  const fileId = `demo-${fileSha256.slice(0, 16)}-${document.fileName}`;
  const initialized = await client.call(personaName, "/upload/init", {
    json: {
      chunkSize: bytes.length,
      fileId,
      fileName: document.fileName,
      fileSha256,
      fileSize: bytes.length,
      lastModified: 0,
      totalChunks: 1,
    },
    method: "POST",
    workspace,
  });

  if (initialized.status !== 201) {
    return initialized;
  }

  const form = new FormData();

  form.append("fileId", fileId);
  form.append("chunkIndex", "0");
  form.append("totalChunks", "1");
  form.append("chunk", new Blob([bytes], { type: "application/octet-stream" }), `${document.fileName}.part`);

  const chunk = await client.call(personaName, "/upload/chunk", { form, method: "POST", workspace });

  if (chunk.status !== 201) {
    return chunk;
  }

  return client.call(personaName, "/upload/complete", { json: { fileId }, method: "POST", workspace });
};

const waitForIngestJob = async (client, personaName, jobId, { timeoutMs = 90_000, workspace } = {}) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await client.call(personaName, `/ingest-jobs/${encodeURIComponent(jobId)}`, { workspace });

    if (response.status !== 200) {
      return { response, status: "unknown" };
    }

    if (response.json?.status !== "queued" && response.json?.status !== "running") {
      return { job: response.json, response, status: response.json?.status };
    }

    await sleep(200);
  }

  throw new Error(`Ingest job ${jobId} did not finish within ${timeoutMs} ms.`);
};

/**
 * Uploads one generated PDF as `personaName` and, in async ingest mode, waits
 * for its job. Resolves { outcome, docId, status, code }: outcome "created",
 * "duplicate" (these bytes were already stored by this tenant), "refused"
 * (the request answered an error; `code` says why) or "failed" (the job
 * failed).
 */
export const uploadDemoDocument = async (client, personaName, document, { chunked = false, workspace } = {}) => {
  const response = chunked
    ? await uploadInChunks(client, personaName, document, { workspace })
    : await client.call(personaName, "/upload", {
        form: buildPdfForm(document),
        method: "POST",
        workspace,
      });

  if (response.status === 200 || response.status === 201) {
    return {
      code: null,
      docId: response.json?.docId ?? response.json?.document?.docId ?? null,
      outcome: response.json?.duplicate ? "duplicate" : "created",
      status: response.status,
    };
  }

  if (response.status !== 202) {
    return { code: response.json?.code ?? null, docId: null, outcome: "refused", status: response.status };
  }

  const waited = await waitForIngestJob(client, personaName, response.json.jobId, { workspace });

  if (waited.status !== "succeeded") {
    return {
      code: waited.job?.error?.code ?? null,
      docId: response.json.docId ?? null,
      outcome: "failed",
      status: waited.response.status,
    };
  }

  return {
    code: null,
    docId: waited.job.docId ?? waited.job.document?.docId ?? response.json.docId,
    outcome: waited.job.duplicate || waited.job.resolution === "duplicate" ? "duplicate" : "created",
    status: 202,
  };
};

/**
 * Registers the demo workspaces and members (as tenant-manager, through
 * /admin/workspaces) and uploads the sample documents (as their uploaders).
 * Idempotent: an existing workspace is kept (and reactivated if a broken run
 * left it suspended), a member's roles are set again, a document already
 * stored is resolved as a duplicate. Throws on the first step that fails.
 */
export const seedDemoTenants = async ({ client, log = () => {} } = {}) => {
  const report = { documents: [], members: [], workspaces: [] };

  for (const workspace of DEMO_WORKSPACES) {
    const created = await client.call("tenantManager", "/admin/workspaces", {
      json: { id: workspace.id, plan: workspace.plan },
      method: "POST",
    });

    if (created.status === 201) {
      report.workspaces.push({ id: workspace.id, outcome: "created" });
    } else if (created.status === 409 && created.json?.code === "WORKSPACE_EXISTS") {
      const current = await client.call("tenantManager", `/admin/workspaces/${workspace.id}`);

      if (current.json?.workspace?.status === "suspended") {
        const activated = await client.call("tenantManager", `/admin/workspaces/${workspace.id}/actions/activate`, {
          method: "POST",
        });

        if (activated.status !== 200) {
          throw new Error(`Reactivating workspace ${workspace.id} answered ${describeResponse(activated)}: ${activated.text}`);
        }
      }

      report.workspaces.push({ id: workspace.id, outcome: "existing" });
    } else {
      throw new Error(`Registering workspace ${workspace.id} answered ${describeResponse(created)}: ${created.text}`);
    }

    log(`workspace ${workspace.id}: ${report.workspaces.at(-1).outcome}`);
  }

  for (const membership of DEMO_MEMBERSHIPS) {
    const saved = await client.call(
      "tenantManager",
      `/admin/workspaces/${membership.workspaceId}/members/${membership.userId}`,
      { json: { roles: [...membership.roles] }, method: "PUT" }
    );

    if (saved.status !== 200 && saved.status !== 201) {
      throw new Error(
        `Adding ${membership.userId} to ${membership.workspaceId} answered ${describeResponse(saved)}: ${saved.text}`
      );
    }

    report.members.push({
      outcome: saved.status === 201 ? "added" : "updated",
      roles: [...membership.roles],
      userId: membership.userId,
      workspaceId: membership.workspaceId,
    });
    log(`member ${membership.userId}@${membership.workspaceId} ${membership.roles.join(",")}: ${report.members.at(-1).outcome}`);
  }

  for (const document of DEMO_DOCUMENTS) {
    const uploaded = await uploadDemoDocument(client, document.uploader, document, {
      chunked: document.chunked === true,
      workspace: document.workspaceId,
    });

    if (uploaded.outcome !== "created" && uploaded.outcome !== "duplicate") {
      throw new Error(
        `Uploading ${document.fileName} as ${document.uploader} ended ${uploaded.outcome} (${uploaded.status}${
          uploaded.code ? ` ${uploaded.code}` : ""
        }).`
      );
    }

    report.documents.push({
      docId: uploaded.docId,
      fileName: document.fileName,
      outcome: uploaded.outcome,
      uploader: document.uploader,
      workspaceId: document.workspaceId,
    });
    log(`document ${document.fileName} (${document.workspaceId}): ${uploaded.outcome} ${uploaded.docId}`);
  }

  return report;
};

const listDocuments = async (client, personaName, workspace) => {
  const response = await client.call(personaName, "/documents", { workspace });

  return { documents: Array.isArray(response.json) ? response.json : null, response };
};

// The persona's trash (DOCUMENT_TRASH_RETENTION_HOURS): the trashed document
// named `fileName`, newest first, or null.
const findInTrash = async (client, personaName, fileName, workspace) => {
  const response = await client.call(personaName, "/documents/trash", { workspace });

  return (Array.isArray(response.json) ? response.json : []).find((document) => document.fileName === fileName) ?? null;
};

// What the deletion redaction writes in place of a deleted document's text
// (rag/document-deletion-redaction.js).
export const DELETED_SOURCE_MARKER = "[source document deleted]";

// bob's probe for the redaction check, uploaded once and then restored from
// the trash and deleted again by every later walkthrough.
export const DEMO_REDACTION_PROBE = Object.freeze({
  fact: "Beta stores its nightly backups in the Juniper vault.",
  fileName: "beta-redaction-probe.pdf",
  lines: Object.freeze(["Beta Industries backup policy.", "Beta stores its nightly backups in the Juniper vault."]),
  question: "Where does Beta store its nightly backups?",
});

/**
 * The seeded documents as the server lists them to their uploaders:
 * { [fileName]: { docId, workspaceId } }. Throws when one is missing (run
 * the seed first).
 */
export const discoverDemoDocuments = async ({ client } = {}) => {
  const found = {};
  const listings = new Map(
    DEMO_DOCUMENTS.map((document) => [`${document.uploader}@${document.workspaceId}`, document])
  );

  for (const { uploader, workspaceId } of listings.values()) {
    const { documents, response } = await listDocuments(client, uploader, workspaceId);

    if (!documents) {
      throw new Error(`Listing ${workspaceId}'s documents as ${uploader} answered ${describeResponse(response)}.`);
    }

    for (const document of documents) {
      found[document.fileName] = { docId: document.docId, workspaceId };
    }
  }

  const missing = DEMO_DOCUMENTS.filter((document) => !found[document.fileName]).map((document) => document.fileName);

  if (missing.length > 0) {
    throw new Error(`Seeded documents are missing (${missing.join(", ")}); run \`npm run demo:seed\` first.`);
  }

  return found;
};

const pass = (detail) => ({ detail, status: "PASS" });
const fail = (detail) => ({ detail, status: "FAIL" });
const skip = (detail) => ({ detail, status: "SKIP" });

const docIdsOf = (context, workspaceId) =>
  DEMO_DOCUMENTS.filter((document) => document.workspaceId === workspaceId).map(
    (document) => context.documents[document.fileName].docId
  );

const firstDocument = (workspaceId) => DEMO_DOCUMENTS.find((document) => document.workspaceId === workspaceId);

// Every id a record of `workspaceId` could name in another field, for the
// export check: the other tenants' document ids, users and workspace ids.
const collectForeignMarkers = (context, workspaceId) => {
  const foreignDocuments = DEMO_DOCUMENTS.filter((document) => document.workspaceId !== workspaceId);
  const foreignDocIds = foreignDocuments.map((document) => context.documents[document.fileName].docId);
  // What another workspace's document says, and its name: an export that
  // carries one of these carries that workspace's data.
  const foreignContent = foreignDocuments.flatMap((document) => [document.answer, document.fileName]);
  const ownUsers = new Set(
    DEMO_MEMBERSHIPS.filter((membership) => membership.workspaceId === workspaceId).map((membership) => membership.userId)
  );
  const foreignUsers = [
    ...new Set(
      DEMO_MEMBERSHIPS.filter((membership) => !ownUsers.has(membership.userId)).map((membership) => membership.userId)
    ),
  ];

  return { foreignContent, foreignDocIds, foreignUsers };
};

const sumCounts = (counts) =>
  Object.values(counts && typeof counts === "object" ? counts : {}).reduce(
    (total, value) => total + (Number(value) || 0),
    0
  );

const readWorkspaceField = (record = {}) => {
  for (const key of ["workspaceId", "workspace_id"]) {
    if (typeof record?.[key] === "string") {
      return record[key];
    }
  }

  return undefined;
};

/**
 * The walkthrough checklist. Each check runs against the seeded server and
 * resolves { status: "PASS" | "FAIL" | "SKIP", detail }. The order matters
 * only where a check changes state: the noisy-neighbour checks run on gamma
 * (suspension, rate limit, storage quota) and leave alpha and beta as the
 * seed made them; the trash check restores the seeded document it deletes,
 * the memory check removes what it stored, and the redaction check keeps one
 * probe in bob's trash between walkthroughs. The refusal check needs the
 * rate-limit check before it.
 */
export const DEMO_CHECKS = Object.freeze([
  {
    id: "probes_answer_status_only",
    title: "An anonymous /ready answers 200 with the status only",
    run: async ({ client }) => {
      const ready = await client.call(null, "/ready");
      const keys = Object.keys(ready.json ?? {});

      return ready.status === 200 && keys.length === 1 && ready.json.status === "ok"
        ? pass("GET /ready 200 {status}")
        : fail(`GET /ready ${ready.status} ${ready.text.slice(0, 200)}`);
    },
  },
  {
    id: "health_row_level_security",
    title: "The platform admin reads the health report (row-level security and role split ok) and the admin status",
    run: async ({ client }) => {
      const health = await client.call("platformAdmin", "/health");
      const rls = health.json?.checks?.rowLevelSecurity;
      const roleSplit = rls?.roleSplit;
      // Platform routes with no workspace (API_AUTH_REQUIRE_WORKSPACE does
      // not ask a platform credential for one there).
      const status = await client.call("platformAdmin", "/admin/status");
      const indexVersions = await client.call("platformAdmin", "/admin/index-versions");

      // Present only with TENANT_ENCRYPTION=on: the keystore and master key.
      const encryption = health.json?.checks?.tenantEncryption;

      if (health.status !== 200 || !rls) {
        return fail(`GET /health ${describeResponse(health)}; no rowLevelSecurity check in the report`);
      }

      return rls.status === "ok" &&
        roleSplit?.status === "ok" &&
        (encryption === undefined || encryption.status === "ok") &&
        status.status === 200 &&
        indexVersions.status === 200
        ? pass(
            `rowLevelSecurity ok, roleSplit ok, tenantEncryption ${encryption ? encryption.status : "off"}; /admin/status 200, /admin/index-versions 200`
          )
        : fail(
            `rowLevelSecurity ${rls.status}, roleSplit ${roleSplit?.status ?? "missing"}, tenantEncryption ${encryption?.status ?? "off"}; /admin/status ${describeResponse(status)}, /admin/index-versions ${describeResponse(indexVersions)}`
          );
    },
  },
  {
    id: "credential_required",
    title: "No token is 401; a credential that names no workspace is 403",
    run: async ({ client }) => {
      const anonymous = await client.call(null, "/documents");
      const noWorkspace = await client.call("carol", "/documents", { workspace: null });
      const withWorkspace = await client.call("carol", "/documents", { workspace: "alpha" });

      return anonymous.status === 401 && noWorkspace.status === 403 && withWorkspace.status === 200
        ? pass("anonymous 401; carol without x-workspace-id 403, with alpha 200")
        : fail(
            `anonymous ${describeResponse(anonymous)}, carol without a workspace ${describeResponse(noWorkspace)}, carol in alpha ${describeResponse(withWorkspace)}`
          );
    },
  },
  {
    id: "membership_required",
    title: "A workspace the user is not a member of (or is not registered) is 403",
    run: async ({ client }) => {
      const annaInBeta = await client.call("anna", "/documents", { workspace: "beta" });
      const daveInUnknown = await client.call("dave", "/documents", { workspace: "omega" });
      const bobInAlpha = await client.call("bob", "/documents", { workspace: "alpha" });
      const ok =
        annaInBeta.status === 403 &&
        annaInBeta.json?.code === "WORKSPACE_MEMBERSHIP_REQUIRED" &&
        daveInUnknown.status === 403 &&
        daveInUnknown.json?.code === "WORKSPACE_MEMBERSHIP_REQUIRED" &&
        bobInAlpha.status === 403;

      return (ok ? pass : fail)(
        `anna in beta ${describeResponse(annaInBeta)}, dave in an unregistered workspace ${describeResponse(daveInUnknown)}, bob (token bound to beta) in alpha ${describeResponse(bobInAlpha)}`
      );
    },
  },
  {
    id: "list_isolation",
    title: "Each member lists exactly its own and its workspace's shared documents",
    run: async ({ client, documents }) => {
      const views = [
        ["alice", "alpha"],
        ["carol", "alpha"],
        ["anna", "alpha"],
        ["bob", "beta"],
        ["ben", "beta"],
        ["carol", "beta"],
      ];
      const problems = [];

      for (const [personaName, workspaceId] of views) {
        const { documents: listed, response } = await listDocuments(client, personaName, workspaceId);
        const listedIds = (listed ?? []).map((document) => document.docId);
        const expected = demoDocumentsVisibleTo(personaName, workspaceId).map(
          (document) => documents[document.fileName].docId
        );

        if (!listed) {
          problems.push(`${personaName}@${workspaceId} ${describeResponse(response)}`);
        } else if (listedIds.length !== expected.length || !expected.every((docId) => listedIds.includes(docId))) {
          problems.push(`${personaName}@${workspaceId} listed ${(listed ?? []).map((document) => document.fileName).join(",")}`);
        }
      }

      return problems.length === 0
        ? pass(`${views.length} listings, each exactly the member's own and the workspace's shared documents`)
        : fail(problems.join("; "));
    },
  },
  {
    id: "download_isolation",
    title: "Another workspace's or another member's private document is 404; own and shared are 200",
    run: async ({ client, documents }) => {
      const docIdOf = (fileName) => documents[fileName].docId;
      const attempts = [
        ["beta's document", "alice", docIdOf("beta-travel-policy.pdf"), 404],
        ["carol's private alpha document", "alice", docIdOf("alpha-security-standard.pdf"), 404],
        ["her own document", "alice", docIdOf("alpha-leave-policy.pdf"), 200],
        ["alpha's shared document", "anna", docIdOf("alpha-shared-glossary.pdf"), 200],
        ["alpha's shared document from beta", "carol", docIdOf("alpha-shared-glossary.pdf"), 404, "beta"],
      ];
      const outcomes = [];
      let ok = true;

      for (const [label, personaName, docId, expected, workspace] of attempts) {
        const response = await client.call(personaName, `/documents/${docId}/file`, { workspace });
        const asExpected =
          response.status === expected && (expected !== 200 || /pdf/u.test(response.headers.get("content-type") ?? ""));

        ok &&= asExpected;
        outcomes.push(`${personaName} ${label} ${describeResponse(response)}`);
      }

      return (ok ? pass : fail)(outcomes.join(", "));
    },
  },
  {
    id: "delete_isolation",
    title: "Deleting another workspace's document is 404 and it survives",
    run: async ({ client, documents }) => {
      const betaDocId = documents[firstDocument("beta").fileName].docId;
      const attempt = await client.call("alice", `/documents/${betaDocId}`, { method: "DELETE" });
      const { documents: betaListing } = await listDocuments(client, "bob");
      const survived = (betaListing ?? []).some((document) => document.docId === betaDocId);

      return attempt.status === 404 && survived
        ? pass("alice (alpha workspace.admin) DELETE beta's document 404; bob still lists it")
        : fail(`alice DELETE ${describeResponse(attempt)}; still in beta: ${survived}`);
    },
  },
  {
    id: "document_trash",
    title: "A delete moves the document to its owner's trash: gone from list, download and chat, invisible and unrestorable to others, restored by its owner",
    run: async ({ client, documents }) => {
      const document = DEMO_DOCUMENTS.find((entry) => entry.fileName === "alpha-leave-policy.pdf");
      const { docId } = documents[document.fileName];
      const ask = () =>
        client.call("alice", "/chat", { json: { docIds: [docId], question: document.question }, method: "POST" });
      const lists = async (personaName, pathname, workspace) => {
        const response = await client.call(personaName, pathname, { workspace });

        return (Array.isArray(response.json) ? response.json : []).some((entry) => entry.docId === docId);
      };
      const outcome = {};
      let restored = null;

      outcome.delete = await client.call("alice", `/documents/${docId}`, { method: "DELETE" });

      try {
        outcome.listed = await lists("alice", "/documents");
        outcome.download = await client.call("alice", `/documents/${docId}/file`);
        outcome.chat = await ask();
        outcome.ownTrash = await findInTrash(client, "alice", document.fileName);
        // Another tenant, and another member of the same workspace: the trash
        // is the deleting (user, workspace) pair's.
        outcome.bobTrash = await lists("bob", "/documents/trash");
        outcome.carolTrash = await lists("carol", "/documents/trash", "alpha");
        outcome.bobRestore = await client.call("bob", `/documents/${docId}/restore`, { method: "POST" });
      } finally {
        restored = await client.call("alice", `/documents/${docId}/restore`, { method: "POST" });
      }

      const listedAgain = await lists("alice", "/documents");
      const chatAgain = await ask();
      const ok =
        outcome.delete.status === 200 &&
        outcome.listed === false &&
        outcome.download.status === 404 &&
        outcome.chat.status === 404 &&
        outcome.ownTrash?.docId === docId &&
        Boolean(outcome.ownTrash?.purgeAfter) &&
        outcome.bobTrash === false &&
        outcome.carolTrash === false &&
        outcome.bobRestore.status === 404 &&
        restored.status === 200 &&
        restored.json?.document?.docId === docId &&
        listedAgain &&
        chatAgain.status === 200 &&
        document.answer.test(String(chatAgain.json?.agentAnswer ?? ""));

      return (ok ? pass : fail)(
        `alice DELETE ${describeResponse(outcome.delete)}; listed ${outcome.listed}, download ${outcome.download ? describeResponse(outcome.download) : "-"}, chat ${outcome.chat ? describeResponse(outcome.chat) : "-"}; in her trash ${Boolean(outcome.ownTrash)} (purge after ${outcome.ownTrash?.purgeAfter ?? "-"}); in bob's trash ${outcome.bobTrash}, in carol's ${outcome.carolTrash}; bob restores ${outcome.bobRestore ? describeResponse(outcome.bobRestore) : "-"}; alice restores ${describeResponse(restored)}, listed again ${listedAgain}, chat ${describeResponse(chatAgain)}`
      );
    },
  },
  {
    id: "chat_isolation",
    title: "Chat over another workspace's document never answers from it; one's own answers",
    run: async ({ client, documents }) => {
      const betaDocument = firstDocument("beta");
      const alphaDocument = firstDocument("alpha");
      const foreign = await client.call("alice", "/chat", {
        json: { docIds: [documents[betaDocument.fileName].docId], question: betaDocument.question },
        method: "POST",
      });
      const own = await client.call("alice", "/chat", {
        json: { docIds: [documents[alphaDocument.fileName].docId], question: alphaDocument.question },
        method: "POST",
      });
      // Nothing of beta's document may reach alice: not its fact, not its
      // file name; and her own answer names no other workspace's document.
      const leaked = betaDocument.answer.test(foreign.text) || foreign.text.includes(betaDocument.fileName);
      const ownAnswered = own.status === 200 && alphaDocument.answer.test(String(own.json?.agentAnswer ?? ""));
      const foreignInOwn = DEMO_DOCUMENTS.filter((document) => document.workspaceId !== "alpha").some(
        (document) => own.text.includes(documents[document.fileName].docId) || own.text.includes(document.fileName)
      );

      return !leaked && ownAnswered && !foreignInOwn
        ? pass(`alice over beta's document ${describeResponse(foreign)} (nothing of it in the reply); over her own 200 with the answer`)
        : fail(
            `alice over beta's document ${describeResponse(foreign)} (beta's document in the reply: ${leaked}); over her own ${describeResponse(own)} answered: ${ownAnswered}, names another workspace's document: ${foreignInOwn}`
          );
    },
  },
  {
    id: "chat_stream_isolation",
    title: "The streamed chat answers one's own document and refuses another workspace's",
    run: async ({ client, documents }) => {
      const alphaDocument = firstDocument("alpha");
      const betaDocument = firstDocument("beta");
      const stream = (docId, question) =>
        client.call("alice", "/chat/stream", {
          headers: { accept: "text/event-stream" },
          json: { docIds: [docId], question },
          method: "POST",
        });
      const own = await stream(documents[alphaDocument.fileName].docId, alphaDocument.question);
      const foreign = await stream(documents[betaDocument.fileName].docId, betaDocument.question);
      // The stream answers 200 at once; the outcome is its result (or error) event.
      const streamEvent = (text, name) => {
        const block = text.split("\n\n").find((part) => part.startsWith(`event: ${name}\n`));
        return block ? JSON.parse(block.slice(block.indexOf("data: ") + 6)) : null;
      };
      const ownResult = streamEvent(own.text, "result");
      const ownAnswered = own.status === 200 && alphaDocument.answer.test(String(ownResult?.body?.agentAnswer ?? ""));
      const leaked = betaDocument.answer.test(foreign.text) || foreign.text.includes(betaDocument.fileName);
      const foreignResult = streamEvent(foreign.text, "result");
      const foreignError = streamEvent(foreign.text, "error");
      const foreignAnswered = foreignResult?.status === 200;
      const foreignOutcome = foreignResult
        ? `result ${foreignResult.status}`
        : foreignError
          ? `error ${foreignError.status}`
          : "no result";

      return ownAnswered && !leaked && !foreignAnswered
        ? pass(`alice's own document: result 200 with the answer; beta's: ${foreignOutcome}, nothing of it in the stream`)
        : fail(
            `own ${describeResponse(own)} answered: ${ownAnswered}; beta's ${describeResponse(foreign)} result ${foreignResult?.status ?? "none"}, its document in the stream: ${leaked}`
          );
    },
  },
  {
    id: "viewer_is_read_only",
    title: "A workspace.viewer reads the shared documents but may not upload or delete (RBAC)",
    run: async ({ client, documents }) => {
      const sharedDocId = documents["alpha-shared-glossary.pdf"].docId;
      const read = await client.call("anna", "/documents");
      const upload = await client.call("anna", "/upload", {
        form: buildPdfForm({ fileName: "anna-attempt.pdf", lines: ["A viewer may not upload."] }),
        method: "POST",
      });
      const remove = await client.call("anna", `/documents/${sharedDocId}`, { method: "DELETE" });
      const ok =
        read.status === 200 &&
        (read.json ?? []).some((document) => document.docId === sharedDocId) &&
        upload.status === 403 &&
        upload.json?.code === "RBAC_PERMISSION_DENIED" &&
        remove.status === 403 &&
        remove.json?.code === "RBAC_PERMISSION_DENIED";

      return (ok ? pass : fail)(
        `anna: list ${describeResponse(read)}, upload ${describeResponse(upload)}, delete ${describeResponse(remove)}`
      );
    },
  },
  {
    id: "membership_roles_in_rbac",
    title: "The registry's membership roles are the RBAC permissions of the active workspace",
    run: async ({ client }) => {
      const views = [
        ["anna", "alpha", ["documents.read", "chat.ask"], ["documents.write", "documents.delete"]],
        ["alice", "alpha", ["documents.read", "documents.write", "documents.delete"], ["admin.tenants.erase"]],
        ["carol", "beta", ["documents.write"], ["documents.delete"]],
      ];
      const problems = [];

      for (const [personaName, workspaceId, granted, withheld] of views) {
        const me = await client.call(personaName, "/auth/me", { workspace: workspaceId });
        const permissions = new Set(me.json?.permissions ?? []);

        if (
          me.status !== 200 ||
          me.json?.workspaceId !== workspaceId ||
          !granted.every((permission) => permissions.has(permission)) ||
          withheld.some((permission) => permissions.has(permission))
        ) {
          problems.push(`${personaName}@${workspaceId} ${describeResponse(me)} ${[...permissions].join(",")}`);
        }
      }

      return problems.length === 0
        ? pass("anna@alpha viewer, alice@alpha admin, carol@beta member, as the registry says")
        : fail(problems.join("; "));
    },
  },
  {
    id: "workspace_switcher",
    title: "GET /auth/me without x-workspace-id lists the workspaces a credential may switch between (the SPA's switcher)",
    run: async ({ client }) => {
      const me = async (personaName) => (await client.call(personaName, "/auth/me", { workspace: null })).json ?? {};
      const carol = await me("carol");
      const alice = await me("alice");
      const anna = await me("anna");
      const sorted = (values) => [...(values ?? [])].sort();
      const ok =
        !carol.workspaceId &&
        JSON.stringify(sorted(carol.workspaceIds)) === JSON.stringify(["alpha", "beta"]) &&
        alice.workspaceId === "alpha" &&
        JSON.stringify(sorted(alice.workspaceIds)) === JSON.stringify(["alpha"]) &&
        Array.isArray(anna.workspaceIds) &&
        anna.workspaceIds.length === 0;

      return (ok ? pass : fail)(
        `carol: ${JSON.stringify(sorted(carol.workspaceIds))} to choose from; alice: fixed ${alice.workspaceId || "-"}; anna (user-only token, membership by header): ${JSON.stringify(anna.workspaceIds ?? null)}`
      );
    },
  },
  {
    id: "memory_isolation",
    title: "Long-term memory and sessions stay with their user",
    run: async ({ client }) => {
      const text = "Alice prefers answers with the policy section number.";
      const remembered = await client.call("alice", "/memory", { json: { text }, method: "POST" });
      const memoryId = remembered.json?.memory?.memoryId ?? remembered.json?.memory?.id;
      const own = await client.call("alice", "/memory");
      const bob = await client.call("bob", "/memory");
      const bobDelete = memoryId ? await client.call("bob", `/memory/${memoryId}`, { method: "DELETE" }) : null;
      const stillThere = await client.call("alice", "/memory");
      // One session id, two tenants: two sessions (rag/memory.js), each
      // cleared by its own tenant.
      const aliceSession = await client.call("alice", "/sessions/demo-shared-session", { method: "DELETE" });
      const bobSession = await client.call("bob", "/sessions/demo-shared-session", { method: "DELETE" });
      const listed = (response) => JSON.stringify(response.json?.memories ?? []).includes(text);
      const ok =
        remembered.status === 201 &&
        listed(own) &&
        bob.status === 200 &&
        !listed(bob) &&
        bobDelete?.status !== 200 &&
        listed(stillThere) &&
        aliceSession.status === 200 &&
        bobSession.status === 200;

      return (ok ? pass : fail)(
        `alice remembers ${describeResponse(remembered)} and lists it: ${listed(own)}; bob lists it: ${listed(bob)}; bob deletes it ${bobDelete ? describeResponse(bobDelete) : "no id"}; still alice's: ${listed(stillThere)}; session clears ${aliceSession.status}/${bobSession.status}`
      );
    },
  },
  {
    id: "workspace_memory",
    title: "A note carol stores in alpha stays in alpha (LONG_MEMORY_SCOPE=workspace); her reply-language preference follows her",
    run: async ({ client, documents }) => {
      const note = "Remember that the Alpha incident bridge is called Harbor Line.";
      const question = "What is the Alpha incident bridge called?";
      const alphaDocument = DEMO_DOCUMENTS.find((entry) => entry.uploader === "carol" && entry.workspaceId === "alpha");
      const betaDocument = DEMO_DOCUMENTS.find((entry) => entry.uploader === "carol" && entry.workspaceId === "beta");
      const memories = async (workspace) =>
        (await client.call("carol", "/memory", { workspace })).json?.memories ?? [];
      const noteIn = (list) => list.find((memory) => /Harbor Line/u.test(memory.text ?? ""));
      const preferenceIn = (list) => list.find((memory) => memory.memoryKey === "reply_language");
      const ask = (workspace, document) =>
        client.call("carol", "/chat", {
          json: { docIds: [documents[document.fileName].docId], question },
          method: "POST",
          workspace,
        });
      const stored = await client.call("carol", "/memory", { json: { text: note }, method: "POST", workspace: "alpha" });
      const preference = await client.call("carol", "/memory", {
        json: { category: "preference", memoryKey: "reply_language", memoryValue: "en", text: "Reply in English." },
        method: "POST",
        workspace: "alpha",
      });
      const result = {};

      try {
        const inBeta = await memories("beta");

        result.noteInBeta = Boolean(noteIn(inBeta));
        result.preferenceInBeta = preferenceIn(inBeta)?.memoryValue ?? null;
        // A beta question that shares the note's words: had the note been
        // recalled, the store would have marked it used (lastUsedAt).
        result.betaChat = (await ask("beta", betaDocument)).status;
        result.usedAfterBeta = noteIn(await memories("alpha"))?.lastUsedAt ?? null;
        // The same question in alpha recalls it.
        result.alphaChat = (await ask("alpha", alphaDocument)).status;
        result.usedAfterAlpha = noteIn(await memories("alpha"))?.lastUsedAt ?? null;
        result.noteWorkspace = noteIn(await memories("alpha"))?.workspaceId ?? null;
      } finally {
        // Back to the seed's state: neither memory stays.
        for (const memoryId of [stored.json?.memory?.memoryId, preference.json?.memory?.memoryId].filter(Boolean)) {
          await client.call("carol", `/memory/${memoryId}`, { method: "DELETE", workspace: "alpha" });
        }
      }

      const ok =
        stored.status === 201 &&
        preference.status === 201 &&
        result.noteInBeta === false &&
        result.preferenceInBeta === "en" &&
        result.betaChat === 200 &&
        result.usedAfterBeta === null &&
        result.alphaChat === 200 &&
        result.usedAfterAlpha !== null &&
        result.noteWorkspace === "alpha";

      return (ok ? pass : fail)(
        `note ${describeResponse(stored)} (workspace ${result.noteWorkspace ?? "-"}), preference ${describeResponse(preference)}; in beta: note listed ${result.noteInBeta}, reply language ${result.preferenceInBeta ?? "none"}; beta chat ${result.betaChat} left the note unused (${result.usedAfterBeta ?? "never used"}); alpha chat ${result.alphaChat} recalled it (${result.usedAfterAlpha ?? "never used"})`
      );
    },
  },
  {
    id: "tenant_manager_least_privilege",
    title: "The tenant manager manages the registry but may not erase or read documents",
    run: async ({ client }) => {
      const workspaces = await client.call("tenantManager", "/admin/workspaces");
      const ids = new Set((workspaces.json?.workspaces ?? []).map((workspace) => workspace.workspaceId ?? workspace.id));
      const erase = await client.call("tenantManager", "/admin/tenants/erase", {
        json: { workspaceId: "alpha" },
        method: "POST",
      });
      const read = await client.call("tenantManager", "/documents", { workspace: "alpha" });
      const ok =
        workspaces.status === 200 &&
        DEMO_WORKSPACES.every((workspace) => ids.has(workspace.id)) &&
        erase.status === 403 &&
        read.status === 403;

      return (ok ? pass : fail)(
        `list workspaces ${describeResponse(workspaces)} (${[...ids].join(",")}), erase ${describeResponse(erase)}, alpha's documents ${describeResponse(read)}`
      );
    },
  },
  {
    id: "suspended_workspace",
    title: "A suspended workspace is refused and works again once reactivated",
    run: async ({ client }) => {
      const suspended = await client.call("tenantManager", "/admin/workspaces/gamma/actions/suspend", {
        method: "POST",
      });
      const whileSuspended = await client.call("dave", "/documents");
      const activated = await client.call("tenantManager", "/admin/workspaces/gamma/actions/activate", {
        method: "POST",
      });
      const afterwards = await client.call("dave", "/documents");
      const alphaMeanwhile = await client.call("alice", "/documents");
      const ok =
        suspended.status === 200 &&
        whileSuspended.status === 403 &&
        whileSuspended.json?.code === "WORKSPACE_SUSPENDED" &&
        activated.status === 200 &&
        afterwards.status === 200 &&
        alphaMeanwhile.status === 200;

      return (ok ? pass : fail)(
        `suspend ${describeResponse(suspended)}, dave while suspended ${describeResponse(whileSuspended)}, activate ${describeResponse(activated)}, dave afterwards ${describeResponse(afterwards)}, alice ${describeResponse(alphaMeanwhile)}`
      );
    },
  },
  {
    id: "background_task_isolation",
    title: "A background task runs in its owner's tenant, and no one else sees it",
    run: async ({ client, documents, taskTimeoutMs = 60_000 }) => {
      const betaDocument = firstDocument("beta");
      const created = await client.call("bob", "/agent-tasks", {
        json: { docIds: [documents[betaDocument.fileName].docId], maxIterations: 1, question: betaDocument.question },
        method: "POST",
      });
      const taskId = created.json?.task?.id;

      if (created.status !== 202 || !taskId) {
        return fail(`POST /agent-tasks ${describeResponse(created)}: ${created.text.slice(0, 200)}`);
      }

      const deadline = Date.now() + taskTimeoutMs;
      let task = null;

      while (Date.now() < deadline) {
        const response = await client.call("bob", `/tasks/${taskId}`);

        task = response.json;

        if (!["pending", "queued", "running"].includes(task?.status)) {
          break;
        }

        await sleep(250);
      }

      const alice = await client.call("alice", `/tasks/${taskId}`);
      const ben = await client.call("ben", `/tasks/${taskId}`);
      const ok = task?.status === "completed" && alice.status === 404 && ben.status === 404;

      return (ok ? pass : fail)(
        `bob's task ${task?.status ?? "unknown"}; alice (alpha) ${describeResponse(alice)}, ben (beta, another member) ${describeResponse(ben)}`
      );
    },
  },
  {
    id: "delete_redaction",
    title: "Excerpts of a deleted document are redacted when it is purged; while it is in the trash they stay",
    // Answer feedback keeps the cited excerpts the client sent with it. The
    // deletion cascade replaces them (as the system role, which may update
    // only that column under the role split: migration 040) when the
    // document is gone for good: at once without the trash, at the purge
    // with it (DOCUMENT_TRASH_RETENTION_HOURS), because a trashed document
    // can still be restored. A settled agent run is redacted the same way
    // where it holds a document's text under its id; the runs of this setup
    // keep only the answer, which a model wrote and the redaction leaves
    // alone (rag/document-deletion-redaction.js). The e2e test ages the
    // trashed probe past the retention and sees the purge redact.
    run: async ({ client }) => {
      const probe = DEMO_REDACTION_PROBE;
      // One probe per walkthrough: a probe a previous run left in the trash is
      // restored rather than uploaded again (an upload of trashed bytes would
      // be a new document, and trashed documents count against the quota).
      const trashed = await findInTrash(client, "bob", probe.fileName);
      const restored = trashed
        ? await client.call("bob", `/documents/${trashed.docId}/restore`, { method: "POST" })
        : null;
      const uploaded = trashed
        ? { code: restored.json?.code ?? null, docId: trashed.docId, outcome: restored.status === 200 ? "restored" : "refused", status: restored.status }
        : await uploadDemoDocument(client, "bob", probe);

      if (!["created", "duplicate", "restored"].includes(uploaded.outcome)) {
        return fail(`getting the probe in place ended ${uploaded.outcome} (${uploaded.status}${uploaded.code ? ` ${uploaded.code}` : ""})`);
      }

      const chat = await client.call("bob", "/chat", {
        json: { docIds: [uploaded.docId], question: probe.question },
        method: "POST",
      });
      const recorded = await client.call("bob", "/feedback", {
        json: {
          answer: { agentAnswer: String(chat.json?.agentAnswer ?? probe.fact) },
          citations: [{ docId: uploaded.docId, excerpt: probe.fact, fileName: probe.fileName, pageNumber: 1 }],
          docIds: [uploaded.docId],
          feedbackType: "helpful",
          question: probe.question,
        },
        method: "POST",
      });
      const feedbackId = recorded.json?.feedback?.feedbackId;
      const readExcerpt = async () => {
        const listing = await client.call("bob", "/feedback?limit=100");
        const record = (listing.json?.feedback ?? []).find((entry) => entry.feedbackId === feedbackId);

        return record?.citations?.[0]?.excerpt ?? null;
      };
      const before = await readExcerpt();
      const removed = await client.call("bob", `/documents/${uploaded.docId}`, { method: "DELETE" });
      const inTrash = await findInTrash(client, "bob", probe.fileName);
      const after = await readExcerpt();
      // With the trash on the excerpt stays until the purge; without it the
      // delete redacts at once.
      const expectedAfter = inTrash ? probe.fact : DELETED_SOURCE_MARKER;
      const ok =
        chat.status === 200 &&
        recorded.status === 201 &&
        before === probe.fact &&
        removed.status === 200 &&
        after === expectedAfter;

      return (ok ? pass : fail)(
        `probe ${uploaded.outcome}; chat ${describeResponse(chat)}, feedback ${describeResponse(recorded)}; excerpt before the delete ${JSON.stringify(before)}; DELETE ${describeResponse(removed)} (${inTrash ? `in the trash until ${inTrash.purgeAfter}` : "deleted for good"}); excerpt after ${JSON.stringify(after)}`
      );
    },
  },
  {
    id: "tenant_rate_limit",
    title: "gamma's chat budget runs out (429) while alpha's is untouched",
    run: async ({ client }) => {
      // Invalid /chat bodies: the per-tenant limiter counts them before the
      // route answers 400, so the budget runs out without calling the model.
      let limited = null;
      let sent = 0;

      for (; sent < 100 && !limited; sent += 1) {
        const response = await client.call("dave", "/chat", { json: {}, method: "POST" });

        if (response.status === 429) {
          limited = response;
        }
      }

      const neighbour = await client.call("alice", "/chat", { json: {}, method: "POST" });
      const ok =
        limited?.json?.code === "TENANT_RATE_LIMITED" &&
        neighbour.status === 400;

      return (ok ? pass : fail)(
        `gamma: ${limited ? `429 ${limited.json?.code} after ${sent} requests` : `no 429 in ${sent} requests`}; alpha meanwhile ${describeResponse(neighbour)} (400: counted, not limited)`
      );
    },
  },
  {
    id: "refusal_accounting",
    title: "The platform admin's usage view counts gamma's TENANT_RATE_LIMITED refusals, and none for alpha",
    run: async ({ client, usageTimeoutMs = 30_000 }) => {
      const deadline = Date.now() + usageTimeoutMs;
      const pathname = "/admin/usage?metric=refusals&reason=TENANT_RATE_LIMITED&groupBy=workspace&limit=100";
      let usage = null;
      let rows = [];

      // The ledger is flushed every TENANT_USAGE_FLUSH_MS.
      while (Date.now() < deadline) {
        usage = await client.call("platformAdmin", pathname);
        rows = usage.json?.tenants ?? [];

        if (rows.some((row) => row.workspaceId === "gamma")) {
          break;
        }

        await sleep(1000);
      }

      const gamma = rows.find((row) => row.workspaceId === "gamma");
      const alpha = rows.find((row) => row.workspaceId === "alpha");
      const ok =
        usage?.status === 200 &&
        Number(gamma?.refusals?.TENANT_RATE_LIMITED ?? 0) > 0 &&
        alpha === undefined;

      return (ok ? pass : fail)(
        `usage ${usage ? describeResponse(usage) : "-"}: gamma ${JSON.stringify(gamma?.refusals ?? null)}, alpha ${alpha ? JSON.stringify(alpha.refusals) : "none"}`
      );
    },
  },
  {
    id: "storage_quota",
    title: "gamma's storage quota refuses an upload past TENANT_MAX_DOCUMENTS (trashed documents count until purged)",
    run: async ({ client }) => {
      const outcomes = [];
      const trashedBefore = await client.call("dave", "/documents/trash");
      const trashedProbes = (Array.isArray(trashedBefore.json) ? trashedBefore.json : []).filter((document) =>
        /^gamma-quota-probe-/u.test(document.fileName ?? "")
      ).length;

      for (let index = 1; index <= DEMO_QUOTA_PROBE_LIMIT; index += 1) {
        const uploaded = await uploadDemoDocument(client, "dave", buildQuotaProbeDocument(index));

        outcomes.push(uploaded);

        if (uploaded.outcome === "refused" || uploaded.outcome === "failed") {
          break;
        }
      }

      const last = outcomes.at(-1);
      const storedProbes = outcomes.filter((outcome) => outcome.outcome === "created" || outcome.outcome === "duplicate");
      // dave (gamma workspace.admin) deletes the probes he stored. With the
      // trash on they go to gamma's trash and keep counting against the quota
      // until the purge, so a later walkthrough is refused at once.
      const cleanup = [];

      for (const probe of storedProbes) {
        cleanup.push((await client.call("dave", `/documents/${probe.docId}`, { method: "DELETE" })).status);
      }

      const ok =
        last?.outcome === "refused" &&
        last.code === "TENANT_STORAGE_QUOTA_EXCEEDED" &&
        cleanup.every((status) => status === 200);

      return ok
        ? pass(
            `refused with ${last.status} TENANT_STORAGE_QUOTA_EXCEEDED after ${storedProbes.length} stored probes (deleted again)${
              trashedProbes > 0 ? `, with ${trashedProbes} probes of an earlier walkthrough still in gamma's trash` : ""
            }`
          )
        : fail(
            `outcomes ${outcomes.map((outcome) => `${outcome.outcome}${outcome.code ? `:${outcome.code}` : ""}`).join(", ")}; cleanup ${cleanup.join(",") || "none"}`
          );
    },
  },
  {
    id: "platform_usage_view",
    title: "The platform admin's usage view shows both tenants; a tenant admin may not read it",
    run: async ({ client, usageTimeoutMs = 30_000 }) => {
      const deadline = Date.now() + usageTimeoutMs;
      let workspaces = new Set();
      let usage = null;

      // The ledger is flushed every TENANT_USAGE_FLUSH_MS.
      while (Date.now() < deadline) {
        usage = await client.call("platformAdmin", "/admin/usage?metric=ingested_bytes&groupBy=workspace&limit=100");
        workspaces = new Set((usage.json?.tenants ?? []).map((row) => row.workspaceId));

        if (workspaces.has("alpha") && workspaces.has("beta")) {
          break;
        }

        await sleep(1000);
      }

      const tenantAdmin = await client.call("alice", "/admin/usage");
      const ok = usage?.status === 200 && workspaces.has("alpha") && workspaces.has("beta") && tenantAdmin.status === 403;

      return (ok ? pass : fail)(
        `platform-admin ${describeResponse(usage)} workspaces ${[...workspaces].join(",") || "none"}; alice ${describeResponse(tenantAdmin)}`
      );
    },
  },
  {
    id: "erase_dry_run",
    title: "A tenant erase dry run reports counts and erases nothing",
    run: async ({ client, documents }) => {
      const preview = await client.call("platformAdmin", "/admin/tenants/erase", {
        json: { workspaceId: "alpha" },
        method: "POST",
      });
      const documentsStore = (preview.json?.stores ?? []).find((store) => store.store === "documents");
      // totals.records is per table: { documents: 3, ... }.
      const records = sumCounts(preview.json?.totals?.records);
      const after = await discoverDemoDocuments({ client }).catch(() => null);
      const alphaDocIds = docIdsOf({ documents }, "alpha");
      const nothingErased = Boolean(after) && alphaDocIds.every((docId) =>
        Object.values(after).some((document) => document.docId === docId)
      );
      const ok =
        preview.status === 200 &&
        preview.json?.dryRun === true &&
        documentsStore?.status === "ok" &&
        records > 0 &&
        nothingErased;

      return (ok ? pass : fail)(
        `dry run ${describeResponse(preview)}: ${records} records over ${(preview.json?.stores ?? []).length} stores, documents ${JSON.stringify(documentsStore?.tables ?? null)}; alpha's documents still listed: ${nothingErased}`
      );
    },
  },
  {
    id: "export_isolation",
    title: "The export of alpha holds alpha's records and none of beta's",
    run: async ({ client, documents }) => {
      const exported = await client.call("platformAdmin", "/admin/tenants/export?workspaceId=alpha");
      const lines = exported.text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const records = lines.filter((line) => line.type === "record");
      const { foreignContent, foreignDocIds, foreignUsers } = collectForeignMarkers({ documents }, "alpha");
      const recordText = (line) => JSON.stringify(line.record);
      const foreignWorkspace = records.filter((line) => {
        const workspaceId = readWorkspaceField(line.record);
        return workspaceId !== undefined && workspaceId !== "alpha";
      });
      const foreignUser = records.filter((line) =>
        ["userId", "user_id", "owner_user_id", "ownerUserId"].some((key) => foreignUsers.includes(line.record?.[key]))
      );
      const foreignData = records.filter((line) =>
        foreignContent.some((marker) => (marker instanceof RegExp ? marker.test(recordText(line)) : recordText(line).includes(marker)))
      );
      // alpha's own records may quote a beta document id that alpha itself
      // sent (alice's refused chat, download and delete above record the ids
      // she asked for); that is alpha's request, not beta's data.
      const quotingForeignIds = records.filter((line) => foreignDocIds.some((docId) => recordText(line).includes(docId)));
      const ownDocIds = docIdsOf({ documents }, "alpha");
      const hasOwn = ownDocIds.every((docId) => records.some((line) => recordText(line).includes(docId)));
      const ok =
        exported.status === 200 &&
        records.length > 0 &&
        hasOwn &&
        foreignWorkspace.length === 0 &&
        foreignUser.length === 0 &&
        foreignData.length === 0;

      return (ok ? pass : fail)(
        `export ${exported.status}: ${records.length} records, alpha's documents present: ${hasOwn}; records of another workspace ${foreignWorkspace.length}, of beta's users ${foreignUser.length}, with beta's content ${foreignData.length} (${quotingForeignIds.length} of alpha's own records quote a beta id alpha sent: ${[...new Set(quotingForeignIds.map((line) => line.table ?? line.store))].join(",") || "none"})`
      );
    },
  },
  {
    id: "data_access_audit",
    title: "Data-access events are audited; only the platform admin reads across tenants",
    run: async ({ client }) => {
      const audit = await client.call("platformAdmin", "/admin/audit?workspaceId=alpha&limit=200");
      const events = audit.json?.events ?? [];
      const dataEvents = events.filter((event) => event.type === "data.access");
      const otherWorkspace = events.filter((event) => (event.principal?.workspaceId ?? "alpha") !== "alpha");
      const platform = await client.call("platformAdmin", "/admin/audit?limit=200");
      const workspaces = new Set(
        (platform.json?.events ?? []).map((event) => event.principal?.workspaceId).filter(Boolean)
      );
      const tenantAdmin = await client.call("alice", "/admin/audit");
      const ok =
        audit.status === 200 &&
        dataEvents.length > 0 &&
        otherWorkspace.length === 0 &&
        platform.status === 200 &&
        workspaces.size >= 2 &&
        tenantAdmin.status === 403;

      return (ok ? pass : fail)(
        `alpha's trail ${describeResponse(audit)}: ${events.length} events, ${dataEvents.length} data.access, ${otherWorkspace.length} of another workspace; across tenants ${describeResponse(platform)} (${[...workspaces].join(",")}); alice ${describeResponse(tenantAdmin)}`
      );
    },
  },
  {
    id: "audit_chain",
    title: "The audit hash chain verifies",
    run: async () =>
      skip(
        "verification reads the database: run `npm run audit:verify` in server/ with the profile's two database URLs (docs/demo-tenant-isolation.md)"
      ),
  },
]);

/**
 * Runs the checklist and resolves [{ id, title, status, detail }]. A check
 * that throws is a FAIL with the error's message. `only` limits it to some ids.
 */
export const runDemoWalkthrough = async ({ client, log = () => {}, only = null, usageTimeoutMs } = {}) => {
  const documents = await discoverDemoDocuments({ client });
  const context = { client, documents, ...(usageTimeoutMs ? { usageTimeoutMs } : {}) };
  const results = [];

  for (const check of DEMO_CHECKS) {
    if (only && !only.includes(check.id)) {
      continue;
    }

    let outcome;

    try {
      outcome = await check.run(context);
    } catch (error) {
      outcome = fail(`threw: ${error instanceof Error ? error.message : String(error)}`);
    }

    results.push({ detail: outcome.detail, id: check.id, status: outcome.status, title: check.title });
    log(`${outcome.status} ${check.id}: ${outcome.detail}`);
  }

  return results;
};

/** A plain-text PASS/FAIL table of walkthrough results. */
export const formatDemoResultTable = (results = []) => {
  const rows = results.map((result) => [result.status, result.id, result.detail]);
  const statusWidth = Math.max(6, ...rows.map((row) => row[0].length));
  const idWidth = Math.max(5, ...rows.map((row) => row[1].length));
  const header = `${"RESULT".padEnd(statusWidth)}  ${"CHECK".padEnd(idWidth)}  DETAIL`;
  const lines = rows.map((row) => `${row[0].padEnd(statusWidth)}  ${row[1].padEnd(idWidth)}  ${row[2]}`);
  const counts = ["PASS", "FAIL", "SKIP"].map(
    (status) => `${results.filter((result) => result.status === status).length} ${status}`
  );

  return [header, "-".repeat(header.length), ...lines, "", counts.join(", ")].join("\n");
};
