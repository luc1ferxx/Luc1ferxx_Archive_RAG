// UI gating only. The server (server/rag/rbac.js) is the authority and
// answers 403 for anything this hides incorrectly; these ids only decide
// which controls to hide or disable. A permission id may be granted exactly,
// through "*", or through a "<prefix>.*" wildcard.

// Ids follow server/rag/rbac.js (RBAC_ROUTE_TABLE): uploads need
// documents.write, delete and clear need documents.delete, and the quality
// refresh admin action needs admin.actions.quality_refresh.
export const UI_CAPABILITY_PERMISSIONS = Object.freeze({
  admin: Object.freeze(["admin.actions.quality_refresh"]),
  delete: Object.freeze(["documents.delete"]),
  upload: Object.freeze(["documents.write"]),
});

export const hasPermission = (permissions, permissionId) => {
  if (!Array.isArray(permissions) || !permissionId) {
    return false;
  }

  return permissions.some((granted) => {
    const value = String(granted ?? "");

    if (value === "*" || value === permissionId) {
      return true;
    }

    return value.endsWith(".*") && permissionId.startsWith(value.slice(0, -1));
  });
};

export const canUseCapability = (permissions, capability) => {
  const required = UI_CAPABILITY_PERMISSIONS[capability];

  if (!required) {
    return false;
  }

  return required.some((permissionId) => hasPermission(permissions, permissionId));
};

/**
 * Decides one UI capability from the auth state:
 * - OIDC not configured: everything stays visible (today's behaviour).
 * - OIDC configured but not signed in: gated actions are disabled.
 * - Signed in with /auth/me loaded: its effective permissions decide.
 * - Signed in but /auth/me unavailable: visible; the server still decides.
 */
export const decideCapability = ({ me, oidcEnabled, status }, capability) => {
  if (!oidcEnabled) {
    return true;
  }

  if (status !== "signed_in") {
    return false;
  }

  if (!me || !Array.isArray(me.permissions)) {
    return true;
  }

  return canUseCapability(me.permissions, capability);
};
