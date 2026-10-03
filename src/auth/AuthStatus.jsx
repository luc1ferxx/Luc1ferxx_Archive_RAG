import React from "react";
import { useAuth } from "./AuthProvider";

const fallbackT = (key) => key;

const describeRoles = (me) => {
  const workspaceRoles =
    me?.workspaceId && Array.isArray(me?.workspaceRoles?.[me.workspaceId])
      ? me.workspaceRoles[me.workspaceId]
      : [];
  const roles = [...new Set([...(me?.roles ?? []), ...workspaceRoles].map(String))];

  return roles.filter(Boolean).join(", ");
};

// Header control: nothing when OIDC is not configured (the static token path
// looks exactly as before), "Sign in" when signed out, and the signed-in
// user with active workspace, role and "Sign out" otherwise.
const AuthStatus = ({ t = fallbackT }) => {
  const { error, me, signIn, signOut, status } = useAuth();

  if (status === "disabled") {
    return null;
  }

  if (status === "loading") {
    return (
      <span className="archive-auth-status" aria-live="polite">
        {t("auth.checking")}
      </span>
    );
  }

  if (status === "signed_in") {
    const roles = describeRoles(me);

    return (
      <span className="archive-auth-status" aria-label={t("auth.account")}>
        <span className="archive-auth-user">
          {t("auth.signedInAs", { user: me?.userId || t("auth.unknownUser") })}
        </span>
        {me?.workspaceId ? (
          <span className="archive-auth-workspace">
            {t("auth.workspace")}: {me.workspaceId}
          </span>
        ) : null}
        <span className="archive-auth-role">
          {t("auth.role")}: {roles || t("auth.noRole")}
        </span>
        <button type="button" onClick={() => signOut()}>
          {t("auth.signOut")}
        </button>
      </span>
    );
  }

  return (
    <span className="archive-auth-status">
      {error ? (
        <span className="archive-auth-error" role="alert">
          {error}
        </span>
      ) : null}
      {status === "signed_out" ? (
        <button type="button" onClick={() => void signIn()}>
          {t("auth.signIn")}
        </button>
      ) : null}
    </span>
  );
};

export default AuthStatus;
