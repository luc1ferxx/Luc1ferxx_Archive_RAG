import test from "node:test";
import assert from "node:assert/strict";

import {
  configureSessionMemoryStore,
  resolveQueryWithSessionMemory,
} from "../rag/memory.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";

// The v3 query-rewrite prompt ships a Chinese compare-mode example. It was once
// committed as UTF-8 bytes decoded as GBK (mojibake), which both reads as broken
// Chinese to the model and silently teaches it garbage. These tests pin two
// things: the rendered v3 prompt carries clean, correct Chinese with none of the
// old mojibake tokens, and a Chinese follow-up ("那第二个呢？") actually drives
// the rewrite path rather than falling back to the raw question.

const withEnv = async (overrides, callback) => {
  const originalValues = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

// The exact Chinese the v3 example is supposed to contain, and the exact
// mojibake tokens it must never contain again.
const EXPECTED_CHINESE = [
  "对比这两份文档的远程办公政策。",
  "两份文档都要求经理审批，但每周远程天数不同。",
  "那第二个呢？",
  "第二份文档的远程办公政策是什么？",
];
const FORBIDDEN_MOJIBAKE = [
  "瀵规瘮",
  "鏀跨瓥",
  "閭ｇ浜屼釜",
  "绗簩浠芥枃妗",
  "杩滅▼鍔炲叕",
];

const buildChineseCompareSession = () => ({
  updatedAt: Date.now(),
  messages: [
    {
      role: "user",
      text: "对比这两份文档的远程办公政策。",
      docLabels: ["plan-a.pdf", "plan-b.pdf"],
      routeMode: null,
      resolvedQuery: null,
    },
    {
      role: "assistant",
      text: "两份文档都要求经理审批，但每周远程天数不同。",
      docLabels: ["plan-a.pdf", "plan-b.pdf"],
      routeMode: "compare",
      resolvedQuery: null,
    },
  ],
});

const configureStaticSession = (session) => {
  configureSessionMemoryStore({
    async initialize() {
      return true;
    },
    async get() {
      return session;
    },
  });
};

test("the v3 rewrite prompt renders clean Chinese with no mojibake and drives the follow-up rewrite", async () => {
  await withEnv({ RAG_PROMPT_VERSION: "v3" }, async () => {
    configureStaticSession(buildChineseCompareSession());

    let capturedPrompt = null;
    configureOpenAIProvider({
      completeText: async (inputText) => {
        capturedPrompt = inputText;
        return JSON.stringify({
          rewritten_query: "第二份文档的远程办公政策是什么？",
          preserved_ambiguity: false,
        });
      },
    });

    try {
      const result = await resolveQueryWithSessionMemory({
        sessionId: "session-zh",
        query: "那第二个呢？",
        documents: [{ fileName: "plan-a.pdf" }, { fileName: "plan-b.pdf" }],
        longTermMemory: "",
      });

      assert.equal(result.memoryApplied, true);
      assert.equal(result.resolvedQuery, "第二份文档的远程办公政策是什么？");

      assert.ok(
        capturedPrompt,
        "the rewrite prompt should have reached the completion provider"
      );
      for (const expected of EXPECTED_CHINESE) {
        assert.ok(
          capturedPrompt.includes(expected),
          `rendered v3 prompt is missing expected Chinese: ${expected}`
        );
      }
      for (const forbidden of FORBIDDEN_MOJIBAKE) {
        assert.ok(
          !capturedPrompt.includes(forbidden),
          `rendered v3 prompt still contains mojibake: ${forbidden}`
        );
      }
    } finally {
      resetOpenAIProvider();
      configureSessionMemoryStore(null);
    }
  });
});

test("a Chinese pronoun follow-up is detected as a rewrite candidate", async () => {
  await withEnv({ RAG_PROMPT_VERSION: "v3" }, async () => {
    configureStaticSession(buildChineseCompareSession());

    let completionCalls = 0;
    configureOpenAIProvider({
      completeText: async () => {
        completionCalls += 1;
        return JSON.stringify({
          rewritten_query: "第一份文档的远程办公政策是什么？",
          preserved_ambiguity: false,
        });
      },
    });

    try {
      const result = await resolveQueryWithSessionMemory({
        sessionId: "session-zh",
        query: "那第一个呢？",
        documents: [{ fileName: "plan-a.pdf" }, { fileName: "plan-b.pdf" }],
      });

      assert.equal(completionCalls, 1);
      assert.equal(result.memoryApplied, true);
      assert.equal(result.resolvedQuery, "第一份文档的远程办公政策是什么？");
    } finally {
      resetOpenAIProvider();
      configureSessionMemoryStore(null);
    }
  });
});

test("a self-contained Chinese question with an active session is left untouched", async () => {
  await withEnv({ RAG_PROMPT_VERSION: "v3" }, async () => {
    configureStaticSession(buildChineseCompareSession());

    let completionCalls = 0;
    configureOpenAIProvider({
      completeText: async () => {
        completionCalls += 1;
        return JSON.stringify({ rewritten_query: "should not be used" });
      },
    });

    try {
      const query =
        "请详细说明第一份劳动合同里关于年度绩效奖金发放条件的具体规定和计算方式。";
      const result = await resolveQueryWithSessionMemory({
        sessionId: "session-zh",
        query,
        documents: [{ fileName: "plan-a.pdf" }, { fileName: "plan-b.pdf" }],
      });

      assert.equal(completionCalls, 0);
      assert.equal(result.memoryApplied, false);
      assert.equal(result.resolvedQuery, query);
    } finally {
      resetOpenAIProvider();
      configureSessionMemoryStore(null);
    }
  });
});
