import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import axios from "axios";
import { AuthContext } from "./AuthProvider";
import { WorkspaceProvider, useWorkspace } from "./WorkspaceProvider";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import {
  describeWorkspaceChoice,
  getActiveWorkspaceId,
  readStoredWorkspaceId,
  resetWorkspaceSelectionForTests,
  setActiveWorkspaceId,
  WORKSPACE_STORAGE_KEY,
  writeStoredWorkspaceId,
} from "./workspaceSelection";
import { resetTokenStoreForTests } from "./tokenStore";
import { buildApiRequestConfig } from "../config";
import { createTranslator } from "../archiveI18n";
import { useChatSession } from "../hooks/useChatSession";
import { useWorkspaceDocuments } from "../hooks/useWorkspaceDocuments";

vi.mock("axios", () => ({
  default: {
    delete: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const t = createTranslator("en");
const SESSION_STORAGE_KEY = "archive-session-id";

// The static-token path (no OIDC): AuthProvider's state when it is not in
// OIDC mode.
const DISABLED_AUTH = {
  can: () => true,
  error: "",
  me: null,
  oidcEnabled: false,
  reloadMe: async () => null,
  signIn: () => undefined,
  signOut: () => undefined,
  status: "disabled",
};

const TWO_WORKSPACES = {
  authProvider: "static_token",
  permissions: [],
  roles: [],
  userId: "alice",
  workspaceId: "",
  workspaceIds: ["ws-a", "ws-b"],
};

const DOCUMENTS = {
  "": [],
  "ws-a": [{ docId: "a-1", fileName: "alpha-contract.pdf", pageCount: 2 }],
  "ws-b": [{ docId: "b-1", fileName: "beta-report.pdf", pageCount: 3 }],
};

const headerOf = (config) => config?.headers?.["x-workspace-id"] ?? "";

// Answers GET /documents per workspace header, and GET /auth/me with `me`.
const serveApi = ({ me = TWO_WORKSPACES } = {}) =>
  axios.get.mockImplementation(async (url, config) => {
    if (url.endsWith("/auth/me")) {
      return { data: me };
    }

    if (url.endsWith("/documents")) {
      return { data: DOCUMENTS[headerOf(config)] ?? [] };
    }

    return { data: {} };
  });

// A stand-in for the app: the real document and chat hooks.
const AppProbe = ({ mounts }) => {
  const { activeDocuments } = useWorkspaceDocuments();
  const { addConversationTurn, conversation, sessionId } = useChatSession();

  React.useEffect(() => {
    mounts.push(getActiveWorkspaceId());
  }, [mounts]);

  return (
    <div>
      <WorkspaceSwitcher t={t} />
      <ul aria-label="documents">
        {activeDocuments.map((document) => (
          <li key={document.docId}>{document.fileName}</li>
        ))}
      </ul>
      <p>{`turns:${conversation.length}`}</p>
      <p data-testid="session">{sessionId}</p>
      <button type="button" onClick={() => addConversationTurn("What changed?", { agentAnswer: "x" })}>
        ask
      </button>
    </div>
  );
};

const renderWithWorkspaces = ({ auth = DISABLED_AUTH, loadBaselineMe, rotateChatSession } = {}) => {
  const mounts = [];
  const view = render(
    <AuthContext.Provider value={auth}>
      <WorkspaceProvider
        {...(loadBaselineMe ? { loadBaselineMe } : {})}
        {...(rotateChatSession ? { rotateChatSession } : {})}
      >
        <AppProbe mounts={mounts} />
      </WorkspaceProvider>
    </AuthContext.Provider>
  );

  return { ...view, mounts };
};

const documentRequests = () =>
  axios.get.mock.calls.filter(([url]) => url.endsWith("/documents")).map(([, config]) => headerOf(config));

beforeEach(() => {
  resetWorkspaceSelectionForTests();
  resetTokenStoreForTests();
  window.localStorage.clear();
  axios.get.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetWorkspaceSelectionForTests();
  window.localStorage.clear();
});

describe("workspace selection", () => {
  test("x-workspace-id goes on every request only while a workspace is selected", () => {
    expect(buildApiRequestConfig()).toBeUndefined();
    expect(buildApiRequestConfig({ timeout: 5 })).toEqual({ timeout: 5 });

    setActiveWorkspaceId("  ws-b ");
    expect(buildApiRequestConfig({ timeout: 5 })).toEqual({ headers: { "x-workspace-id": "ws-b" }, timeout: 5 });
    // A caller's own header wins, and the first /auth/me can ask without it.
    expect(buildApiRequestConfig({ headers: { "x-workspace-id": "ws-a" } }).headers["x-workspace-id"]).toBe("ws-a");
    expect(buildApiRequestConfig({ omitWorkspaceHeader: true, timeout: 5 })).toEqual({ timeout: 5 });

    // Not an id a server would hold: nothing is sent.
    setActiveWorkspaceId("ws\nb");
    expect(buildApiRequestConfig()).toBeUndefined();
    setActiveWorkspaceId("x".repeat(257));
    expect(buildApiRequestConfig()).toBeUndefined();
  });

  test("only a credential with several workspaces and no fixed one may switch", () => {
    expect(describeWorkspaceChoice(null).switchable).toBe(false);
    // Auth off: /auth/me answers for nobody.
    expect(describeWorkspaceChoice({ authProvider: "none", workspaceIds: ["ws-a", "ws-b"] }).switchable).toBe(false);
    expect(describeWorkspaceChoice({ ...TWO_WORKSPACES, workspaceIds: ["ws-a"] }).switchable).toBe(false);
    // A credential bound to ws-a: the server refuses any other workspace.
    expect(describeWorkspaceChoice({ ...TWO_WORKSPACES, workspaceId: "ws-a" }).switchable).toBe(false);
    expect(describeWorkspaceChoice(TWO_WORKSPACES)).toEqual({
      options: ["ws-a", "ws-b"],
      personal: true,
      switchable: true,
    });
    expect(describeWorkspaceChoice({ ...TWO_WORKSPACES, userId: "" }).personal).toBe(false);
  });

  test("blocked storage reads as nothing remembered and writes are dropped", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(readStoredWorkspaceId()).toBe("");
    expect(() => writeStoredWorkspaceId("ws-a")).not.toThrow();
  });
});

describe("WorkspaceProvider", () => {
  test("switching reloads the documents and clears the chat of the previous workspace", async () => {
    serveApi();
    const rotate = vi.fn(() => window.localStorage.setItem(SESSION_STORAGE_KEY, `session-${rotate.mock.calls.length}`));
    const { mounts } = renderWithWorkspaces({ rotateChatSession: rotate });

    // Nothing remembered: the app is not held back, and requests carry no workspace.
    const select = await screen.findByRole("combobox", { name: "Switch workspace" });

    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: "No workspace (personal)" })).toBeEnabled();
    expect(documentRequests()).toEqual([""]);
    // The baseline /auth/me asked without a workspace.
    const meCall = axios.get.mock.calls.find(([url]) => url.endsWith("/auth/me"));

    expect(headerOf(meCall[1])).toBe("");

    fireEvent.change(select, { target: { value: "ws-a" } });
    expect(await screen.findByText("alpha-contract.pdf")).toBeInTheDocument();
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe("ws-a");
    expect(screen.getByTestId("session")).toHaveTextContent("session-1");

    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    expect(screen.getByText("turns:1")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Switch workspace" }), { target: { value: "ws-b" } });
    expect(await screen.findByText("beta-report.pdf")).toBeInTheDocument();
    // Nothing of workspace A is left on screen.
    expect(screen.queryByText("alpha-contract.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("turns:0")).toBeInTheDocument();
    expect(screen.getByTestId("session")).toHaveTextContent("session-2");
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe("ws-b");
    expect(getActiveWorkspaceId()).toBe("ws-b");
    // Each workspace's app mounted with its own header in place.
    expect(mounts).toEqual(["", "ws-a", "ws-b"]);
    expect(documentRequests()).toEqual(["", "ws-a", "ws-b"]);

    // Back to no workspace: the header goes away and so does the memory of it.
    fireEvent.change(screen.getByRole("combobox", { name: "Switch workspace" }), { target: { value: "" } });
    await waitFor(() => expect(mounts).toHaveLength(4));
    expect(getActiveWorkspaceId()).toBe("");
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
  });

  test("a remembered workspace still listed is in place before the app's first request", async () => {
    serveApi();
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, "ws-b");
    const { mounts } = renderWithWorkspaces();

    // The app waits while /auth/me is asked.
    expect(screen.getByRole("status")).toHaveTextContent("Loading workspace…");
    expect(await screen.findByText("beta-report.pdf")).toBeInTheDocument();
    expect(mounts).toEqual(["ws-b"]);
    expect(documentRequests()).toEqual(["ws-b"]);
    expect(screen.getByRole("combobox", { name: "Switch workspace" })).toHaveValue("ws-b");

    // The real baseline request went out without the remembered workspace.
    const meCall = axios.get.mock.calls.find(([url]) => url.endsWith("/auth/me"));

    expect(headerOf(meCall[1])).toBe("");
  });

  test("a remembered workspace no longer listed is forgotten and never sent", async () => {
    serveApi();
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, "ws-gone");
    const { mounts } = renderWithWorkspaces();

    await waitFor(() => expect(mounts).toEqual([""]));
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
    expect(documentRequests()).toEqual([""]);
    expect(screen.getByRole("combobox", { name: "Switch workspace" })).toHaveValue("");
  });

  test("an unreachable /auth/me hides the selector and keeps the remembered workspace for later", async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, "ws-b");
    axios.get.mockImplementation(async (url) => {
      if (url.endsWith("/auth/me")) {
        throw Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
      }

      return { data: [] };
    });
    const { mounts } = renderWithWorkspaces();

    await waitFor(() => expect(mounts).toEqual([""]));
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe("ws-b");
    expect(getActiveWorkspaceId()).toBe("");
  });

  test.each([
    ["auth is off", { authProvider: "none", userId: "", workspaceId: "", workspaceIds: [] }],
    ["one workspace", { ...TWO_WORKSPACES, workspaceIds: ["ws-a"] }],
    ["a credential bound to one workspace", { ...TWO_WORKSPACES, workspaceId: "ws-a" }],
  ])("no selector when %s", async (_label, me) => {
    serveApi({ me });
    const { mounts } = renderWithWorkspaces();

    await waitFor(() => expect(axios.get.mock.calls.some(([url]) => url.endsWith("/auth/me"))).toBe(true));
    await act(async () => {});
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(mounts).toEqual([""]);
    expect(getActiveWorkspaceId()).toBe("");
  });

  test("blocked storage: the selector still switches, nothing is remembered", async () => {
    serveApi();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    renderWithWorkspaces();
    fireEvent.change(await screen.findByRole("combobox", { name: "Switch workspace" }), {
      target: { value: "ws-a" },
    });

    expect(await screen.findByText("alpha-contract.pdf")).toBeInTheDocument();
    expect(getActiveWorkspaceId()).toBe("ws-a");
  });

  test("an OIDC session switches from its own /auth/me and reloads it for the new workspace", async () => {
    serveApi();
    const reloadMe = vi.fn(async () => ({ ...TWO_WORKSPACES, workspaceId: getActiveWorkspaceId() }));
    const loadBaselineMe = vi.fn();
    const auth = {
      ...DISABLED_AUTH,
      me: { ...TWO_WORKSPACES, authProvider: "oidc", userId: "", workspaceIds: ["ws-a", "ws-b"] },
      oidcEnabled: true,
      reloadMe,
      status: "signed_in",
    };

    renderWithWorkspaces({ auth, loadBaselineMe });

    const select = await screen.findByRole("combobox", { name: "Switch workspace" });

    expect(loadBaselineMe).not.toHaveBeenCalled();
    // No user: acting in no workspace is not a choice.
    expect(screen.getByRole("option", { name: "Choose a workspace" })).toBeDisabled();

    fireEvent.change(select, { target: { value: "ws-a" } });
    expect(await screen.findByText("alpha-contract.pdf")).toBeInTheDocument();
    expect(reloadMe).toHaveBeenCalledTimes(1);
    // The permissions were read for the workspace now in place.
    expect(await reloadMe.mock.results[0].value).toMatchObject({ workspaceId: "ws-a" });
  });

  test("outside a provider the switcher renders nothing and selecting does nothing", async () => {
    const Probe = () => {
      const { selectWorkspace } = useWorkspace();
      const [result, setResult] = React.useState("");

      return (
        <>
          <WorkspaceSwitcher t={t} />
          <button type="button" onClick={async () => setResult(String(await selectWorkspace("ws-a")))}>
            select
          </button>
          <p>{`result:${result}`}</p>
        </>
      );
    };

    render(<Probe />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "select" }));
    expect(await screen.findByText("result:false")).toBeInTheDocument();
    expect(getActiveWorkspaceId()).toBe("");
  });
});
