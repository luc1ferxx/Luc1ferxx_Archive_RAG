import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import axios from "axios";

vi.mock("axios", () => ({
  default: {
    delete: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const unauthorized = () => {
  const error = new Error("Request failed with status code 401");
  error.response = { data: { error: "API authentication is required." }, status: 401 };
  return error;
};

// config.js reads VITE_* at import time and tokenStore keeps module state, so
// every test imports a fresh module graph.
const loadModules = async () => {
  const tokenStore = await import("./tokenStore");
  const config = await import("../config");
  const apiClient = await import("../apiClient");
  const archiveApi = await import("../archiveApi");

  return { apiClient, archiveApi, config, tokenStore };
};

beforeEach(() => {
  vi.resetModules();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  axios.get.mockReset();
  axios.post.mockReset();
  axios.delete.mockReset();
});

describe("static token path (OIDC not configured)", () => {
  test("keeps sending x-api-key and never an Authorization header", async () => {
    vi.stubEnv("VITE_API_AUTH_TOKEN", "static-token");
    const { apiClient, config } = await loadModules();
    axios.get.mockResolvedValue({ data: [] });

    await apiClient.apiGet("/documents");

    expect(config.buildApiRequestConfig()).toEqual({ headers: { "x-api-key": "static-token" } });
    expect(axios.get).toHaveBeenCalledWith("http://localhost:5001/documents", {
      headers: { "x-api-key": "static-token" },
      timeout: 30_000,
    });
  });

  test("sends no auth header without a static token, as before", async () => {
    vi.stubEnv("VITE_API_AUTH_TOKEN", "");
    const { config } = await loadModules();

    expect(config.buildApiRequestConfig()).toBeUndefined();
    expect(config.buildApiRequestConfig({ timeout: 5 })).toEqual({ timeout: 5 });
  });

  test("does not retry or start a login on a 401", async () => {
    vi.stubEnv("VITE_API_AUTH_TOKEN", "static-token");
    const { apiClient, tokenStore } = await loadModules();
    const onReauthRequired = vi.fn();
    const onRefresh = vi.fn().mockResolvedValue(true);
    tokenStore.setTokenHandlers({ onReauthRequired, onRefresh });
    axios.get.mockRejectedValue(unauthorized());

    await expect(apiClient.apiGet("/documents")).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onReauthRequired).not.toHaveBeenCalled();
  });
});

describe("OIDC bearer token", () => {
  test("attaches Authorization: Bearer instead of the static token", async () => {
    vi.stubEnv("VITE_API_AUTH_TOKEN", "static-token");
    const { apiClient, config, tokenStore } = await loadModules();
    tokenStore.setOidcTokens({ access_token: "oidc-access", expires_in: 300 });
    axios.post.mockResolvedValue({ data: { ok: true } });

    await apiClient.apiPost("/feedback", { rating: 1 });

    const headers = axios.post.mock.calls[0][2].headers;
    expect(headers.Authorization).toBe("Bearer oidc-access");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(config.buildApiRequestConfig({ headers: { Accept: "x" } }).headers).toEqual({
      Accept: "x",
      Authorization: "Bearer oidc-access",
    });
  });

  test("keeps the access token in memory and the refresh token in sessionStorage only", async () => {
    const { tokenStore } = await loadModules();

    tokenStore.setOidcTokens({
      access_token: "oidc-access",
      expires_in: 300,
      id_token: "id-token",
      refresh_token: "refresh-1",
    });

    expect(window.sessionStorage.getItem(tokenStore.OIDC_REFRESH_TOKEN_STORAGE_KEY)).toBe(
      "refresh-1"
    );
    const stored = [
      ...Object.values({ ...window.localStorage }),
      ...Object.values({ ...window.sessionStorage }),
    ].join(" ");
    expect(stored).not.toContain("oidc-access");
    expect(stored).not.toContain("id-token");
    expect(Object.keys({ ...window.localStorage })).toEqual([]);

    tokenStore.clearOidcTokens();
    expect(tokenStore.getAccessToken()).toBe("");
    expect(tokenStore.getStoredRefreshToken()).toBe("");
  });

  test("a 401 refreshes once and retries with the new bearer token", async () => {
    const { apiClient, tokenStore } = await loadModules();
    tokenStore.setOidcTokens({ access_token: "expired-access", expires_in: 300 });
    const onReauthRequired = vi.fn();
    const onRefresh = vi.fn(async () => {
      tokenStore.setOidcTokens({ access_token: "fresh-access", expires_in: 300 });
      return true;
    });
    tokenStore.setTokenHandlers({ onReauthRequired, onRefresh });
    axios.delete.mockRejectedValueOnce(unauthorized()).mockResolvedValueOnce({ data: {} });

    await apiClient.apiDelete("/documents/doc-1");

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onReauthRequired).not.toHaveBeenCalled();
    expect(axios.delete).toHaveBeenCalledTimes(2);
    expect(axios.delete.mock.calls[0][1].headers.Authorization).toBe("Bearer expired-access");
    expect(axios.delete.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-access");
  });

  test("a 401 that cannot be refreshed drops the token and starts re-authentication", async () => {
    const { apiClient, tokenStore } = await loadModules();
    tokenStore.setOidcTokens({ access_token: "expired-access", expires_in: 300 });
    const onReauthRequired = vi.fn();
    tokenStore.setTokenHandlers({ onReauthRequired, onRefresh: vi.fn().mockResolvedValue(false) });
    axios.get.mockRejectedValue(unauthorized());

    await expect(apiClient.apiGet("/documents")).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(onReauthRequired).toHaveBeenCalledTimes(1);
    expect(tokenStore.getAccessToken()).toBe("");
  });

  test("the chat stream follows the same 401 rule", async () => {
    const { archiveApi, tokenStore } = await loadModules();
    tokenStore.setOidcTokens({ access_token: "expired-access", expires_in: 300 });
    const onReauthRequired = vi.fn();
    tokenStore.setTokenHandlers({ onReauthRequired, onRefresh: vi.fn().mockResolvedValue(false) });
    const fetchMock = vi.fn().mockResolvedValue({
      body: null,
      json: async () => ({ error: "API authentication is required." }),
      ok: false,
      status: 401,
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      archiveApi.streamChat({ docIds: ["doc-1"], question: "q", sessionId: "s", userId: "u" })
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer expired-access");
    expect(onReauthRequired).toHaveBeenCalledTimes(1);
  });
});

describe("403", () => {
  test("turns a bare Forbidden into a clear message naming the missing permission", async () => {
    const { apiClient } = await loadModules();
    const error = new Error("Request failed with status code 403");
    error.response = {
      data: { adminAuthorization: { permissionId: "admin.actions.quality_refresh" }, error: "Forbidden." },
      status: 403,
    };
    axios.post.mockRejectedValue(error);

    const failure = await apiClient
      .apiPost("/admin/actions/quality-refresh", {})
      .catch((caught) => caught);

    expect(failure.permissionDenied).toBe(true);
    expect(failure.response.data.error).toBe(
      "You do not have permission to do this. Missing permission: admin.actions.quality_refresh."
    );
  });

  test("reads the RBAC denial body (code, permission)", async () => {
    const { apiClient } = await loadModules();

    expect(
      apiClient.describeForbiddenResponse({
        code: "RBAC_PERMISSION_DENIED",
        error: "Forbidden.",
        permission: "documents.delete",
      })
    ).toBe("You do not have permission to do this. Missing permission: documents.delete.");
  });

  test("keeps a specific server message and an object-shaped error body", async () => {
    const { apiClient } = await loadModules();

    expect(apiClient.describeForbiddenResponse({ error: "Workspace w2 is read-only." })).toBe(
      "Workspace w2 is read-only."
    );
    expect(apiClient.withForbiddenMessage({ error: { code: "x", message: "Forbidden" } })).toEqual({
      error: { code: "x", message: "You do not have permission to do this." },
    });
  });
});
