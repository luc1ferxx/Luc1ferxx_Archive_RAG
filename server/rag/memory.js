import { ChatPromptTemplate, PromptTemplate } from "@langchain/core/prompts";
import { completeText } from "./openai.js";
import { getPromptVersion } from "./config.js";
import { tokenize } from "./text-utils.js";
import { getRagDataPath, readJsonFileSync, writeJsonFileSync } from "./storage.js";

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RECENT_TURNS = 3;
const MAX_RECENT_MESSAGES = MAX_RECENT_TURNS * 2;
const MAX_MESSAGE_CHARS = 700;
const FOLLOW_UP_PATTERNS = [
  /\b(it|they|them|this|that|these|those|same|former|latter)\b/i,
  /^\s*(and|also|then|what about|how about|same for|and for|what else)\b/i,
  /(?:\u4e0a\u4e00|\u4e0a\u4e2a|\u8fd9\u4e2a|\u90a3\u4e2a|\u8fd9\u4efd|\u90a3\u4efd|\u5b83|\u5b83\u4eec|\u4ed6\u4eec|\u524d\u8005|\u540e\u8005|\u540c\u6837|\u7ee7\u7eed|\u90a3|\u518d|\u7b2c\u4e8c\u4e2a|\u7b2c\u4e00\u4e2a)/,
];

const sessionMemoryPath = () => getRagDataPath("session-memory.json");

const loadSessionMemoryStore = () => {
  const storedSessions = readJsonFileSync(sessionMemoryPath(), []);
  const nextStore = new Map();

  for (const session of storedSessions) {
    const sessionId = String(session?.sessionId ?? "").trim();

    if (!sessionId) {
      continue;
    }

    nextStore.set(sessionId, {
      updatedAt: Number(session.updatedAt ?? Date.now()),
      messages: Array.isArray(session.messages) ? session.messages : [],
    });
  }

  return nextStore;
};

let sessionMemoryStore = loadSessionMemoryStore();

const persistSessionMemoryStore = () => {
  writeJsonFileSync(
    sessionMemoryPath(),
    [...sessionMemoryStore.entries()].map(([sessionId, session]) => ({
      sessionId,
      updatedAt: session.updatedAt,
      messages: session.messages,
    }))
  );
};

const rewritePromptV1 = PromptTemplate.fromTemplate(
  `You rewrite follow-up questions into standalone retrieval queries for a document-grounded RAG system.
Use the conversation only to resolve references, ellipsis, and document scope.
Do not add facts that were not already stated by the user or assistant.
Keep the rewritten question concise and in the same language as the user's latest question.
Return only the rewritten question with no explanation.

Active documents:
{documents}

Recent conversation:
{recentConversation}

Latest user question:
{question}

Standalone retrieval question:`
);

const rewritePromptV2 = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You rewrite follow-up questions into standalone retrieval queries for a document-grounded RAG system.
Follow these rules strictly:
- Use the conversation only to resolve references, ellipsis, and document scope.
- Keep the rewritten question concise and in the same language as the user's latest question.
- Preserve ambiguity if the user was ambiguous.
- Do not add facts, constraints, dates, or policy details that were not already stated by the user or assistant.
- Return only the rewritten question with no explanation.`,
  ],
  [
    "human",
    `Active documents:
{documents}

Recent conversation:
{recentConversation}

Latest user question:
{question}

Standalone retrieval question:`,
  ],
]);

const formatRewritePrompt = async (values) =>
  getPromptVersion() === "v1"
    ? rewritePromptV1.format(values)
    : rewritePromptV2.invoke(values);

const trimMemoryText = (value = "", maxLength = MAX_MESSAGE_CHARS) => {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
};

const cleanupExpiredSessions = () => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  let changed = false;

  for (const [sessionId, session] of sessionMemoryStore.entries()) {
    if ((session.updatedAt ?? 0) < cutoff) {
      sessionMemoryStore.delete(sessionId);
      changed = true;
    }
  }

  if (changed) {
    persistSessionMemoryStore();
  }
};

const getSession = (sessionId) => {
  if (!sessionId) {
    return null;
  }

  cleanupExpiredSessions();

  return sessionMemoryStore.get(sessionId) ?? null;
};

const getOrCreateSession = (sessionId) => {
  cleanupExpiredSessions();

  if (!sessionMemoryStore.has(sessionId)) {
    sessionMemoryStore.set(sessionId, {
      messages: [],
      updatedAt: Date.now(),
    });
    persistSessionMemoryStore();
  }

  return sessionMemoryStore.get(sessionId);
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

const sanitizeRewrittenQuery = (rewrittenQuery, fallbackQuery) => {
  const normalized = String(rewrittenQuery ?? "")
    .trim()
    .replace(/^(```(?:text)?|```)/gi, "")
    .replace(/^(standalone retrieval question|standalone question|rewritten question|question)\s*:\s*/i, "")
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

export const resolveQueryWithSessionMemory = async ({
  sessionId,
  query,
  documents,
}) => {
  const session = getSession(sessionId);

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

export const recordSessionTurn = ({
  sessionId,
  query,
  resolvedQuery,
  answer,
  documents,
  routeMode,
}) => {
  if (!sessionId) {
    return;
  }

  const session = getOrCreateSession(sessionId);
  const docLabels = documents.map((document) => document.fileName);

  session.messages.push({
    role: "user",
    text: trimMemoryText(query, 400),
    resolvedQuery:
      resolvedQuery && resolvedQuery !== query
        ? trimMemoryText(resolvedQuery, 500)
        : null,
    docLabels,
  });
  session.messages.push({
    role: "assistant",
    text: trimMemoryText(answer),
    docLabels,
    routeMode,
  });
  session.messages = session.messages.slice(-MAX_RECENT_MESSAGES);
  session.updatedAt = Date.now();
  persistSessionMemoryStore();
};

export const clearSessionMemory = (sessionId) => {
  if (!sessionId) {
    return false;
  }

  const deleted = sessionMemoryStore.delete(sessionId);

  if (deleted) {
    persistSessionMemoryStore();
  }

  return deleted;
};

export const resetSessionMemory = () => {
  sessionMemoryStore = loadSessionMemoryStore();
};
