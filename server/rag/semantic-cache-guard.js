// The lexical guard in front of a semantic cache hit (rag/semantic-cache.js).
//
// An embedding cannot tell a paraphrase from a look-alike question with
// another meaning. Measured with nomic-embed-text: "Is pre-approval not
// required ..." scores 0.994 against "Is pre-approval required ...", a role
// swap 0.997, "can"/"must" 0.981, "to"/"from another employee" 0.997, a moved
// "not" 0.983, "> $500"/"< $500" 0.998 and a Russian negation 0.986 -- above
// most reworded paraphrases (0.94-0.998). So a hit needs the embedding
// threshold AND this guard.
//
// The guard is a near-exact match of the normalized question plus a short
// allowlist of rewrites that cannot change the answer. It does not drop word
// classes: an earlier version dropped modals, prepositions, pronouns and
// negator positions and let every one of the contrasts above through.
//
// What may differ (the allowlist):
//   - case, spacing, punctuation, contractions ("what's", "can't");
//   - the articles a/an/the, "of", "please", "kindly", do-support "do/does",
//     the present copula "is/are/am" and possessive "'s";
//   - a plural or third-person "-s" on an English word;
//   - modals within one class: permission (can, could, may, might),
//     obligation (must, shall, should, have/has/need/ought to), future (will,
//     would); "had to" and "needed to" are past obligation;
//   - these word swaps: get/obtain/receive, let/permit/allow,
//     need/require, say/state/mention (in the same form: "needed" is
//     "required", never "require"), "during"/"in", "were"/"was", "has"/"have";
//   - a number written as digits or words ("3"/"three");
//   - a time unit written as "per/each/every/a <unit>" or as "daily",
//     "weekly", ... ("per day"/"daily").
//
// Everything else must be equal, in order:
//   negation  the same negators, each in the same place (a moved "not" is
//             another question), no negating prefix (un-/non-/in-/dis-) and
//             no antonym swapped (minimum/maximum, before/after, ...).
//   number    the same numbers, comparators (< > <= >= = !=) and currency
//             symbols, in order; "three" equals "3".
//   date      the same months, weekdays, quarters, relative dates and time
//             units, in order ("from Monday to Friday" is not "from Friday
//             to Monday"; "per month for each year" is not the other way).
//   entity    the same capitalized names, acronyms, identifiers, file names
//             and quoted spans, in order.
//   modal     the same modal classes, in order.
//   script    a question with any letter outside the Latin script (Cyrillic,
//             Greek, Arabic, Hebrew, Thai, Devanagari, CJK, ...) must match the
//             other one exactly apart from case, spacing and punctuation: the
//             word lists here are English and the English embedding model
//             scores 带薪年假/带薪病假 at 0.992.
//   content   every other word, in order: question words, prepositions
//             (to, from, into, by, for, since, until, ...), pronouns and
//             possessives, tense ("did", "was", "approved"), quantifiers.
//
// A miss costs one ordinary RAG run; a false hit silently serves another
// question's answer, so anything not on the allowlist is a miss.
//
// Modes exist for the evaluation's ablation: "full" (the runtime guard),
// "required" (negation, number, date, entity only) and "none".

export const SEMANTIC_CACHE_GUARD_MODES = Object.freeze(["full", "required", "none"]);

export const SEMANTIC_CACHE_GUARD_VERSION = "semantic-cache-guard/v2";

// Any letter whose script is not Latin. Precomposed accented Latin letters
// (é, ạ, ß) are Script=Latin, so Western and Vietnamese text is not caught.
const NON_LATIN_LETTER = /(?=\p{L})\P{Script=Latin}/u;

const NEGATORS = new Map([
  ["not", "not"],
  ["no", "not"],
  ["never", "not"],
  ["none", "not"],
  ["nor", "not"],
  ["neither", "not"],
  ["nobody", "not"],
  ["nothing", "not"],
  ["nowhere", "not"],
  ["non", "not"],
  ["without", "without"],
  ["except", "except"],
  ["excepting", "except"],
  ["unless", "unless"],
]);

const NEGATION_VALUES = new Set(NEGATORS.values());

const CJK_NEGATORS = /[不没無无未非别別勿否]/gu;

const NEGATION_PREFIXES = ["un", "non", "in", "im", "il", "ir", "dis"];

// Each pair names two words that invert a question's meaning when one is
// swapped for the other. Compared after stemming. The content check would
// refuse these swaps anyway; this names the reason and serves the "required"
// ablation mode.
const ANTONYM_PAIRS = [
  ["minimum", "maximum"],
  ["min", "max"],
  ["minimal", "maximal"],
  ["before", "after"],
  ["more", "less"],
  ["more", "fewer"],
  ["most", "least"],
  ["higher", "lower"],
  ["highest", "lowest"],
  ["above", "below"],
  ["over", "under"],
  ["increase", "decrease"],
  ["include", "exclude"],
  ["included", "excluded"],
  ["allow", "prohibit"],
  ["allowed", "forbidden"],
  ["permit", "forbid"],
  ["required", "optional"],
  ["mandatory", "optional"],
  ["earliest", "latest"],
  ["first", "last"],
  ["start", "end"],
  ["begin", "end"],
  ["open", "close"],
  ["accept", "reject"],
  ["approve", "reject"],
  ["approved", "rejected"],
  ["pass", "fail"],
  ["buy", "sell"],
  ["add", "remove"],
  ["enable", "disable"],
  ["internal", "external"],
  ["domestic", "international"],
  ["domestically", "internationally"],
  ["full", "part"],
  ["inbound", "outbound"],
  ["import", "export"],
  ["upper", "lower"],
  ["inside", "outside"],
  ["true", "false"],
  ["same", "different"],
  ["with", "without"],
  ["gain", "loss"],
  ["profit", "loss"],
  ["win", "lose"],
  ["old", "new"],
  ["oldest", "newest"],
];

const NUMBER_WORDS = new Map([
  ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5],
  ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11],
  ["twelve", 12], ["thirteen", 13], ["fourteen", 14], ["fifteen", 15], ["sixteen", 16],
  ["seventeen", 17], ["eighteen", 18], ["nineteen", 19], ["twenty", 20], ["thirty", 30],
  ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90],
  ["dozen", 12], ["single", 1], ["double", 2], ["twice", 2], ["once", 1], ["half", 0.5],
]);

const NUMBER_SCALES = new Map([
  ["hundred", 100],
  ["thousand", 1000],
  ["million", 1_000_000],
  ["billion", 1_000_000_000],
]);

const ORDINAL_WORDS = new Map([
  ["first", 1], ["second", 2], ["third", 3], ["fourth", 4], ["fifth", 5], ["sixth", 6],
  ["seventh", 7], ["eighth", 8], ["ninth", 9], ["tenth", 10], ["eleventh", 11],
  ["twelfth", 12], ["twentieth", 20], ["thirtieth", 30], ["hundredth", 100],
]);

// Comparators and currency symbols go into the number sequence at their place.
const SYMBOLS = new Map([
  ["<", "<"], [">", ">"], ["<=", "<="], ["=<", "<="], ["≤", "<="], [">=", ">="], ["=>", ">="],
  ["≥", ">="], ["=", "="], ["!=", "!="], ["≠", "!="], ["$", "$"], ["€", "€"], ["£", "£"],
  ["¥", "¥"], ["₹", "₹"], ["₩", "₩"],
]);

const MONTHS = new Map([
  ["january", "jan"], ["jan", "jan"], ["february", "feb"], ["feb", "feb"],
  ["march", "mar"], ["april", "apr"], ["apr", "apr"], ["june", "jun"], ["july", "jul"],
  ["august", "aug"], ["aug", "aug"], ["september", "sep"], ["sept", "sep"], ["sep", "sep"],
  ["october", "oct"], ["oct", "oct"], ["november", "nov"], ["nov", "nov"],
  ["december", "dec"], ["dec", "dec"],
]);

const WEEKDAYS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "weekend",
  "weekday", "weekdays", "weekends", "mondays", "tuesdays", "wednesdays", "thursdays",
  "fridays", "saturdays", "sundays",
]);

const TIME_UNITS = new Map([
  ["second", "second"], ["seconds", "second"], ["minute", "minute"], ["minutes", "minute"],
  ["hour", "hour"], ["hours", "hour"], ["hourly", "hour"], ["day", "day"], ["days", "day"],
  ["daily", "day"], ["week", "week"], ["weeks", "week"], ["weekly", "week"],
  ["fortnight", "fortnight"], ["month", "month"], ["months", "month"], ["monthly", "month"],
  ["quarter", "quarter"], ["quarters", "quarter"], ["quarterly", "quarter"], ["year", "year"],
  ["years", "year"], ["yearly", "year"], ["annually", "year"], ["decade", "decade"],
  ["decades", "decade"], ["century", "century"],
]);

// Words before a time unit that only say "per": "per day", "each day", "a day".
const PER_UNIT_WORDS = new Set(["per", "each", "every", "a", "an"]);

const RELATIVE_DATE_WORDS = new Set([
  "today", "tonight", "yesterday", "tomorrow", "now", "currently", "recently",
  "ytd", "mtd", "qtd",
]);

const RELATIVE_DATE_MODIFIERS = new Set(["last", "next", "this", "previous", "coming", "past", "prior", "current"]);

const DATE_PREPOSITIONS = new Set(["in", "of", "since", "until", "till", "by", "during", "from", "to", "before", "after"]);

const MODAL_CLASSES = new Map([
  ["can", "permission"], ["could", "permission"], ["may", "permission"], ["might", "permission"],
  ["must", "obligation"], ["shall", "obligation"], ["should", "obligation"],
  ["will", "future"], ["would", "future"],
]);

// "<head> to" is a modal: "has to approve", "need to submit".
const MODAL_PHRASE_HEADS = new Map([
  ["have", "obligation"], ["has", "obligation"], ["need", "obligation"], ["needs", "obligation"],
  ["ought", "obligation"], ["had", "obligation:past"], ["needed", "obligation:past"],
]);

// The only words dropped before content words are compared.
const DROPPED_WORDS = new Set(["a", "an", "the", "do", "does", "is", "are", "am", "s", "of", "please", "kindly"]);

// Keyed by the lightly stemmed word; each form maps to the same form of the
// other word, so tense and participles still have to agree.
const CONTENT_SYNONYMS = new Map([
  ["get", "receive"], ["obtain", "receive"],
  ["got", "received"], ["gotten", "received"], ["obtained", "received"],
  ["getting", "receiving"], ["obtaining", "receiving"],
  ["let", "allow"], ["permit", "allow"],
  ["permitted", "allowed"], ["letting", "allowing"], ["permitting", "allowing"],
  ["need", "require"], ["needed", "required"], ["needing", "requiring"],
  ["state", "say"], ["mention", "say"], ["stated", "said"], ["mentioned", "said"],
  ["stating", "saying"], ["mentioning", "saying"],
  ["during", "in"],
  ["were", "was"],
  ["has", "have"],
]);

// The old stemmer, for antonym and negating-prefix lookups only.
const stemWord = (word) => {
  let stem = word;

  if (stem.length > 4 && (stem.endsWith("ies") || stem.endsWith("ied"))) {
    stem = `${stem.slice(0, -3)}y`;
  } else if (stem.length > 5 && stem.endsWith("ing")) {
    stem = stem.slice(0, -3);
  } else if (stem.length > 4 && stem.endsWith("ed")) {
    stem = stem.slice(0, -2);
  } else if (stem.length > 3 && /(?:ss|x|ch|sh|z)es$/.test(stem)) {
    stem = stem.slice(0, -2);
  } else if (stem.length > 3 && stem.endsWith("s") && !/(?:ss|us|is)$/.test(stem)) {
    stem = stem.slice(0, -1);
  }

  if (stem.length > 4 && stem.endsWith("e")) {
    stem = stem.slice(0, -1);
  }

  return stem;
};

// Words whose final "s" is not a plural: "news media" is not "new media".
const NON_PLURAL_S_WORDS = new Set(["news", "series", "species", "whereas", "perhaps"]);

// Content words: a plural or third-person "-s" only, on English words only.
// "-ed" and "-ing" stay, so "approved" is not "approves".
const stripPluralS = (word) => {
  if (!/^[a-z]+$/.test(word) || NON_PLURAL_S_WORDS.has(word)) {
    return word;
  }

  if (word.length > 4 && word.endsWith("ies")) {
    return `${word.slice(0, -3)}y`;
  }

  if (word.length > 3 && /(?:ss|x|ch|sh|z)es$/.test(word)) {
    return word.slice(0, -2);
  }

  if (word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) {
    return word.slice(0, -1);
  }

  return word;
};

const ANTONYM_INDEX = (() => {
  const index = new Map();

  ANTONYM_PAIRS.forEach(([left, right], pairIndex) => {
    for (const [word, side] of [[left, 0], [right, 1]]) {
      const stem = stemWord(word);
      const entries = index.get(stem) ?? [];

      entries.push({ pair: pairIndex, side });
      index.set(stem, entries);
    }
  });

  return index;
})();

const normalizeQuestion = (text) =>
  String(text ?? "")
    .normalize("NFKC")
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"');

// "can't" -> "can not", "won't" -> "will not", "what's" -> "what 's".
const expandContractions = (text) =>
  text
    .replace(/\bcan't\b/gi, "can not")
    .replace(/\bwon't\b/gi, "will not")
    .replace(/\bshan't\b/gi, "shall not")
    .replace(/\b([a-z]+)n't\b/gi, "$1 not")
    .replace(/\bcannot\b/gi, "can not")
    .replace(/'ll\b/gi, " will")
    .replace(/'ve\b/gi, " have")
    .replace(/'re\b/gi, " are")
    .replace(/'m\b/gi, " am")
    .replace(/'d\b/gi, " would");

const TOKEN_PATTERN = /\p{L}[\p{L}\p{M}]*|\d+(?:[.,]\d+)*%?|<=|>=|=<|=>|!=|[<>≤≥=≠$€£¥₹₩]/gu;

const tokenize = (text) => expandContractions(text).toLowerCase().match(TOKEN_PATTERN) ?? [];

const isWordToken = (token) => /^\p{L}/u.test(token);

const parseNumberToken = (token) => {
  const percent = token.endsWith("%");
  const digits = (percent ? token.slice(0, -1) : token).replace(/,(?=\d{3}\b)/g, "");
  const value = Number(digits.replace(",", "."));

  return Number.isFinite(value) ? `${value}${percent ? "%" : ""}` : token;
};

// Numbers in order: digits, number words ("twenty five", "two hundred"),
// ordinals (1st, "third"), number-word multiples, comparators and currency
// symbols.
const extractNumbers = (tokens) => {
  const numbers = [];
  let pending = null;

  const flush = () => {
    if (pending) {
      numbers.push(String(pending.total + pending.current));
      pending = null;
    }
  };

  for (const token of tokens) {
    if (SYMBOLS.has(token)) {
      flush();
      numbers.push(`sym:${SYMBOLS.get(token)}`);
      continue;
    }

    if (/^\d/.test(token)) {
      flush();
      numbers.push(parseNumberToken(token));
      continue;
    }

    const ordinalSuffix = token.match(/^(\d+)(?:st|nd|rd|th)$/);

    if (ordinalSuffix) {
      flush();
      numbers.push(`ord:${Number(ordinalSuffix[1])}`);
      continue;
    }

    if (NUMBER_WORDS.has(token)) {
      // "two three" is two numbers; "twenty five" and "hundred and five" are one.
      if (pending && !pending.afterScale && !(pending.current % 10 === 0 && pending.current >= 20 && NUMBER_WORDS.get(token) < 10)) {
        flush();
      }

      pending ??= { total: 0, current: 0 };
      pending.current += NUMBER_WORDS.get(token);
      pending.afterScale = false;
      continue;
    }

    if (NUMBER_SCALES.has(token) && pending) {
      const scale = NUMBER_SCALES.get(token);

      if (scale === 100) {
        pending.current = (pending.current || 1) * scale;
      } else {
        pending.total += (pending.current || 1) * scale;
        pending.current = 0;
      }

      pending.afterScale = true;
      continue;
    }

    if (token === "and" && pending?.afterScale) {
      continue;
    }

    flush();

    if (ORDINAL_WORDS.has(token)) {
      numbers.push(`ord:${ORDINAL_WORDS.get(token)}`);
    }
  }

  flush();
  return numbers;
};

// Dates and modals in order, and which token positions they used up (a
// "per" before a unit, a "last" before "year", "to" after "has").
const extractDatesAndModals = (tokens) => {
  const consumed = new Set();
  const dates = [];
  const modals = [];

  tokens.forEach((token, index) => {
    const previous = tokens[index - 1] ?? "";
    const next = tokens[index + 1] ?? "";

    if (consumed.has(index)) {
      return;
    }

    if (MONTHS.has(token)) {
      dates.push(`month:${MONTHS.get(token)}`);
      consumed.add(index);
    } else if (token === "may") {
      // "may" is a modal unless a date context says otherwise ("in May", "May 2024").
      if (DATE_PREPOSITIONS.has(previous) || /^\d/.test(previous) || /^\d{4}$/.test(next)) {
        dates.push("month:may");
      } else {
        modals.push("permission");
      }

      consumed.add(index);
    } else if (WEEKDAYS.has(token)) {
      dates.push(`weekday:${token.replace(/s$/, "")}`);
      consumed.add(index);
    } else if (/^[qh][1-4]$/.test(token) || /^fy\d{2,4}$/.test(token)) {
      dates.push(`period:${token}`);
      consumed.add(index);
    } else if (RELATIVE_DATE_WORDS.has(token)) {
      dates.push(`relative:${token}`);
      consumed.add(index);
    } else if (TIME_UNITS.has(token)) {
      const unit = TIME_UNITS.get(token);

      if (RELATIVE_DATE_MODIFIERS.has(previous) && !consumed.has(index - 1)) {
        dates.push(`relative:${previous}:${unit}`);
        consumed.add(index - 1);
      } else {
        dates.push(`unit:${unit}`);

        if (PER_UNIT_WORDS.has(previous) && !consumed.has(index - 1)) {
          consumed.add(index - 1);
        }
      }

      consumed.add(index);
    } else if (MODAL_CLASSES.has(token)) {
      modals.push(MODAL_CLASSES.get(token));
      consumed.add(index);
    } else if (MODAL_PHRASE_HEADS.has(token) && next === "to") {
      modals.push(MODAL_PHRASE_HEADS.get(token));
      consumed.add(index);
      consumed.add(index + 1);
    }
  });

  return { consumed, dates, modals };
};

const isShoutingCase = (text) => {
  const letters = text.match(/\p{L}/gu) ?? [];
  const upper = letters.filter((letter) => letter === letter.toUpperCase() && letter !== letter.toLowerCase());

  return letters.length >= 8 && upper.length / letters.length > 0.6;
};

// Named things in order: capitalized words after the first word of a
// sentence (consecutive ones as one phrase), acronyms, identifiers with
// digits or inner capitals, file names and quoted spans. Null when the text is
// written in capitals throughout, where case says nothing; the content guard
// still compares its words.
const extractEntities = (text) => {
  if (isShoutingCase(text)) {
    return null;
  }

  const entities = [];

  for (const match of text.matchAll(/"([^"]{2,})"|'([^']{2,})'|「([^」]+)」/g)) {
    entities.push(`quote:${(match[1] ?? match[2] ?? match[3]).trim().toLowerCase()}`);
  }

  for (const match of text.matchAll(/[\w.-]+\.(?:pdf|docx?|txt|md|csv|xlsx?|pptx?|json|html?)\b/gi)) {
    entities.push(`file:${match[0].toLowerCase()}`);
  }

  const sentences = text.split(/(?<=[.!?;:])\s+|\n+/);

  for (const sentence of sentences) {
    const words = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}&'-]*/gu) ?? [];
    let phrase = [];

    const flush = () => {
      if (phrase.length > 0) {
        entities.push(`name:${phrase.join(" ").toLowerCase()}`);
        phrase = [];
      }
    };

    words.forEach((word, index) => {
      const acronym = /^\p{Lu}{2,}s?$/u.test(word);
      const identifier = /\p{L}/u.test(word) && /\d/.test(word);
      const innerCapital = /^\p{Ll}+\p{Lu}/u.test(word) || /^\p{Lu}\p{Ll}+\p{Lu}/u.test(word);
      const capitalized = /^\p{Lu}/u.test(word) && index > 0 && word !== "I";

      if (acronym || identifier || innerCapital || capitalized) {
        phrase.push(word);
      } else {
        flush();
      }
    });

    flush();
  }

  return entities;
};

const extractNegations = (text, tokens) => {
  const negations = tokens.filter((token) => NEGATORS.has(token)).map((token) => NEGATORS.get(token));
  const cjkNegators = text.match(CJK_NEGATORS) ?? [];

  return [...negations, ...cjkNegators.map(() => "not")].sort();
};

const extractContent = (tokens, consumed) => {
  const content = [];

  tokens.forEach((token, index) => {
    if (
      consumed.has(index) ||
      !isWordToken(token) ||
      DROPPED_WORDS.has(token) ||
      NUMBER_WORDS.has(token) ||
      NUMBER_SCALES.has(token) ||
      ORDINAL_WORDS.has(token)
    ) {
      return;
    }

    if (NEGATORS.has(token)) {
      content.push(NEGATORS.get(token));
      return;
    }

    const stem = stripPluralS(token);

    content.push(CONTENT_SYNONYMS.get(stem) ?? stem);
  });

  return content;
};

// Each negator with the content word it applies to: "not required ... when
// international" is not "required ... when not international".
const extractNegationScope = (content) =>
  content.flatMap((word, index) => (NEGATION_VALUES.has(word) ? [`${word}>${content[index + 1] ?? "$"}`] : []));

const normalizeExactText = (text) => text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "");

/** What the guard compares, for one question. */
export const analyzeCacheQuestion = (question) => {
  const text = normalizeQuestion(question);
  const tokens = tokenize(text);
  const { consumed, dates, modals } = extractDatesAndModals(tokens);
  const content = extractContent(tokens, consumed);

  return {
    content,
    dates,
    entities: extractEntities(text),
    modals,
    negations: extractNegations(text, tokens),
    negationScope: extractNegationScope(content),
    numbers: extractNumbers(tokens),
    script: NON_LATIN_LETTER.test(text) ? normalizeExactText(text) : null,
    words: new Set(tokens.filter(isWordToken)),
  };
};

const sameSequence = (left = [], right = []) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

// A word on one side that is a negating prefix plus a word on the other side
// ("unpaid"/"paid", "nonrefundable"/"refundable").
const findPrefixNegation = (leftWords, rightWords) => {
  for (const word of leftWords) {
    if (rightWords.has(word)) {
      continue;
    }

    for (const prefix of NEGATION_PREFIXES) {
      if (word.startsWith(prefix) && word.length - prefix.length >= 3) {
        const base = word.slice(prefix.length);

        if (rightWords.has(base) && !leftWords.has(base)) {
          return `${word}/${base}`;
        }
      }
    }
  }

  return null;
};

const findAntonymSwap = (leftWords, rightWords) => {
  const sidesOf = (words) => {
    const sides = new Map();

    for (const word of words) {
      for (const entry of ANTONYM_INDEX.get(stemWord(word)) ?? []) {
        const set = sides.get(entry.pair) ?? new Set();

        set.add(entry.side);
        sides.set(entry.pair, set);
      }
    }

    return sides;
  };
  const leftSides = sidesOf(leftWords);
  const rightSides = sidesOf(rightWords);

  for (const [pair, sides] of leftSides) {
    const other = rightSides.get(pair);

    if (other && !sameSequence([...sides].sort(), [...other].sort())) {
      return ANTONYM_PAIRS[pair].join("/");
    }
  }

  return null;
};

/**
 * Whether a cached answer to `cached` may serve `incoming`. Returns
 * `{ ok: true, reason: null }` or `{ ok: false, reason, detail }` with the
 * first check that failed (negation, number, date, entity, modal, script,
 * content).
 */
export const compareCacheQuestions = (incoming, cached, { mode = "full" } = {}) => {
  if (mode === "none") {
    return { ok: true, reason: null, detail: null };
  }

  const left = typeof incoming === "string" ? analyzeCacheQuestion(incoming) : incoming;
  const right = typeof cached === "string" ? analyzeCacheQuestion(cached) : cached;
  const reject = (reason, detail = null) => ({ ok: false, reason, detail });

  if (!sameSequence(left.negations, right.negations)) {
    return reject("negation", "negators differ");
  }

  const prefixNegation =
    findPrefixNegation(left.words, right.words) ?? findPrefixNegation(right.words, left.words);

  if (prefixNegation) {
    return reject("negation", prefixNegation);
  }

  const antonym = findAntonymSwap(left.words, right.words);

  if (antonym) {
    return reject("negation", antonym);
  }

  if (!sameSequence(left.negationScope, right.negationScope)) {
    return reject("negation", "negator moved");
  }

  if (!sameSequence(left.numbers, right.numbers)) {
    return reject("number");
  }

  if (!sameSequence(left.dates, right.dates)) {
    return reject("date");
  }

  if (left.entities && right.entities && !sameSequence(left.entities, right.entities)) {
    return reject("entity");
  }

  if (mode === "required") {
    return { ok: true, reason: null, detail: null };
  }

  if (!sameSequence(left.modals, right.modals)) {
    return reject("modal");
  }

  if ((left.script !== null || right.script !== null) && left.script !== right.script) {
    return reject("script");
  }

  if (!sameSequence(left.content, right.content)) {
    return reject("content");
  }

  return { ok: true, reason: null, detail: null };
};
