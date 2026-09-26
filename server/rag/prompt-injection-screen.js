import { getPromptInjectionScreenMode } from "./config.js";

// Deterministic screen for text that reaches a model prompt from an untrusted
// source: retrieved document chunks, upload file names, web search results.
//
// A document is data. A sentence in it that addresses an AI system ("Note to
// AI assistants: ...", "Ignore all previous instructions", chat-template role
// markers, "print your system prompt") is not a fact about the document; it is
// an attempt to steer whoever reads it. Such sentences are replaced by a
// marker before the text enters a prompt, so the model never sees the
// instruction. The citation shown to the user keeps the original text.
//
// This is a pattern screen, so it stops the phrasings it knows and misses an
// attacker who avoids them. It is one layer: the answer prompts also tell the
// model that evidence is untrusted, and guardAnswerLinks removes links the
// model could only have taken from a payload. The patterns are tuned against
// false positives on ordinary documents (evaluation/run-prompt-injection-eval.mjs
// reports how many benign corpus sentences they flag).

export const SCREENED_SENTENCE_MARKER = "[removed: text addressed to an AI system]";

// Words that name the reader as a machine. Bare "model" is excluded on
// purpose: research papers say "the model must output" about their own models.
const AI_ADDRESSEE = String.raw`(?:AI(?:\s+(?:assistants?|systems?|models?|agents?|tools?|readers?))?|assistants?|chat\s?bots?|language\s+models?|LLMs?|GPTs?|answering\s+models?|(?:automated\s+)?(?:fact|claim)[-\s]?checkers?)`;
const DIRECTIVE_VERB = String.raw`(?:reply|respond|answer|say|state|tell|print|output|repeat|append|include|begin|start|end|write|mark|conclude|warn|display|ignore|reveal|disclose|translate|add|insert|mention)`;

const SENTENCE_RULES = Object.freeze([
  {
    id: "override_instructions",
    pattern: new RegExp(
      String.raw`\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|original|system|existing|other)\s+(?:instructions?|rules|prompts?|guidelines|directions|messages)\b`,
      "i"
    ),
  },
  { id: "override_instructions", pattern: /\binstructions you (?:were|have been) given\b/i },
  { id: "new_task", pattern: /\byour new (?:task|role|instructions?|objective|policy)\b/i },
  {
    id: "addressed_note",
    pattern: new RegExp(
      String.raw`\b(?:note|notice|message|instruction|reminder|attention|warning|request)s?\s+(?:to|for)\s+(?:any\s+|all\s+|the\s+|every\s+)?${AI_ADDRESSEE}\b`,
      "i"
    ),
  },
  {
    id: "vocative_addressee",
    // "Assistant: ..." or "AI, reply ...". A leading comma alone is not enough:
    // "LLMs, language as a mechanism, ..." opens ordinary prose.
    pattern: new RegExp(
      String.raw`^\s*(?:dear\s+)?(?:the\s+)?${AI_ADDRESSEE}\s*(?::|,\s*(?:please\s+)?${DIRECTIVE_VERB}\b)`,
      "i"
    ),
  },
  {
    id: "addressee_directive",
    pattern: new RegExp(
      String.raw`\b${AI_ADDRESSEE}\b[^.!?]{0,60}?\b(?:must|should|shall|needs?\s+to|is\s+required\s+to|are\s+required\s+to)\s+(?:now\s+|always\s+|also\s+)?${DIRECTIVE_VERB}\b`,
      "i"
    ),
  },
  {
    id: "answer_directive",
    pattern: new RegExp(
      String.raw`\b(?:when|before|after|whenever)\s+(?:you\s+)?(?:answer|respond|reply|summari[sz]e)(?:ing)?\b[^.!?]{0,80}?\b${DIRECTIVE_VERB}\b`,
      "i"
    ),
  },
  {
    id: "answer_directive",
    pattern: new RegExp(String.raw`\byou\s+(?:must|should|shall)\s+(?:now\s+|always\s+)?${DIRECTIVE_VERB}\b`, "i"),
  },
  { id: "reply_only_with", pattern: /\b(?:reply|respond|answer)\s+only\s+with\b|\band nothing else\b/i },
  // Chinese phrasings of the same moves; the answer prompts reply in the
  // user's language, so a payload can be written in it too.
  {
    id: "override_instructions",
    pattern: /(?:忽略|无视|忘记|忽视)(?:掉)?(?:之前|以上|先前|前面|上述|所有|全部|原有|系统)的?(?:所有|全部)?(?:指令|指示|规则|提示|要求|设定)/,
  },
  { id: "new_task", pattern: /你的新(?:任务|角色|指令|身份)/ },
  {
    id: "addressed_note",
    pattern: /(?:给|致|对|写给)(?:所有|任何)?(?:的)?(?:AI|人工智能|智能)?(?:助手|模型|大模型|语言模型|机器人|AI)(?:的)?(?:说明|提示|通知|指令|注意|备注|消息)?[:：]/i,
  },
  {
    // Only with a quoted payload: "只回复客户的书面请求" is ordinary policy text.
    id: "reply_only_with",
    pattern: /(?:只|仅)(?:需)?(?:回复|回答|输出|返回)(?:一个词|一句话|以下内容|下面这句话)?\s*[:：]?\s*[“"「『]/,
  },
  {
    id: "prompt_exfiltration",
    pattern: /(?:输出|打印|复述|透露|显示|重复)[^。！？]{0,20}(?:系统提示词?|系统指令|你的指令|初始提示)|(?:系统提示词?|系统指令)[^。！？]{0,20}(?:输出|打印|复述|透露|显示|逐字)/,
  },
  {
    id: "prompt_exfiltration",
    pattern:
      /\b(?:system\s+(?:prompt|instructions?|message)|your\s+(?:instructions|initial\s+prompt|original\s+prompt|hidden\s+instructions))\b[^.!?]{0,60}\b(?:print|reveal|repeat|show|output|disclose|verbatim|word for word)\b|\b(?:print|reveal|repeat|show|output|disclose)\b[^.!?]{0,40}\b(?:system\s+(?:prompt|instructions?|message)|your\s+(?:instructions|initial\s+prompt|original\s+prompt))\b/i,
  },
]);

// Chat-template control tokens have no business in a document. A whole
// <|im_start|> ... <|im_end|> span is attacker text, including its body.
const CONTROL_SPAN_PATTERN = /<\|im_start\|>[\s\S]*?(?:<\|im_end\|>|$)|\[INST\][\s\S]*?(?:\[\/INST\]|$)|<<SYS>>[\s\S]*?(?:<<\/SYS>>|$)/gi;
const CONTROL_TOKEN_PATTERN = /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|^\s*#{2,}\s*(?:system|instructions?)\b/gim;

// Sentence ends: terminal punctuation followed by whitespace, or a line break.
const SENTENCE_SPLIT_PATTERN = /(?<=[.!?。！？])\s+|\n+/;

export const findInjectionRule = (sentence) =>
  SENTENCE_RULES.find(({ pattern }) => pattern.test(sentence))?.id ?? null;

/**
 * Returns the text with every sentence addressed to an AI system replaced by
 * SCREENED_SENTENCE_MARKER, plus what was removed (rule ids only, never the
 * text, so the result is safe to log).
 */
export const screenUntrustedText = (text) => {
  const source = String(text ?? "");

  if (getPromptInjectionScreenMode() === "off") {
    return { removed: [], text: source };
  }

  const removed = [];
  let screened = source.replace(CONTROL_SPAN_PATTERN, () => {
    removed.push("control_tokens");
    return ` ${SCREENED_SENTENCE_MARKER} `;
  });

  if (CONTROL_TOKEN_PATTERN.test(screened)) {
    CONTROL_TOKEN_PATTERN.lastIndex = 0;
    screened = screened.replace(CONTROL_TOKEN_PATTERN, () => {
      removed.push("control_tokens");
      return " ";
    });
  }

  CONTROL_TOKEN_PATTERN.lastIndex = 0;

  const sentences = screened.split(SENTENCE_SPLIT_PATTERN);
  const kept = sentences.map((sentence) => {
    const rule = findInjectionRule(sentence);

    if (!rule) {
      return sentence;
    }

    removed.push(rule);
    return SCREENED_SENTENCE_MARKER;
  });

  return {
    removed,
    text: removed.length === 0 ? source : kept.join(" ").replace(/\s{2,}/g, " ").trim(),
  };
};

export const createInjectionScreenSummary = () => ({ removedSentences: 0, rules: {}, screenedSources: 0 });

export const addToInjectionScreenSummary = (summary, removed = []) => {
  if (removed.length === 0) {
    return summary;
  }

  summary.screenedSources += 1;
  summary.removedSentences += removed.length;

  for (const rule of removed) {
    summary.rules[rule] = (summary.rules[rule] ?? 0) + 1;
  }

  return summary;
};

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\([^)]*\)/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()\]"'`]+/gi;
const ANSWER_SENTENCE_PATTERN = /[^.!?\n]*(?:[.!?]+(?:\s*\[Source \d+\])*|\n|$)/g;

const normalizeUrl = (url) => url.replace(/[.,;:!?]+$/, "").toLowerCase();

/**
 * Removes what only an injected instruction could have put in an answer:
 * markdown images (an auto-loading image URL is an exfiltration channel) and
 * sentences carrying a link that appears neither in the evidence the model was
 * shown nor in the user's question.
 */
export const guardAnswerLinks = (answer, { allowedText = "" } = {}) => {
  const text = String(answer ?? "");
  const allowed = String(allowedText ?? "").toLowerCase();
  const removed = [];
  const withoutImages = text.replace(MARKDOWN_IMAGE_PATTERN, () => {
    removed.push("markdown_image");
    return "";
  });
  const guarded = (withoutImages.match(ANSWER_SENTENCE_PATTERN) ?? [])
    .filter((sentence) => {
      const urls = sentence.match(URL_PATTERN) ?? [];
      const foreign = urls.some((url) => !allowed.includes(normalizeUrl(url)));

      if (foreign) {
        removed.push("unsourced_link");
      }

      return !foreign;
    })
    .join("");

  return {
    removed,
    text: removed.length === 0 ? text : guarded.replace(/[ \t]{2,}/g, " ").trim(),
  };
};
