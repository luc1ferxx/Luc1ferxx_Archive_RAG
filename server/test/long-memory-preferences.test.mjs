import assert from "node:assert/strict";
import test from "node:test";

import {
  configureLongMemoryStore,
  recordLongMemoryFromUserMessage,
  resetLongMemoryStore,
} from "../rag/long-memory.js";

// Every user message passes through recordLongMemoryFromUserMessage, and a
// stored preference shapes every later answer, so only an explicit instruction
// about the reply may store one.

// The default store's remember() in memory: it looks the row up, then inserts
// it when absent, with a round trip in between, so two writes of one key sent
// together both insert.
const useStore = (t) => {
  const saved = {
    LONG_MEMORY_SCOPE: process.env.LONG_MEMORY_SCOPE,
    RAG_LONG_MEMORY_ENABLED: process.env.RAG_LONG_MEMORY_ENABLED,
  };
  const rows = [];

  process.env.RAG_LONG_MEMORY_ENABLED = "true";
  delete process.env.LONG_MEMORY_SCOPE;
  configureLongMemoryStore({
    async list({ userId }) {
      return rows.filter((row) => row.userId === userId);
    },
    async remember(input) {
      const existing = rows.find(
        (row) =>
          row.userId === input.userId &&
          row.category === input.category &&
          (input.memoryKey ? row.memoryKey === input.memoryKey : row.text === input.text)
      );

      await new Promise((resolve) => setImmediate(resolve));

      if (existing) {
        return Object.assign(existing, input);
      }

      rows.push({ ...input });
      return input;
    },
  });
  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    await resetLongMemoryStore();
  });

  return rows;
};

test("a document question that mentions a language or a length stores no preference", async (t) => {
  const rows = useStore(t);

  for (const query of [
    "What was the reply from the Chinese supplier about the delay?",
    "请回答这篇英文论文的主要结论是什么？",
    "What are the short-term borrowings?",
    "What details does section 4 give on the brief filed by the plaintiff?",
    "Give a detailed list of the short-term lease obligations",
  ]) {
    await recordLongMemoryFromUserMessage({ query, userId: "u1" });
  }

  assert.deepEqual(rows, []);
});

test("an explicit instruction about the reply stores the preference, in either language", async (t) => {
  const rows = useStore(t);

  for (const [query, memoryKey, memoryValue] of [
    ["以后用中文回答", "reply_language", "zh"],
    ["请用英文回答这个问题", "reply_language", "en"],
    ["Reply in Chinese from now on.", "reply_language", "zh"],
    ["Please answer in English.", "reply_language", "en"],
    ["Please keep answers concise.", "answer_style", "concise"],
    ["回答简短一点", "answer_style", "concise"],
    ["Be more detailed.", "answer_style", "detailed"],
    ["说细一点", "answer_style", "detailed"],
  ]) {
    await recordLongMemoryFromUserMessage({ query, userId: query });

    assert.deepEqual(
      rows
        .filter((row) => row.userId === query)
        .map((row) => [row.category, row.memoryKey, row.memoryValue, row.source]),
      [["preference", memoryKey, memoryValue, "user_explicit"]],
      query
    );
  }
});

test("a message that asks for both answer styles writes one row of that key", async (t) => {
  const rows = useStore(t);

  await recordLongMemoryFromUserMessage({
    query: "Keep answers short, but be more detailed about the numbers.",
    userId: "u1",
  });

  assert.equal(rows.filter((row) => row.memoryKey === "answer_style").length, 1);
});
