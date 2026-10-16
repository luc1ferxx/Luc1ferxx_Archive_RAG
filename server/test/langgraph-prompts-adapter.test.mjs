// Must stay the first import: it clears the LangSmith tracing variables before
// any @langchain module can read them.
import "./langgraph-support/langsmith-off.mjs";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Equivalence bar for rag/langgraph/prompts.js, on the production templates
// themselves. answer-writer.js, memory.js and chat-mcp.js keep their templates
// module-private, so every import of lib/prompt-template.js is redirected to a
// stand-in that records each template the real constructors build
// (test/langgraph-adapters/). The hook must be registered before any project
// module loads, which is why everything below is imported dynamically.
const CAPTURE_URL = new URL("./langgraph-adapters/prompt-template-capture.mjs", import.meta.url).href;

register("./langgraph-adapters/prompt-template-capture-hooks.mjs", import.meta.url, {
  data: {
    capture: CAPTURE_URL,
    target: new URL("../lib/prompt-template.js", import.meta.url).href,
  },
});

const { capturedPromptTemplates } = await import(CAPTURE_URL);
// prompt-catalog.js imports every module that builds a template.
const { listPromptTemplates } = await import("../rag/prompt-catalog.js");
const PRODUCTION_TEMPLATES = Object.freeze([...capturedPromptTemplates]);

const { ChatPromptTemplate, PromptTemplate } = await import("@langchain/core/prompts");
const { AIMessage, ChatMessage, HumanMessage, SystemMessage } = await import(
  "@langchain/core/messages"
);
const { createChatPromptTemplate, createPromptTemplate } = await import("../lib/prompt-template.js");
const { LANGSMITH_TRACING_ENABLED_CODE, LANGSMITH_TRACING_VARIABLES } = await import(
  "../rag/langgraph/langsmith-guard.js"
);
const {
  PROMPT_ADAPTER_ERROR_CODES,
  describeLangChainPrompt,
  renderLangChainPrompt,
  toLangChainPromptTemplate,
  toPromptInput,
} = await import("../rag/langgraph/prompts.js");
const { LLMOPS_TRACE_TYPE } = await import("../rag/llmops-metrics.js");
const { completeTextWithMetadata, configureOpenAIProvider, resetOpenAIProvider } = await import(
  "../rag/openai.js"
);
const { toChatMessages } = await import("../rag/openai-client.js");
const { fingerprintPromptSource } = await import("../rag/prompt-registry.js");

// The template-backed entries of PINNED_PROMPT_TEMPLATES in
// test/prompt-registry.test.mjs, which owns the pins: a template edit fails
// that suite first, and this copy must follow it.
const PINNED_TEMPLATE_PROMPTS = Object.freeze({
  "comparison_answer@v1.1": "5cfc615314eb",
  "comparison_answer@v2.1": "2046647cec58",
  "guarded_comparison_answer@v1.1": "5a59976484cd",
  "guarded_comparison_answer@v2.1": "e5f60f0f5aba",
  "memory_query_rewrite@v1": "482c557f3448",
  "memory_query_rewrite@v2": "c695383ae9e3",
  "memory_query_rewrite@v3": "2dc8733dd00c",
  "qa_answer@v1.2": "b96d76d43661",
  "qa_answer@v1.3": "c57f90a838c7",
  "qa_answer@v2.2": "69647d5ad62c",
  "qa_answer@v2.3": "f13805dcc49f",
  "web_answer@v1.1": "26e8ffa6c6c4",
  "web_answer@v2.1": "9fb8253dfa4f",
});
// Built by functions from request data; they keep their builders.
const FUNCTION_BUILT_PROMPT_IDS = Object.freeze([
  "claim_judge",
  "dag_planner",
  "execution_planner",
  "intent_planner",
  "replanner",
  "unified_graph_planner",
]);
const TEMPLATE_VARIABLES = Object.freeze({
  comparison_answer: ["context", "diagnostics", "preferenceBlock", "questionBlock"],
  guarded_comparison_answer: ["context", "diagnostics", "preferenceBlock", "questionBlock"],
  memory_query_rewrite: ["documents", "longTermMemory", "question", "recentConversation"],
  qa_answer: ["context", "preferenceBlock", "questionBlock"],
  web_answer: ["question", "searchResults"],
});

const REALISTIC_VALUES = Object.freeze({
  context:
    "[Source 1] vendor-msa.pdf, page 2\nThe vendor requires 30 days written notice before renewal.",
  diagnostics: "High-similarity pairs without explicit conflicts: none\nDocuments without strong evidence: none",
  documents: "vendor-msa.pdf, vendor-sow.pdf",
  longTermMemory: "No long-term memory",
  preferenceBlock: "Long-term memory: none.",
  question: "What notice period does the vendor require?",
  questionBlock: "User Question:\nWhat notice period does the vendor require?",
  recentConversation: "User [docs: vendor-msa.pdf]: Tell me about renewal.",
  searchResults: "1. Vendor terms - https://example.com/terms\nNotice: 45 days.",
});

// Values that look like template syntax must come out verbatim, never be
// parsed again: braces, escapes, a variable's own name, JSON, and the
// replacement patterns String.prototype.replace would expand in a string.
const bracedValue = (name) =>
  `${name}: {question} {{context}} }} {{ {"rewritten_query":"x","preserved_ambiguity":true} } { {${name}} $& $1 $$ \\ 第二行\n  indented`;

const VALUE_SETS = Object.freeze([
  ["realistic", (names) => Object.fromEntries(names.map((name) => [name, REALISTIC_VALUES[name]]))],
  ["braces", (names) => Object.fromEntries(names.map((name) => [name, bracedValue(name)]))],
  ["empty", (names) => Object.fromEntries(names.map((name) => [name, ""]))],
]);

// createChatPromptTemplate returns { invoke, source }, createPromptTemplate { format, source }.
const isChatTemplate = (template) => typeof template.invoke === "function";
const renderInHouse = (template, values) =>
  isChatTemplate(template) ? template.invoke(values) : template.format(values);
const keyOf = ({ id, version }) => `${id}@${version}`;

const pairProductionTemplates = () => {
  const descriptors = listPromptTemplates();

  return PRODUCTION_TEMPLATES.map((template) => {
    const matches = descriptors.filter(
      (descriptor) => descriptor.fingerprint === fingerprintPromptSource(template.source)
    );

    assert.equal(matches.length, 1, "every captured template has exactly one descriptor");

    return { descriptor: matches[0], template };
  });
};

const withEnvironment = async (overrides, callback) => {
  const previous = new Map(
    Object.keys(overrides).map((name) => [
      name,
      Object.hasOwn(process.env, name) ? process.env[name] : undefined,
    ])
  );

  for (const [name, value] of Object.entries(overrides)) {
    process.env[name] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

// Timestamps and durations differ per call by design; everything else must not.
const maskClock = (event) => ({ ...event, latencyMs: "<masked>", timestamp: "<masked>" });

test("every template-backed production prompt is captured and keeps its pinned fingerprint", () => {
  const pairs = pairProductionTemplates();
  const pairedKeys = pairs.map(({ descriptor }) => keyOf(descriptor)).sort();

  assert.deepEqual(pairedKeys, Object.keys(PINNED_TEMPLATE_PROMPTS).sort());

  for (const { descriptor, template } of pairs) {
    assert.equal(descriptor.fingerprint, PINNED_TEMPLATE_PROMPTS[keyOf(descriptor)]);
    assert.equal(fingerprintPromptSource(template.source), descriptor.fingerprint);
  }

  const templateBacked = new Set(pairedKeys);
  const functionBuiltIds = listPromptTemplates()
    .filter((descriptor) => !templateBacked.has(keyOf(descriptor)))
    .map(({ id }) => id)
    .sort();

  assert.deepEqual(functionBuiltIds, [...FUNCTION_BUILT_PROMPT_IDS]);
});

test("a converted template keeps its descriptor: the fingerprint is the unrendered source's", () => {
  for (const { descriptor, template } of pairProductionTemplates()) {
    const langChainTemplate = toLangChainPromptTemplate(template);
    const key = keyOf(descriptor);

    assert.ok(
      langChainTemplate instanceof (isChatTemplate(template) ? ChatPromptTemplate : PromptTemplate),
      key
    );
    assert.deepEqual(
      [...langChainTemplate.inputVariables].sort(),
      TEMPLATE_VARIABLES[descriptor.id],
      key
    );

    for (const identified of [langChainTemplate, template]) {
      const described = describeLangChainPrompt({ descriptor, template: identified });

      assert.deepStrictEqual(described, {
        fingerprint: PINNED_TEMPLATE_PROMPTS[key],
        id: descriptor.id,
        version: descriptor.version,
      });
      assert.ok(Object.isFrozen(described));
    }
  }
});

for (const { descriptor, template } of pairProductionTemplates()) {
  test(`${keyOf(descriptor)}: LangChain renders exactly what the in-house template renders`, async () => {
    const langChainTemplate = toLangChainPromptTemplate(template);
    const variables = TEMPLATE_VARIABLES[descriptor.id];

    for (const [label, buildValues] of VALUE_SETS) {
      const values = buildValues(variables);
      const expected = renderInHouse(template, values);
      const rendered = await renderLangChainPrompt(langChainTemplate, values);

      assert.deepStrictEqual(rendered, expected, label);
      // Straight through LangChain's own entry points, for string values.
      assert.deepStrictEqual(toPromptInput(await langChainTemplate.invoke(values)), expected, label);

      if (isChatTemplate(template)) {
        const messages = await langChainTemplate.formatMessages(values);

        assert.deepStrictEqual(toPromptInput(messages), expected, label);
        assert.deepEqual(
          messages.map((message) => message.constructor),
          expected.messages.map(({ role }) => (role === "system" ? SystemMessage : HumanMessage)),
          label
        );
      } else {
        assert.equal(await langChainTemplate.format(values), expected, label);
      }

      // The messages the OpenAI-compatible client sends (openai-client.js).
      assert.deepStrictEqual(toChatMessages(rendered), toChatMessages(expected), label);
    }
  });
}

test("the rendered prompt reaches completeTextWithMetadata identically", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "langgraph-prompts-"));
  const eventsPath = path.join(tempRoot, "rag-events.jsonl");
  const providerCalls = [];
  const readLlmOpsEvents = () =>
    readFileSync(eventsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.traceType === LLMOPS_TRACE_TYPE);

  try {
    await withEnvironment(
      { RAG_OBSERVABILITY_ENABLED: "true", RAG_OBSERVABILITY_EVENTS_PATH: eventsPath },
      async () => {
        configureOpenAIProvider({
          completeText: async (inputText, options) => {
            providerCalls.push({ inputText, options });
            return "The vendor requires 30 days written notice. [Source 1]";
          },
        });

        for (const { descriptor, template } of pairProductionTemplates()) {
          const key = keyOf(descriptor);
          const values = Object.fromEntries(
            TEMPLATE_VARIABLES[descriptor.id].map((name) => [name, bracedValue(name)])
          );
          const langChainTemplate = toLangChainPromptTemplate(template);

          providerCalls.length = 0;
          writeFileSync(eventsPath, "", "utf8");
          const expected = await completeTextWithMetadata(renderInHouse(template, values), {
            promptTemplate: descriptor,
          });
          const expectedEvents = readLlmOpsEvents();

          writeFileSync(eventsPath, "", "utf8");
          const actual = await completeTextWithMetadata(
            await renderLangChainPrompt(langChainTemplate, values),
            { promptTemplate: describeLangChainPrompt({ descriptor, template: langChainTemplate }) }
          );
          const actualEvents = readLlmOpsEvents();

          assert.deepStrictEqual(actual, expected, key);
          assert.equal(providerCalls.length, 2, key);
          assert.deepStrictEqual(providerCalls[1], providerCalls[0], key);
          assert.equal(expectedEvents.length, 1, key);
          assert.deepStrictEqual(actualEvents.map(maskClock), expectedEvents.map(maskClock), key);
          assert.deepStrictEqual(actualEvents[0].promptTemplate, { ...descriptor }, key);
          // The metric names the template; it never carries the prompt itself.
          assert.equal(JSON.stringify(actualEvents).includes("第二行"), false, key);
        }
      }
    );
  } finally {
    resetOpenAIProvider();
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("a non-string value renders as the in-house formatter renders it", async () => {
  const template = createChatPromptTemplate([
    ["system", "Count {count}, flags {flags}, scope {scope}."],
    ["human", "Missing {nothing}, unset {unset}."],
  ]);
  const values = { count: 5, flags: ["a", "b"], nothing: null, scope: { userId: "u" }, unset: undefined };
  const langChainTemplate = toLangChainPromptTemplate(template);

  assert.deepStrictEqual(await renderLangChainPrompt(langChainTemplate, values), template.invoke(values));
  // LangChain alone would JSON-encode them, which is why rendering goes
  // through renderLangChainPrompt.
  assert.notDeepStrictEqual(
    toPromptInput(await langChainTemplate.invoke(values)),
    template.invoke(values)
  );
});

test("a missing value fails both renders without echoing the other values", async () => {
  const secret = "CONFIDENTIAL evidence text";
  const template = createPromptTemplate("Question: {question}\nEvidence: {context}");
  const langChainTemplate = toLangChainPromptTemplate(template);

  assert.throws(() => template.format({ context: secret }), /Missing value for variable "question"/);
  await assert.rejects(renderLangChainPrompt(langChainTemplate, { context: secret }), (error) => {
    assert.match(error.message, /question/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

// The edge-case sources below use no variable or only "b"; ours renders them
// as text with whatever value is given.
const renderInHouseLeniently = (template) => template.format({ b: "value" });

test("a template LangChain would render differently is refused at conversion", async () => {
  for (const source of [
    "Single closing } brace",
    "Empty {} braces",
    "Unclosed { brace",
    "Nested {a{b} braces",
  ]) {
    const template = createPromptTemplate(source);

    // Not a broken in-house template: ours renders the edge case as text.
    assert.equal(typeof renderInHouseLeniently(template), "string", source);
    assert.throws(
      () => toLangChainPromptTemplate(template),
      (error) => {
        assert.equal(error.code, PROMPT_ADAPTER_ERROR_CODES.templateNotRepresentable, source);
        assert.equal(error.message.includes(source), false);
        return true;
      }
    );
  }

  for (const role of ["ai", "user", "assistant", "developer", "placeholder"]) {
    assert.throws(
      () => toLangChainPromptTemplate(createChatPromptTemplate([[role, "Hello {name}"]])),
      (error) => error.code === PROMPT_ADAPTER_ERROR_CODES.templateUnsupported,
      role
    );
  }

  for (const notTemplate of [null, "Hello {name}", {}, PromptTemplate.fromTemplate("Hello {name}")]) {
    assert.throws(
      () => toLangChainPromptTemplate(notTemplate),
      (error) => error.code === PROMPT_ADAPTER_ERROR_CODES.templateUnsupported
    );
  }
});

test("identity is checked against the in-house source, never LangChain's own template", async () => {
  const [first, second] = pairProductionTemplates();
  const langChainTemplate = toLangChainPromptTemplate(first.template);

  assert.throws(
    () => describeLangChainPrompt({ descriptor: second.descriptor, template: langChainTemplate }),
    (error) => {
      assert.equal(error.code, PROMPT_ADAPTER_ERROR_CODES.fingerprintMismatch);
      assert.equal(error.message.includes(first.template.source.slice(0, 40)), false);
      return true;
    }
  );
  assert.throws(
    () => describeLangChainPrompt({ descriptor: { id: "qa_answer" }, template: langChainTemplate }),
    (error) => error.code === PROMPT_ADAPTER_ERROR_CODES.descriptorInvalid
  );

  // A LangChain template built elsewhere from the same text carries no
  // in-house source, so it cannot be identified or rendered here.
  const foreign = isChatTemplate(first.template)
    ? ChatPromptTemplate.fromMessages(langChainTemplate.promptMessages)
    : PromptTemplate.fromTemplate(first.template.source);

  assert.throws(
    () => describeLangChainPrompt({ descriptor: first.descriptor, template: foreign }),
    (error) => error.code === PROMPT_ADAPTER_ERROR_CODES.sourceUnknown
  );
  await assert.rejects(
    renderLangChainPrompt(foreign, {}),
    (error) => error.code === PROMPT_ADAPTER_ERROR_CODES.sourceUnknown
  );
});

test("LangChain output without an exact in-house shape is refused", () => {
  for (const rendered of [
    [new AIMessage("Hello")],
    [new ChatMessage({ content: "Hello", role: "user" })],
    [new HumanMessage({ content: [{ text: "Hello", type: "text" }] })],
    [{ content: "Hello", role: "human" }],
    { messages: "Hello" },
    42,
  ]) {
    assert.throws(
      () => toPromptInput(rendered),
      (error) => error.code === PROMPT_ADAPTER_ERROR_CODES.outputUnsupported
    );
  }
});

test("a chat template's messages are recovered from the in-house template, which stays { invoke, source }", async () => {
  const messages = [
    ["system", "{lead}Rules {{json}} and }} for {topic}.\n\nhuman:\nnot a message {topic}{question}"],
    ["human", "{question}\n\n{{\"answer\":\"{topic}\"}}"],
  ];
  const template = createChatPromptTemplate(messages);

  // lib/prompt-template.js is not widened for the adapter: nothing on the
  // unrendered template looks like a rendered prompt's `messages`.
  assert.deepEqual(Object.keys(template).sort(), ["invoke", "source"]);

  const langChainTemplate = toLangChainPromptTemplate(template);

  // Each message's template text comes back exactly, including a message
  // whose text contains what `source` uses as a message separator.
  assert.deepStrictEqual(
    langChainTemplate.promptMessages.map((message) => message.prompt.template),
    messages.map(([, text]) => text)
  );
  assert.deepEqual([...langChainTemplate.inputVariables].sort(), ["lead", "question", "topic"]);

  for (const values of [
    { lead: "", question: "Q?", topic: "T" },
    { lead: "{topic}", question: "{{x}} $& }", topic: "{lead}" },
  ]) {
    assert.deepStrictEqual(await renderLangChainPrompt(langChainTemplate, values), template.invoke(values));
  }
});

test("a chat template holding the recovery markers itself is refused, never mis-rendered", () => {
  // Rendered, the literal "\u00000\u0000" looks like the marker of the first
  // variable; the check with other markers sees the difference.
  const template = createChatPromptTemplate([["human", "Literal \u00000\u0000 then {topic}."]]);

  assert.throws(
    () => toLangChainPromptTemplate(template),
    (error) => error.code === PROMPT_ADAPTER_ERROR_CODES.templateNotRepresentable
  );
});

test("LangSmith tracing refuses conversion and rendering", async () => {
  const [{ template }] = pairProductionTemplates();
  const langChainTemplate = toLangChainPromptTemplate(template);
  const values = Object.fromEntries(langChainTemplate.inputVariables.map((name) => [name, "v"]));
  const isRefusal = (error) => error.code === LANGSMITH_TRACING_ENABLED_CODE;

  for (const name of LANGSMITH_TRACING_VARIABLES) {
    await withEnvironment({ [name]: "true" }, async () => {
      assert.throws(() => toLangChainPromptTemplate(template), isRefusal, name);
      await assert.rejects(renderLangChainPrompt(langChainTemplate, values), isRefusal, name);
    });
    assert.equal(Object.hasOwn(process.env, name), false, `${name} restored`);
  }

  // And both work again once the variable is gone.
  assert.deepStrictEqual(
    await renderLangChainPrompt(toLangChainPromptTemplate(template), values),
    renderInHouse(template, values)
  );
});
