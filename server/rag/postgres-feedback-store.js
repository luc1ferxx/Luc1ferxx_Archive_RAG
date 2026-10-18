import { getFeedbackPostgresTable } from "./config.js";
import { getFeedbackTableName, runPostgresMigrations } from "./db-migrations.js";
import { queryPostgres } from "./postgres.js";
import { createPostgresTenantRecordMethods } from "./tenant-records.js";
import {
  buildRetentionLockKey,
  normalizeRetentionBatchLimit,
  normalizeRetentionCutoffs,
  readRetentionLockAcquired,
  renderRetentionPreludeCtes,
} from "./retention-sql.js";
import { runAsDatabaseSystem } from "./postgres-tenant.js";

// Answer feedback in PostgreSQL (migration 034), the store feedback.js uses
// whenever a database is configured. Every statement runs under the request's
// database tenant (rag/postgres.js), so the tenant_isolation policy checks the
// owner columns of every row it reads or writes whether or not the WHERE
// clause below filters them. Operator tools that read or import across tenants
// wrap their calls in runAsDatabaseSystem themselves.

export const FEEDBACK_LIST_DEFAULT_LIMIT = 25;
export const FEEDBACK_LIST_MAX_LIMIT = 100;

export const normalizeFeedbackListLimit = (limit) =>
  Math.max(
    1,
    Math.min(
      FEEDBACK_LIST_MAX_LIMIT,
      Number.parseInt(limit, 10) || FEEDBACK_LIST_DEFAULT_LIMIT
    )
  );

const normalizeText = (value) => String(value ?? "").trim();

/**
 * Which records a caller may list; one decision for both feedback stores
 * (feedback.js applies it to the file, this store to its WHERE clause).
 *
 * - A scope naming a user or a workspace sees the records of exactly that
 *   (user, workspace) pair, empty strings included, as migration 034's policy
 *   does.
 * - A scope naming neither sees every record, as the document registry
 *   reads it. That is the single-tenant setup: auth disabled, or the single
 *   shared API_AUTH_TOKEN without a user. requireApiAuth (requireTenantScope
 *   in auth.js) refuses every other authenticated scope that names neither
 *   before it reaches a feedback route, so this store keeps the same rule as
 *   the registry rather than a second, stricter one the single token would
 *   trip over.
 */
export const resolveFeedbackReadScope = (accessScope = {}) => {
  const userId = normalizeText(accessScope?.userId);
  const workspaceId = normalizeText(accessScope?.workspaceId);

  if (userId || workspaceId) {
    return { mode: "tenant", userId, workspaceId };
  }

  return { mode: "all", userId: "", workspaceId: "" };
};

// The record fields buildFeedbackRecord writes, each in a column of its own.
// Any other top-level field (only an imported record has one) is kept in
// `extra`.
const RECORD_FIELDS = new Set([
  "feedbackId",
  "createdAt",
  "userId",
  "workspaceId",
  "sessionId",
  "turnIndex",
  "question",
  "docIds",
  "feedbackType",
  "note",
  "answerText",
  "agentMode",
  "skills",
  "claimChecks",
  "agentObservability",
  "citations",
]);

// PostgreSQL text cannot hold U+0000, which a JSON request body can carry and
// the JSONL file kept. Content fields drop it rather than fail the write. Ids
// (feedback, user, workspace) are left as they are, so an id holding it fails
// the statement closed, as a tenant id holding it does (rag/postgres.js).
const toTextColumn = (value) => String(value ?? "").replaceAll("\u0000", "");

// A plain JSON round trip: the value the json column gives back. The json
// type keeps the text as written, so this is the only normalization a nested
// value goes through (undefined members dropped, NaN and Infinity as null).
const toJsonValue = (value, fallback) =>
  value === undefined ? fallback : JSON.parse(JSON.stringify(value) ?? "null");

const toTurnIndex = (value) => {
  const parsed = Number(value);

  return value !== null && value !== undefined && Number.isInteger(parsed) ? parsed : null;
};

const toCreatedAt = (value, now) => {
  const date = value instanceof Date ? value : new Date(value ?? "");
  const iso = Number.isNaN(date.getTime()) ? "" : date.toISOString();

  // toISOString writes years past 9999 with a sign PostgreSQL does not parse.
  return /^\d{4}-/.test(iso) ? iso : new Date(now()).toISOString();
};

const toExtra = (record) => {
  const extra = {};

  for (const [key, value] of Object.entries(record)) {
    if (!RECORD_FIELDS.has(key) && value !== undefined) {
      extra[key] = toJsonValue(value, null);
    }
  }

  return extra;
};

/**
 * The record exactly as the table will give it back, and the statement values
 * that store it. recordFeedback returns this record, so a POST /feedback
 * response equals the entry GET /feedback lists later.
 */
export const buildStoredFeedback = (record = {}, { now = () => Date.now() } = {}) => {
  // Same key order as buildFeedbackRecord and mapFeedbackRow.
  const stored = {
    feedbackId: String(record.feedbackId ?? ""),
    createdAt: toCreatedAt(record.createdAt, now),
    userId: String(record.userId ?? ""),
    workspaceId: String(record.workspaceId ?? ""),
    sessionId: toTextColumn(record.sessionId),
    turnIndex: toTurnIndex(record.turnIndex),
    question: toTextColumn(record.question),
    docIds: toJsonValue(record.docIds, []),
    feedbackType: toTextColumn(record.feedbackType),
    note: toTextColumn(record.note),
    answerText: toTextColumn(record.answerText),
    agentMode: toTextColumn(record.agentMode),
    skills: toJsonValue(record.skills, []),
    claimChecks: toJsonValue(record.claimChecks, []),
    agentObservability: toJsonValue(record.agentObservability, null),
    citations: toJsonValue(record.citations, []),
  };

  const extra = toExtra(record);

  return {
    record: { ...stored, ...extra },
    values: [
      stored.feedbackId,
      stored.userId,
      stored.workspaceId,
      stored.createdAt,
      stored.sessionId,
      stored.turnIndex === null ? null : String(stored.turnIndex),
      stored.question,
      JSON.stringify(stored.docIds),
      stored.feedbackType,
      stored.note,
      stored.answerText,
      stored.agentMode,
      JSON.stringify(stored.skills),
      JSON.stringify(stored.claimChecks),
      stored.agentObservability === null ? null : JSON.stringify(stored.agentObservability),
      JSON.stringify(stored.citations),
      JSON.stringify(extra),
    ],
  };
};

const toIsoText = (value) => {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

const jsonColumn = (value, fallback) => (value === undefined ? fallback : value);

// node-pg parses json columns itself, so a column that holds a JSON string
// arrives as that string and is not parsed again. Keys come in the order
// buildFeedbackRecord writes them, then an imported record's extras.
export const mapFeedbackRow = (row = {}) => ({
  feedbackId: row.feedback_id,
  createdAt: toIsoText(row.created_at),
  userId: row.owner_user_id ?? "",
  workspaceId: row.workspace_id ?? "",
  sessionId: row.session_id ?? "",
  turnIndex:
    row.turn_index === null || row.turn_index === undefined ? null : Number(row.turn_index),
  question: row.question ?? "",
  docIds: jsonColumn(row.doc_ids, []),
  feedbackType: row.feedback_type ?? "",
  note: row.note ?? "",
  answerText: row.answer_text ?? "",
  agentMode: row.agent_mode ?? "",
  skills: jsonColumn(row.skills, []),
  claimChecks: jsonColumn(row.claim_checks, []),
  agentObservability: jsonColumn(row.agent_observability, null),
  citations: jsonColumn(row.citations, []),
  ...(row.extra && typeof row.extra === "object" && !Array.isArray(row.extra) ? row.extra : {}),
});

const SELECT_COLUMNS = `
  feedback_id,
  owner_user_id,
  workspace_id,
  created_at,
  session_id,
  turn_index,
  question,
  doc_ids,
  feedback_type,
  note,
  answer_text,
  agent_mode,
  skills,
  claim_checks,
  agent_observability,
  citations,
  extra
`;

const buildInsertStatement = (feedbackTable, { ignoreExisting }) => `
  INSERT INTO ${feedbackTable} (
    feedback_id,
    owner_user_id,
    workspace_id,
    created_at,
    session_id,
    turn_index,
    question,
    doc_ids,
    feedback_type,
    note,
    answer_text,
    agent_mode,
    skills,
    claim_checks,
    agent_observability,
    citations,
    extra
  )
  VALUES (
    $1, $2, $3, $4::timestamptz, $5, $6::numeric, $7, $8::json, $9, $10, $11, $12,
    $13::json, $14::json, $15::json, $16::json, $17::json
  )${ignoreExisting ? "\n  ON CONFLICT (feedback_id) DO NOTHING" : ""}
`;

export const createPostgresFeedbackStore = ({
  now = () => Date.now(),
  query = queryPostgres,
  runMigrations = runPostgresMigrations,
  tableName = getFeedbackPostgresTable(),
} = {}) => {
  const feedbackTable = getFeedbackTableName(tableName);
  let initialized = false;

  const initialize = async () => {
    if (!initialized) {
      await runMigrations();
      initialized = true;
    }

    return true;
  };

  return {
    backend: "postgres",

    describe() {
      return { backend: "postgres", table: feedbackTable };
    },

    initialize,

    // The tenant erase and export (rag/tenant-records.js). The tenant role may
    // not delete feedback; the erase runs as the system, which migration 038
    // lets delete (035 gave it SELECT and INSERT only).
    ...createPostgresTenantRecordMethods({
      initialize,
      query,
      tables: () => [
        {
          keyColumns: ["id"],
          mapRow: mapFeedbackRow,
          name: "feedback",
          table: feedbackTable,
          userColumn: "owner_user_id",
          workspaceColumn: "workspace_id",
        },
      ],
    }),

    // A fresh feedbackId every time (buildFeedbackRecord), so a conflict is a
    // fault and fails the request rather than being skipped.
    async recordFeedback(feedback = {}) {
      await initialize();

      const { record, values } = buildStoredFeedback(feedback, { now });

      await query(buildInsertStatement(feedbackTable, { ignoreExisting: false }), values);

      return record;
    },

    async listFeedback({ accessScope = {}, limit = FEEDBACK_LIST_DEFAULT_LIMIT } = {}) {
      const scope = resolveFeedbackReadScope(accessScope);

      await initialize();

      const values = scope.mode === "tenant" ? [scope.userId, scope.workspaceId] : [];
      const where =
        scope.mode === "tenant" ? "WHERE owner_user_id = $1 AND workspace_id = $2" : "";

      values.push(normalizeFeedbackListLimit(limit));

      // Newest first; among equal timestamps the order they were written in,
      // as the stable sort over the file's lines gave.
      const result = await query(
        `
          SELECT ${SELECT_COLUMNS}
          FROM ${feedbackTable}
          ${where}
          ORDER BY created_at DESC, id ASC
          LIMIT $${values.length}
        `,
        values
      );

      return (result.rows ?? []).map(mapFeedbackRow);
    },

    // Every record the caller's database tenant may see, in the order written.
    // Called on the owner path (runAsDatabaseSystem) it is every tenant's.
    async listAllFeedback() {
      await initialize();

      const result = await query(
        `
          SELECT ${SELECT_COLUMNS}
          FROM ${feedbackTable}
          ORDER BY id ASC
        `
      );

      return (result.rows ?? []).map(mapFeedbackRow);
    },

    async countExistingFeedbackIds(feedbackIds = []) {
      await initialize();

      if (feedbackIds.length === 0) {
        return 0;
      }

      const result = await query(
        `
          SELECT COUNT(*)::int AS existing
          FROM ${feedbackTable}
          WHERE feedback_id = ANY($1::text[])
        `,
        [feedbackIds]
      );

      return Number(result.rows?.[0]?.existing ?? 0) || 0;
    },

    // The delete of a document under DOCUMENT_DELETE_REDACTION=on
    // (rag/document-deletion-cascade.js): every record of the caller's scope
    // (exactly its pair, or every record for a scope naming neither, as
    // listFeedback reads) whose citations serialize one of `needles` gets
    // `redactCitations(citations)`'s value written back, the citations column
    // only. On the system path: the tenant role may only read and append
    // feedback (migration 034), and migration 040 grants the system role
    // UPDATE on this one column, so the owner filter below is what keeps the
    // write to the caller's own records. Resolves to { redacted }.
    async redactDocumentReferences({ accessScope = {}, needles = [], redactCitations } = {}) {
      const values = (Array.isArray(needles) ? needles : []).map(String).filter(Boolean);

      if (values.length === 0 || typeof redactCitations !== "function") {
        return { redacted: 0 };
      }

      await initialize();

      const scope = resolveFeedbackReadScope(accessScope);
      const pageSize = 100;

      return runAsDatabaseSystem(async () => {
        let afterId = "0";
        let redacted = 0;

        for (;;) {
          const result = await query(
            `
              SELECT id, citations
              FROM ${feedbackTable}
              WHERE id > $1::bigint
                AND ($2::boolean = FALSE OR (owner_user_id = $3 AND workspace_id = $4))
                AND EXISTS (
                  SELECT 1
                  FROM unnest($5::text[]) AS needle(value)
                  WHERE strpos(citations::text, needle.value) > 0
                )
              ORDER BY id ASC
              LIMIT $6
            `,
            [afterId, scope.mode === "tenant", scope.userId, scope.workspaceId, values, pageSize]
          );
          const rows = result.rows ?? [];

          for (const row of rows) {
            const outcome = redactCitations(jsonColumn(row.citations, []));

            if (outcome?.changed) {
              await query(`UPDATE ${feedbackTable} SET citations = $2::json WHERE id = $1::bigint`, [
                String(row.id),
                JSON.stringify(outcome.value ?? []),
              ]);
              redacted += 1;
            }
          }

          if (rows.length < pageSize) {
            return { redacted };
          }

          afterId = String(rows.at(-1).id);
        }
      });
    },

    // npm run feedback:import: a record whose feedbackId is already stored is
    // left as it is, so an interrupted import can simply be run again.
    async importFeedback(records = []) {
      await initialize();

      let inserted = 0;

      for (const record of records) {
        const { values } = buildStoredFeedback(record, { now });
        const result = await query(
          buildInsertStatement(feedbackTable, { ignoreExisting: true }),
          values
        );

        inserted += Number(result.rowCount ?? 0) || 0;
      }

      return { alreadyPresent: records.length - inserted, inserted };
    },

    /**
     * Retention (rag/retention.js, FEEDBACK_RETENTION_DAYS): deletes at most
     * `limit` records of every tenant created before their workspace's
     * cutoff, oldest first. No row lock: no statement ever updates feedback,
     * and the system role holds no UPDATE on the table, which SELECT ... FOR
     * UPDATE would need; a row two sweeps both pick is deleted once. Under
     * the role split the system role needs DELETE, which migration 039
     * grants (no request may delete feedback: the tenant role still holds
     * SELECT and INSERT only). One statement, holding the table's advisory
     * try-lock while it runs. System work: the caller binds
     * runAsDatabaseSystem. Resolves to { acquired, deleted }.
     */
    async deleteExpired({ cutoff, limit, workspaceCutoffs = [] } = {}) {
      await initialize();

      const normalized = normalizeRetentionCutoffs({ cutoff, workspaceCutoffs });
      const result = await query(
        `
          WITH ${renderRetentionPreludeCtes({ lockKey: 1, workspaceCutoffs: 5, workspaceIds: 4 })},
          expired AS (
            SELECT f.id
            FROM ${feedbackTable} AS f
            LEFT JOIN retention_overrides AS o ON o.workspace_id = f.workspace_id
            WHERE (SELECT acquired FROM retention_lock)
              AND f.created_at < $3::timestamptz
              AND f.created_at < COALESCE(o.cutoff, $2::timestamptz)
            ORDER BY f.created_at ASC, f.id ASC
            LIMIT $6
          ),
          deleted_feedback AS (
            DELETE FROM ${feedbackTable} AS f
            USING expired AS x
            WHERE f.id = x.id
            RETURNING 1
          )
          SELECT
            (SELECT acquired FROM retention_lock) AS acquired,
            (SELECT COUNT(*) FROM deleted_feedback)::int AS deleted
        `,
        [
          buildRetentionLockKey(feedbackTable),
          normalized.cutoff,
          normalized.upperBound,
          normalized.workspaceIds,
          normalized.workspaceCutoffs,
          normalizeRetentionBatchLimit(limit),
        ]
      );
      const row = result.rows?.[0];

      return {
        acquired: readRetentionLockAcquired(row),
        deleted: Number(row?.deleted ?? 0) || 0,
      };
    },
  };
};
