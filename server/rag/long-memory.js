import { randomUUID } from "crypto";
import {
  getLongMemoryConfigStatus,
  getLongMemoryPostgresTable,
  isLongMemoryEnabled,
  isLongMemoryWorkspaceScoped,
} from "./config.js";
import { resolveConversationMemoryTenant } from "./conversation-memory-tenant.js";
import { resetPostgresMigrations, runPostgresMigrations } from "./db-migrations.js";
import {
  isPostgresConfigured,
  queryLongMemoryPostgres,
  resetLongMemoryPostgresPool,
} from "./postgres.js";
import { createPostgresTenantRecordMethods } from "./tenant-records.js";
import { extractMeaningfulTokens, normalizeWhitespace } from "./text-utils.js";

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const MAX_CONTEXT_ITEMS = 6;
const USER_NOTE_MIN_LENGTH = 4;
const PUBLIC_MEMORY_CATEGORIES = Object.freeze(["preference", "note"]);

// LONG_MEMORY_SCOPE=workspace (migration 045). A workspace is a tenant, and a
// user who belongs to two of them (a consultant serving two clients) must not
// have a note taken in one recalled into answers in the other. Under that
// scope every row carries the workspace it was written in, and a read in
// workspace W sees the user's rows of W plus the user's user-level rows
// (workspace_id ''); the tenant_isolation policy of migration 045 enforces the
// same rule in PostgreSQL.
//
// User-level rows are the preferences below and nothing else: each holds one
// value out of a fixed set and a fixed text (buildPreferenceMemoryText), so
// nothing a user said in one workspace reaches another through them. Notes,
// agent experience (whose text quotes request terms), any other category and
// a preference with another key or value carry free text and stay in their
// workspace. Rows written before the scope was turned on have workspace_id ''
// and so stay visible in every workspace until the user deletes or clears
// them.
//
// The personal scope (a user-only tenant: a user acting in no workspace) is a
// tenant of its own too. Its free text is stored with workspace_id '' and
// `personal` TRUE (migration 046), which no workspace reads: a read in W sees
// W's rows and the user-level rows that are not personal; a read in the
// personal scope sees the user-level rows and the personal ones. Without the
// flag such a note had the user-level marker and was recalled in every
// workspace, and a clear in any workspace deleted it.
//
// The workspace is the conversation memory tenant's
// (rag/conversation-memory-tenant.js, the derivation session memory keys on):
// the caller's access scope, else the active database tenant; '' when that
// tenant has no workspace (the personal scope), and also with auth off, where
// there is no tenant and every row stays user-level, not personal, as before.
// Under the default `user` scope none of this applies: the store calls, their
// SQL and the stored rows are those of before 045.
const USER_LEVEL_PREFERENCE_VALUES = new Map([
  ["reply_language", Object.freeze(["zh", "en"])],
  ["answer_style", Object.freeze(["concise", "detailed"])],
]);

// What a user-level preference row records as its origin, whoever wrote it.
const USER_LEVEL_PREFERENCE_SOURCE = "user_explicit";
const USER_LEVEL_PREFERENCE_CONFIDENCE = 1;

const isUserLevelPreference = ({ category, memoryKey, memoryValue } = {}) =>
  String(category ?? "").trim() === "preference" &&
  (USER_LEVEL_PREFERENCE_VALUES.get(String(memoryKey ?? "").trim())?.includes(
    String(memoryValue ?? "").trim()
  ) ??
    false);

/**
 * The workspace long-term memory reads and writes in for `accessScope` under
 * LONG_MEMORY_SCOPE=workspace ('' = user-level only), or null under the
 * default `user` scope, where memory is not partitioned by workspace.
 */
export const resolveLongMemoryWorkspace = (accessScope = null) =>
  isLongMemoryWorkspaceScoped()
    ? resolveConversationMemoryTenant(accessScope)?.workspaceId ?? ""
    : null;

// Whether a free-text write under LONG_MEMORY_SCOPE=workspace lands in the
// personal scope: a tenant that names no workspace. Auth off has no tenant,
// and its rows stay user-level as before.
const isPersonalScope = (accessScope) => {
  const tenant = resolveConversationMemoryTenant(accessScope);

  return tenant !== null && !tenant.workspaceId;
};

// The store arguments a workspace adds: nothing under the `user` scope, so a
// store sees exactly the calls it saw before LONG_MEMORY_SCOPE existed.
const withWorkspace = (input, workspaceId) =>
  workspaceId === null ? input : { ...input, workspaceId };

const isWorkspaceArgument = (workspaceId) => typeof workspaceId === "string";

const CHINESE_REPLY_PATTERNS = [
  /\u4ee5\u540e.*(?:\u7528\u4e2d\u6587|\u4e2d\u6587\u56de\u7b54)/i,
  /\u9ed8\u8ba4.*\u4e2d\u6587\u56de\u7b54/i,
  /\u8bf7.*\u4e2d\u6587\u56de\u7b54/i,
  /\u540e\u7eed.*\u4e2d\u6587\u56de\u7b54/i,
  /\u56de\u7b54.*\u4e2d\u6587/i,
  /\b(reply|answer)\b.*\bchinese\b/i,
];
const ENGLISH_REPLY_PATTERNS = [
  /\u4ee5\u540e.*(?:\u7528\u82f1\u6587|\u82f1\u6587\u56de\u7b54)/i,
  /\u9ed8\u8ba4.*\u82f1\u6587\u56de\u7b54/i,
  /\u8bf7.*\u82f1\u6587\u56de\u7b54/i,
  /\u540e\u7eed.*\u82f1\u6587\u56de\u7b54/i,
  /\u56de\u7b54.*\u82f1\u6587/i,
  /\b(reply|answer)\b.*\benglish\b/i,
];
const CONCISE_PATTERNS = [
  /\u4ee5\u540e.*(?:\u7b80\u77ed|\u7b80\u6d01)/i,
  /\u56de\u7b54.*(?:\u7b80\u77ed|\u7b80\u6d01)/i,
  /\u522b\u592a\u957f/i,
  /\u7cbe\u7b80\u4e00\u70b9/i,
  /\u7b80\u77ed\u4e00\u70b9/i,
  /\u7b80\u6d01\u4e00\u70b9/i,
  /\b(concise|brief|short)\b/i,
];
const DETAILED_PATTERNS = [
  /\u4ee5\u540e.*\u8be6\u7ec6/i,
  /\u56de\u7b54.*\u8be6\u7ec6/i,
  /\u5c55\u5f00\u4e00\u70b9/i,
  /\u8bf4\u7ec6\u4e00\u70b9/i,
  /\u8be6\u7ec6\u4e00\u70b9/i,
  /\u8bb2\u8be6\u7ec6\u4e00\u70b9/i,
  /\b(detailed|detail|verbose)\b/i,
];

let configuredLongMemoryStore = null;

export const createLongMemoryObservability = (status = getLongMemoryConfigStatus()) => ({
  enabled: Boolean(status.enabled),
  postgresConfigured: Boolean(status.postgresConfigured),
  reason: status.reason ?? null,
  status: status.enabled ? "ready" : "disabled",
});

const createDisabledContext = (status = getLongMemoryConfigStatus()) => ({
  memories: [],
  observability: createLongMemoryObservability(status),
  rewriteBlock: "",
  answerBlock: "",
});

const toIsoString = (value) => {
  if (!value) {
    return null;
  }

  const parsedValue = value instanceof Date ? value : new Date(value);

  return Number.isNaN(parsedValue.getTime()) ? null : parsedValue.toISOString();
};

const normalizeMemoryText = (value = "") =>
  normalizeWhitespace(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();

const ensureUserId = (userId) => String(userId ?? "").trim();

const ensureTableName = () => {
  const tableName = getLongMemoryPostgresTable();

  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `LONG_MEMORY_POSTGRES_TABLE must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  return tableName;
};

const mapRowToMemory = (row) => ({
  memoryId: String(row.memory_id),
  userId: String(row.user_id),
  category: String(row.category),
  memoryKey: row.memory_key ? String(row.memory_key) : null,
  memoryValue: row.memory_value ? String(row.memory_value) : null,
  text: String(row.text),
  source: String(row.source),
  confidence: Number(row.confidence ?? 1),
  createdAt: toIsoString(row.created_at),
  updatedAt: toIsoString(row.updated_at),
  lastUsedAt: toIsoString(row.last_used_at),
  // Only the workspace-scoped statements select the column, so a memory read
  // under the `user` scope keeps the shape it had before migration 045.
  ...(row.workspace_id === undefined ? {} : { workspaceId: String(row.workspace_id) }),
});

const MEMORY_COLUMNS = `memory_id, user_id, category, memory_key, memory_value, text, source,
          confidence, created_at, updated_at, last_used_at`;

// A read in workspace $n: the workspace's rows and the user-level rows that
// are not personal; in the personal scope ($n = '') every row of no
// workspace, the personal ones included (migration 046's policy).
const visibleInWorkspace = (placeholder) =>
  `(workspace_id = ${placeholder} OR (workspace_id = '' AND NOT personal))`;

const buildPreferenceMemoryText = (memoryKey, memoryValue) => {
  if (memoryKey === "reply_language" && memoryValue === "zh") {
    return "Reply in Chinese by default.";
  }

  if (memoryKey === "reply_language" && memoryValue === "en") {
    return "Reply in English by default.";
  }

  if (memoryKey === "answer_style" && memoryValue === "concise") {
    return "Keep answers concise by default.";
  }

  if (memoryKey === "answer_style" && memoryValue === "detailed") {
    return "Give more detailed answers by default.";
  }

  return "";
};

// remember() under LONG_MEMORY_SCOPE=workspace: the same dedupe and upsert,
// within the row's workspace and personal flag (a personal note never merges
// into a user-level row of the same text, nor the other way round). The
// tenant_isolation policy (migration 046) refuses a tenant's row for a
// workspace other than its own, and a personal row outside the personal
// scope.
const rememberInWorkspace = async ({
  category,
  confidence,
  memoryKey,
  memoryValue,
  personal,
  source,
  tableName,
  text,
  userId,
  workspaceId,
}) => {
  const existing = await queryLongMemoryPostgres(
    memoryKey
      ? `
          SELECT memory_id
          FROM ${tableName}
          WHERE user_id = $1
            AND category = $2
            AND memory_key = $3
            AND workspace_id = $4
            AND personal = $5
            AND archived = FALSE
          LIMIT 1
        `
      : `
          SELECT memory_id
          FROM ${tableName}
          WHERE user_id = $1
            AND category = $2
            AND text = $3
            AND workspace_id = $4
            AND personal = $5
            AND archived = FALSE
          LIMIT 1
        `,
    [userId, category, memoryKey ?? text, workspaceId, personal]
  );

  if (existing.rows[0]?.memory_id) {
    const updated = await queryLongMemoryPostgres(
      `
        UPDATE ${tableName}
        SET text = $2,
            memory_value = $3,
            source = $4,
            confidence = $5,
            archived = FALSE,
            updated_at = NOW()
        WHERE memory_id = $1 AND workspace_id = $6 AND personal = $7
        RETURNING ${MEMORY_COLUMNS}, workspace_id
      `,
      [String(existing.rows[0].memory_id), text, memoryValue, source, confidence, workspaceId, personal]
    );

    return updated.rows[0] ? mapRowToMemory(updated.rows[0]) : null;
  }

  const inserted = await queryLongMemoryPostgres(
    `
      INSERT INTO ${tableName} (
        memory_id,
        user_id,
        category,
        memory_key,
        memory_value,
        text,
        source,
        confidence,
        workspace_id,
        personal
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING ${MEMORY_COLUMNS}, workspace_id
    `,
    [randomUUID(), userId, category, memoryKey, memoryValue, text, source, confidence, workspaceId, personal]
  );

  return mapRowToMemory(inserted.rows[0]);
};

const createDefaultStore = () => ({
  async initialize() {
    if (!isLongMemoryEnabled()) {
      return false;
    }

    await runPostgresMigrations();
    return true;
  },

  // `workspaceId` (a string, LONG_MEMORY_SCOPE=workspace only): that
  // workspace's rows and the user-level rows. Absent: every row of the user.
  async list({
    userId,
    limit = DEFAULT_LIST_LIMIT,
    categories = PUBLIC_MEMORY_CATEGORIES,
    workspaceId,
  }) {
    const normalizedUserId = ensureUserId(userId);
    const normalizedCategories = Array.isArray(categories)
      ? [
          ...new Set(
            categories
              .map((category) => String(category ?? "").trim())
              .filter(Boolean)
          ),
        ]
      : PUBLIC_MEMORY_CATEGORIES;

    if (
      !isLongMemoryEnabled() ||
      !normalizedUserId ||
      normalizedCategories.length === 0
    ) {
      return [];
    }

    await this.initialize();

    const tableName = ensureTableName();
    const safeLimit = Math.max(
      1,
      Math.min(MAX_LIST_LIMIT, Number(limit) || DEFAULT_LIST_LIMIT)
    );

    if (isWorkspaceArgument(workspaceId)) {
      const scoped = await queryLongMemoryPostgres(
        `
          SELECT ${MEMORY_COLUMNS}, workspace_id
          FROM ${tableName}
          WHERE user_id = $1
            AND category = ANY($3::text[])
            AND archived = FALSE
            AND ${visibleInWorkspace("$4")}
          ORDER BY updated_at DESC
          LIMIT $2
        `,
        [normalizedUserId, safeLimit, normalizedCategories, workspaceId.trim()]
      );

      return scoped.rows.map(mapRowToMemory);
    }

    const result = await queryLongMemoryPostgres(
      `
        SELECT memory_id, user_id, category, memory_key, memory_value, text, source,
          confidence, created_at, updated_at, last_used_at
        FROM ${tableName}
        WHERE user_id = $1
          AND category = ANY($3::text[])
          AND archived = FALSE
        ORDER BY updated_at DESC
        LIMIT $2
      `,
      [normalizedUserId, safeLimit, normalizedCategories]
    );

    return result.rows.map(mapRowToMemory);
  },

  async remember({
    userId,
    category = "note",
    memoryKey = null,
    memoryValue = null,
    text,
    source = "user_explicit",
    confidence = 1,
    // A string under LONG_MEMORY_SCOPE=workspace only: the row's workspace
    // ('' = no workspace), decided by rememberLongMemory, with `personal`
    // (migration 046) true for a free-text row of the personal scope and
    // absent or false for a user-level row.
    workspaceId,
    personal = false,
  }) {
    const normalizedUserId = ensureUserId(userId);
    const normalizedText = normalizeMemoryText(text);
    const normalizedCategory = String(category ?? "note").trim() || "note";
    const normalizedKey = String(memoryKey ?? "").trim() || null;
    const normalizedValue = String(memoryValue ?? "").trim() || null;
    const normalizedSource =
      String(source ?? "user_explicit").trim() || "user_explicit";
    const normalizedConfidence = Number.isFinite(Number(confidence))
      ? Number(confidence)
      : 1;

    if (!isLongMemoryEnabled() || !normalizedUserId || !normalizedText) {
      return null;
    }

    await this.initialize();

    const tableName = ensureTableName();

    if (isWorkspaceArgument(workspaceId)) {
      const rowWorkspaceId = workspaceId.trim();

      return rememberInWorkspace({
        category: normalizedCategory,
        confidence: normalizedConfidence,
        memoryKey: normalizedKey,
        memoryValue: normalizedValue,
        // Only a row of no workspace can be personal (the table's check).
        personal: personal === true && rowWorkspaceId === "",
        source: normalizedSource,
        tableName,
        text: normalizedText,
        userId: normalizedUserId,
        workspaceId: rowWorkspaceId,
      });
    }

    const dedupeQuery = normalizedKey
      ? `
          SELECT memory_id
          FROM ${tableName}
          WHERE user_id = $1
            AND category = $2
            AND memory_key = $3
            AND archived = FALSE
          LIMIT 1
        `
      : `
          SELECT memory_id
          FROM ${tableName}
          WHERE user_id = $1
            AND category = $2
            AND text = $3
            AND archived = FALSE
          LIMIT 1
        `;
    const dedupeParams = normalizedKey
      ? [normalizedUserId, normalizedCategory, normalizedKey]
      : [normalizedUserId, normalizedCategory, normalizedText];
    const existing = await queryLongMemoryPostgres(dedupeQuery, dedupeParams);

    if (existing.rows[0]?.memory_id) {
      const updated = await queryLongMemoryPostgres(
        `
          UPDATE ${tableName}
          SET text = $2,
              memory_value = $3,
              source = $4,
              confidence = $5,
              archived = FALSE,
              updated_at = NOW()
          WHERE memory_id = $1
          RETURNING memory_id, user_id, category, memory_key, memory_value, text, source,
            confidence, created_at, updated_at, last_used_at
        `,
        [
          String(existing.rows[0].memory_id),
          normalizedText,
          normalizedValue,
          normalizedSource,
          normalizedConfidence,
        ]
      );

      return mapRowToMemory(updated.rows[0]);
    }

    const inserted = await queryLongMemoryPostgres(
      `
        INSERT INTO ${tableName} (
          memory_id,
          user_id,
          category,
          memory_key,
          memory_value,
          text,
          source,
          confidence
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING memory_id, user_id, category, memory_key, memory_value, text, source,
          confidence, created_at, updated_at, last_used_at
      `,
      [
        randomUUID(),
        normalizedUserId,
        normalizedCategory,
        normalizedKey,
        normalizedValue,
        normalizedText,
        normalizedSource,
        normalizedConfidence,
      ]
    );

    return mapRowToMemory(inserted.rows[0]);
  },

  // `workspaceId` as in list: only a memory that workspace sees.
  async delete({ userId, memoryId, workspaceId }) {
    const normalizedUserId = ensureUserId(userId);
    const normalizedMemoryId = String(memoryId ?? "").trim();

    if (!isLongMemoryEnabled() || !normalizedUserId || !normalizedMemoryId) {
      return null;
    }

    await this.initialize();

    const tableName = ensureTableName();

    if (isWorkspaceArgument(workspaceId)) {
      const scoped = await queryLongMemoryPostgres(
        `
          DELETE FROM ${tableName}
          WHERE user_id = $1 AND memory_id = $2 AND ${visibleInWorkspace("$3")}
          RETURNING ${MEMORY_COLUMNS}, workspace_id
        `,
        [normalizedUserId, normalizedMemoryId, workspaceId.trim()]
      );

      return scoped.rows[0] ? mapRowToMemory(scoped.rows[0]) : null;
    }

    const result = await queryLongMemoryPostgres(
      `
        DELETE FROM ${tableName}
        WHERE user_id = $1 AND memory_id = $2
        RETURNING memory_id, user_id, category, memory_key, memory_value, text, source,
          confidence, created_at, updated_at, last_used_at
      `,
      [normalizedUserId, normalizedMemoryId]
    );

    return result.rows[0] ? mapRowToMemory(result.rows[0]) : null;
  },

  // `workspaceId` as in list: everything that workspace sees, the user-level
  // rows (preferences, rows from before the scope) included.
  async clear({ userId, workspaceId }) {
    const normalizedUserId = ensureUserId(userId);

    if (!isLongMemoryEnabled() || !normalizedUserId) {
      return 0;
    }

    await this.initialize();

    const tableName = ensureTableName();

    if (isWorkspaceArgument(workspaceId)) {
      const scoped = await queryLongMemoryPostgres(
        `
          DELETE FROM ${tableName}
          WHERE user_id = $1 AND ${visibleInWorkspace("$2")}
        `,
        [normalizedUserId, workspaceId.trim()]
      );

      return Number(scoped.rowCount ?? 0);
    }

    const result = await queryLongMemoryPostgres(
      `
        DELETE FROM ${tableName}
        WHERE user_id = $1
      `,
      [normalizedUserId]
    );

    return Number(result.rowCount ?? 0);
  },

  async touch({ memoryIds }) {
    if (!isLongMemoryEnabled() || !Array.isArray(memoryIds) || memoryIds.length === 0) {
      return 0;
    }

    await this.initialize();

    const tableName = ensureTableName();
    const normalizedMemoryIds = [
      ...new Set(
        memoryIds.map((memoryId) => String(memoryId ?? "").trim()).filter(Boolean)
      ),
    ];

    if (normalizedMemoryIds.length === 0) {
      return 0;
    }

    const result = await queryLongMemoryPostgres(
      `
        UPDATE ${tableName}
        SET last_used_at = NOW()
        WHERE memory_id = ANY($1::text[])
      `,
      [normalizedMemoryIds]
    );

    return Number(result.rowCount ?? 0);
  },

  // The tenant erase and export (rag/tenant-records.js): every category and
  // archived row, whatever RAG_LONG_MEMORY_ENABLED says now (a memory written
  // while it was on is still the user's). Under LONG_MEMORY_SCOPE=user the
  // memory belongs to the user in every workspace, so a selector that names a
  // user takes every row of that user, and a workspace selector the rows that
  // carry the workspace (written while the scope was `workspace`; rows
  // written under `user` all have '', so it finds none of those). Under
  // `workspace` a row is matched on its (user, workspace_id) pair like every
  // other tenant table: a workspace selector takes the workspace's rows of
  // every user, a user in a workspace that pair's rows, and a user outside
  // any workspace that user's rows of no workspace (workspace_id '': the
  // user-level rows and the personal ones).
  ...createPostgresTenantRecordMethods({
    initialize: () => runPostgresMigrations(),
    query: queryLongMemoryPostgres,
    tables: () => [
      isLongMemoryWorkspaceScoped()
        ? {
            keyColumns: ["memory_id"],
            name: "long_memory",
            table: ensureTableName(),
            userColumn: "user_id",
          }
        : {
            keyColumns: ["memory_id"],
            name: "long_memory",
            table: ensureTableName(),
            userColumn: "user_id",
            userWide: true,
          },
    ],
  }),
});

const getLongMemoryStore = () => configuredLongMemoryStore ?? createDefaultStore();

/**
 * The long-term memory store the tenant erase and export use, as
 * getSessionMemoryTenantRecordStore in rag/memory.js: `not_configured` when
 * the default PostgreSQL store has no database, `unsupported` when a
 * configured store has no tenant record calls.
 */
export const getLongMemoryTenantRecordStore = () => {
  if (configuredLongMemoryStore) {
    return typeof configuredLongMemoryStore.countTenantRecords === "function"
      ? { status: "ok", store: configuredLongMemoryStore }
      : { status: "unsupported", store: null };
  }

  return isPostgresConfigured()
    ? { status: "ok", store: getLongMemoryStore() }
    : { status: "not_configured", store: null };
};

/**
 * Whether a tenant erase or export selector reaches long-term memory: every
 * selector in both scopes. Under LONG_MEMORY_SCOPE=user a workspace-wide one
 * finds only the rows that carry the workspace, written while the scope was
 * `workspace`; before, it skipped long memory, and members' notes of an
 * erased workspace survived a switch back to `user` (see the tenant record
 * methods of the default store).
 */
export const longMemoryAppliesToTenantSelector = (selector) => Boolean(selector);

const addCandidate = (candidates, candidate) => {
  if (!candidate?.text) {
    return;
  }

  const dedupeKey = [
    candidate.category ?? "note",
    candidate.memoryKey ?? "",
    normalizeMemoryText(candidate.text),
  ].join(":");

  if (candidates.some((entry) => entry.dedupeKey === dedupeKey)) {
    return;
  }

  candidates.push({
    ...candidate,
    dedupeKey,
  });
};

const matchesAnyPattern = (patterns, value) =>
  patterns.some((pattern) => pattern.test(value));

const extractMemoryCandidates = (query) => {
  const normalizedQuery = normalizeMemoryText(query);
  const candidates = [];

  if (!normalizedQuery) {
    return [];
  }

  if (matchesAnyPattern(CHINESE_REPLY_PATTERNS, normalizedQuery)) {
    addCandidate(candidates, {
      category: "preference",
      memoryKey: "reply_language",
      memoryValue: "zh",
      text: buildPreferenceMemoryText("reply_language", "zh"),
    });
  }

  if (matchesAnyPattern(ENGLISH_REPLY_PATTERNS, normalizedQuery)) {
    addCandidate(candidates, {
      category: "preference",
      memoryKey: "reply_language",
      memoryValue: "en",
      text: buildPreferenceMemoryText("reply_language", "en"),
    });
  }

  if (matchesAnyPattern(CONCISE_PATTERNS, normalizedQuery)) {
    addCandidate(candidates, {
      category: "preference",
      memoryKey: "answer_style",
      memoryValue: "concise",
      text: buildPreferenceMemoryText("answer_style", "concise"),
    });
  }

  if (matchesAnyPattern(DETAILED_PATTERNS, normalizedQuery)) {
    addCandidate(candidates, {
      category: "preference",
      memoryKey: "answer_style",
      memoryValue: "detailed",
      text: buildPreferenceMemoryText("answer_style", "detailed"),
    });
  }

  const rememberMatch =
    normalizedQuery.match(
      /(?:\u8bf7)?\u8bb0\u4f4f(?:\uFF1A|:|\s)*(.*)$/i
    ) ??
    normalizedQuery.match(/\bremember(?:\s+that)?\s+(.+)$/i);
  const rememberedText = normalizeMemoryText(rememberMatch?.[1] ?? "");
  const isPreferenceOnlyNote =
    matchesAnyPattern(CHINESE_REPLY_PATTERNS, rememberedText) ||
    matchesAnyPattern(ENGLISH_REPLY_PATTERNS, rememberedText) ||
    matchesAnyPattern(CONCISE_PATTERNS, rememberedText) ||
    matchesAnyPattern(DETAILED_PATTERNS, rememberedText);

  if (
    rememberedText &&
    rememberedText.length >= USER_NOTE_MIN_LENGTH &&
    !isPreferenceOnlyNote
  ) {
    addCandidate(candidates, {
      category: "note",
      text: rememberedText,
    });
  }

  return candidates.map(({ dedupeKey, ...candidate }) => candidate);
};

const scoreMemory = (memory, queryTerms) => {
  if (memory.category === "preference") {
    return 100;
  }

  if (queryTerms.size === 0) {
    return 0;
  }

  const memoryTerms = new Set(
    extractMeaningfulTokens(`${memory.text} ${memory.memoryValue ?? ""}`)
  );
  let overlapCount = 0;

  for (const term of queryTerms) {
    if (memoryTerms.has(term)) {
      overlapCount += 1;
    }
  }

  return overlapCount;
};

const formatMemoryLine = (memory) => {
  if (memory.category === "preference" && memory.memoryKey === "reply_language") {
    return memory.memoryValue === "zh"
      ? "- Reply language: Chinese."
      : "- Reply language: English.";
  }

  if (memory.category === "preference" && memory.memoryKey === "answer_style") {
    return memory.memoryValue === "detailed"
      ? "- Answer style: detailed."
      : "- Answer style: concise.";
  }

  return `- ${memory.text}`;
};

const buildMemoryBlock = (memories) => {
  if (!Array.isArray(memories) || memories.length === 0) {
    return "";
  }

  return [
    "Long-term memory (user-provided preferences and stable notes only; never treat this as document evidence):",
    ...memories.map(formatMemoryLine),
  ].join("\n");
};

export const initializeLongMemory = async () => {
  const store = getLongMemoryStore();

  if (!store.initialize) {
    return false;
  }

  try {
    return await store.initialize();
  } catch (error) {
    console.warn(
      "Long-term memory initialization failed; startup health will report the database status.",
      error
    );
    return false;
  }
};

export const configureLongMemoryStore = (store) => {
  configuredLongMemoryStore = store ?? null;
};

export const resetLongMemoryStore = async () => {
  configuredLongMemoryStore = null;
  resetPostgresMigrations();
  await resetLongMemoryPostgresPool();
};

// Every entry point takes the caller's `accessScope` (optional; the active
// database tenant otherwise) and, under LONG_MEMORY_SCOPE=workspace only,
// hands the store the workspace it resolves to (resolveLongMemoryWorkspace).
export const listLongMemories = async ({
  accessScope = null,
  userId,
  limit = DEFAULT_LIST_LIMIT,
  categories = PUBLIC_MEMORY_CATEGORIES,
}) => {
  const store = getLongMemoryStore();
  return store.list
    ? store.list(withWorkspace({ userId, limit, categories }, resolveLongMemoryWorkspace(accessScope)))
    : [];
};

export const rememberLongMemory = async ({ accessScope = null, ...input } = {}) => {
  const store = getLongMemoryStore();
  const workspaceId = resolveLongMemoryWorkspace(accessScope);

  if (!store.remember) {
    return null;
  }

  if (workspaceId === null) {
    return store.remember(input);
  }

  if (!isUserLevelPreference(input)) {
    // Free text stays in its workspace; in the personal scope (no workspace)
    // it is marked personal, so no workspace reads it (migration 046).
    return store.remember(
      workspaceId === "" && isPersonalScope(accessScope)
        ? { ...input, personal: true, workspaceId }
        : { ...input, workspaceId }
    );
  }

  // A user-level row is read in every workspace of the user, so it keeps only
  // the preference's fixed value, its fixed text and a fixed source and
  // confidence, never anything the caller wrote (POST /memory takes any text,
  // source and confidence).
  const memoryKey = String(input.memoryKey).trim();
  const memoryValue = String(input.memoryValue).trim();

  return store.remember({
    ...input,
    confidence: USER_LEVEL_PREFERENCE_CONFIDENCE,
    memoryKey,
    memoryValue,
    source: USER_LEVEL_PREFERENCE_SOURCE,
    text: buildPreferenceMemoryText(memoryKey, memoryValue),
    workspaceId: "",
  });
};

export const deleteLongMemory = async ({ accessScope = null, userId, memoryId }) => {
  const store = getLongMemoryStore();
  return store.delete
    ? store.delete(withWorkspace({ userId, memoryId }, resolveLongMemoryWorkspace(accessScope)))
    : null;
};

export const clearLongMemories = async ({ accessScope = null, userId }) => {
  const store = getLongMemoryStore();
  return store.clear
    ? store.clear(withWorkspace({ userId }, resolveLongMemoryWorkspace(accessScope)))
    : 0;
};

export const getLongMemoryContext = async ({ accessScope = null, userId, query }) => {
  const normalizedUserId = ensureUserId(userId);
  const configStatus = getLongMemoryConfigStatus();

  if (!configStatus.enabled || !normalizedUserId) {
    return createDisabledContext(
      !normalizedUserId && configStatus.enabled
        ? {
            ...configStatus,
            reason: "missing_user",
          }
        : configStatus
    );
  }

  const memories = await listLongMemories({
    accessScope,
    categories: PUBLIC_MEMORY_CATEGORIES,
    userId: normalizedUserId,
    limit: DEFAULT_LIST_LIMIT,
  });
  const queryTerms = new Set(extractMeaningfulTokens(query));
  const rankedMemories = memories
    .map((memory, index) => ({
      memory,
      index,
      score: scoreMemory(memory, queryTerms),
    }))
    .filter(({ score, memory }) => memory.category === "preference" || score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_CONTEXT_ITEMS)
    .map(({ memory }) => memory);
  const usedMemoryIds = rankedMemories
    .map((memory) => memory.memoryId)
    .filter(Boolean);

  if (usedMemoryIds.length > 0) {
    const store = getLongMemoryStore();

    if (store.touch) {
      await store.touch({
        memoryIds: usedMemoryIds,
      });
    }
  }

  return {
    memories: rankedMemories,
    observability: {
      ...createLongMemoryObservability(configStatus),
      applied: rankedMemories.length > 0,
      hitCount: rankedMemories.length,
    },
    rewriteBlock: buildMemoryBlock(rankedMemories),
    answerBlock: buildMemoryBlock(rankedMemories),
  };
};

export const recordLongMemoryFromUserMessage = async ({ accessScope = null, userId, query }) => {
  const normalizedUserId = ensureUserId(userId);

  if (!isLongMemoryEnabled() || !normalizedUserId) {
    return [];
  }

  const candidates = extractMemoryCandidates(query);

  if (candidates.length === 0) {
    return [];
  }

  const storedMemories = await Promise.all(
    candidates.map((candidate) =>
      rememberLongMemory({
        accessScope,
        userId: normalizedUserId,
        category: candidate.category,
        memoryKey: candidate.memoryKey ?? null,
        memoryValue: candidate.memoryValue ?? null,
        text: candidate.text,
        source: "user_explicit",
        confidence: 1,
      })
    )
  );

  return storedMemories.filter(Boolean);
};
