import { AsyncLocalStorage } from "node:async_hooks";

// Which tenant the current async call chain acts for. `rag/postgres.js` reads
// it on every query: with a tenant it runs the statement in a transaction that
// switches to the tenant role and sets the tenant settings the row-level
// security policies compare against (see migration 013). Without one the
// statement runs as the connection's own (owner) role, which bypasses the
// policies -- that is the path for migrations, startup loads, cross-tenant
// recovery scans, and auth-disabled requests that carry no scope.
//
// The context is set in exactly three kinds of place: the request middleware
// (from the authenticated access scope), background work that acts for one
// stored record (a task or agent run, from that record's own scope), and
// system work (runAsDatabaseSystem). Code in between never passes a scope to
// the database layer, which is the point: a store query that forgets its
// user/workspace filter still only sees the caller's rows.
//
// A call chain is in one of four states, so "no tenant" never has to be
// guessed:
//   tenant    a user/workspace pair: statements run as the tenant role.
//   system    runAsDatabaseSystem: owner work by nature (migrations, process-wide
//             caches, cross-tenant scans, start-up, health).
//   unscoped  runWithDatabaseTenant (bindDatabaseTenant, a task or run) with a
//             scope that names no tenant: an auth-disabled request, the single
//             shared API_AUTH_TOKEN, a platform admin path, a record stored
//             without a scope.
//   unbound   nothing bound at all: the store is undefined. Either code that
//             never went through one of the three binders, or a chain that lost
//             its context (a stream callback that resumes in the socket's
//             context). POSTGRES_TENANT_CONTEXT=strict refuses to query in this
//             state (rag/postgres.js); the default (lenient) runs it as the
//             owner, as before the states existed.
// Only the tenant state runs as the tenant role; the other three all run as
// the owner, so the states change nothing unless strict mode is on.
//
// With the database role split on (POSTGRES_MIGRATION_DATABASE_URL), the
// application no longer logs in as the owner: system and unscoped run as the
// system role (POSTGRES_SYSTEM_ROLE, migration 035, every row through its
// system_access policies but no ownership), and unbound runs as the runtime
// login itself, which holds no table privilege, so a lost context fails
// closed in lenient mode too. Owner work (migrations, DDL) uses a separate
// owner pool and only from the system state (rag/postgres.js).
const tenantStorage = new AsyncLocalStorage();

// The two explicit non-tenant states. Frozen singletons compared by identity,
// so no tenant object, whatever its fields, can pass for one of them.
const SYSTEM_CONTEXT = Object.freeze({ databaseContext: "system" });
const UNSCOPED_CONTEXT = Object.freeze({ databaseContext: "unscoped" });

export const DATABASE_TENANT_CONTEXTS = Object.freeze({
  system: "system",
  tenant: "tenant",
  unbound: "unbound",
  unscoped: "unscoped",
});

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
 * nor a workspace is not a tenant: the callback then runs unscoped (as the
 * owner), as an auth-disabled request always has, and never keeps an outer
 * tenant. Callers pass the scope they act for, never a narrower or wider one.
 */
export const runWithDatabaseTenant = (accessScope, callback) =>
  tenantStorage.run(toDatabaseTenant(accessScope) ?? UNSCOPED_CONTEXT, callback);

/**
 * Runs `callback` as the owner role even inside a tenant request. Only for work
 * that is system-wide by nature: migrations, start-up initialisation, filling
 * process-wide caches, health checks, background loops that claim work for
 * every tenant, and recovery scans that list every tenant's runnable records.
 * Per-record work inside such a loop binds the record's own scope again.
 */
export const runAsDatabaseSystem = (callback) => tenantStorage.run(SYSTEM_CONTEXT, callback);

/** One of DATABASE_TENANT_CONTEXTS for the current call chain. */
export const getDatabaseTenantContext = () => {
  const store = tenantStorage.getStore();

  if (store === undefined) {
    return DATABASE_TENANT_CONTEXTS.unbound;
  }

  if (store === SYSTEM_CONTEXT) {
    return DATABASE_TENANT_CONTEXTS.system;
  }

  if (store === UNSCOPED_CONTEXT) {
    return DATABASE_TENANT_CONTEXTS.unscoped;
  }

  return DATABASE_TENANT_CONTEXTS.tenant;
};

/**
 * The tenant the chain acts for, as a copy, or null in every other state
 * (system, unscoped and unbound alike): callers that only ask "is there a
 * tenant" keep working unchanged.
 */
export const getActiveDatabaseTenant = () =>
  getDatabaseTenantContext() === DATABASE_TENANT_CONTEXTS.tenant ? { ...tenantStorage.getStore() } : null;
