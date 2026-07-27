import {
  createChatPromptTemplate,
  createPromptTemplate,
} from "../lib/prompt-template.js";
import { completeText } from "./openai.js";
import {
  getPromptVersion,
  getSessionMemoryPostgresTable,
} from "./config.js";
import { runPostgresMigrations } from "./db-migrations.js";
import { queryPostgres } from "./postgres.js";
import { tokenize } from "./text-utils.js";

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RECENT_TURNS = 3;
const MAX_RECENT_MESSAGES = MAX_RECENT_TURNS * 2;
const MAX_MESSAGE_CHARS = 700;
const FOLLOW_UP_PATTERNS = [
  /\b(it|they|them|this|that|these|those|same|former|latter)\b/i,
  /^\s*(and|also|then|what about|how about|same for|and for|what else)\b/i,
  /(?:\u4e0a\u4e00|\u4e0a\u4e2a|\u8fd9\u4e2a|\u90a3\u4e2a|\u8fd9\u4efd|\u90a3\u4efd|\u5b83|\u5b83\u4eec|\u4ed6\u4eec|\u524d\u8005|\u540e\u8005|\u540c\u6837|\u7ee7\u7eed|\u90a3|\u518d|\u7b2c\u4e8c\u4e2a|\u7b2c\u4e00\u4e2a)/,
];
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000;
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

let configuredSessionMemoryStore = null;
let sessionMemoryInitialized = false;
let lastSessionCleanupAt = 0;

const rewritePromptV1 = createPromptTemplate(
  `You rewrite follow-up questions into standalone retrieval queries for a document-grounded RAG system.
Use the conversation only to resolve references, ellipsis, and document scope.
Use long-term memory only as user-provided preferences or stable notes, never as document evidence.
Do not add facts that were not already stated by the user or assistant.
Keep the rewritten question concise and in the same language as the user's latest question.
Return only the rewritten question with no explanation.

Active documents:
{documents}

Long-term memory:
{longTermMemory}

Recent conversation:
{recentConversation}

Latest user question:
{question}

Standalone retrieval question:`
);

const rewritePromptV2 = createChatPromptTemplate([
  [
    "system",
    `You rewrite follow-up questions into standalone retrieval queries for a document-grounded RAG system.
Follow these rules strictly:
- Use the conversation only to resolve references, ellipsis, and document scope.
- Use long-term memory only as user-provided preferences or stable notes, never as document evidence.
- Keep the rewritten question concise and in the same language as the user's latest question.
- Preserve ambiguity if the user was ambiguous.
- Do not add facts, constraints, dates, or policy details that were not already stated by the user or assistant.
- Return only the rewritten question with no explanation.`,
  ],
  [
    "human",
    `Active documents:
{documents}

Long-term memory:
{longTermMemory}

Recent conversation:
{recentConversation}

Latest user question:
{question}

Standalone retrieval question:`,
  ],
]);

const rewritePromptV3 = createChatPromptTemplate([
  [
    "system",
    `You rewrite follow-up questions into standalone retrieval queries for a document-grounded RAG system.
Follow these rules strictly:
- Use the conversation only to resolve references, ellipsis, and document scope.
- Use long-term memory only as user-provided preferences or stable notes, never as document evidence.
- Keep the rewritten question concise and in the same language as the user's latest question.
- Preserve ambiguity if the user was ambiguous.
- Do not add facts, constraints, dates, policy details, or comparisons that were not already stated by the user or assistant.
- Prefer concrete nouns from the recent conversation over pronouns when the referent is clear.
- Do not answer the question. Only rewrite it for retrieval.
- Return JSON only with this shape:
  {{"rewritten_query":"...","preserved_ambiguity":true|false}}`,
  ],
  [
    "human",
    `Active documents:
{documents}

Long-term memory:
{longTermMemory}

Recent conversation:
{recentConversation}

Latest user question:
{question}

Examples:
1.
Recent conversation:
User [docs: benefits-2025.pdf]: Tell me about remote work.
Assistant [docs: benefits-2025.pdf] [mode: qa]: Manager approval is required.
Latest user question:
And approval?
JSON:
{{"rewritten_query":"What is the remote work approval policy?","preserved_ambiguity":false}}

2.
Recent conversation:
User [docs: plan-a.pdf, plan-b.pdf]: 瀵规瘮杩欎袱浠芥枃妗ｇ殑杩滅▼鍔炲叕鏀跨瓥銆?
Assistant [docs: plan-a.pdf, plan-b.pdf] [mode: compare]: 涓や唤鏂囨。閮借姹傜粡鐞嗗鎵癸紝浣嗘瘡鍛ㄨ繙绋嬪ぉ鏁颁笉鍚屻€?
Latest user question:
閭ｇ浜屼釜鍛紵
JSON:
{{"rewritten_query":"绗簩浠芥枃妗ｇ殑杩滅▼鍔炲叕鏀跨瓥鏄粈涔堬紵","preserved_ambiguity":false}}

3.
Recent conversation:
User [docs: handbook.pdf]: Tell me about reimbursement and remote work.
Assistant [docs: handbook.pdf] [mode: qa]: The handbook covers both reimbursement and remote work.
Latest user question:
Which one is stricter?
JSON:
{{"rewritten_query":"Which one is stricter?","preserved_ambiguity":true}}

Now return JSON only.`,
  ],
]);

const ensureTableName = () => {
  const tableName = getSessionMemoryPostgresTable();

  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      `SESSION_MEMORY_POSTGRES_TABLE must be a simple PostgreSQL identifier. Received "${tableName}".`
    );
  }

  return tableName;
};

const formatRewritePrompt = async (values) => {
  const promptVersion = getPromptVersion();

  if (promptVersion === "v1") {
    return rewritePromptV1.format(values);
  }

  if (promptVersion === "v3") {
    return rewritePromptV3.invoke(values);
  }

  return rewritePromptV2.invoke(values);
};

const trimMemoryText = (value = "", maxLength = MAX_MESSAGE_CHARS) => {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
};

const normalizeSessionId = (sessionId) => String(sessionId ?? "").trim();

const sanitizeMessage = (message = {}) => {
  const role = message.role === "assistant" ? "assistant" : "user";
  const text = trimMemoryText(message.text ?? "", role === "user" ? 400 : MAX_MESSAGE_CHARS);
  const resolvedQuery = message.resolvedQuery
    ? trimMemoryText(message.resolvedQuery, 500)
    : null;
  const docLabels = Array.isArray(message.docLabels)
    ? message.docLabels
        .map((label) => trimMemoryText(label, 120))
        .filter(Boolean)
        .slice(0, 10)
    : [];
  const routeMode = message.routeMode ? String(message.routeMode).trim() : null;

  return {
    role,
    text,
    resolvedQuery,
    docLabels,
    routeMode,
  };
};

const sanitizeSessionMessages = (messages = []) =>
  (Array.isArray(messages) ? messages : [])
    .map((message) => sanitizeMessage(message))
    .filter((message) => message.text)
    .slice(-MAX_RECENT_MESSAGES);

const mapRowToSession = (row = {}) => ({
  updatedAt: new Date(row.updated_at ?? Date.now()).getTime(),
  messages: sanitizeSessionMessages(row.messages ?? []),
});

const shouldRunCleanup = () =>
  Date.now() - lastSessionCleanupAt >= SESSION_CLEANUP_INTERVAL_MS;

const createDefaultStore = () => ({
  async initialize() {
    await runPostgresMigrations();
    return true;
  },

  async cleanupExpired() {
    if (!shouldRunCleanup()) {
      return 0;
    }

    const tableName = ensureTableName();
    lastSessionCleanupAt = Date.now();
    const result = await queryPostgres(
      `
        DELETE FROM ${tableName}
        WHERE updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
      `,
      [SESSION_TTL_MS]
    );

    return Number(result.rowCount ?? 0);
  },

  async get(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);

    if (!normalizedSessionId) {
      return null;
    }

    await this.initialize();
    await this.cleanupExpired();

    const tableName = ensureTableName();
    const result = await queryPostgres(
      `
        SELECT session_id, updated_at, messages
        FROM ${tableName}
        WHERE session_id = $1
        LIMIT 1
      `,
      [normalizedSessionId]
    );

    return result.rows[0] ? mapRowToSession(result.rows[0]) : null;
  },

  async upsert({ sessionId, messages, updatedAt = Date.now() }) {
    const normalizedSessionId = normalizeSessionId(sessionId);

    if (!normalizedSessionId) {
      return null;
    }

    await this.initialize();
    await this.cleanupExpired();

    const tableName = ensureTableName();
    const sanitizedMessages = sanitizeSessionMessages(messages);
    const result = await queryPostgres(
      `
        INSERT INTO ${tableName} (session_id, updated_at, messages)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (session_id)
        DO UPDATE SET
          updated_at = EXCLUDED.updated_at,
          messages = EXCLUDED.messages
        RETURNING session_id, updated_at, messages
      `,
      [
        normalizedSessionId,
        new Date(updatedAt).toISOString(),
        JSON.stringify(sanitizedMessages),
      ]
    );

    return result.rows[0] ? mapRowToSession(result.rows[0]) : null;
  },

  async delete(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);

    if (!normalizedSessionId) {
      return false;
    }

    await this.initialize();
    const tableName = ensureTableName();
    const result = await queryPostgres(
      `
        DELETE FROM ${tableName}
        WHERE session_id = $1
      `,
      [normalizedSessionId]
    );

    return Number(result.rowCount ?? 0) > 0;
  },

  async clearAll() {
    await this.initialize();
    const tableName = ensureTableName();
    const result = await queryPostgres(`DELETE FROM ${tableName}`);
    return Number(result.rowCount ?? 0);
  },
});

const getSessionMemoryStore = () =>
  configuredSessionMemoryStore ?? createDefaultStore();

const initializeSessionMemoryStore = async () => {
  if (sessionMemoryInitialized) {
    return true;
  }

  const store = getSessionMemoryStore();

  if (store.initialize) {
    await store.initialize();
  }

  sessionMemoryInitialized = true;
  return true;
};

const getSession = async (sessionId) => {
  const normalizedSessionId = normalizeSessionId(sessionId);

  if (!normalizedSessionId) {
    return null;
  }

  await initializeSessionMemoryStore();
  const store = getSessionMemoryStore();
  return store.get ? store.get(normalizedSessionId) : null;
};

const formatRecentConversation = (messages) =>
  messages
    .map((message) => {
      const scope = message.docLabels?.length
        ? ` [docs: ${message.docLabels.join(", ")}]`
        : "";
      const route = message.routeMode ? ` [mode: ${message.routeMode}]` : "";
      const resolvedQuery =
        message.role === "user" && message.resolvedQuery
          ? `\nResolved retrieval question: ${message.resolvedQuery}`
          : "";

      return `${message.role === "assistant" ? "Assistant" : "User"}${scope}${route}: ${
        message.text
      }${resolvedQuery}`;
    })
    .join("\n\n");

const shouldRewriteQuestion = ({ query, session }) => {
  if (!session || session.messages.length === 0) {
    return false;
  }

  if (FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(query))) {
    return true;
  }

  return tokenize(query).length <= 5;
};

const sanitizeRewriteQueryText = (rewrittenQuery, fallbackQuery) => {
  const normalized = String(rewrittenQuery ?? "")
    .trim()
    .replace(/^(```(?:text)?|```)/gi, "")
    .replace(
      /^(standalone retrieval question|standalone question|rewritten question|question)\s*:\s*/i,
      ""
    )
    .trim();
  const finalQuery =
    normalized
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? "";

  if (!finalQuery || finalQuery.length > 500) {
    return fallbackQuery;
  }

  return finalQuery.replace(/^["'`]+|["'`]+$/g, "").trim() || fallbackQuery;
};

const parseRewriteJsonResponse = (rewrittenResponse) => {
  const normalized = String(rewrittenResponse ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const startIndex = normalized.indexOf("{");
  const endIndex = normalized.lastIndexOf("}");

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return null;
  }

  try {
    const parsed = JSON.parse(normalized.slice(startIndex, endIndex + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const sanitizeRewrittenQuery = (rewrittenResponse, fallbackQuery) => {
  const parsedResponse = parseRewriteJsonResponse(rewrittenResponse);

  if (parsedResponse) {
    if (parsedResponse.should_rewrite === false) {
      return fallbackQuery;
    }

    const structuredQuery =
      typeof parsedResponse.rewritten_query === "string"
        ? parsedResponse.rewritten_query
        : typeof parsedResponse.query === "string"
          ? parsedResponse.query
          : "";

    if (structuredQuery) {
      return sanitizeRewriteQueryText(structuredQuery, fallbackQuery);
    }
  }

  return sanitizeRewriteQueryText(rewrittenResponse, fallbackQuery);
};

export const initializeSessionMemory = async () => initializeSessionMemoryStore();

export const configureSessionMemoryStore = (store) => {
  configuredSessionMemoryStore = store ?? null;
  sessionMemoryInitialized = false;
  lastSessionCleanupAt = 0;
};

export const resolveQueryWithSessionMemory = async ({
  sessionId,
  query,
  documents,
  longTermMemory = "",
}) => {
  const session = await getSession(sessionId);

  if (!shouldRewriteQuestion({ query, session })) {
    return {
      resolvedQuery: query,
      memoryApplied: false,
    };
  }

  try {
    const prompt = await formatRewritePrompt({
      documents:
        documents.length > 0
          ? documents.map((document) => document.fileName).join(", ")
          : "No active documents",
      longTermMemory: longTermMemory || "No long-term memory",
      recentConversation: formatRecentConversation(
        session.messages.slice(-MAX_RECENT_MESSAGES)
      ),
      question: query,
    });
    const rewrittenQuery = sanitizeRewrittenQuery(
      await completeText(prompt),
      query
    );

    return {
      resolvedQuery: rewrittenQuery,
      memoryApplied: rewrittenQuery !== query,
    };
  } catch {
    return {
      resolvedQuery: query,
      memoryApplied: false,
    };
  }
};

export const recordSessionTurn = async ({
  sessionId,
  query,
  resolvedQuery,
  answer,
  documents,
  routeMode,
}) => {
  const normalizedSessionId = normalizeSessionId(sessionId);

  if (!normalizedSessionId) {
    return null;
  }

  await initializeSessionMemoryStore();
  const store = getSessionMemoryStore();
  const existingSession = store.get ? await store.get(normalizedSessionId) : null;
  const docLabels = documents.map((document) => document.fileName);
  const nextMessages = [
    ...(existingSession?.messages ?? []),
    {
      role: "user",
      text: trimMemoryText(query, 400),
      resolvedQuery:
        resolvedQuery && resolvedQuery !== query
          ? trimMemoryText(resolvedQuery, 500)
          : null,
      docLabels,
    },
    {
      role: "assistant",
      text: trimMemoryText(answer),
      docLabels,
      routeMode,
    },
  ].slice(-MAX_RECENT_MESSAGES);

  return store.upsert
    ? store.upsert({
        sessionId: normalizedSessionId,
        messages: nextMessages,
        updatedAt: Date.now(),
      })
    : null;
};

export const clearSessionMemory = async (sessionId) => {
  const normalizedSessionId = normalizeSessionId(sessionId);

  if (!normalizedSessionId) {
    return false;
  }

  await initializeSessionMemoryStore();
  const store = getSessionMemoryStore();
  return store.delete ? store.delete(normalizedSessionId) : false;
};

export const resetSessionMemory = () => {
  sessionMemoryInitialized = false;
  lastSessionCleanupAt = 0;
};

export const resetSessionMemoryStore = async () => {
  const store = configuredSessionMemoryStore;

  if (store?.reset) {
    await store.reset();
  }

  configuredSessionMemoryStore = null;
  resetSessionMemory();
};
