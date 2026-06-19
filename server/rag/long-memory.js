import { randomUUID } from "crypto";
import {
  getLongMemoryConfigStatus,
  getLongMemoryPostgresTable,
  isLongMemoryEnabled,
} from "./config.js";
import { resetPostgresMigrations, runPostgresMigrations } from "./db-migrations.js";
import {
  queryLongMemoryPostgres,
  resetLongMemoryPostgresPool,
} from "./postgres.js";
import { extractMeaningfulTokens, normalizeWhitespace } from "./text-utils.js";

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const MAX_CONTEXT_ITEMS = 6;
const USER_NOTE_MIN_LENGTH = 4;
const PUBLIC_MEMORY_CATEGORIES = Object.freeze(["preference", "note"]);

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
});

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

const createDefaultStore = () => ({
  async initialize() {
    if (!isLongMemoryEnabled()) {
      return false;
    }

    await runPostgresMigrations();
    return true;
  },

  async list({ userId, limit = DEFAULT_LIST_LIMIT, categories = PUBLIC_MEMORY_CATEGORIES }) {
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

  async delete({ userId, memoryId }) {
    const normalizedUserId = ensureUserId(userId);
    const normalizedMemoryId = String(memoryId ?? "").trim();

    if (!isLongMemoryEnabled() || !normalizedUserId || !normalizedMemoryId) {
      return null;
    }

    await this.initialize();

    const tableName = ensureTableName();
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

  async clear({ userId }) {
    const normalizedUserId = ensureUserId(userId);

    if (!isLongMemoryEnabled() || !normalizedUserId) {
      return 0;
    }

    await this.initialize();

    const tableName = ensureTableName();
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
});

const getLongMemoryStore = () => configuredLongMemoryStore ?? createDefaultStore();

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

export const listLongMemories = async ({
  userId,
  limit = DEFAULT_LIST_LIMIT,
  categories = PUBLIC_MEMORY_CATEGORIES,
}) => {
  const store = getLongMemoryStore();
  return store.list ? store.list({ userId, limit, categories }) : [];
};

export const rememberLongMemory = async (input) => {
  const store = getLongMemoryStore();
  return store.remember ? store.remember(input) : null;
};

export const deleteLongMemory = async ({ userId, memoryId }) => {
  const store = getLongMemoryStore();
  return store.delete ? store.delete({ userId, memoryId }) : null;
};

export const clearLongMemories = async ({ userId }) => {
  const store = getLongMemoryStore();
  return store.clear ? store.clear({ userId }) : 0;
};

export const getLongMemoryContext = async ({ userId, query }) => {
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

export const recordLongMemoryFromUserMessage = async ({ userId, query }) => {
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
