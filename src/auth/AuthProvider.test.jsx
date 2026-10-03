import React from "react";
import { webcrypto } from "node:crypto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthProvider";
import AuthStatus from "./AuthStatus";
import { isOidcMode, resolveOidcSettings } from "./authSettings";
import { base64UrlEncode, savePendingLogin } from "./oidc";
import { canUseCapability, decideCapability, hasPermission } from "./permissions";
import { getAccessToken, getStoredRefreshToken, resetTokenStoreForTests } from "./tokenStore";
import WorkspaceSidebar from "../components/WorkspaceSidebar";
import { createTranslator } from "../archiveI18n";

vi.mock("../components/PdfUploader", () => ({
  default: () => <div>Uploader</div>,
}));

const t = createTranslator("en");
const ISSUER = "https://idp.example.test";
const discoveryDocument = {
  authorization_endpoint: `${ISSUER}/authorize`,
  end_session_endpoint: `${ISSUER}/logout`,
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/token`,
};
const oidcConfig = {
  mode: "static_token+oidc",
  oidc: { audience: "archive-api", clientId: "archive-spa", issuer: ISSUER, scopes: ["openid", "profile"] },
};

const jsonResponse = (body, status = 200) => ({
  json: async () => body,
  ok: status >= 200 && status < 300,
  status,
});

const idTokenFor = (claims) =>
  [
    base64UrlEncode(new TextEncoder().encode("{}")),
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims))),
    "sig",
  ].join(".");

const createLocation = (href = "http://localhost:3000/") => ({
  assign: vi.fn(),
  href,
  origin: new URL(href).origin,
});

const createFetch = ({ nonce = "nonce-1" } = {}) =>
  vi.fn(async (url, init) => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return jsonResponse(discoveryDocument);
    }

    if (url === `${ISSUER}/token` && init?.method === "POST") {
      return jsonResponse({
        access_token: "access-1",
        expires_in: 3600,
        id_token: idTokenFor({
          aud: "archive-spa",
          exp: Math.floor(Date.now() / 1000) + 3600,
          iss: ISSUER,
          nonce,
          sub: "alice",
        }),
        refresh_token: "refresh-1",
      });
    }

    return jsonResponse({}, 404);
  });

const CapabilityProbe = () => {
  const { can } = useAuth();

  return (
    <ul>
      {["upload", "delete", "admin"].map((capability) => (
        <li key={capability}>{`${capability}:${can(capability) ? "yes" : "no"}`}</li>
      ))}
    </ul>
  );
};

const renderAuth = (props) =>
  render(
    <AuthProvider cryptoImpl={webcrypto} replaceUrl={vi.fn()} {...props}>
      <AuthStatus t={t} />
      <CapabilityProbe />
    </AuthProvider>
  );

beforeEach(() => {
  resetTokenStoreForTests();
  window.sessionStorage.clear();
});

afterEach(() => {
  resetTokenStoreForTests();
});

describe("auth settings", () => {
  test("the config endpoint wins over the build variables", () => {
    const env = { VITE_OIDC_CLIENT_ID: "env-client", VITE_OIDC_ISSUER: "https://env.example.test" };

    // The server's own shapes (server/rag/oidc.js buildPublicAuthConfig).
    expect(resolveOidcSettings({ env, serverConfig: { mode: "token", oidc: null } })).toBeNull();
    expect(resolveOidcSettings({ env, serverConfig: { mode: "disabled", oidc: null } })).toBeNull();

    expect(resolveOidcSettings({ env, origin: "http://localhost:3000", serverConfig: { mode: "static_token" } })).toBeNull();
    expect(
      resolveOidcSettings({ env, origin: "http://localhost:3000", serverConfig: oidcConfig })
    ).toMatchObject({ clientId: "archive-spa", issuer: ISSUER, redirectUri: "http://localhost:3000/", scopes: "openid profile" });
    expect(resolveOidcSettings({ env, origin: "http://localhost:3000", serverConfig: null })).toMatchObject({
      clientId: "env-client",
      issuer: "https://env.example.test",
      scopes: "openid profile email",
    });
    expect(resolveOidcSettings({ env: {}, serverConfig: null })).toBeNull();
    expect(isOidcMode(["jwt_hs256", "oidc"])).toBe(true);
    expect(isOidcMode("oidcish")).toBe(false);
  });
});

describe("permissions", () => {
  test("grants exact, wildcard and prefix permissions", () => {
    expect(hasPermission(["documents.write"], "documents.write")).toBe(true);
    expect(hasPermission(["documents.*"], "documents.delete")).toBe(true);
    expect(hasPermission(["*"], "admin.actions.quality_refresh")).toBe(true);
    expect(hasPermission(["documents.read"], "documents.write")).toBe(false);
    expect(canUseCapability(["documents.write"], "delete")).toBe(false);
    expect(canUseCapability(["admin.actions.quality_refresh"], "admin")).toBe(true);
    expect(canUseCapability(["documents.read"], "delete")).toBe(false);
  });

  test("only gates when OIDC is configured", () => {
    expect(decideCapability({ oidcEnabled: false, status: "disabled" }, "upload")).toBe(true);
    expect(decideCapability({ oidcEnabled: true, status: "signed_out" }, "upload")).toBe(false);
    expect(decideCapability({ me: null, oidcEnabled: true, status: "signed_in" }, "upload")).toBe(true);
    expect(
      decideCapability({ me: { permissions: ["documents.read"] }, oidcEnabled: true, status: "signed_in" }, "upload")
    ).toBe(false);
  });
});

describe("AuthProvider", () => {
  test("renders nothing and gates nothing when the server is not in OIDC mode", async () => {
    const fetchImpl = vi.fn();
    const { container } = renderAuth({
      env: { VITE_OIDC_CLIENT_ID: "c", VITE_OIDC_ISSUER: ISSUER },
      fetchImpl,
      loadMe: vi.fn(),
      loadServerConfig: async () => ({ mode: "static_token" }),
      location: createLocation(),
    });

    await waitFor(() => expect(screen.getByText("upload:yes")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(container.querySelector(".archive-auth-status")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("offers Sign in from the build variables and redirects with PKCE", async () => {
    const location = createLocation();
    renderAuth({
      env: { VITE_OIDC_CLIENT_ID: "archive-spa", VITE_OIDC_ISSUER: ISSUER },
      fetchImpl: createFetch(),
      loadMe: vi.fn(),
      loadServerConfig: async () => {
        throw new Error("404");
      },
      location,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(screen.getByText("upload:no")).toBeInTheDocument();

    await waitFor(() => expect(location.assign).toHaveBeenCalledTimes(1));
    const url = new URL(location.assign.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/");
    const pending = JSON.parse(window.sessionStorage.getItem("archive-rag.oidc.pending"));
    expect(pending.state).toBe(url.searchParams.get("state"));
    expect(window.localStorage.getItem("archive-rag.oidc.pending")).toBeNull();
  });

  test("completes the callback, loads /auth/me and gates by effective permissions", async () => {
    savePendingLogin({
      codeVerifier: "verifier-1",
      createdAt: Date.now(),
      nonce: "nonce-1",
      redirectUri: "http://localhost:3000/",
      state: "state-1",
    });
    const replaceUrl = vi.fn();
    const loadMe = vi.fn(async () => {
      expect(getAccessToken()).toBe("access-1");
      return {
        authProvider: "oidc",
        permissions: ["documents.read", "documents.write", "chat.ask"],
        roles: ["member"],
        userId: "alice",
        workspaceId: "w1",
        workspaceIds: ["w1"],
        workspaceRoles: { w1: ["editor"] },
      };
    });
    const fetchImpl = createFetch();

    renderAuth({
      env: {},
      fetchImpl,
      loadMe,
      loadServerConfig: async () => oidcConfig,
      location: createLocation("http://localhost:3000/?code=code-1&state=state-1"),
      replaceUrl,
    });

    expect(await screen.findByText("Signed in as alice")).toBeInTheDocument();
    expect(screen.getByText("Workspace: w1")).toBeInTheDocument();
    expect(screen.getByText("Role: member, editor")).toBeInTheDocument();
    expect(screen.getByText("upload:yes")).toBeInTheDocument();
    expect(screen.getByText("delete:no")).toBeInTheDocument();
    expect(screen.getByText("admin:no")).toBeInTheDocument();
    expect(replaceUrl).toHaveBeenCalledWith("http://localhost:3000/");
    expect(getStoredRefreshToken()).toBe("refresh-1");
    const tokenCall = fetchImpl.mock.calls.find(([url]) => url === `${ISSUER}/token`);
    expect(new URLSearchParams(tokenCall[1].body).get("code_verifier")).toBe("verifier-1");
  });

  test("mounts the app only after the callback, so its first request carries the bearer", async () => {
    savePendingLogin({
      codeVerifier: "verifier-1",
      createdAt: Date.now(),
      nonce: "nonce-1",
      redirectUri: "http://localhost:3000/",
      state: "state-1",
    });
    const tokensSeenAtMount = [];
    const AppProbe = () => {
      React.useEffect(() => {
        tokensSeenAtMount.push(getAccessToken());
      }, []);
      return <div>app mounted</div>;
    };

    render(
      <AuthProvider
        cryptoImpl={webcrypto}
        env={{}}
        fetchImpl={createFetch()}
        loadMe={async () => ({ permissions: [], userId: "alice" })}
        loadServerConfig={async () => oidcConfig}
        location={createLocation("http://localhost:3000/?code=code-1&state=state-1")}
        replaceUrl={vi.fn()}
      >
        <AppProbe />
      </AuthProvider>
    );

    expect(screen.getByRole("status")).toHaveTextContent("Checking sign-in");
    expect(await screen.findByText("app mounted")).toBeInTheDocument();
    expect(tokensSeenAtMount).toEqual(["access-1"]);
  });

  test("a callback whose state does not match stays signed out with an error", async () => {
    savePendingLogin({
      codeVerifier: "verifier-1",
      createdAt: Date.now(),
      nonce: "nonce-1",
      redirectUri: "http://localhost:3000/",
      state: "state-1",
    });
    const fetchImpl = createFetch();

    renderAuth({
      env: {},
      fetchImpl,
      loadMe: vi.fn(),
      loadServerConfig: async () => oidcConfig,
      location: createLocation("http://localhost:3000/?code=code-1&state=forged"),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("state does not match");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(fetchImpl.mock.calls.some(([url]) => url === `${ISSUER}/token`)).toBe(false);
    expect(getAccessToken()).toBe("");
  });

  test("Sign out clears the session and calls the end-session endpoint", async () => {
    savePendingLogin({
      codeVerifier: "verifier-1",
      createdAt: Date.now(),
      nonce: "nonce-1",
      redirectUri: "http://localhost:3000/",
      state: "state-1",
    });
    const location = createLocation("http://localhost:3000/?code=code-1&state=state-1");

    renderAuth({
      env: {},
      fetchImpl: createFetch(),
      loadMe: async () => ({ permissions: [], roles: [], userId: "alice", workspaceId: "w1" }),
      loadServerConfig: async () => oidcConfig,
      location,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(getAccessToken()).toBe("");
    expect(getStoredRefreshToken()).toBe("");
    expect(location.assign.mock.calls[0][0]).toMatch(/^https:\/\/idp\.example\.test\/logout\?/);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("permission-based UI gating in the workspace sidebar", () => {
  const renderSidebar = (props) =>
    render(
      <WorkspaceSidebar
        activeDocuments={[{ docId: "doc-1", fileName: "policy.pdf", pageCount: 2 }]}
        onClearDocuments={vi.fn()}
        onRemoveDocument={vi.fn()}
        onRunSyntheticQuality={vi.fn()}
        recoveryRuns={[]}
        t={t}
        {...props}
      />
    );

  test("shows every action by default (auth off or static token)", () => {
    renderSidebar();

    expect(screen.getByText("Uploader")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove policy\.pdf/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: t("sidebar.clearWorkspace") })).toBeEnabled();
    expect(screen.getByRole("button", { name: t("quality.runEval") })).toBeEnabled();
  });

  test("hides upload and disables delete and admin actions the user lacks", () => {
    renderSidebar({ authStatus: "signed_in", canAdmin: false, canDelete: false, canUpload: false });

    expect(screen.queryByText("Uploader")).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Your role cannot upload documents.");
    expect(screen.getByRole("button", { name: /Remove policy\.pdf/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: t("sidebar.clearWorkspace") })).toBeDisabled();
    expect(screen.getByRole("button", { name: t("quality.runEval") })).toBeDisabled();
  });
});
