// The cross-site guard (cross-site-guard.js) as createApp mounts it. A browser
// request (Origin or Sec-Fetch-Site) that would change data from another site
// is refused, and so, while API auth is off, is any request naming a host that
// is neither loopback, an IP address nor an ALLOWED_ORIGINS host (DNS
// rebinding; a rebinding page's same-origin GET carries no browser header).
// Requests without browser headers, the Vite dev frontend, the
// single-container frontend, a listed split-origin frontend, the PDF preview
// iframe and probes pass. With ALLOWED_ORIGINS empty, CORS reflects loopback
// pages only and still sends Vary: Origin.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../app.js";
import {
  CROSS_SITE_REQUEST_REFUSED,
  HOST_NOT_ALLOWED,
  compileAllowedOrigins,
  getRequestHost,
  isAllowedHost,
  isAllowedOrigin,
  isIpAddressHostname,
  isLoopbackOrigin,
  isSameOrigin,
  isStateChangingRequest,
  parseOrigin,
} from "../cross-site-guard.js";
import { createInMemoryAgentRunStore } from "../rag/agent-runs.js";
import { createInMemoryTaskStore } from "../rag/tasks.js";
import { withEnv } from "./langgraph-execution-plan-graph/mask.mjs";

const ATTACKER = "https://attacker.example";
const VITE_DEV = "http://localhost:3000";
const FRONTEND = "https://frontend.example.test";
const OWNER_TOKEN = "cross-site-guard-owner-0f6c2e8a9b4d4c1e8a7f3b2d6e5c9a10";

// Every setting the guard and CORS read, reset for each app. createApp reads
// ALLOWED_ORIGINS, TRUST_PROXY and FRONTEND_BUILD_DIRECTORY once; the guard
// reads API_AUTH_ENABLED per request, so the env stays applied while the
// server answers.
const BASE_ENV = Object.freeze({
  ALLOWED_ORIGINS: undefined,
  API_AUTH_ENABLED: undefined,
  API_AUTH_JWT_ENABLED: undefined,
  API_AUTH_OIDC_ENABLED: undefined,
  API_AUTH_TOKEN: undefined,
  API_AUTH_TOKENS: undefined,
  FRONTEND_BUILD_DIRECTORY: undefined,
  RATE_LIMIT_ENABLED: undefined,
  RBAC_MODE: undefined,
  TENANT_RATE_LIMIT_ENABLED: undefined,
  TRUST_PROXY: undefined,
});

const AUTH_ENV = Object.freeze({
  API_AUTH_ENABLED: "true",
  API_AUTH_TOKENS: JSON.stringify({
    [OWNER_TOKEN]: { userId: "alice", workspaceId: "acme" },
  }),
});

const okHealthService = {
  buildHealthReport: async () => ({ checks: {}, status: "ok" }),
  runStartupHealthChecks: async () => ({ checks: {}, status: "ok" }),
};

// node:http rather than fetch: fetch drops a Host header it is given.
const send = (port, { body, headers = {}, method = "GET", path: requestPath = "/" } = {}) =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        agent: false,
        headers: { host: `127.0.0.1:${port}`, ...headers },
        host: "127.0.0.1",
        method,
        path: requestPath,
        port,
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;

          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }

          resolve({ headers: response.headers, json, status: response.statusCode, text });
        });
      }
    );

    request.on("error", reject);
    request.end(body);
  });

const withGuardedApp = async (env, run, { serveFrontend = false } = {}) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cross-site-guard-"));
  const frontendDirectory = path.join(tempRoot, "frontend");

  if (serveFrontend) {
    await mkdir(frontendDirectory);
    await writeFile(
      path.join(frontendDirectory, "index.html"),
      "<!doctype html><title>Archive</title>"
    );
  }

  const appEnv = {
    ...BASE_ENV,
    ...env,
    ...(serveFrontend ? { FRONTEND_BUILD_DIRECTORY: frontendDirectory } : {}),
  };

  try {
    return await withEnv(appEnv, async () => {
      const calls = { clear: 0, ingest: 0 };
      const app = await createApp({
        agentRunStore: createInMemoryAgentRunStore(),
        healthService: okHealthService,
        ragService: {
          clearDocuments: async () => {
            calls.clear += 1;
            return [];
          },
          getDocumentFile: async () => ({
            document: { version: 1 },
            fileBuffer: Buffer.from("%PDF-1.4 preview"),
            fileName: "preview.pdf",
            mimeType: "application/pdf",
          }),
          ingestDocument: async () => {
            calls.ingest += 1;
            return null;
          },
          initializeDocumentRegistry: async () => [],
          initializeLongMemory: async () => true,
          initializeSessionMemory: async () => true,
          listDocuments: () => [],
        },
        taskStore: createInMemoryTaskStore(),
        uploadSessionDirectory: path.join(tempRoot, "upload-sessions"),
        uploadsDirectory: path.join(tempRoot, "uploads"),
      });
      const server = createServer(app);

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

      const { port } = server.address();

      try {
        return await run({
          apiOrigin: `http://127.0.0.1:${port}`,
          calls,
          port,
          send: (options) => send(port, options),
        });
      } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
        await app.locals.stop?.();
      }
    });
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
};

const assertRefused = (response, code, label) => {
  assert.equal(response.status, 403, label);
  assert.equal(response.json?.code, code, label);
};

const multipartBody = (boundary) =>
  [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="planted.pdf"',
    "Content-Type: application/pdf",
    "",
    "%PDF-1.4 planted",
    `--${boundary}--`,
    "",
  ].join("\r\n");

test("a cross-site simple request cannot clear the archive or upload into it", async () => {
  await withGuardedApp({}, async ({ calls, send }) => {
    let response = await send({
      body: "x",
      headers: {
        "content-type": "text/plain",
        origin: ATTACKER,
        "sec-fetch-site": "cross-site",
      },
      method: "POST",
      path: "/documents/clear",
    });
    assertRefused(response, CROSS_SITE_REQUEST_REFUSED, "cross-site text/plain POST");
    assert.match(response.json.error, /ALLOWED_ORIGINS/u);

    response = await send({
      body: "x",
      headers: { "content-type": "text/plain", "sec-fetch-site": "cross-site" },
      method: "POST",
      path: "/documents/clear",
    });
    assertRefused(response, CROSS_SITE_REQUEST_REFUSED, "Sec-Fetch-Site cross-site, no Origin");

    // A sandboxed iframe or a file:// page sends Origin: null.
    for (const headers of [{ origin: "null" }, { origin: "null", "sec-fetch-site": "cross-site" }]) {
      response = await send({ headers, method: "POST", path: "/documents/clear" });
      assertRefused(response, CROSS_SITE_REQUEST_REFUSED, `Origin null ${JSON.stringify(headers)}`);
    }

    const boundary = "cross-site-guard-boundary";
    response = await send({
      body: multipartBody(boundary),
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        origin: ATTACKER,
        "sec-fetch-site": "cross-site",
      },
      method: "POST",
      path: "/upload",
    });
    assertRefused(response, CROSS_SITE_REQUEST_REFUSED, "cross-site multipart upload");

    assert.equal(calls.clear, 0, "clearDocuments never ran");
    assert.equal(calls.ingest, 0, "nothing was ingested");
  });
});

test("a cross-site read passes the guard; CORS keeps the answer from the page", async () => {
  await withGuardedApp({}, async ({ send }) => {
    const response = await send({
      headers: { origin: ATTACKER, "sec-fetch-site": "cross-site" },
      path: "/documents",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  });
});

test("the dev frontend, a same-origin page, the PDF preview iframe and non-browser clients pass", async () => {
  await withGuardedApp({}, async ({ apiOrigin, calls, port, send }) => {
    // The Vite dev frontend at http://localhost:3000 calling the API at :5001.
    let response = await send({
      headers: {
        "content-type": "application/json",
        host: `localhost:${port}`,
        origin: VITE_DEV,
        "sec-fetch-site": "same-site",
      },
      method: "POST",
      path: "/documents/clear",
    });
    assert.equal(response.status, 200);
    assert.equal(calls.clear, 1);

    response = await send({
      headers: { origin: apiOrigin, "sec-fetch-site": "same-origin" },
      method: "POST",
      path: "/documents/clear",
    });
    assert.equal(response.status, 200, "same-origin POST");
    assert.equal(calls.clear, 2);

    response = await send({ method: "POST", path: "/documents/clear" });
    assert.equal(response.status, 200, "no browser headers");
    assert.equal(calls.clear, 3);

    // The workbench's PDF preview: an iframe navigation, no Origin.
    response = await send({
      headers: {
        host: `localhost:${port}`,
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-site",
      },
      path: "/documents/doc-1/file",
    });
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /application\/pdf/u);

    // A probe names the pod address, not a loopback host; it sends no browser header.
    response = await send({
      headers: { host: `10.0.0.7:${port}`, "sec-fetch-mode": "cors" },
      path: "/health",
    });
    assert.equal(response.status, 200);
  });
});

test("ALLOWED_ORIGINS replaces the loopback default: listed origins pass, null never does", async () => {
  await withGuardedApp({ ALLOWED_ORIGINS: VITE_DEV }, async ({ calls, send }) => {
    let response = await send({
      headers: { origin: VITE_DEV, "sec-fetch-site": "same-site" },
      method: "POST",
      path: "/documents/clear",
    });
    assert.equal(response.status, 200, ".env.example's dev frontend");
    assert.equal(response.headers["access-control-allow-origin"], VITE_DEV);

    response = await send({
      headers: { origin: "http://localhost:4000", "sec-fetch-site": "same-site" },
      method: "POST",
      path: "/documents/clear",
    });
    assertRefused(response, CROSS_SITE_REQUEST_REFUSED, "an unlisted loopback page");
    assert.equal(calls.clear, 1);
  });

  // A split-origin deployment: the frontend on another site, auth on.
  await withGuardedApp(
    { ...AUTH_ENV, ALLOWED_ORIGINS: `${FRONTEND},null` },
    async ({ calls, send }) => {
      const headers = {
        host: "api.example.test",
        "x-api-key": OWNER_TOKEN,
      };
      let response = await send({
        headers: { ...headers, origin: FRONTEND, "sec-fetch-site": "cross-site" },
        method: "POST",
        path: "/documents/clear",
      });
      assert.equal(response.status, 200, "the listed frontend");
      assert.equal(response.headers["access-control-allow-origin"], FRONTEND);
      assert.equal(calls.clear, 1);

      for (const origin of ["null", ATTACKER]) {
        response = await send({
          headers: { ...headers, origin, "sec-fetch-site": "cross-site" },
          method: "POST",
          path: "/documents/clear",
        });
        assertRefused(response, CROSS_SITE_REQUEST_REFUSED, `Origin ${origin} with auth on`);
      }

      assert.equal(calls.clear, 1);
    }
  );
});

test("DNS rebinding: with auth off every request must name a loopback, IP-address or ALLOWED_ORIGINS host", async () => {
  await withGuardedApp({}, async ({ calls, port, send }) => {
    const rebound = `attacker.example:${port}`;

    // The rebinding page is same-origin to the browser: its GETs carry no
    // Origin, and a browser sends no Sec-Fetch-* header to an http URL that is
    // not localhost, so the request looks like curl's.
    let response = await send({ headers: { host: rebound }, path: "/documents" });
    assertRefused(response, HOST_NOT_ALLOWED, "rebound read, no browser header");
    assert.match(response.json.error, /API_AUTH_ENABLED=true/u);

    for (const requestPath of ["/health", "/ready", "/auth/config", "/documents/doc-1/file"]) {
      response = await send({ headers: { host: rebound }, path: requestPath });
      assertRefused(response, HOST_NOT_ALLOWED, `rebound ${requestPath}`);
    }

    response = await send({
      headers: { host: rebound, "sec-fetch-site": "same-origin" },
      path: "/documents",
    });
    assertRefused(response, HOST_NOT_ALLOWED, "rebound read with Sec-Fetch-Site");

    // Addresses are never a rebinding page's host: a probe on a pod IP, a LAN
    // client by address, 0.0.0.0 and mapped IPv6 pass the host check.
    for (const host of [
      `10.0.0.7:${port}`,
      `192.168.1.20:${port}`,
      `0.0.0.0:${port}`,
      `[::ffff:127.0.0.1]:${port}`,
    ]) {
      response = await send({ headers: { host }, path: "/documents" });
      assert.equal(response.status, 200, host);
    }

    response = await send({
      headers: {
        host: rebound,
        origin: `http://${rebound}`,
        "sec-fetch-site": "same-origin",
      },
      method: "POST",
      path: "/documents/clear",
    });
    assertRefused(response, HOST_NOT_ALLOWED, "rebound clear");
    assert.equal(calls.clear, 0);

    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      response = await send({ headers: { host, "sec-fetch-site": "none" }, path: "/documents" });
      assert.equal(response.status, 200, host);
    }
  });

  await withGuardedApp({ ALLOWED_ORIGINS: FRONTEND }, async ({ send }) => {
    let response = await send({
      headers: { host: "frontend.example.test", "sec-fetch-site": "same-origin" },
      path: "/documents",
    });
    assert.equal(response.status, 200, "an ALLOWED_ORIGINS hostname");

    response = await send({ headers: { host: "api.example.test" }, path: "/documents" });
    assertRefused(response, HOST_NOT_ALLOWED, "an unlisted hostname");
  });

  // The static frontend is behind the check too.
  await withGuardedApp(
    {},
    async ({ port, send }) => {
      const response = await send({ headers: { host: `attacker.example:${port}` }, path: "/" });
      assertRefused(response, HOST_NOT_ALLOWED, "rebound frontend");
    },
    { serveFrontend: true }
  );

  // With auth on the check is off: the rebinding page holds no credential.
  await withGuardedApp(AUTH_ENV, async ({ port, send }) => {
    const headers = { host: `attacker.example:${port}`, "sec-fetch-site": "same-origin" };
    let response = await send({ headers: { ...headers, "x-api-key": OWNER_TOKEN }, path: "/documents" });
    assert.equal(response.status, 200);

    response = await send({ headers, path: "/documents" });
    assert.equal(response.status, 401);
  });
});

test("TRUST_PROXY: a trusted X-Forwarded-Host is the request host, and cannot hide a rebound Host", async () => {
  const proxied = {
    host: "127.0.0.1:5001",
    origin: "https://archive.example.test",
    "sec-fetch-site": "same-origin",
    "x-api-key": OWNER_TOKEN,
    "x-forwarded-host": "archive.example.test",
  };

  await withGuardedApp({ ...AUTH_ENV, TRUST_PROXY: "loopback" }, async ({ calls, send }) => {
    const response = await send({ headers: proxied, method: "POST", path: "/documents/clear" });
    assert.equal(response.status, 200, "same-origin through a trusted proxy");
    assert.equal(calls.clear, 1);
  });

  await withGuardedApp(AUTH_ENV, async ({ calls, send }) => {
    const response = await send({ headers: proxied, method: "POST", path: "/documents/clear" });
    assertRefused(response, CROSS_SITE_REQUEST_REFUSED, "X-Forwarded-Host from an untrusted peer");
    assert.equal(calls.clear, 0);
  });

  await withGuardedApp({ TRUST_PROXY: "loopback" }, async ({ port, send }) => {
    for (const headers of [
      { host: `attacker.example:${port}`, "x-forwarded-host": `localhost:${port}` },
      { host: `127.0.0.1:${port}`, "x-forwarded-host": "attacker.example" },
    ]) {
      const response = await send({
        headers: { ...headers, "sec-fetch-site": "same-origin" },
        path: "/documents",
      });
      assertRefused(response, HOST_NOT_ALLOWED, JSON.stringify(headers));
    }
  });
});

test("the single-container frontend is served and may write from the API origin", async () => {
  await withGuardedApp(
    {},
    async ({ calls, port, send }) => {
      const pageHost = `localhost:${port}`;
      let response = await send({
        headers: { host: pageHost, "sec-fetch-mode": "navigate", "sec-fetch-site": "none" },
        path: "/",
      });
      assert.equal(response.status, 200);
      assert.match(response.text, /<title>Archive<\/title>/u);

      response = await send({
        headers: { host: pageHost, origin: `http://${pageHost}`, "sec-fetch-site": "same-origin" },
        method: "POST",
        path: "/documents/clear",
      });
      assert.equal(response.status, 200);
      assert.equal(calls.clear, 1);
    },
    { serveFrontend: true }
  );

  // Opened on a LAN name, which docs/deployment.md allows only with auth on.
  await withGuardedApp(
    AUTH_ENV,
    async ({ calls, port, send }) => {
      const pageHost = `archive.lan:${port}`;
      const response = await send({
        headers: {
          host: pageHost,
          origin: `http://${pageHost}`,
          "sec-fetch-site": "same-origin",
          "x-api-key": OWNER_TOKEN,
        },
        method: "POST",
        path: "/documents/clear",
      });
      assert.equal(response.status, 200);
      assert.equal(calls.clear, 1);
    },
    { serveFrontend: true }
  );
});

test("CORS with ALLOWED_ORIGINS empty reflects loopback pages only, and every answer varies on Origin", async () => {
  await withGuardedApp({}, async ({ send }) => {
    for (const origin of [VITE_DEV, "http://127.0.0.1:5173", "http://[::1]:3000"]) {
      const response = await send({ headers: { origin }, path: "/documents" });
      assert.equal(response.headers["access-control-allow-origin"], origin, origin);
      assert.match(response.headers["access-control-expose-headers"], /Content-Disposition/u);
      assert.match(response.headers.vary ?? "", /\bOrigin\b/u, origin);
    }

    for (const origin of [ATTACKER, "http://localhost.attacker.example", "null", undefined]) {
      const response = await send({ headers: origin ? { origin } : {}, path: "/documents" });
      assert.equal(response.headers["access-control-allow-origin"], undefined, String(origin));
      // A shared cache must not hand one origin's answer to another.
      assert.match(response.headers.vary ?? "", /\bOrigin\b/u, String(origin));
    }

    const preflight = (origin) =>
      send({
        headers: {
          "access-control-request-headers": "content-type",
          "access-control-request-method": "POST",
          origin,
        },
        method: "OPTIONS",
        path: "/documents/clear",
      });

    assert.equal((await preflight(VITE_DEV)).headers["access-control-allow-origin"], VITE_DEV);
    assert.equal((await preflight(ATTACKER)).headers["access-control-allow-origin"], undefined);
  });
});

test("origin and host helpers", () => {
  assert.equal(parseOrigin("null"), null);
  assert.equal(parseOrigin("file:///tmp/page.html"), null);
  assert.equal(parseOrigin("not a url"), null);
  assert.equal(parseOrigin("HTTP://LOCALHOST:80").origin, "http://localhost");

  for (const origin of ["http://localhost:3000", "https://127.0.0.1", "http://[::1]:5173"]) {
    assert.equal(isLoopbackOrigin(origin), true, origin);
  }

  for (const origin of [
    "http://localhost.attacker.example",
    "http://127.0.0.1.attacker.example",
    "ftp://localhost",
    ATTACKER,
    "null",
    undefined,
  ]) {
    assert.equal(isLoopbackOrigin(origin), false, String(origin));
  }

  assert.equal(isSameOrigin("https://archive.example.test", "archive.example.test:443"), true);
  assert.equal(isSameOrigin("http://archive.example.test", "ARCHIVE.example.test"), true);
  assert.equal(isSameOrigin("http://archive.example.test:8080", "archive.example.test"), false);
  assert.equal(isSameOrigin("http://localhost:3000", "localhost:5001"), false);
  assert.equal(isSameOrigin("http://localhost:5001", "attacker.example@localhost:5001"), false);
  assert.equal(isSameOrigin("null", "localhost:5001"), false);

  const loopbackOnly = compileAllowedOrigins([]);
  const listed = compileAllowedOrigins([FRONTEND, "*", "null"]);

  assert.equal(isAllowedOrigin(VITE_DEV, loopbackOnly), true);
  assert.equal(isAllowedOrigin(VITE_DEV, listed), false);
  assert.equal(isAllowedOrigin(FRONTEND, listed), true);
  assert.equal(isAllowedOrigin("null", listed), false);
  assert.equal(isAllowedHost("frontend.example.test:8443", listed), true);
  assert.equal(isAllowedHost("[::1]:5001", loopbackOnly), true);
  assert.equal(isAllowedHost("10.0.0.7:5001", loopbackOnly), true);
  assert.equal(isAllowedHost("127.1:5001", loopbackOnly), true);
  assert.equal(isAllowedHost("127.0.0.1.nip.io:5001", loopbackOnly), false);
  assert.equal(isAllowedHost("localtest.me", loopbackOnly), false);
  assert.equal(isIpAddressHostname("192.168.1.20"), true);
  assert.equal(isIpAddressHostname("[::ffff:7f00:1]"), true);
  assert.equal(isIpAddressHostname("1.2.3.4.example"), false);
  assert.equal(isAllowedHost("attacker.example@localhost", loopbackOnly), false);
  assert.equal(isAllowedHost("localhost/attacker", loopbackOnly), false);
  assert.equal(isAllowedHost(undefined, loopbackOnly), false);

  const request = (method, requestPath) => ({ method, path: requestPath });

  for (const [method, requestPath] of [
    ["POST", "/documents/clear"],
    ["DELETE", "/documents/doc-1"],
    ["PATCH", "/anything"],
  ]) {
    assert.equal(isStateChangingRequest(request(method, requestPath)), true, `${method} ${requestPath}`);
  }

  for (const [method, requestPath] of [
    ["GET", "/documents"],
    ["HEAD", "/documents/doc-1/file"],
    ["OPTIONS", "/chat"],
    // No GET changes data: GET /chat, which started an agent run, is gone.
    ["GET", "/chat"],
    ["HEAD", "/chat"],
  ]) {
    assert.equal(isStateChangingRequest(request(method, requestPath)), false, `${method} ${requestPath}`);
  }

  const proxiedRequest = (trusted) => ({
    app: { get: (setting) => (setting === "trust proxy fn" ? () => trusted : undefined) },
    headers: { host: "127.0.0.1:5001", "x-forwarded-host": "archive.example.test, inner.example" },
    socket: { remoteAddress: "127.0.0.1" },
  });

  assert.equal(getRequestHost(proxiedRequest(true)), "archive.example.test");
  assert.equal(getRequestHost(proxiedRequest(false)), "127.0.0.1:5001");
});
