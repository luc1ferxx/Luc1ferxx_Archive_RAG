import {
  ChatPromptTemplate,
  HumanMessagePromptTemplate,
  PromptTemplate,
  SystemMessagePromptTemplate,
  renderTemplate,
} from "@langchain/core/prompts";
import { isBaseMessage } from "@langchain/core/messages";
import { ChatPromptValue, StringPromptValue } from "@langchain/core/prompt_values";
import { fingerprintPromptSource, normalizePromptDescriptor } from "../prompt-registry.js";
import { assertLangSmithTracingDisabled, guardRunnableEntryPoints } from "./langsmith-guard.js";

// definePrompt templates as LangChain prompt templates, without changing what
// reaches the model or how the prompt is identified (docs/adr/0001, constraint 6).
//
// Scope: only templates built with lib/prompt-template.js -- the document
// answer prompts (answer-writer.js), the memory rewrite (memory.js) and the web
// answer (chat-mcp.js). Planner and claim-judge prompts are built by functions
// from request data (the fingerprint covers the function's output for an empty
// input, prompt-registry.js) and keep their builders; nothing here wraps them.
//
// Identity: the fingerprint is always the one definePrompt computed from the
// unrendered in-house source. LangChain's own representation of a template
// (parsed nodes, message objects, its serialized form) is never fingerprinted,
// so converting a template cannot move it to another fingerprint or version.
//
// Rendering: lib/prompt-template.js uses {var} with {{ and }} escapes, which is
// LangChain's f-string format, but the two parsers differ at the edges (a lone
// "}" or "{" is literal text in ours and an error in LangChain's; "{}" is
// literal in ours and an empty variable name in LangChain's) and in how a
// non-string value is turned into text (ToString in ours, JSON.stringify in
// LangChain's). Each conversion therefore renders both sides with marker
// values and refuses a template whose output differs, and renderLangChainPrompt
// converts values the way ours does. Rendering goes through formatPromptValue,
// not invoke: invoke builds a callback manager, which is where the LangSmith
// tracer would attach. The converted template is still a LangChain runnable,
// so its own entry points (invoke, stream, batch, ...) and whatever its pipe,
// withConfig, ... build check LangSmith first (langsmith-guard.js, which also
// says what that check cannot cover).
//
// Source of a chat template's messages: lib/prompt-template.js keeps the
// [role, template] pairs private and exposes only `source`, the pairs joined
// into one string that cannot be split back reliably. The pairs are recovered
// from the template itself instead: rendered with marker values, each message
// is its own text with the escapes collapsed and a marker where each variable
// stood (see recoverMessageTemplate). That needs nothing from
// lib/prompt-template.js beyond what it already offers.

// The roles our templates use, "system" and "human", map one-to-one onto
// LangChain's message types and back. Any other role is refused instead of
// mapped: "user" would come back as "human", and openai.js puts the role name
// into the rendered input ("HUMAN:" vs "USER:"); "ai" would round-trip, but
// openai-client.js sends it as role "user" and the chat model adapter
// (model.js) refuses it, so no template may carry one.
const MESSAGE_PROMPT_TEMPLATES = Object.freeze({
  human: HumanMessagePromptTemplate,
  system: SystemMessagePromptTemplate,
});
const ROLE_BY_MESSAGE_TYPE = Object.freeze({ human: "human", system: "system" });

export const PROMPT_ADAPTER_ERROR_CODES = Object.freeze({
  descriptorInvalid: "PROMPT_DESCRIPTOR_INVALID",
  fingerprintMismatch: "PROMPT_FINGERPRINT_MISMATCH",
  outputUnsupported: "PROMPT_OUTPUT_UNSUPPORTED",
  sourceUnknown: "PROMPT_SOURCE_UNKNOWN",
  templateNotRepresentable: "PROMPT_TEMPLATE_NOT_REPRESENTABLE",
  templateUnsupported: "PROMPT_TEMPLATE_UNSUPPORTED",
});

// Error messages name codes, roles, positions and descriptor ids only: never
// template text, variable values or rendered prompt text.
const createPromptAdapterError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

// LangChain template -> the in-house template it was built from. A LangChain
// template carries no source of ours, so describeLangChainPrompt and
// renderLangChainPrompt accept only templates this module built.
const inHouseTemplates = new WeakMap();

// createChatPromptTemplate returns { invoke, source }, createPromptTemplate
// { format, source }.
const isChatTemplate = (template) =>
  typeof template?.invoke === "function" &&
  typeof template?.format !== "function" &&
  typeof template?.source === "string";

const isStringTemplate = (template) =>
  typeof template?.format === "function" &&
  typeof template?.invoke !== "function" &&
  typeof template?.source === "string";

// Marker values carry no braces, so they survive both parsers unchanged and
// expose every difference; built from NUL and SOH, they do not occur in a real
// template. A chat template is recovered with the NUL set and checked with the
// SOH set, so the check does not merely replay the recovery, and a template
// that does hold the NUL markers is refused by it.
const RECOVERY_DELIMITER = "\u0000";
const CHECK_DELIMITER = "\u0001";
const RECOVERY_MARKER_PATTERN = /\u0000(\d+)\u0000/g;

const buildMarkerValues = (variableNames, delimiter = RECOVERY_DELIMITER) =>
  Object.fromEntries(
    [...new Set(variableNames)].map((name, index) => [name, `${delimiter}${index}${delimiter}`])
  );

const parseAsLangChain = (template) => {
  try {
    return PromptTemplate.fromTemplate(template, { templateFormat: "f-string" });
  } catch {
    throw createPromptAdapterError(
      PROMPT_ADAPTER_ERROR_CODES.templateNotRepresentable,
      "The prompt template cannot be parsed as a LangChain f-string template."
    );
  }
};

// Renders the in-house template with the marker values. It throws when ours
// uses a variable LangChain did not find (ours then misses a marker value).
const renderInHouseWithMarkers = (render) => {
  try {
    return render();
  } catch {
    return null;
  }
};

const refuseUnrepresentable = (where) => {
  throw createPromptAdapterError(
    PROMPT_ADAPTER_ERROR_CODES.templateNotRepresentable,
    `The prompt template renders differently under LangChain (${where}).`
  );
};

const toStringPromptTemplate = (template) => {
  const langChainTemplate = parseAsLangChain(template.source);
  const markers = buildMarkerValues(langChainTemplate.inputVariables);
  const expected = renderInHouseWithMarkers(() => template.format(markers));

  if (expected === null || expected !== renderTemplate(template.source, "f-string", markers)) {
    refuseUnrepresentable("string template");
  }

  return langChainTemplate;
};

const escapeBraces = (text) => text.replace(/[{}]/g, (brace) => `${brace}${brace}`);

// One message rendered with the recovery markers, back into an f-string
// template: the in-house renderer turned "{{" and "}}" into single braces and
// each {name} into name's marker, so doubling every brace of the literal text
// and writing "{name}" where a marker stands gives the message's template in
// LangChain's syntax. null when the text holds a marker no variable has (a
// template containing the marker characters itself).
const recoverMessageTemplate = (content, variableNames) => {
  let text = "";
  let position = 0;

  for (const match of content.matchAll(RECOVERY_MARKER_PATTERN)) {
    const name = variableNames[Number(match[1])];

    if (name === undefined) {
      return null;
    }

    text += `${escapeBraces(content.slice(position, match.index))}{${name}}`;
    position = match.index + match[0].length;
  }

  return `${text}${escapeBraces(content.slice(position))}`;
};

const toChatPromptTemplate = (template) => {
  // The variable names come from the whole source: the "role:" headers that
  // join the messages there carry no braces.
  const variableNames = [...new Set(parseAsLangChain(template.source).inputVariables)];
  const recovered = renderInHouseWithMarkers(() =>
    template.invoke(buildMarkerValues(variableNames))
  );

  if (!Array.isArray(recovered?.messages)) {
    refuseUnrepresentable("chat template");
  }

  const parts = recovered.messages.map((message, index) => {
    const role = message?.role;
    const MessagePromptTemplate = Object.hasOwn(MESSAGE_PROMPT_TEMPLATES, role)
      ? MESSAGE_PROMPT_TEMPLATES[role]
      : null;

    if (!MessagePromptTemplate || typeof message.content !== "string") {
      throw createPromptAdapterError(
        PROMPT_ADAPTER_ERROR_CODES.templateUnsupported,
        `Chat prompt message ${index} has a role without a one-to-one LangChain message type.`
      );
    }

    const text = recoverMessageTemplate(message.content, variableNames);

    if (text === null) {
      refuseUnrepresentable("chat template");
    }

    const prompt = parseAsLangChain(text);

    return { messageTemplate: new MessagePromptTemplate(prompt), prompt, role };
  });
  // The check, with markers the recovery never saw: every message renders
  // the same text through both renderers, or the template is refused.
  const markers = buildMarkerValues(variableNames, CHECK_DELIMITER);
  const expected = renderInHouseWithMarkers(() => template.invoke(markers));

  if (
    !Array.isArray(expected?.messages) ||
    expected.messages.length !== parts.length ||
    parts.some(
      ({ prompt, role }, index) =>
        expected.messages[index].role !== role ||
        expected.messages[index].content !== renderTemplate(prompt.template, "f-string", markers)
    )
  ) {
    refuseUnrepresentable("chat template");
  }

  return ChatPromptTemplate.fromMessages(
    parts.map(({ messageTemplate }) => messageTemplate),
    { templateFormat: "f-string" }
  );
};

/**
 * Converts a lib/prompt-template.js template into a LangChain one:
 * createPromptTemplate -> PromptTemplate, createChatPromptTemplate ->
 * ChatPromptTemplate (system and human messages). Throws, with a code, for a
 * template LangChain would render differently. The result's runnable entry
 * points and compositions check LangSmith first (guardRunnableEntryPoints).
 */
export const toLangChainPromptTemplate = (template) => {
  assertLangSmithTracingDisabled();

  let langChainTemplate;

  if (isChatTemplate(template)) {
    langChainTemplate = toChatPromptTemplate(template);
  } else if (isStringTemplate(template)) {
    langChainTemplate = toStringPromptTemplate(template);
  } else {
    throw createPromptAdapterError(
      PROMPT_ADAPTER_ERROR_CODES.templateUnsupported,
      "Only createPromptTemplate and createChatPromptTemplate templates can be converted."
    );
  }

  inHouseTemplates.set(langChainTemplate, template);

  return guardRunnableEntryPoints(langChainTemplate);
};

/**
 * The descriptor to send with a call rendered from `template` (an in-house
 * template, or a LangChain template toLangChainPromptTemplate built). Throws
 * unless the descriptor's fingerprint is the fingerprint of the template's
 * unrendered in-house source, i.e. unless the descriptor identifies exactly
 * these instructions.
 */
export const describeLangChainPrompt = ({ descriptor, template } = {}) => {
  const normalized = normalizePromptDescriptor(descriptor);

  if (!normalized) {
    throw createPromptAdapterError(
      PROMPT_ADAPTER_ERROR_CODES.descriptorInvalid,
      "A prompt descriptor needs a well-formed id, version and fingerprint."
    );
  }

  const source = typeof template?.source === "string"
    ? template.source
    : inHouseTemplates.get(template)?.source;

  if (typeof source !== "string") {
    throw createPromptAdapterError(
      PROMPT_ADAPTER_ERROR_CODES.sourceUnknown,
      `Prompt ${normalized.id}@${normalized.version}: no in-house source to fingerprint.`
    );
  }

  const fingerprint = fingerprintPromptSource(source);

  if (fingerprint !== normalized.fingerprint) {
    throw createPromptAdapterError(
      PROMPT_ADAPTER_ERROR_CODES.fingerprintMismatch,
      `Prompt ${normalized.id}@${normalized.version} is pinned to ${normalized.fingerprint}, ` +
        `but its template fingerprints to ${fingerprint}.`
    );
  }

  return Object.freeze(normalized);
};

const toInHouseMessage = (message, index) => {
  const type = isBaseMessage(message) ? message.getType() : null;
  const role = Object.hasOwn(ROLE_BY_MESSAGE_TYPE, type) ? ROLE_BY_MESSAGE_TYPE[type] : null;

  if (!role || typeof message.content !== "string") {
    throw createPromptAdapterError(
      PROMPT_ADAPTER_ERROR_CODES.outputUnsupported,
      `Rendered prompt message ${index} is not a text system or human message.`
    );
  }

  return { role, content: message.content };
};

/**
 * LangChain prompt output -> the input completeText / completeTextWithMetadata
 * take: a string for a string template (string or StringPromptValue), and
 * { messages: [{ role, content }] } for a chat template (ChatPromptValue or
 * an array of messages), exactly what the in-house template renders.
 */
export const toPromptInput = (rendered) => {
  if (typeof rendered === "string") {
    return rendered;
  }

  if (rendered instanceof StringPromptValue) {
    return rendered.value;
  }

  const messages = rendered instanceof ChatPromptValue ? rendered.messages : rendered;

  if (!Array.isArray(messages)) {
    throw createPromptAdapterError(
      PROMPT_ADAPTER_ERROR_CODES.outputUnsupported,
      "Rendered prompt output must be a string, a prompt value or a message array."
    );
  }

  return { messages: messages.map(toInHouseMessage) };
};

// ToString, as the in-house formatter applies it to a replacement value (a
// template literal throws on a Symbol exactly as String.prototype.replace
// does); LangChain would JSON.stringify every non-string value instead.
const toTemplateValues = (values = {}) =>
  Object.fromEntries(
    Object.entries(values ?? {}).map(([name, value]) => [
      name,
      typeof value === "string" ? value : `${value}`,
    ])
  );

/**
 * Renders a template toLangChainPromptTemplate built and returns the input to
 * hand completeTextWithMetadata (or ArchiveRagChatModel): a string or
 * { messages }, nothing else. It does not carry the prompt's identity: the
 * caller passes describeLangChainPrompt's descriptor as the call's
 * `promptTemplate` option, or the LLMOps event and the run ledger record the
 * call with none (constraint 6).
 */
export const renderLangChainPrompt = async (langChainTemplate, values) => {
  assertLangSmithTracingDisabled();

  if (!inHouseTemplates.has(langChainTemplate)) {
    throw createPromptAdapterError(
      PROMPT_ADAPTER_ERROR_CODES.sourceUnknown,
      "Only templates built by toLangChainPromptTemplate are rendered."
    );
  }

  return toPromptInput(await langChainTemplate.formatPromptValue(toTemplateValues(values)));
};
