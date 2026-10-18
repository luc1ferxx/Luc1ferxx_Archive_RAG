// Which tenant key a record is encrypted under (tenant isolation phase 5).
//
// The key scope follows the audit chain (rag/admin-audit-chain.js) and the
// tenant erase selector (rag/tenant-records.js):
//
//   a record in a workspace          the workspace's key, whichever user
//                                    wrote it (every member shares it)
//   a user's record outside any      that user's own key
//   workspace
//   a record with no owner at all    one shared "unscoped" key (auth off, the
//                                    single shared API_AUTH_TOKEN)
//
// So an erase of a workspace destroys the workspace key and an erase of a user
// outside any workspace destroys that user's key. An erase of one user inside
// a workspace deletes that user's rows only: the key is the workspace's, and
// destroying it would shred every other member's documents too.
//
// A key id is a hash of the scope, never the raw tenant id, because it is
// written into every envelope (the database) and into keystore file names.
import { createHash } from "node:crypto";

export const TENANT_KEY_SCOPE_KINDS = Object.freeze({
  unscoped: "unscoped",
  user: "user",
  workspace: "workspace",
});

const KEY_ID_PATTERN = /^tk_[0-9a-f]{40}$/;

const normalizeId = (value) => String(value ?? "").trim();

export const toTenantKeyId = ({ id = "", kind }) =>
  `tk_${createHash("sha256")
    .update(JSON.stringify(["archive-rag/tenant-key", 1, kind, normalizeId(id)]))
    .digest("hex")
    .slice(0, 40)}`;

export const isTenantKeyId = (value) => KEY_ID_PATTERN.test(String(value ?? ""));

/**
 * The key scope of a record whose owner columns are `{ userId, workspaceId }`
 * (trimmed): { kind, id, keyId }. The workspace decides when there is one.
 */
export const resolveTenantKeyScope = ({ userId = "", workspaceId = "" } = {}) => {
  const workspace = normalizeId(workspaceId);
  const user = normalizeId(userId);
  const scope = workspace
    ? { id: workspace, kind: TENANT_KEY_SCOPE_KINDS.workspace }
    : user
      ? { id: user, kind: TENANT_KEY_SCOPE_KINDS.user }
      : { id: "", kind: TENANT_KEY_SCOPE_KINDS.unscoped };

  return Object.freeze({ ...scope, keyId: toTenantKeyId(scope) });
};

/**
 * What a tenant erase of `selector` (a normalized tenant selector) does to
 * keys: `destroy` lists the scopes whose key goes once the rows are gone,
 * `kept` the shared scope a one-user erase inside a workspace leaves alone.
 */
export const resolveTenantKeyScopesForErase = (selector = {}) => {
  const workspaceId = normalizeId(selector.workspaceId);
  const userId = selector.userId === null || selector.userId === undefined ? null : normalizeId(selector.userId);

  if (workspaceId && userId === null) {
    return { destroy: [resolveTenantKeyScope({ workspaceId })], kept: [] };
  }

  if (workspaceId) {
    return { destroy: [], kept: [resolveTenantKeyScope({ workspaceId })] };
  }

  return userId ? { destroy: [resolveTenantKeyScope({ userId })], kept: [] } : { destroy: [], kept: [] };
};
