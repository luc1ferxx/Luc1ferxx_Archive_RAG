// The workspace this tab acts in. buildApiRequestConfig (src/config.js) sends
// it as x-workspace-id on every API request while one is selected; with none
// selected (the default) requests are exactly what they were before, and the
// server resolves the workspace from the credential as it always has.
//
// The choice is remembered in localStorage so a reload stays in the same
// workspace. Storage may be missing or blocked (a private window, a sandboxed
// preview); every read and write is guarded and the app then simply starts
// without a remembered workspace. The server stays the authority: a
// workspace the credential may not use is refused there (403), whatever is
// stored here, and WorkspaceProvider drops a stored id that /auth/me does not
// list.

export const WORKSPACE_STORAGE_KEY = "archive-rag.workspace-id";
export const WORKSPACE_HEADER = "x-workspace-id";

// Server-side workspace ids are at most 256 characters (the tenant registry's
// MAX_TENANT_ID_LENGTH); anything longer, or with control characters, is not
// one this tab will send. Nor is one with a character above U+00FF: a header
// value must be a ByteString, and fetch and XHR throw on anything else before
// the request leaves, so one such id (listed by /auth/me, or remembered) made
// every request of the tab fail. It is not offered and not sent; the tenant
// registry no longer registers such ids (printable ASCII only).
const MAX_WORKSPACE_ID_LENGTH = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const NOT_BYTE_STRING = /[^\u0000-ÿ]/u;

export const normalizeWorkspaceId = (value) => {
  if (typeof value !== "string") {
    return "";
  }

  const text = value.trim();

  return text &&
    text.length <= MAX_WORKSPACE_ID_LENGTH &&
    !CONTROL_CHARACTERS.test(text) &&
    !NOT_BYTE_STRING.test(text)
    ? text
    : "";
};

let activeWorkspaceId = "";

/** The workspace requests are sent for, or "" for none. */
export const getActiveWorkspaceId = () => activeWorkspaceId;

export const setActiveWorkspaceId = (workspaceId) => {
  activeWorkspaceId = normalizeWorkspaceId(workspaceId);
};

const getLocalStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export const readStoredWorkspaceId = () => {
  try {
    return normalizeWorkspaceId(getLocalStorage()?.getItem(WORKSPACE_STORAGE_KEY) ?? "");
  } catch {
    return "";
  }
};

/** Remembers `workspaceId` ("" forgets it). Never throws. */
export const writeStoredWorkspaceId = (workspaceId) => {
  try {
    const storage = getLocalStorage();
    const normalized = normalizeWorkspaceId(workspaceId);

    if (normalized) {
      storage?.setItem(WORKSPACE_STORAGE_KEY, normalized);
    } else {
      storage?.removeItem(WORKSPACE_STORAGE_KEY);
    }
  } catch {
    // Storage may be blocked; the choice then lasts until the tab reloads.
  }
};

/**
 * What GET /auth/me (read without x-workspace-id) allows this tab to choose:
 * `{ fallback, options, switchable, personal }`.
 *
 * - Auth off (authProvider "none") or no answer: nothing to choose.
 * - A credential bound to one workspace (its own workspaceId, which /auth/me
 *   reports even without a header) cannot act in another: not switchable.
 * - Otherwise the workspaces it lists; more than one makes the selector
 *   worth showing. `personal` says whether acting in no workspace is a real
 *   choice: the credential names a user and the server does not require a
 *   workspace (`workspaceRequired`, API_AUTH_REQUIRE_WORKSPACE), where every
 *   request without one is refused.
 * - `fallback` is the workspace to act in when nothing (valid) is
 *   remembered: "" (no workspace, as before) unless a workspace is required,
 *   then the first one listed, so the tab never starts in a scope every
 *   request is refused in.
 */
export const describeWorkspaceChoice = (me) => {
  if (!me || typeof me !== "object" || Array.isArray(me) || me.authProvider === "none") {
    return { fallback: "", options: [], personal: false, switchable: false };
  }

  const options = [
    ...new Set(
      (Array.isArray(me.workspaceIds) ? me.workspaceIds : []).map(normalizeWorkspaceId).filter(Boolean)
    ),
  ];
  const boundWorkspaceId = normalizeWorkspaceId(me.workspaceId);
  const required = me.workspaceRequired === true;

  return {
    fallback: required && !boundWorkspaceId ? options[0] ?? "" : "",
    options,
    personal: !required && typeof me.userId === "string" && me.userId.trim() !== "",
    switchable: options.length > 1 && !boundWorkspaceId,
  };
};

/** Tests: forget the selection (storage is the test's own to clear). */
export const resetWorkspaceSelectionForTests = () => {
  activeWorkspaceId = "";
};
