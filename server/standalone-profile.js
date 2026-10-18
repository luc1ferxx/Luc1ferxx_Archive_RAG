// The zero-infrastructure profile: what has to be true for the archive to answer
// questions about PDFs with nothing installed but Node and an API key.
//
// The archive normally leans on PostgreSQL for the document registry, long-term
// memory, session memory, tasks, agent runs, workspace artifacts and the admin
// audit log. Only the first of those matters to "answer a question about these
// PDFs" -- the rest already have off switches, and the registry now has a
// file-backed store (rag/doc-registry-file.js). This module flips every switch in
// one place so a standalone entry point is one call, not a checklist a caller can
// get half-right.
//
// Constraint worth knowing before extending this: every setting below is read
// lazily by rag/config.js, so applying the profile after the RAG modules are
// imported still works. Two values are NOT lazy -- RAG_DATA_DIRECTORY is captured
// when rag/storage.js is first imported, and vector-store-local.js loads its index
// at import time. If this profile ever needs to set RAG_DATA_DIRECTORY, the
// assignment has to happen before those modules are imported, which means a
// dynamic import in the caller rather than a call in its module body.

import { configureDocumentRegistryStore } from "./rag/doc-registry.js";
import { createFileDocumentRegistryStore } from "./rag/doc-registry-file.js";
import { configureSessionMemoryStore } from "./rag/memory.js";
import { getActiveDatabaseTenant } from "./rag/postgres-tenant.js";
import { summarizeTenantRecords, tenantSelectorMatches } from "./rag/tenant-records.js";

// Session memory is only reachable when a caller passes a sessionId, and the MCP
// bridge passes none. This exists so that a caller which *does* pass one gets
// per-process conversation continuity instead of a PostgreSQL connection error.
// Long-term memory needs no equivalent: getLongMemoryContext() already
// short-circuits on the disabled config below (rag/long-memory.js:575).
//
// Like the PostgreSQL store's owner columns (migration 031), a session keeps
// the database tenant that first wrote it, so the tenant erase and export
// (rag/tenant-records.js) can find it; a session written without a tenant
// (auth off) belongs to no tenant.
export const createInMemorySessionMemoryStore = () => {
  const sessionsById = new Map();

  const cloneSession = (session) =>
    session
      ? {
          updatedAt: Number(session.updatedAt ?? Date.now()),
          messages: structuredClone(session.messages ?? []),
        }
      : null;
  const listTenantSessions = (selector) =>
    [...sessionsById.entries()].filter(
      ([, session]) => session.owner && tenantSelectorMatches(selector, session.owner)
    );

  return {
    async initialize() {
      return true;
    },
    async get(sessionId) {
      return cloneSession(sessionsById.get(sessionId) ?? null);
    },
    async upsert({ sessionId, messages, updatedAt = Date.now() }) {
      const tenant = getActiveDatabaseTenant();

      sessionsById.set(sessionId, {
        updatedAt,
        messages: structuredClone(messages ?? []),
        owner: sessionsById.get(sessionId)?.owner ?? (tenant ? { ...tenant } : null),
      });

      return cloneSession(sessionsById.get(sessionId));
    },
    async countTenantRecords(selector) {
      return summarizeTenantRecords(await this.listTenantRecords(selector), ["session_memory"]);
    },
    async listTenantRecords(selector) {
      return listTenantSessions(selector).map(([sessionId, session]) => ({
        record: {
          messages: structuredClone(session.messages ?? []),
          ownerUserId: session.owner.userId,
          sessionId,
          updatedAt: Number(session.updatedAt ?? 0),
          workspaceId: session.owner.workspaceId,
        },
        table: "session_memory",
      }));
    },
    async deleteTenantRecords(selector) {
      const matched = listTenantSessions(selector);

      for (const [sessionId] of matched) {
        sessionsById.delete(sessionId);
      }

      return { session_memory: { deleted: matched.length } };
    },
    async delete(sessionId) {
      return sessionsById.delete(sessionId);
    },
    async clearAll() {
      const clearedCount = sessionsById.size;
      sessionsById.clear();
      return clearedCount;
    },
    async reset() {
      sessionsById.clear();
      return true;
    },
  };
};

// Clearing the two database URLs is the decisive move rather than one setting
// among many: isPostgresDatabaseConfigured() is what every "auto" provider and
// the long-memory default key off. The explicit settings that follow are belt and
// braces -- they make the intent visible in the config status each subsystem
// reports ("env_memory" rather than "postgres_not_configured") and stop a stray
// .env from re-enabling a subsystem that has no database to talk to.
const STANDALONE_ENVIRONMENT = Object.freeze({
  POSTGRES_DATABASE_URL: "",
  LONG_MEMORY_DATABASE_URL: "",
  RAG_LONG_MEMORY_ENABLED: "false",
  RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
  TASK_STORE_PROVIDER: "memory",
  WORKSPACE_ARTIFACT_STORE_PROVIDER: "memory",
  AGENT_RUN_STORE_PROVIDER: "memory",
  ADMIN_AUDIT_STORE_PROVIDER: "memory",
  // These two do not select a store -- the stores below are injected directly.
  // They exist so the health report describes the backend that is actually
  // installed. Without them the startup health check probes PostgreSQL for the
  // document registry and session memory regardless, reports them as errors, and
  // refuses to boot at all under STARTUP_HEALTH_STRICT=true.
  DOCUMENT_STORE_PROVIDER: "filesystem",
  SESSION_MEMORY_STORE_PROVIDER: "memory",
  // Qdrant is a server too. The local index is a JSON file, which is the point.
  VECTOR_STORE_PROVIDER: "local",
});

export const isStandaloneProfileEnabled = ({ environment = process.env } = {}) =>
  String(environment.DOCCOMPARE_STANDALONE ?? "").trim() === "1";

export const applyStandaloneProfile = ({
  createRegistryStore = createFileDocumentRegistryStore,
  environment = process.env,
} = {}) => {
  for (const [name, value] of Object.entries(STANDALONE_ENVIRONMENT)) {
    environment[name] = value;
  }

  configureDocumentRegistryStore(createRegistryStore());
  configureSessionMemoryStore(createInMemorySessionMemoryStore());

  return {
    applied: true,
    documentRegistryBackend: "filesystem",
    sessionMemoryBackend: "memory",
    settings: {
      ...STANDALONE_ENVIRONMENT,
    },
  };
};
