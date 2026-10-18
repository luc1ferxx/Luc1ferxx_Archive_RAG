import { DATA_ACCESS_ACTION_IDS, DATA_ACCESS_OUTCOMES } from "./admin-audit.js";
import { getDocumentTrashRetentionHours, isAdminAuditDataEventsEnabled } from "./config.js";
import { runDocumentDeletionCascade } from "./document-deletion-cascade.js";
import {
  DOCUMENT_TRASH_ERROR_CODES,
  DOCUMENT_TRASH_UNSUPPORTED_MESSAGE,
  purgeTrashedDocumentsBatch,
  supportsDocumentTrash,
} from "./index.js";
import { runWithDatabaseTenant } from "./postgres-tenant.js";

// The document trash (migration 042), DOCUMENT_TRASH_RETENTION_HOURS (default
// 0: deletes are immediate, nothing here runs).
//
// With the setting above 0 (rag/index.js deleteDocument / clearDocuments):
//
// - DELETE /documents/:docId and POST /documents/clear move documents into the
//   trash. In one transaction their chunks leave every live index version
//   table (search can no longer reach them) and the row is marked deleted_at
//   with the deleting scope; the bytes stay. Their queued ingest jobs are
//   cancelled right after, as for a delete. Every read of the documents a
//   tenant works with leaves a trashed row out (rag/doc-registry.js).
// - GET /documents/trash lists the caller's trash; POST /documents/:docId/
//   restore re-chunks and re-embeds the stored bytes through the commit path
//   under the caller's tenant (rag/index.js restoreDocument), bumping the
//   content version. RAG_INGEST_DEDUP: an upload of bytes a trashed document
//   holds creates a new document (a trashed document is not a duplicate), and
//   a restore whose bytes the tenant has since stored again as another
//   document is refused (409 DOCUMENT_RESTORE_DUPLICATE), so there is still one
//   document per content.
// - The retention sweep (rag/retention.js, API tier) purges documents trashed
//   more than the setting's hours ago, in batches on the system path
//   (deleteExpiredTrash below), and only then runs the deletion cascade with
//   DOCUMENT_DELETE_REDACTION, in the deleting scope's context, so a restore
//   within the window loses nothing.
// - Storage quotas keep counting a trashed document until it is purged (its
//   bytes are still stored); a restore adds nothing to them.
// - The tenant erase removes trashed documents with the rest.
//
// It needs VECTOR_STORE_PROVIDER=pgvector with the PostgreSQL document
// registry (one transaction moves the chunks and the row); anything else
// refuses the start (assertDocumentTrashSupported). Setting it back to 0
// leaves what is already in the trash hidden and restorable, but unpurged
// until it is raised again (or the tenant is erased).

const HOUR_MS = 60 * 60 * 1000;

export { DOCUMENT_TRASH_ERROR_CODES };

/**
 * Refuses the start (createApp) when the trash is switched on where it cannot
 * work. `ragService.supportsDocumentTrash` answers when the service has it
 * (app-services.js wires rag/index.js's; a test double may declare its own).
 */
export const assertDocumentTrashSupported = ({
  hours = getDocumentTrashRetentionHours(),
  ragService = null,
} = {}) => {
  if (!(hours > 0)) {
    return;
  }

  const supported =
    typeof ragService?.supportsDocumentTrash === "function"
      ? ragService.supportsDocumentTrash()
      : supportsDocumentTrash();

  if (supported !== true) {
    throw Object.assign(new Error(DOCUMENT_TRASH_UNSUPPORTED_MESSAGE), {
      code: DOCUMENT_TRASH_ERROR_CODES.unsupported,
    });
  }
};

/** When a document trashed at `deletedAt` is purged: null with the trash off. */
export const computeTrashPurgeAfter = (deletedAt, hours = getDocumentTrashRetentionHours()) => {
  const deleted = Date.parse(String(deletedAt ?? ""));

  if (!Number.isFinite(deleted) || !(hours > 0)) {
    return null;
  }

  return new Date(deleted + hours * HOUR_MS).toISOString();
};

/** A trashed document as GET /documents/trash shows it. */
export const describeTrashedDocument = (document, { hours = getDocumentTrashRetentionHours() } = {}) => ({
  ...document,
  purgeAfter: computeTrashPurgeAfter(document?.deletedAt, hours),
});

const describeError = (error) => [error?.code, error?.name].filter(Boolean).join(" ") || "Error";

// The purged documents per deleting scope (deleted_by_*): that scope's
// records are what an immediate delete by the same request would have
// redacted, and its audit chain records the purge.
const groupByDeletingScope = (documents) => {
  const groups = new Map();

  for (const document of documents) {
    const scope = {
      userId: String(document.deletedByUserId ?? ""),
      workspaceId: String(document.deletedByWorkspaceId ?? ""),
    };
    const key = JSON.stringify([scope.userId, scope.workspaceId]);

    if (!groups.has(key)) {
      groups.set(key, { docIds: [], scope });
    }

    groups.get(key).docIds.push(document.docId);
  }

  return [...groups.values()];
};

/**
 * The sweep side of the trash: `deleteExpiredTrash({ cutoff, limit })` is the
 * retention delete of the `document_trash` type (rag/retention.js). One batch
 * per call, on the system path the sweep binds; then, per deleting scope and
 * in that scope's database context, the deletion cascade (redaction with
 * DOCUMENT_DELETE_REDACTION=on, and the ingest jobs again, which is a no-op
 * by now) and, with ADMIN_AUDIT_DATA_EVENTS=on, one `document.purge` event
 * (ids and counts only). Neither ever fails the purge: the rows are gone
 * already, so a failure is logged with ids and codes. Resolves to
 * { acquired, deleted }, or null when the registry keeps no trash.
 */
export const createDocumentTrashService = ({
  adminAuditService = null,
  getCascade = () => null,
  isDataEventsEnabled = isAdminAuditDataEventsEnabled,
  logger = console,
  purgeBatch = purgeTrashedDocumentsBatch,
} = {}) => {
  const recordPurge = async ({ docIds, scope }) => {
    if (isDataEventsEnabled() !== true || typeof adminAuditService?.recordDataAccess !== "function") {
      return;
    }

    try {
      await adminAuditService.recordDataAccess({
        accessScope: scope,
        actionId: DATA_ACCESS_ACTION_IDS.documentPurge,
        count: docIds.length,
        outcome: DATA_ACCESS_OUTCOMES.succeeded,
        request: { method: "", path: "", route: "" },
        resourceIds: docIds,
        status: 200,
        target: scope,
      });
    } catch (error) {
      logger.warn?.(
        `[document-trash] could not write the audit event of a purge of ${docIds.length} document(s) (${describeError(error)}).`
      );
    }
  };

  return {
    async deleteExpiredTrash({ cutoff, limit } = {}) {
      const result = await purgeBatch({ cutoff, limit });

      if (!result) {
        return null;
      }

      for (const group of groupByDeletingScope(result.documents ?? [])) {
        await runWithDatabaseTenant(group.scope, async () => {
          await runDocumentDeletionCascade(
            getCascade(),
            { accessScope: group.scope, docIds: group.docIds, redact: true },
            { logger }
          );
          await recordPurge(group);
        });
      }

      return { acquired: result.acquired !== false, deleted: Number(result.deleted) || 0 };
    },
  };
};
