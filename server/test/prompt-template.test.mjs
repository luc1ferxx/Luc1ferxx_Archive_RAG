import test from "node:test";
import assert from "node:assert/strict";
import {
  createChatPromptTemplate,
  createPromptTemplate,
} from "../lib/prompt-template.js";
import {
  completeText,
  configureOpenAIProvider,
  resetOpenAIProvider,
} from "../rag/openai.js";

test("createPromptTemplate substitutes {var} placeholders", () => {
  const template = createPromptTemplate("Hello {name}, welcome to {place}.");
  const result = template.format({ name: "Alice", place: "Wonderland" });
  assert.equal(result, "Hello Alice, welcome to Wonderland.");
});

test("createPromptTemplate renders {{ as literal { and }} as literal }", () => {
  const template = createPromptTemplate(
    `Return JSON: {{"key": "{value}"}}`
  );
  const result = template.format({ value: "hello" });
  assert.equal(result, `Return JSON: {"key": "hello"}`);
});

test("createPromptTemplate throws on missing variable", () => {
  const template = createPromptTemplate("Hello {name}");
  assert.throws(
    () => template.format({}),
    /Missing value for variable "name"/
  );
});

test("createPromptTemplate handles empty values", () => {
  const template = createPromptTemplate("{a}{b}{c}");
  const result = template.format({ a: "", b: "x", c: "" });
  assert.equal(result, "x");
});

test("createChatPromptTemplate returns messages with role and rendered content", () => {
  const template = createChatPromptTemplate([
    ["system", "You are a {role}."],
    ["human", "Tell me about {topic}."],
  ]);
  const result = template.invoke({ role: "teacher", topic: "math" });
  assert.deepEqual(result, {
    messages: [
      { role: "system", content: "You are a teacher." },
      { role: "human", content: "Tell me about math." },
    ],
  });
});

test("createChatPromptTemplate handles {{ }} escapes in chat messages", () => {
  const template = createChatPromptTemplate([
    ["system", `Return JSON: {{"query":"{question}"}}`],
    ["human", "{question}"],
  ]);
  const result = template.invoke({ question: "What is life?" });
  assert.equal(
    result.messages[0].content,
    `Return JSON: {"query":"What is life?"}`
  );
  assert.equal(result.messages[1].content, "What is life?");
});

test("end-to-end: completeText with chat prompt template via custom provider", async () => {
  try {
    configureOpenAIProvider({
      completeText: async (inputText) => inputText,
    });

    const template = createChatPromptTemplate([
      ["system", "Use evidence from {source}."],
      ["human", "Answer: {question}"],
    ]);
    const prompt = template.invoke({
      source: "documents",
      question: "What is RAG?",
    });
    const result = await completeText(prompt);

    assert.match(result, /SYSTEM:\nUse evidence from documents\./);
    assert.match(result, /HUMAN:\nAnswer: What is RAG\?/);
  } finally {
    resetOpenAIProvider();
  }
});

test("end-to-end: completeText with string prompt via custom provider", async () => {
  try {
    configureOpenAIProvider({
      completeText: async (inputText) => inputText,
    });

    const template = createPromptTemplate("Question: {q}\nAnswer:");
    const prompt = template.format({ q: "Hello?" });
    const result = await completeText(prompt);

    assert.equal(result, "Question: Hello?\nAnswer:");
  } finally {
    resetOpenAIProvider();
  }
});
