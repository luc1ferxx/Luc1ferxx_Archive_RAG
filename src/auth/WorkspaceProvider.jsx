import React, {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiGet } from "../apiClient";
import { createTranslator, getInitialLocale } from "../archiveI18n";
import { createSessionId, persistSessionId } from "../archiveSession";
import { useAuth } from "./AuthProvider";
import {
  describeWorkspaceChoice,
  normalizeWorkspaceId,
  readStoredWorkspaceId,
  setActiveWorkspaceId,
  writeStoredWorkspaceId,
} from "./workspaceSelection";

// Which workspace the app acts in, for a credential that may use several
// (GET /auth/me lists them in workspaceIds). Mounted inside AuthProvider,
// around the app:
//
// - What may be chosen is read once, from /auth/me without x-workspace-id:
//   the OIDC session's own answer when signed in, otherwise this provider's
//   request (a static token, or auth off, where /auth/me says "none" and
//   nothing is offered). One workspace, a credential bound to one, or no
//   answer: no selector, and requests go out exactly as before.
// - A remembered choice (localStorage) is used only when /auth/me still lists
//   it; until that is known the app waits, so its first requests already go
//   to the right workspace. One that is no longer listed is forgotten.
// - Switching unmounts the app first, then points every request at the new
//   workspace (src/config.js), starts a new chat session id, refreshes the
//   OIDC permissions for that workspace, and mounts the app again: documents
//   are listed afresh and no conversation, preview or task of the previous
//   workspace survives on screen.

const HIDDEN_CHOICE = Object.freeze({ options: Object.freeze([]), personal: false, switchable: false });

const DEFAULT_WORKSPACE = Object.freeze({
  choice: HIDDEN_CHOICE,
  selectWorkspace: async () => false,
  selected: "",
  switching: false,
});

export const WorkspaceContext = createContext(DEFAULT_WORKSPACE);

export const useWorkspace = () => useContext(WorkspaceContext);

const defaultLoadBaselineMe = () => apiGet("/auth/me", { omitWorkspaceHeader: true });

// A new chat session for the new workspace: useChatSession reads the stored
// id when the app mounts again.
const defaultRotateChatSession = () => persistSessionId(createSessionId());

const isMe = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const translateLoading = () => {
  try {
    return createTranslator(getInitialLocale())("auth.workspaceLoading");
  } catch {
    return createTranslator("en")("auth.workspaceLoading");
  }
};

export const WorkspaceProvider = ({
  children,
  loadBaselineMe = defaultLoadBaselineMe,
  rotateChatSession = defaultRotateChatSession,
}) => {
  const auth = useAuth();
  const authRef = useRef(auth);
  const [stored] = useState(() => readStoredWorkspaceId());
  const [state, setState] = useState(() => ({
    choice: HIDDEN_CHOICE,
    pending: null,
    // Only a remembered workspace is worth waiting for.
    ready: !stored,
    selected: "",
  }));
  const stateRef = useRef(state);
  const rotateRef = useRef(rotateChatSession);

  authRef.current = auth;
  stateRef.current = state;
  rotateRef.current = rotateChatSession;

  useEffect(() => {
    let cancelled = false;

    const decide = async () => {
      const { me: authMe, status } = authRef.current;
      let me = null;

      if (status === "signed_in") {
        // AuthProvider read it before any workspace was selected.
        me = isMe(authMe) ? authMe : null;
      } else if (status === "disabled") {
        me = await Promise.resolve()
          .then(() => loadBaselineMe())
          .catch(() => null);
        me = isMe(me) ? me : null;
      }

      if (cancelled) {
        return;
      }

      const choice = me ? describeWorkspaceChoice(me) : HIDDEN_CHOICE;
      const selected = choice.switchable && choice.options.includes(stored) ? stored : "";

      // Forgotten only on an answer that no longer lists it; an unreachable
      // /auth/me keeps it for the next load.
      if (stored && !selected && me) {
        writeStoredWorkspaceId("");
      }

      setActiveWorkspaceId(selected);

      if (selected && status === "signed_in") {
        await authRef.current.reloadMe?.();
      }

      if (!cancelled) {
        setState((current) => ({ ...current, choice, ready: true, selected }));
      }
    };

    void decide();

    return () => {
      cancelled = true;
    };
    // Decided once per mount; the inputs are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A switch, after the app of the previous workspace has unmounted.
  useEffect(() => {
    if (state.pending === null) {
      return undefined;
    }

    let cancelled = false;
    const target = state.pending;

    const apply = async () => {
      setActiveWorkspaceId(target);
      writeStoredWorkspaceId(target);

      try {
        rotateRef.current();
      } catch {
        // The old session id then continues; the server keys it per workspace.
      }

      if (authRef.current.status === "signed_in") {
        await authRef.current.reloadMe?.();
      }

      if (!cancelled) {
        setState((current) => ({ ...current, pending: null, selected: target }));
      }
    };

    void apply();

    return () => {
      cancelled = true;
    };
  }, [state.pending]);

  const selectWorkspace = useCallback(async (nextWorkspaceId) => {
    const current = stateRef.current;
    const target = normalizeWorkspaceId(nextWorkspaceId);

    if (!current.ready || current.pending !== null || !current.choice.switchable) {
      return false;
    }

    if (target ? !current.choice.options.includes(target) : !current.choice.personal) {
      return false;
    }

    if (target !== current.selected) {
      setState((latest) => ({ ...latest, pending: target }));
    }

    return true;
  }, []);

  const value = useMemo(
    () => ({
      choice: state.choice,
      selectWorkspace,
      selected: state.selected,
      switching: state.pending !== null,
    }),
    [selectWorkspace, state.choice, state.pending, state.selected]
  );
  const showChildren = state.ready && state.pending === null;

  return (
    <WorkspaceContext.Provider value={value}>
      {showChildren ? (
        // A new key per workspace: every hook of the app starts over.
        <Fragment key={`workspace:${state.selected}`}>{children}</Fragment>
      ) : (
        <div className="archive-auth-loading" role="status" aria-live="polite">
          {translateLoading()}
        </div>
      )}
    </WorkspaceContext.Provider>
  );
};

export default WorkspaceProvider;
