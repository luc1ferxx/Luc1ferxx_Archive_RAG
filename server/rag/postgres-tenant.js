import { AsyncLocalStorage } from "node:async_hooks";

// Which tenant the current async call chain acts for. `rag/postgres.js` reads
// it on every query: with a tenant it runs the statement in a transaction that
// switches to the tenant role and sets the tenant settings the row-level
// security policies compare against (see migration 013). Without one the
// statement runs as the connection's own (owner) role, which bypasses the
// policies -- that is the path for migrations, startup loads, cross-tenant
// recovery scans, and auth-disabled requests that carry no scope.
//
// The context is set in exactly two kinds of place: the request middleware
// (from the authenticated access scope) and background work that acts for one
// stored record (a task or agent run, from that record's own scope). Code in
// between never passes a scope to the database layer, which is the point: a
// store query that forgets its user/workspace filter still only sees the
// caller's rows.
const tenantStorage = new AsyncLocalStorage();

const normalizeTenantValue = (value) => String(value ?? "").trim();

// Trimmed only, the same normalization auth.js applies to the principal and the
// document registry applies to owner columns. The task and run stores also
// collapse internal whitespace; an id with a whitespace run would therefore not
// match its task rows and the policy fails closed (the rows stay invisible).
export const toDatabaseTenant = (accessScope = {}) => {
  const userId = normalizeTenantValue(accessScope?.userId);
  const workspaceId = normalizeTenantValue(accessScope?.workspaceId);

  return userId || workspaceId ? { userId, workspaceId } : null;
};

/**
 * Runs `callback` acting for exactly `accessScope`. A scope with neither a user
 * nor a workspace is not a tenant: the callback then runs unscoped, as an
 * auth-disabled request always has. Callers pass the scope they act for, never
 * a narrower or wider one.
 */
export const runWithDatabaseTenant = (accessScope, callback) =>
  tenantStorage.run(toDatabaseTenant(accessScope), callback);

/**
 * Runs `callback` as the owner role even inside a tenant request. Only for work
 * that is system-wide by nature: migrations, filling process-wide caches, and
 * recovery scans that list every tenant's runnable records.
 */
export const runAsDatabaseSystem = (callback) => tenantStorage.run(null, callback);

export const getActiveDatabaseTenant = () => {
  const tenant = tenantStorage.getStore();

  return tenant ? { ...tenant } : null;
};
