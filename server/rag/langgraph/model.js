// A LangChain chat model over completeTextWithMetadata (docs/adr/0001-langgraph-
// runtime.md, phase 1). It translates, it does not reimplement: every call goes
// through rag/openai.js exactly as a direct caller's would, so the retries,
// backoff, circuit breaker, concurrency cap, failover, model gateway, LLMOps
// metering, run-usage charging and request deadline all stay in one place.
//
// LangChain brings machinery of its own that would stack on top of ours, so
// this class switches it off rather than tuning it:
//   - AsyncCaller: maxRetries 0 and no maxConcurrency, and _generate never calls
//     this.caller. A second retry layer would multiply openai.js's attempts (a
//     down model would get 4 x 7 requests instead of 4), and a queued call would
//     start in whichever request's AsyncLocalStorage context drained the queue,
//     charging the wrong run and reading the wrong tenant and deadline.
//   - cache: LangChain's `cache: true` is a process-wide InMemoryCache keyed by
//     prompt text, which would answer one tenant from another tenant's call.
//   - verbose: prints prompts and replies to the console.
//   - token callbacks: _generate never calls runManager.handleLLMNewToken, so
//     raw answer tokens do not reach LangChain handlers one by one; the
//     caller's own onTextDelta still gets them, as it would from a direct
//     call. LangGraph's "messages" stream mode would still emit the finished
//     reply from handleLLMEnd, which is why constraint 4 keeps that mode off.
//   - withStructuredOutput: core's default turns the schema into a tool call,
//     silently ignores method "jsonSchema" and throws on strict. Ours sends the
//     strict response_format the planners already send.
//   - the abort signal: core copies RunnableConfig.signal into the call
//     options (an explicit signal, a `timeout` turned into one, or, inside
//     LangGraph, the run's own signal, which LangGraph aborts when a sibling
//     task fails). It is not passed on, as the tool adapter does not pass it
//     (tools.js): the ADR's drain decision keeps cancellation on the request
//     deadline, which openai.js already reads from AsyncLocalStorage
//     (withRequestSignal). Passed on, a sibling's failure aborted this call
//     mid-flight, and a LangChain `timeout` (an abort named TimeoutError)
//     reached the circuit breaker as an unavailable model: five short
//     timeouts opened the circuit for every tenant of the process, and a
//     sibling's AbortError closed a half-open circuit unanswered. A `timeout`
//     call option is refused, since it would otherwise do nothing.
//
// Nothing here puts question, prompt, document or reply text into an error;
// the LLMOps event carries the prompt's {id, version, fingerprint} only, as
// openai.js records it.
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { StringPromptValue } from "@langchain/core/prompt_values";
import { Runnable } from "@langchain/core/runnables";
import { isStandardSchema } from "@langchain/core/utils/standard_schema";
import { isInteropZodSchema } from "@langchain/core/utils/types";

import { completeTextWithMetadata } from "../openai.js";
import { buildJsonSchemaResponseFormat, parseFirstJsonValue } from "../structured-output.js";
import { assertLangSmithTracingDisabled, guardRunnableEntryPoints } from "./langsmith-guard.js";

export const ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES = Object.freeze({
  config: "ARCHIVE_RAG_CHAT_MODEL_CONFIG",
  structuredOutputConfig: "ARCHIVE_RAG_STRUCTURED_OUTPUT_CONFIG",
  structuredOutputParse: "ARCHIVE_RAG_STRUCTURED_OUTPUT_PARSE_FAILED",
  unsupportedMessage: "ARCHIVE_RAG_CHAT_MODEL_UNSUPPORTED_MESSAGE",
  unsupportedOption: "ARCHIVE_RAG_CHAT_MODEL_UNSUPPORTED_OPTION",
});

// The call options completeTextWithMetadata understands, on top of core's.
export const ARCHIVE_RAG_CHAT_MODEL_CALL_KEYS = Object.freeze([
  "onAttemptStart",
  "onTextDelta",
  "promptTemplate",
  "responseFormat",
  "temperature",
]);

// The OpenAI limit on a json_schema name; LangChain's default "extract" is not
// used, because a structured call without a deliberate name is a mistake.
const SCHEMA_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Message types are LangChain class identifiers, never caller text, but an
// unexpected value is still not echoed unless it looks like one.
const MESSAGE_TYPE_PATTERN = /^[a-z_]{1,32}$/;

const createAdapterError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const describeMessageType = (type) =>
  MESSAGE_TYPE_PATTERN.test(String(type ?? "")) ? `"${type}"` : "an unknown type";

// The HumanMessage LangChain made from a plain string prompt (StringPromptValue).
// Our planners pass strings, and completeTextWithMetadata sends a string as is,
// while a message list is rendered with role headers ("HUMAN:\n..."). That
// rendering is the custom provider's input and the inputCharacters every LLMOps
// estimate is computed from, so a string must reach openai.js as the same
// string. The marker is set in generatePrompt, where the prompt value's kind is
// still visible, and read in _generate; it lives only as long as the message.
const stringPromptMessages = new WeakSet();

// The role names our templates use (lib/prompt-template.js callers write
// ["system", ...] and ["human", ...]). Both survive LangChain's coercion as the
// same message types, so the round trip is exact. Everything else is refused:
// openai-client.js would send an AI or tool message as role "user", and a
// developer message as "user" too, which no direct caller does.
const ROLE_BY_MESSAGE_TYPE = Object.freeze({ human: "human", system: "system" });

const getMessageType = (message) =>
  typeof message?.getType === "function" ? message.getType() : message?._getType?.();

const toPromptMessage = (message) => {
  const type = getMessageType(message);
  const role = Object.hasOwn(ROLE_BY_MESSAGE_TYPE, type) ? ROLE_BY_MESSAGE_TYPE[type] : null;

  if (!role || message.additional_kwargs?.__openai_role__ !== undefined) {
    throw createAdapterError(
      ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.unsupportedMessage,
      `ArchiveRagChatModel sends system and human messages only; got ${describeMessageType(type)}.`
    );
  }

  // Content blocks would be forwarded to the API unchanged by one path and
  // flattened to text by the other; no direct caller sends them.
  if (typeof message.content !== "string") {
    throw createAdapterError(
      ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.unsupportedMessage,
      "ArchiveRagChatModel sends string message content only."
    );
  }

  return { content: message.content, role };
};

// The prompt in the shape a direct caller passes: the original string, or
// { messages: [{ role, content }] } as createChatPromptTemplate(...).invoke()
// returns it.
const toArchiveRagPrompt = (messages) => {
  if (messages.length === 1 && stringPromptMessages.has(messages[0])) {
    return messages[0].content;
  }

  return { messages: messages.map(toPromptMessage) };
};

// The plain object createChatPromptTemplate(...).invoke() returns. Class
// instances (a LangChain ChatPromptValue also has `messages`) are left to
// LangChain's own input handling.
const isArchiveRagChatPrompt = (input) => {
  const prototype = input && typeof input === "object" ? Object.getPrototypeOf(input) : undefined;

  return (prototype === Object.prototype || prototype === null) && Array.isArray(input.messages);
};

// A per-call `timeout` becomes an abort signal inside core before any of our
// code sees it, and that signal is not passed on (see the header), so the
// option would silently do nothing. Checked where the caller's options are
// still as given, before core's config handling.
const assertNoCallTimeout = (options) => {
  if (options && typeof options === "object" && !Array.isArray(options) && options.timeout !== undefined) {
    throw createAdapterError(
      ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.unsupportedOption,
      "ArchiveRagChatModel does not support the call option timeout: the request deadline " +
        "(rag/request-deadline.js) bounds model calls."
    );
  }
};

// Options LangChain offers that the request cannot carry. Ignoring them would
// change what the model sees without saying so.
const assertSupportedCallOptions = (options = {}) => {
  const unsupported = [
    Array.isArray(options.stop) && options.stop.length > 0 ? "stop" : null,
    options.tools !== undefined ? "tools" : null,
    options.tool_choice !== undefined ? "tool_choice" : null,
  ].filter(Boolean);

  if (unsupported.length > 0) {
    throw createAdapterError(
      ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.unsupportedOption,
      `ArchiveRagChatModel does not support the call option(s) ${unsupported.join(", ")}.`
    );
  }
};

// openai.js already retries, backs off, honours Retry-After, fails over to the
// fallback model and trips the circuit breaker (ADR constraint 7). A LangChain
// retry or fallback wrapped around this model would repeat every one of those
// attempts and meter each of them again, so both are refused.
const refuseSecondRetryLayer = (method) => {
  throw createAdapterError(
    ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.unsupportedOption,
    `ArchiveRagChatModel does not support ${method}: rag/openai.js owns retries and failover.`
  );
};

// Fields that would turn LangChain's own retry, queue, cache or console logging
// back on. Refused rather than overridden, so a caller who set one learns it
// has no effect.
const assertNoLangChainCallLayer = ({ cache, maxConcurrency, maxRetries, verbose }) => {
  const refused = [
    maxRetries !== undefined && maxRetries !== 0 ? "maxRetries" : null,
    maxConcurrency !== undefined ? "maxConcurrency" : null,
    cache !== undefined && cache !== false ? "cache" : null,
    verbose === true ? "verbose" : null,
  ].filter(Boolean);

  if (refused.length > 0) {
    throw createAdapterError(
      ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.config,
      `ArchiveRagChatModel refuses ${refused.join(", ")}: retries, concurrency and caching ` +
        "belong to rag/openai.js and rag/model-call-guard.js."
    );
  }
};

// Only options a direct caller can pass. The model's route fields are added
// only when set, so an unset one falls back inside openai.js exactly as an
// absent one does. options.signal is deliberately absent (see the header):
// openai.js still aborts the call when the bound request is cancelled.
const buildCompletionOptions = (model, options = {}) => ({
  ...(model.capability !== undefined ? { capability: model.capability } : {}),
  ...(model.routeId !== undefined ? { routeId: model.routeId } : {}),
  ...(model.workspacePolicy !== undefined ? { workspacePolicy: model.workspacePolicy } : {}),
  onAttemptStart: options.onAttemptStart,
  onTextDelta: options.onTextDelta,
  promptTemplate: options.promptTemplate ?? model.promptTemplate,
  responseFormat: options.responseFormat,
  temperature: options.temperature ?? model.temperature,
});

export class ArchiveRagChatModel extends BaseChatModel {
  static lc_name() {
    return "ArchiveRagChatModel";
  }

  constructor({
    capability,
    promptTemplate = null,
    routeId,
    temperature,
    workspacePolicy,
    ...rest
  } = {}) {
    assertLangSmithTracingDisabled();
    assertNoLangChainCallLayer(rest);

    // outputVersion is pinned to v0 unless the caller asks: LC_OUTPUT_VERSION=v1
    // in the environment would otherwise turn the reply into content blocks.
    super({ outputVersion: "v0", ...rest, maxRetries: 0 });

    this.capability = capability;
    this.promptTemplate = promptTemplate;
    this.routeId = routeId;
    this.temperature = temperature;
    this.workspacePolicy = workspacePolicy;
    // stream, batch and the runnables pipe / withConfig / ... build check
    // LangSmith before LangChain configures their callbacks.
    guardRunnableEntryPoints(this);
  }

  get callKeys() {
    return [...super.callKeys, ...ARCHIVE_RAG_CHAT_MODEL_CALL_KEYS];
  }

  _llmType() {
    return "archive-rag";
  }

  withRetry() {
    return refuseSecondRetryLayer("withRetry");
  }

  withFallbacks() {
    return refuseSecondRetryLayer("withFallbacks");
  }

  // Each public entry point checks LangSmith before LangChain configures its
  // callbacks, which is where the tracer would be attached.
  async invoke(input, options) {
    assertLangSmithTracingDisabled();

    return super.invoke(isArchiveRagChatPrompt(input) ? input.messages : input, options);
  }

  async generatePrompt(promptValues, options, callbacks) {
    assertLangSmithTracingDisabled();

    const promptMessages = promptValues.map((promptValue) => {
      const messages = promptValue.toChatMessages();

      if (promptValue instanceof StringPromptValue && messages.length === 1) {
        stringPromptMessages.add(messages[0]);
      }

      return messages;
    });

    return this.generate(promptMessages, options, callbacks);
  }

  async generate(messages, options, callbacks) {
    assertLangSmithTracingDisabled();
    // invoke and generatePrompt reach core through here with the caller's
    // options unchanged.
    assertNoCallTimeout(options);

    return super.generate(messages, options, callbacks);
  }

  async _generate(messages, options = {}) {
    assertLangSmithTracingDisabled();
    assertSupportedCallOptions(options);

    const completion = await completeTextWithMetadata(
      toArchiveRagPrompt(messages),
      buildCompletionOptions(this, options)
    );
    // modelRoute holds ids and statuses only (provider, model id, route id).
    const message = new AIMessage({
      content: completion.text,
      response_metadata: { modelRoute: completion.modelRoute },
    });

    return {
      generations: [{ message, text: completion.text }],
      llmOutput: { modelRoute: completion.modelRoute },
    };
  }

  // Accepts a JSON Schema object, the kind rag/structured-output.js builds, and
  // sends it as the same strict response_format the planners send. Refused:
  //   - method other than "jsonSchema": function calling and json mode are not
  //     how any of our calls ask for structure;
  //   - zod and Standard Schema objects: converting them is not guaranteed to
  //     give the strict subset (every property required, additionalProperties
  //     false, bounded strings), and the planners build JSON Schema directly;
  //   - strict false: buildJsonSchemaResponseFormat is the one builder and it
  //     is always strict.
  // The reply is parsed with parseFirstJsonValue and not validated further:
  // the planner validators stay the final authority over what it contains.
  withStructuredOutput(
    schema,
    { includeRaw = false, method = "jsonSchema", name, strict = true } = {}
  ) {
    assertLangSmithTracingDisabled();

    const refuse = (reason) => {
      throw createAdapterError(
        ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.structuredOutputConfig,
        `ArchiveRagChatModel.withStructuredOutput ${reason}`
      );
    };

    if (method !== "jsonSchema") {
      refuse('supports method "jsonSchema" only.');
    }

    if (strict !== true) {
      refuse("sends strict schemas only.");
    }

    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      refuse("takes a JSON Schema object.");
    }

    if (isInteropZodSchema(schema) || isStandardSchema(schema)) {
      refuse("takes a JSON Schema object, not a zod or Standard Schema.");
    }

    if (typeof name !== "string" || !SCHEMA_NAME_PATTERN.test(name)) {
      refuse("needs a schema name of 1-64 letters, digits, '_' or '-'.");
    }

    return new ArchiveRagStructuredOutput({
      includeRaw: includeRaw === true,
      model: this,
      responseFormat: buildJsonSchemaResponseFormat({ name, schema }),
    });
  }
}

// A plain Runnable rather than core's pipe-plus-fallbacks pipeline: invoke goes
// straight to the model, so no chain-level callback machinery runs before the
// LangSmith check, and includeRaw needs no withFallbacks.
class ArchiveRagStructuredOutput extends Runnable {
  lc_namespace = ["archive_rag", "langgraph"];

  #includeRaw;
  #model;
  #responseFormat;

  static lc_name() {
    return "ArchiveRagStructuredOutput";
  }

  withRetry() {
    return refuseSecondRetryLayer("withRetry");
  }

  withFallbacks() {
    return refuseSecondRetryLayer("withFallbacks");
  }

  constructor({ includeRaw, model, responseFormat }) {
    assertLangSmithTracingDisabled();
    super();
    this.#includeRaw = includeRaw;
    this.#model = model;
    this.#responseFormat = responseFormat;
    guardRunnableEntryPoints(this);
  }

  async invoke(input, options) {
    assertLangSmithTracingDisabled();

    // responseFormat last: the schema this runnable was built for cannot be
    // replaced per call.
    const raw = await this.#model.invoke(input, {
      ...options,
      responseFormat: this.#responseFormat,
    });
    const parsed = parseFirstJsonValue(raw.text);

    if (this.#includeRaw) {
      return { parsed: parsed ?? null, raw };
    }

    if (parsed === undefined) {
      throw createAdapterError(
        ARCHIVE_RAG_CHAT_MODEL_ERROR_CODES.structuredOutputParse,
        "The model reply held no complete JSON object or array."
      );
    }

    return parsed;
  }
}
