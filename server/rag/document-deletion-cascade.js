import { AGENT_RUN_STATUSES } from "./agent-run-state-machine.js";
import { isAgentRunRevisionConflictError } from "./agent-run-revision.js";
import { isDocumentDeleteRedactionEnabled } from "./config.js";
import {
  buildDocumentReferenceNeedles,
  redactDocumentText,
  referencesDocuments,
  replaceQuotedText,
  replaceQuotedTextDeep,
  toDeletedDocIdSet,
} from "./document-deletion-redaction.js";

// What else a document delete removes (rag/index.js deleteDocument and
// clearDocuments call afterDocumentsDeleted once their own delete committed).
//
// The document's chunks in every live index version table go in the delete's
// own transaction (vector-store-pgvector.js). This runs afterwards, in the
// deleting request's database context, so every statement is held to that
// tenant (its row policies, or the exact scope filter the stores apply on the
// unscoped and system paths). It never fails the delete: the document is
// already gone, so each part logs its own failure and the next one runs.
//
// - Always: the document's queued, retry-waiting and dead-lettered ingest
//   jobs are settled failed with canceled_reason 'document_deleted' and lose
//   their bytes and stage outputs (ingest-job-store.js cancelDocumentJobs).
// - DOCUMENT_DELETE_REDACTION=on: the copies of its text in the deleting
//   tenant's records (rag/document-deletion-redaction.js):
//   * settled agent runs (completed, failed, canceled): steps, observations,
//     decisions and result, the private graph checkpoint included, through
//     the store's revision CAS with updatedAt kept. A run that is still
//     running or waiting for the user is skipped, because its persisted
//     outputs are what a resume reconciles against; approval snapshots and
//     run events are not rewritten.
//   * workspace artifacts that cite it: citation excerpts and quoted payload
//     text removed, verbatim quotes in the body replaced, and the artifact
//     marked source_deleted (migration 040).
//   * answer feedback: the citation excerpts (system path, migration 040).

const SETTLED_RUN_STATUSES = new Set([
  AGENT_RUN_STATUSES.canceled,
  AGENT_RUN_STATUSES.completed,
  AGENT_RUN_STATUSES.failed,
]);
const RUN_FIELDS = Object.freeze(["steps", "observations", "decisions", "result"]);
const CAS_ATTEMPTS = 3;
// Documents per redaction pass (two needles each), and the most ids a
// failure log line names.
const REDACTION_BATCH_SIZE = 100;
const LOGGED_DOC_ID_LIMIT = 20;
// A page loop that keeps returning pages stops here rather than spin.
const MAX_PAGES = 10_000;

const describeError = (error) => ({
  code: error?.code ?? null,
  name: error?.name ?? "Error",
});

const toPlainScope = (accessScope = {}) => ({
  userId: String(accessScope?.userId ?? "").trim(),
  workspaceId: String(accessScope?.workspaceId ?? "").trim(),
});

const redactRunFields = (run, deleted) => {
  const fields = {};

  for (const field of RUN_FIELDS) {
    const outcome = redactDocumentText(run[field], deleted);

    if (outcome.changed) {
      fields[field] = outcome.value;
    }
  }

  return Object.keys(fields).length > 0 ? fields : null;
};

const redactArtifact = (artifact, deleted) => {
  const content = String(artifact.content ?? "");
  const manifest = redactDocumentText(artifact.citationManifest ?? [], deleted);
  const payloadSource = artifact.payload ?? {};
  const payload = redactDocumentText(payloadSource, deleted);
  const quotes = [...manifest.quotes, ...payload.quotes];
  const fields = {
    citationManifest: manifest.value,
    content: replaceQuotedText(content, quotes),
    payload: replaceQuotedTextDeep(payload.value, quotes),
  };

  return {
    changed:
      manifest.changed ||
      fields.content !== content ||
      fields.payload !== payloadSource,
    fields,
  };
};

// The deleted documents this artifact names (in docIds or as a citation or
// payload member), so a document it never cited is not recorded on it.
const deletedDocIdsOf = (artifact, deleted) =>
  [...deleted].filter(
    (docId) =>
      (artifact.docIds ?? []).includes(docId) ||
      referencesDocuments([artifact.citationManifest ?? [], artifact.payload ?? {}], [docId])
  );

export const createDocumentDeletionCascade = ({
  agentRunStore = null,
  feedbackStore = null,
  ingestJobStore = null,
  isRedactionEnabled = isDocumentDeleteRedactionEnabled,
  logger = console,
  now = () => new Date().toISOString(),
  workspaceArtifactStore = null,
} = {}) => {
  const cancelIngestJobs = async ({ accessScope, docIds }) => {
    if (typeof ingestJobStore?.cancelDocumentJobs !== "function") {
      return null;
    }

    const canceled = await ingestJobStore.cancelDocumentJobs({ accessScope, docIds });

    return { canceled: canceled.length };
  };

  const redactRun = async (run, deleted) => {
    let current = run;

    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      if (!SETTLED_RUN_STATUSES.has(current.status)) {
        return "skippedActive";
      }

      const fields = redactRunFields(current, deleted);

      if (!fields) {
        return "unchanged";
      }

      try {
        await agentRunStore.update({
          accessScope: current.accessScope,
          baseRun: current,
          expectedRevision: current.revision,
          patch: { ...fields, updatedAt: current.updatedAt },
          runId: current.runId,
        });
        return "redacted";
      } catch (error) {
        if (!isAgentRunRevisionConflictError(error)) {
          throw error;
        }
      }

      current = await agentRunStore.get({ accessScope: current.accessScope, runId: current.runId });

      if (!current) {
        return "unchanged";
      }
    }

    return "conflicts";
  };

  const redactAgentRuns = async ({ accessScope, deleted, needles }) => {
    if (typeof agentRunStore?.listRunsReferencingDocuments !== "function") {
      return null;
    }

    const counts = { conflicts: 0, redacted: 0, skippedActive: 0, unchanged: 0 };
    let after = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { next, runs } = await agentRunStore.listRunsReferencingDocuments({ accessScope, after, needles });

      for (const run of runs) {
        counts[await redactRun(run, deleted)] += 1;
      }

      if (!next) {
        break;
      }

      after = next;
    }

    return counts;
  };

  const markArtifact = async (artifact, deleted) => {
    let current = artifact;

    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const deletedDocIds = deletedDocIdsOf(current, deleted);
      const redacted = redactArtifact(current, deleted);
      const alreadyMarked =
        current.sourceDeleted === true &&
        deletedDocIds.every((docId) => (current.sourceDeletedDocIds ?? []).includes(docId));

      if (deletedDocIds.length === 0 || (alreadyMarked && !redacted.changed)) {
        return "unchanged";
      }

      const scope = { userId: current.ownerUserId, workspaceId: current.workspaceId };
      const marked = await workspaceArtifactStore.markArtifactSourceDeleted({
        accessScope: scope,
        artifactId: current.artifactId,
        ...redacted.fields,
        deletedDocIds,
        previous: {
          citationManifest: current.citationManifest ?? [],
          content: String(current.content ?? ""),
          payload: current.payload ?? {},
        },
        timestamp: now(),
      });

      if (marked) {
        return "redacted";
      }

      current = await workspaceArtifactStore.getArtifact({ accessScope: scope, artifactId: current.artifactId });

      if (!current) {
        return "unchanged";
      }
    }

    return "conflicts";
  };

  const redactArtifacts = async ({ accessScope, deleted, needles }) => {
    if (
      typeof workspaceArtifactStore?.listArtifactsReferencingDocuments !== "function" ||
      typeof workspaceArtifactStore?.markArtifactSourceDeleted !== "function"
    ) {
      return null;
    }

    const counts = { conflicts: 0, redacted: 0, unchanged: 0 };
    let after = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { artifacts, next } = await workspaceArtifactStore.listArtifactsReferencingDocuments({
        accessScope,
        after,
        docIds: [...deleted],
        needles,
      });

      for (const artifact of artifacts) {
        counts[await markArtifact(artifact, deleted)] += 1;
      }

      if (!next) {
        break;
      }

      after = next;
    }

    return counts;
  };

  const redactFeedback = async ({ accessScope, deleted, needles }) => {
    if (typeof feedbackStore?.redactDocumentReferences !== "function") {
      return null;
    }

    return feedbackStore.redactDocumentReferences({
      accessScope,
      needles,
      redactCitations: (citations) => redactDocumentText(citations, deleted),
    });
  };

  // One part's failure is logged with ids and codes only (no document text)
  // and reported as `{ failed: true }`; the next part still runs.
  const runPart = async (part, docIds, work) => {
    try {
      return await work();
    } catch (error) {
      logger.error?.(
        `[document-deletion] ${part} after deleting ${docIds.length} document(s) failed.`,
        {
          ...(docIds.length <= LOGGED_DOC_ID_LIMIT ? { docIds } : {}),
          ...describeError(error),
        }
      );
      return { failed: true };
    }
  };

  return {
    /**
     * The cascade for documents the caller's delete just removed. Resolves to
     * what each part did ({ ingestJobs, redaction }); never rejects.
     */
    async afterDocumentsDeleted({ accessScope = {}, docIds = [] } = {}) {
      const deleted = toDeletedDocIdSet(docIds);
      const ids = [...deleted];

      if (ids.length === 0) {
        return { ingestJobs: null, redaction: null };
      }

      const scope = toPlainScope(accessScope);
      const ingestJobs = await runPart("cancelling ingest jobs", ids, () =>
        cancelIngestJobs({ accessScope: scope, docIds: ids })
      );

      if (!isRedactionEnabled()) {
        return { ingestJobs, redaction: null };
      }

      // A clear can name thousands of documents: each pass over a store
      // looks for a bounded batch of them, so no statement carries an
      // unbounded needle list.
      const batches = [];

      for (let offset = 0; offset < ids.length; offset += REDACTION_BATCH_SIZE) {
        const batch = ids.slice(offset, offset + REDACTION_BATCH_SIZE);

        batches.push({
          accessScope: scope,
          deleted: new Set(batch),
          needles: buildDocumentReferenceNeedles(batch),
        });
      }

      const redactInBatches = async (redact) => {
        let total = null;

        for (const input of batches) {
          const counts = await redact(input);

          if (counts === null) {
            return null;
          }

          total ??= Object.fromEntries(Object.keys(counts).map((key) => [key, 0]));

          for (const [key, value] of Object.entries(counts)) {
            total[key] = (total[key] ?? 0) + (Number(value) || 0);
          }
        }

        return total;
      };

      return {
        ingestJobs,
        redaction: {
          agentRuns: await runPart("redacting agent runs", ids, () => redactInBatches(redactAgentRuns)),
          artifacts: await runPart("redacting workspace artifacts", ids, () => redactInBatches(redactArtifacts)),
          feedback: await runPart("redacting answer feedback", ids, () => redactInBatches(redactFeedback)),
        },
      };
    },
  };
};

/** The cascade hook rag/index.js calls; a missing cascade does nothing. */
export const runDocumentDeletionCascade = async (cascade, input, { logger = console } = {}) => {
  if (typeof cascade?.afterDocumentsDeleted !== "function") {
    return null;
  }

  try {
    return await cascade.afterDocumentsDeleted(input);
  } catch (error) {
    logger.error?.("[document-deletion] the deletion cascade failed.", describeError(error));
    return null;
  }
};
