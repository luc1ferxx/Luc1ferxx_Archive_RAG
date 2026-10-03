import { createHash, webcrypto } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  OIDC_PENDING_LOGIN_STORAGE_KEY,
  base64UrlEncode,
  buildAuthorizationRequest,
  buildEndSessionUrl,
  completeAuthorizationCallback,
  computeS256Challenge,
  createPkcePair,
  discoverOidc,
  exchangeAuthorizationCode,
  isCallbackUrl,
  randomUrlSafeString,
  savePendingLogin,
  stripCallbackParams,
  takePendingLogin,
} from "./oidc";

const discovery = {
  authorizationEndpoint: "https://idp.example.test/authorize",
  endSessionEndpoint: "https://idp.example.test/logout",
  issuer: "https://idp.example.test",
  tokenEndpoint: "https://idp.example.test/token",
};

const encodeJwt = (claims) =>
  [
    base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256" }))),
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims))),
    "signature",
  ].join(".");

const jsonResponse = (body, status = 200) => ({
  json: async () => body,
  ok: status >= 200 && status < 300,
  status,
});

const pendingFor = (overrides = {}) => ({
  codeVerifier: "verifier-abc",
  createdAt: Date.now(),
  nonce: "nonce-123",
  redirectUri: "http://localhost:3000/",
  state: "state-xyz",
  ...overrides,
});

describe("PKCE", () => {
  test("creates a 43-character base64url verifier from 32 random bytes with an S256 challenge", async () => {
    const pair = await createPkcePair({ crypto: webcrypto });
    const expected = createHash("sha256").update(pair.verifier).digest("base64url");

    expect(pair.method).toBe("S256");
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(expected);
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  test("computes BASE64URL(SHA-256(verifier)) for a fixed verifier", async () => {
    await expect(
      computeS256Challenge("dBjftJeZ4CVP-mJ92K9qcqqVwkK3aG0tQ9bbuoNXfwQ", webcrypto)
    ).resolves.toBe(
      createHash("sha256")
        .update("dBjftJeZ4CVP-mJ92K9qcqqVwkK3aG0tQ9bbuoNXfwQ")
        .digest("base64url")
    );
  });

  test("draws fresh randomness each time and refuses fewer than 32 bytes", async () => {
    const first = await createPkcePair({ crypto: webcrypto });
    const second = await createPkcePair({ crypto: webcrypto });

    expect(first.verifier).not.toBe(second.verifier);
    expect(() => randomUrlSafeString(16, webcrypto)).toThrow(/32 random bytes/);
  });
});

describe("authorization request", () => {
  test("redirects with code flow, S256 challenge, state, nonce, scopes and audience", async () => {
    const { pending, url } = await buildAuthorizationRequest({
      audience: "archive-api",
      clientId: "archive-spa",
      crypto: webcrypto,
      discovery,
      redirectUri: "http://localhost:3000/",
      scopes: "profile email",
    });
    const params = new URL(url).searchParams;

    expect(url.startsWith(discovery.authorizationEndpoint)).toBe(true);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("archive-spa");
    expect(params.get("redirect_uri")).toBe("http://localhost:3000/");
    expect(params.get("scope")).toBe("openid profile email");
    expect(params.get("audience")).toBe("archive-api");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBe(
      createHash("sha256").update(pending.codeVerifier).digest("base64url")
    );
    expect(params.get("state")).toBe(pending.state);
    expect(params.get("nonce")).toBe(pending.nonce);
    expect(pending.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.nonce).not.toBe(pending.state);
    // The verifier itself never leaves the browser in the redirect.
    expect(url).not.toContain(pending.codeVerifier);
  });

  test("keeps the pending login in sessionStorage and redeems it only once", () => {
    savePendingLogin(pendingFor());

    expect(window.localStorage.getItem(OIDC_PENDING_LOGIN_STORAGE_KEY)).toBeNull();
    expect(takePendingLogin()).toMatchObject({ state: "state-xyz" });
    expect(takePendingLogin()).toBeNull();
  });

  test("drops an expired pending login", () => {
    savePendingLogin(pendingFor({ createdAt: Date.now() - 11 * 60 * 1000 }));

    expect(takePendingLogin()).toBeNull();
  });
});

describe("callback", () => {
  test("rejects a state mismatch before any token request", async () => {
    const fetchImpl = vi.fn();

    await expect(
      completeAuthorizationCallback({
        clientId: "archive-spa",
        discovery,
        fetchImpl,
        href: "http://localhost:3000/?code=abc&state=forged",
        pending: pendingFor(),
      })
    ).rejects.toMatchObject({ code: "oidc_state_mismatch" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects a callback with no login in progress", async () => {
    await expect(
      completeAuthorizationCallback({
        clientId: "archive-spa",
        discovery,
        fetchImpl: vi.fn(),
        href: "http://localhost:3000/?code=abc&state=state-xyz",
        pending: null,
      })
    ).rejects.toMatchObject({ code: "oidc_no_pending_login" });
  });

  test("rejects an ID token whose nonce does not match", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: "access-1",
        expires_in: 300,
        id_token: encodeJwt({
          aud: "archive-spa",
          exp: Math.floor(Date.now() / 1000) + 300,
          iss: discovery.issuer,
          nonce: "another-nonce",
          sub: "user-1",
        }),
      })
    );

    await expect(
      completeAuthorizationCallback({
        clientId: "archive-spa",
        discovery,
        fetchImpl,
        href: "http://localhost:3000/?code=abc&state=state-xyz",
        pending: pendingFor(),
      })
    ).rejects.toMatchObject({ code: "oidc_nonce_mismatch" });
  });

  test("accepts a matching state and nonce and returns the tokens", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: "access-1",
        expires_in: 300,
        id_token: encodeJwt({
          aud: ["archive-spa"],
          exp: Math.floor(Date.now() / 1000) + 300,
          iss: discovery.issuer,
          nonce: "nonce-123",
          sub: "user-1",
        }),
        refresh_token: "refresh-1",
      })
    );

    const result = await completeAuthorizationCallback({
      clientId: "archive-spa",
      discovery,
      fetchImpl,
      href: "http://localhost:3000/?code=abc&state=state-xyz",
      pending: pendingFor(),
    });

    expect(result.tokens.access_token).toBe("access-1");
    expect(result.claims.sub).toBe("user-1");
  });

  test("detects and strips callback parameters", () => {
    expect(isCallbackUrl("http://localhost:3000/?code=abc&state=s")).toBe(true);
    expect(isCallbackUrl("http://localhost:3000/?view=chat")).toBe(false);
    expect(stripCallbackParams("http://localhost:3000/?code=abc&state=s&view=chat")).toBe(
      "http://localhost:3000/?view=chat"
    );
  });
});

describe("token endpoint", () => {
  test("exchanges the code as a public client with the PKCE verifier", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: "access-1" }));

    await exchangeAuthorizationCode({
      clientId: "archive-spa",
      code: "code-1",
      codeVerifier: "verifier-abc",
      discovery,
      fetchImpl,
      redirectUri: "http://localhost:3000/",
    });

    const [url, init] = fetchImpl.mock.calls[0];
    const body = new URLSearchParams(init.body);

    expect(url).toBe(discovery.tokenEndpoint);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(body)).toEqual({
      client_id: "archive-spa",
      code: "code-1",
      code_verifier: "verifier-abc",
      grant_type: "authorization_code",
      redirect_uri: "http://localhost:3000/",
    });
    expect(body.has("client_secret")).toBe(false);
  });

  test("surfaces only the OAuth error code on failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: "invalid_grant", error_description: "code abc was used" }, 400)
    );

    const failure = await exchangeAuthorizationCode({
      clientId: "archive-spa",
      code: "abc",
      codeVerifier: "v",
      discovery,
      fetchImpl,
      redirectUri: "http://localhost:3000/",
    }).catch((error) => error);

    expect(failure.message).toBe("Token request failed with status 400 (invalid_grant).");
    expect(failure.message).not.toContain("abc");
  });
});

describe("discovery and sign-out", () => {
  test("reads the discovery document and refuses another issuer", async () => {
    const document = {
      authorization_endpoint: discovery.authorizationEndpoint,
      end_session_endpoint: discovery.endSessionEndpoint,
      issuer: discovery.issuer,
      token_endpoint: discovery.tokenEndpoint,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(document));

    await expect(discoverOidc("https://idp.example.test/", { fetchImpl })).resolves.toEqual(
      discovery
    );
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://idp.example.test/.well-known/openid-configuration"
    );

    fetchImpl.mockResolvedValue(jsonResponse({ ...document, issuer: "https://evil.test" }));
    await expect(discoverOidc("https://idp.example.test", { fetchImpl })).rejects.toMatchObject({
      code: "oidc_issuer_mismatch",
    });
  });

  test("builds the end-session URL only when the provider has one", () => {
    const url = new URL(
      buildEndSessionUrl({
        clientId: "archive-spa",
        discovery,
        idTokenHint: "id-token",
        postLogoutRedirectUri: "http://localhost:3000/",
      })
    );

    expect(url.origin + url.pathname).toBe(discovery.endSessionEndpoint);
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe("http://localhost:3000/");
    expect(buildEndSessionUrl({ discovery: { ...discovery, endSessionEndpoint: "" } })).toBe("");
  });
});
