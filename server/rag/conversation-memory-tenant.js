import { isApiAuthEnabled } from "./config.js";
import { getActiveDatabaseTenant, toDatabaseTenant } from "./postgres-tenant.js";

/**
 * The tenant a conversation memory read or write acts for. One rule for the
 * session memory key (rag/memory.js) and for long-term memory under
 * LONG_MEMORY_SCOPE=workspace (rag/long-memory.js), so a chat, a background
 * task and the agent tier reach the same memory as the request that wrote it.
 *
 * The tenant is the caller's access scope (chat, research brief, the memory
 * routes) or, when a caller passes none or one without a user and workspace,
 * the active database tenant. It applies only when the scope is authenticated
 * or API auth is on (a task's stored scope carries no `authenticated` flag):
 * with auth off there is no tenant boundary to keep, and the result is null.
 *
 * Returns { userId, workspaceId } (trimmed, either may be empty) or null.
 */
export const resolveConversationMemoryTenant = (accessScope) => {
  const explicitScope =
    accessScope && typeof accessScope === "object" && toDatabaseTenant(accessScope)
      ? accessScope
      : null;
  const scope = explicitScope ?? getActiveDatabaseTenant();

  if (!scope || (scope.authenticated !== true && !isApiAuthEnabled())) {
    return null;
  }

  return toDatabaseTenant(scope);
};
