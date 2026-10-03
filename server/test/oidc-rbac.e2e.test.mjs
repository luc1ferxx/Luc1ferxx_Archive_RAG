import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startDevOidcProvider } from "../dev-oidc-provider.mjs";
import { buildTextPdf } from "../evaluation/load-bench-pdf.mjs";
import { buildFakeChatAnswer, hashEmbedding } from "../evaluation/run-api-load-bench.mjs";

// OIDC + RBAC end to end, without a browser: the dev IdP (in this process, on
// port 0), the real server as a child process (API_AUTH_ENABLED, OIDC on,
// RBAC_MODE=enforce, local vector store, a fake OpenAI-compatible model), and
// a client that runs the Authorization Code + PKCE flow over HTTP the way the
// SPA does. Then the same /chat through a split deployment (api edge in front
// of an agent tier), where RBAC is decided at the edge.
//
// The child processes see nothing of the developer's shell or server/.env:
// only the variables below, DOTENV_CONFIG_PATH names an empty file, and the
// working directory is the temp root.

const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverUrl = pathToFileURL(`${serverDirectory}/`).href;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "oidc-rbac-e2e-"));
const EMBEDDING_DIMENSIONS = 64;
const REDIRECT_URI = "http://127.0.0.1:3000/";
const JWKS_TTL_MS = 1500;
const JWKS_MIN_REFRESH_MS = 200;
const QUESTION = "How many paid annual leave days do employees receive?";
const HANDBOOK_LINES = [
  "Program Aster employee handbook.",
  "Employees receive twelve paid annual leave days each year.",
  "Unused leave days carry over until the end of March.",
];

// vera was a member while onboarding (she uploaded her own handbook) and is
// a viewer now. The dev IdP keeps each user's claims object and reads it at
// every token issue, so changing veraClaims changes vera's next token.
const veraClaims = { workspace_roles: { "ws-a": ["workspace.member"] }, workspaces: ["ws-a"] };
const IDP_USERS = [
  { claims: veraClaims, sub: "vera" },
  {
    claims: {
      workspace_id: "ws-a",
      workspace_roles: { "ws-a": ["workspace.member"] },
      workspaces: ["ws-a"],
    },
    sub: "mia",
  },
  {
    claims: {
      workspace_roles: { "ws-a": ["workspace.admin"], "ws-b": ["workspace.viewer"] },
      workspaces: ["ws-a", "ws-b"],
    },
    sub: "dana",
  },
];

const children = new Set();
const servers = new Set();

after(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }

  await Promise.all([...servers].map((server) => server.stop()));
  rmSync(tempRoot, { force: true, recursive: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readBody = async (req) => {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
};

// OpenAI-compatible embeddings and chat (JSON or SSE) with the load bench's
// deterministic answers, as in service-split.e2e.test.mjs.
const startFakeModel = async () => {
  const server = http.createServer(async (req, res) => {
    const payload = JSON.parse((await readBody(req)) || "{}");

    if (req.url.endsWith("/embeddings")) {
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: inputs.map((input, index) => ({
            embedding: hashEmbedding(input, EMBEDDING_DIMENSIONS),
            index,
            object: "embedding",
          })),
          model: payload.model,
          object: "list",
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        })
      );
      return;
    }

    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "No such route." } }));
      return;
    }

    const content = buildFakeChatAnswer(payload);
    const usage = { completion_tokens: 20, prompt_tokens: 400, total_tokens: 420 };

    if (!payload.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", index: 0, message: { content, role: "assistant" } }],
          model: payload.model,
          object: "chat.completion",
          usage,
        })
      );
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }], model: payload.model })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], model: payload.model, usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const entry = {
    stop: () =>
      new Promise((resolve) => {
        servers.delete(entry);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    url: `http://127.0.0.1:${server.address().port}`,
  };

  servers.add(entry);

  return entry;
};

const spawnServer = async ({ args, environment, name }) => {
  const child = spawn(process.execPath, args, {
    cwd: tempRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = [];
  const keep = (chunk) => {
    tail.push(...String(chunk).split("\n").filter(Boolean));
    tail.splice(0, Math.max(0, tail.length - 60));
  };

  children.add(child);
  child.stderr.on("data", keep);

  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      keep(chunk);
      const match = /(?:is running on port|E2E_LISTENING) (\d+)/u.exec(tail.join("\n"));

      if (match) {
        resolve(Number(match[1]));
      }
    });
    exited.then(({ code, signal }) =>
      reject(new Error(`${name} exited (${code ?? signal}) before listening:\n${tail.join("\n")}`))
    );
  });

  return {
    logs: () => tail.join("\n"),
    stop: async () => {
      child.kill("SIGTERM");
      await exited;
      children.delete(child);
    },
    url: `http://127.0.0.1:${port}`,
  };
};

const INHERITED_VARIABLES = /^(HOME|LANG|LC_ALL|NODE_V8_COVERAGE|PATH|SYSTEMROOT|TEMP|TMP|TMPDIR)$/u;
const emptyEnvironmentFile = path.join(tempRoot, "empty.env");

writeFileSync(emptyEnvironmentFile, "", "utf8");

const SERVICE_KEYS = `e2e:${randomBytes(32).toString("hex")}`;

const baseEnvironment = ({ idp, model }) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => INHERITED_VARIABLES.test(name))),
  AGENT_EXECUTION_PLANNER: "deterministic",
  AGENT_INTENT_PLANNER: "deterministic",
  AGENT_PLANNER_ROLLOUT: "deterministic",
  API_AUTH_ENABLED: "true",
  API_AUTH_OIDC_AUDIENCE: idp.audience,
  API_AUTH_OIDC_CLIENT_ID: idp.clientId,
  API_AUTH_OIDC_ENABLED: "true",
  API_AUTH_OIDC_ISSUER: idp.issuer,
  API_AUTH_OIDC_JWKS_MIN_REFRESH_MS: String(JWKS_MIN_REFRESH_MS),
  API_AUTH_OIDC_JWKS_TTL_MS: String(JWKS_TTL_MS),
  API_AUTH_OIDC_REQUIRE_TYP: "true",
  DOCCOMPARE_STANDALONE: "1",
  DOTENV_CONFIG_PATH: emptyEnvironmentFile,
  DOTENV_CONFIG_QUIET: "true",
  INTERNAL_SERVICE_KEYS: SERVICE_KEYS,
  OPENAI_API_KEY: "e2e-model-key",
  OPENAI_BASE_URL: `${model.url}/v1`,
  OPENAI_CHAT_MODEL: "e2e-chat",
  OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
  PDF_PARSER: "pdfjs",
  PORT: "0",
  RAG_CLAIM_JUDGE: "off",
  RAG_DATA_DIRECTORY: path.join(tempRoot, "rag-data"),
  RAG_INGEST_MODE: "sync",
  RAG_OBSERVABILITY_ENABLED: "false",
  RAG_RERANK_ENABLED: "false",
  RAG_SEMANTIC_CACHE: "off",
  RAG_SHARED_STATE: "memory",
  RATE_LIMIT_ENABLED: "false",
  RBAC_MODE: "enforce",
  STARTUP_HEALTH_STRICT: "false",
  UPLOADS_DIRECTORY: path.join(tempRoot, "uploads"),
  VECTOR_STORE_PROVIDER: "local",
});

const SERVER_ENTRY = [path.join(serverDirectory, "server.js")];
const MONOLITH_HARNESS = [
  "--input-type=module",
  "-e",
  `const root = ${JSON.stringify(serverUrl)};
const { applyStandaloneProfile } = await import(new URL("standalone-profile.js", root));
applyStandaloneProfile();
const { createApp } = await import(new URL("app.js", root));
const app = await createApp();
const server = app.listen(0, "127.0.0.1", () => console.log("E2E_LISTENING " + server.address().port));
process.once("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});`,
];

// Authorization Code + PKCE (S256) as a public client: discovery, /authorize
// with login_hint (the dev IdP's auto-approval), the redirect back with code,
// state and iss, then the code exchange with the verifier.
const login = async (idp, loginHint) => {
  const discovery = await (await fetch(`${idp.issuer}/.well-known/openid-configuration`)).json();
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const authorize = new URL(discovery.authorization_endpoint);

  authorize.search = new URLSearchParams({
    client_id: idp.clientId,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    login_hint: loginHint,
    nonce: randomBytes(16).toString("base64url"),
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid profile",
    state,
  }).toString();

  const redirect = await fetch(authorize, { redirect: "manual" });

  assert.equal(redirect.status, 302);

  const callback = new URL(redirect.headers.get("location"));

  assert.equal(`${callback.origin}${callback.pathname}`, REDIRECT_URI);
  assert.equal(callback.searchParams.get("state"), state);
  assert.equal(callback.searchParams.get("iss"), idp.issuer);

  const exchange = await fetch(discovery.token_endpoint, {
    body: new URLSearchParams({
      client_id: idp.clientId,
      code: callback.searchParams.get("code"),
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  assert.equal(exchange.status, 200);

  const tokens = await exchange.json();

  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.access_token && tokens.id_token);
  lastIdToken = tokens.id_token;

  return tokens.access_token;
};

let lastIdToken = "";

const kidOf = (token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")).kid;

const call = async (baseUrl, route, { body, form, method = "GET", token, workspaceId } = {}) => {
  const response = await fetch(`${baseUrl}${route}`, {
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
    },
    method,
  });
  const text = await response.text();

  return {
    headers: response.headers,
    json: text ? JSON.parse(text) : null,
    status: response.status,
    text,
  };
};

const upload = (baseUrl, { fileName, lines, token, workspaceId }) => {
  const form = new FormData();

  form.append(
    "file",
    new Blob([buildTextPdf({ pages: [lines], title: fileName })], { type: "application/pdf" }),
    fileName
  );

  return call(baseUrl, "/upload", { form, method: "POST", token, workspaceId });
};

const assertRbacDenied = (response, permission) => {
  assert.equal(response.status, 403, response.text);
  assert.deepEqual(response.json, {
    code: "RBAC_PERMISSION_DENIED",
    error: "Forbidden.",
    permission,
  });
};

const MEMBER_PERMISSIONS = [
  "chat.ask",
  "documents.read",
  "documents.write",
  "memory.read",
  "memory.write",
  "quality.feedback",
  "tasks.run",
];

test("OIDC login + RBAC enforce: roles from the IdP decide every route, keys rotate, expired tokens fail, and the split edge enforces before forwarding", async () => {
  let clockOffsetMs = 0;
  const idp = await startDevOidcProvider({
    now: () => Date.now() + clockOffsetMs,
    redirectUris: [REDIRECT_URI],
    users: IDP_USERS,
  });

  servers.add({ stop: () => idp.stop() });

  const model = await startFakeModel();
  const environment = baseEnvironment({ idp, model });
  const app = await spawnServer({ args: MONOLITH_HARNESS, environment, name: "monolith" });

  // The SPA's login configuration: public, no secret.
  const config = await call(app.url, "/auth/config");

  assert.equal(config.status, 200);
  assert.deepEqual(config.json, {
    mode: "oidc",
    oidc: {
      audience: idp.audience,
      clientId: idp.clientId,
      issuer: idp.issuer,
      scopes: ["openid", "profile", "email"],
    },
  });
  assert.equal(config.headers.get("cache-control"), "no-store");

  // No token and a garbage token fail.
  assert.equal((await call(app.url, "/documents")).status, 401);
  assert.equal((await call(app.url, "/documents", { token: "not-a-jwt" })).status, 401);

  // Onboarding: vera (member then) uploads her handbook.
  const veraOnboarding = await login(idp, "vera");
  const veraUpload = await upload(app.url, {
    fileName: "vera-handbook.pdf",
    lines: HANDBOOK_LINES,
    token: veraOnboarding,
  });

  assert.equal(veraUpload.status, 201, veraUpload.text);

  // Viewer: reads her documents and asks /chat; upload and delete are 403.
  veraClaims.workspace_roles = { "ws-a": ["workspace.viewer"] };
  const vera = await login(idp, "vera");

  // The ID token (aud = client id, typ JWT) is not an API credential.
  assert.equal((await call(app.url, "/documents", { token: lastIdToken })).status, 401);
  const veraDocuments = await call(app.url, "/documents", { token: vera });

  assert.equal(veraDocuments.status, 200);
  assert.equal(veraDocuments.json.length, 1);

  const veraDocId = veraDocuments.json[0].docId;
  const veraChat = await call(app.url, "/chat", {
    body: { docIds: [veraDocId], question: QUESTION },
    method: "POST",
    token: vera,
  });

  assert.equal(veraChat.status, 200, veraChat.text);
  assert.match(veraChat.json.text ?? veraChat.json.answer ?? veraChat.text, /twelve/iu);
  assertRbacDenied(
    await upload(app.url, { fileName: "nope.pdf", lines: ["Viewer upload."], token: vera }),
    "documents.write"
  );
  assertRbacDenied(
    await call(app.url, `/documents/${veraDocId}`, { method: "DELETE", token: vera }),
    "documents.delete"
  );

  // Member: uploads and chats, cannot delete (not even her own document).
  const mia = await login(idp, "mia");
  const miaUpload = await upload(app.url, {
    fileName: "mia-handbook.pdf",
    lines: [...HANDBOOK_LINES, "Mia keeps this copy."],
    token: mia,
  });

  assert.equal(miaUpload.status, 201, miaUpload.text);

  const miaDocId = miaUpload.json.docId ?? miaUpload.json.document?.docId;

  assert.ok(miaDocId, miaUpload.text);

  const miaChat = await call(app.url, "/chat", {
    body: { docIds: [miaDocId], question: QUESTION },
    method: "POST",
    token: mia,
  });

  assert.equal(miaChat.status, 200, miaChat.text);
  assertRbacDenied(
    await call(app.url, `/documents/${miaDocId}`, { method: "DELETE", token: mia }),
    "documents.delete"
  );

  // RBAC grants actions, never visibility: vera cannot see mia's document.
  const crossOwner = await call(app.url, "/chat", {
    body: { docIds: [miaDocId], question: QUESTION },
    method: "POST",
    token: vera,
  });

  assert.notEqual(crossOwner.status, 200);
  assert.notEqual(crossOwner.json?.code, "RBAC_PERMISSION_DENIED");

  // /auth/me: the effective access for the active workspace, never the token.
  const me = await call(app.url, "/auth/me", { token: mia });

  assert.equal(me.status, 200);
  assert.deepEqual(me.json, {
    authProvider: "oidc",
    permissions: MEMBER_PERMISSIONS,
    rbacMode: "enforce",
    roles: ["workspace.member"],
    userId: "mia",
    workspaceId: "ws-a",
    workspaceIds: ["ws-a"],
  });
  assert.equal(me.headers.get("cache-control"), "no-store");
  assert.equal(me.text.includes(mia), false);

  // workspace.admin of ws-a: uploads and deletes in ws-a; in ws-b (viewer)
  // the same delete is 403. Workspace roles carry no admin.* permission.
  const dana = await login(idp, "dana");
  const danaUpload = await upload(app.url, {
    fileName: "dana-notes.pdf",
    lines: ["Dana keeps the release checklist.", "Releases ship on Thursdays."],
    token: dana,
    workspaceId: "ws-a",
  });

  assert.equal(danaUpload.status, 201, danaUpload.text);

  const danaDocId = danaUpload.json.docId ?? danaUpload.json.document?.docId;

  assertRbacDenied(
    await call(app.url, `/documents/${danaDocId}`, { method: "DELETE", token: dana, workspaceId: "ws-b" }),
    "documents.delete"
  );

  const danaDelete = await call(app.url, `/documents/${danaDocId}`, {
    method: "DELETE",
    token: dana,
    workspaceId: "ws-a",
  });

  assert.equal(danaDelete.status, 200, danaDelete.text);

  const danaMe = await call(app.url, "/auth/me", { token: dana, workspaceId: "ws-b" });

  assert.deepEqual(danaMe.json.permissions, ["chat.ask", "documents.read"]);
  assert.deepEqual(danaMe.json.roles, ["workspace.viewer"]);
  assert.equal((await call(app.url, "/admin/status", { token: dana, workspaceId: "ws-a" })).status, 403);

  // A workspace outside the token's workspaces claim is refused.
  assert.equal((await call(app.url, "/documents", { token: mia, workspaceId: "ws-b" })).status, 403);

  // Expired: a token issued an hour ago (600 s lifetime) is a 401.
  clockOffsetMs = -60 * 60 * 1000;
  const expired = await login(idp, "mia");
  clockOffsetMs = 0;

  const expiredResponse = await call(app.url, "/documents", { token: expired });

  assert.equal(expiredResponse.status, 401);
  assert.equal(expiredResponse.text.includes(expired), false);

  // Key rotation. Rotate: the new key signs, JWKS serves both; a token with
  // the new (unknown) kid triggers one rate-limited JWKS refresh and passes,
  // and old-key tokens keep working.
  const oldKeyToken = mia;
  const oldKid = kidOf(oldKeyToken);

  idp.rotateKeys();
  await sleep(JWKS_MIN_REFRESH_MS + 50);

  const newKeyToken = await login(idp, "mia");

  assert.notEqual(kidOf(newKeyToken), oldKid);
  assert.equal((await call(app.url, "/documents", { token: newKeyToken })).status, 200);

  const cachedAt = Date.now();

  assert.equal((await call(app.url, "/documents", { token: oldKeyToken })).status, 200);

  // Drop every old key: tokens with an old kid still verify against the cached
  // key set until its TTL runs out, then the refreshed set rejects them.
  idp.rotateKeys({ dropPrevious: true });

  const withinTtl = await call(app.url, "/documents", { token: oldKeyToken });

  if (Date.now() - cachedAt < JWKS_TTL_MS - 200) {
    assert.equal(withinTtl.status, 200, "the cached key set still holds the old key");
  }

  await sleep(JWKS_TTL_MS + JWKS_MIN_REFRESH_MS + 100);

  assert.equal((await call(app.url, "/documents", { token: oldKeyToken })).status, 401);
  assert.equal((await call(app.url, "/documents", { token: newKeyToken })).status, 401);

  const rotatedToken = await login(idp, "mia");

  assert.equal((await call(app.url, "/documents", { token: rotatedToken })).status, 200);

  // Split deployment: the api edge (OIDC + RBAC) in front of an agent tier
  // that has no OIDC configuration and does not mount RBAC. The documents are
  // on disk, so the agent tier reads them at start.
  const agent = await spawnServer({
    args: SERVER_ENTRY,
    environment: {
      ...environment,
      API_AUTH_OIDC_ENABLED: "false",
      API_AUTH_OIDC_ISSUER: "",
      ARCHIVE_RAG_ROLE: "agent",
    },
    name: "agent",
  });
  const edge = await spawnServer({
    args: SERVER_ENTRY,
    environment: { ...environment, AGENT_SERVICE_URL: agent.url, ARCHIVE_RAG_ROLE: "api" },
    name: "api",
  });
  const veraNow = await login(idp, "vera");
  const edgeChat = await call(edge.url, "/chat", {
    body: { docIds: [veraDocId], question: QUESTION },
    method: "POST",
    token: veraNow,
  });
  const monolithChat = await call(app.url, "/chat", {
    body: { docIds: [veraDocId], question: QUESTION },
    method: "POST",
    token: veraNow,
  });

  assert.equal(edgeChat.status, 200, `${edgeChat.text}\n${edge.logs()}\n${agent.logs()}`);
  assert.equal(edgeChat.json.text ?? edgeChat.json.answer, monolithChat.json.text ?? monolithChat.json.answer);

  // A forwarded route the viewer lacks (tasks.run) is refused at the edge: the
  // RBAC code only exists there, since the agent tier does not mount RBAC.
  assertRbacDenied(
    await call(edge.url, "/agent-tasks", { body: {}, method: "POST", token: veraNow }),
    "tasks.run"
  );
  // The agent tier never accepts a public bearer token.
  assert.equal((await call(agent.url, "/chat", { body: { question: QUESTION }, method: "POST", token: veraNow })).status, 401);

  await Promise.all([edge.stop(), agent.stop(), app.stop()]);
});
