import { extractMeaningfulTokens, normalizeSearchText } from "../text-utils.js";
import {
  CHINESE_MODALITY_SURFACE_PATTERN,
  CLAIM_LEAD_LABEL_PATTERN,
  DATE_PATTERN,
  DOTTED_ABBREVIATION_PATTERN,
  FACT_TERM_ALIASES,
  GROUPED_SOURCE_LABEL_PATTERN,
  NEGATIVE_POLARITY_PATTERN,
  NUMBER_PATTERN,
  NUMERIC_CONSTRAINT_PATTERNS,
  REPORTIVE_STATED_WRAPPER_PATTERN,
  SOURCE_LABEL_PATTERN,
  SOURCE_LABEL_CAPTURE_PATTERN,
} from "./patterns.js";

const UNICODE_DECIMAL_DIGIT_BASES = [
  0x0660,
  0x06f0,
  0x0966,
  0x09e6,
];

const normalizeUnicodeDecimalDigits = (value = "") =>
  [...value].map((character) => {
    const codePoint = character.codePointAt(0);
    const base = UNICODE_DECIMAL_DIGIT_BASES.find(
      (candidate) => codePoint >= candidate && codePoint <= candidate + 9
    );

    return base === undefined ? character : String(codePoint - base);
  }).join("");

export const normalizeSemanticText = (value = "") =>
  normalizeUnicodeDecimalDigits(String(value ?? "").normalize("NFKC"))
    .replace(/[\u2018\u2019\u02bc\uff07]/g, "'");

export const normalizeEvidenceText = (value) =>
  normalizeSemanticText(value).trim();

const QUOTED_TEXT_PATTERN = /["“]([^"”]+)["”]/gu;
const REFUTED_QUOTE_SUFFIX_PATTERN =
  /^\s*(?:(?:is|was|remains?)\s+)?(?:false|incorrect|inaccurate|misleading|untrue)\b/i;

export const isRefutedQuotedClaim = ({
  claimText = "",
  supportText = "",
} = {}) => {
  const normalizedClaim = normalizeSearchText(claimText);
  const text = normalizeSemanticText(supportText);

  if (!normalizedClaim || !text) {
    return false;
  }

  QUOTED_TEXT_PATTERN.lastIndex = 0;
  const refuted = [...text.matchAll(QUOTED_TEXT_PATTERN)].some((match) => {
    const quotedText = normalizeSearchText(match[1]);
    const suffix = text.slice((match.index ?? 0) + match[0].length);

    return (
      quotedText === normalizedClaim &&
      REFUTED_QUOTE_SUFFIX_PATTERN.test(suffix)
    );
  });
  QUOTED_TEXT_PATTERN.lastIndex = 0;

  return refuted;
};

export const uniqueValues = (values = []) => [...new Set(values.filter(Boolean))];

export const canonicalizeFactTerm = (term = "") => FACT_TERM_ALIASES.get(term) ?? term;

const ENGLISH_NUMBER_VALUES = new Map([
  ["zero", 0],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
  ["thirty", 30],
  ["forty", 40],
  ["fifty", 50],
  ["sixty", 60],
  ["seventy", 70],
  ["eighty", 80],
  ["ninety", 90],
]);
const ENGLISH_NUMBER_SCALE_VALUES = new Map([
  ["hundred", 100],
  ["thousand", 1_000],
  ["million", 1_000_000],
]);
const ENGLISH_NUMBER_TOKEN_SOURCE = [
  ...ENGLISH_NUMBER_VALUES.keys(),
  ...ENGLISH_NUMBER_SCALE_VALUES.keys(),
].join("|");
const ENGLISH_NUMBER_SEQUENCE_PATTERN = new RegExp(
  `\\b(?:${ENGLISH_NUMBER_TOKEN_SOURCE})(?:(?:[ -]+and)?[ -]+(?:${ENGLISH_NUMBER_TOKEN_SOURCE}))*\\b`,
  "gi"
);
const ENGLISH_SIMPLE_NUMBER_SOURCE = [
  ...ENGLISH_NUMBER_VALUES.keys(),
].join("|");
const ENGLISH_MIXED_FRACTION_PATTERN = new RegExp(
  `\\b(${ENGLISH_SIMPLE_NUMBER_SOURCE})\\s+and\\s+a\\s+half\\b`,
  "gi"
);
const ENGLISH_DOZEN_PATTERN = new RegExp(
  `\\b(?:a|(${ENGLISH_SIMPLE_NUMBER_SOURCE}))\\s+dozen\\b`,
  "gi"
);
const CHINESE_NUMBER_VALUES = new Map([
  ["零", 0],
  ["〇", 0],
  ["一", 1],
  ["二", 2],
  ["两", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9],
]);
const CHINESE_NUMBER_WITH_UNIT_PATTERN =
  /([零〇一二两三四五六七八九十百千万]{1,12})(?=\s*(?:%|个|人|元|天|小时|分钟|周|年|日|月|次|章|席|项|页))/g;

const parseEnglishIntegerWords = (value = "") => {
  const words = value.toLowerCase().split(/[\s-]+/).filter(Boolean);
  const conjunctionIndexes = words.flatMap((word, index) =>
    word === "and" ? [index] : []
  );

  if (
    conjunctionIndexes.some(
      (index) =>
        !words
          .slice(0, index)
          .some((word) => ENGLISH_NUMBER_SCALE_VALUES.has(word))
    )
  ) {
    return null;
  }

  let total = 0;
  let current = 0;

  for (const word of words) {
    if (word === "and") {
      continue;
    }
    if (ENGLISH_NUMBER_VALUES.has(word)) {
      current += ENGLISH_NUMBER_VALUES.get(word);
      continue;
    }
    if (word === "hundred") {
      current = (current || 1) * 100;
      continue;
    }
    const scale = ENGLISH_NUMBER_SCALE_VALUES.get(word);

    if (!scale) {
      return null;
    }

    total += (current || 1) * scale;
    current = 0;
  }

  return total + current;
};

const parseChineseIntegerWords = (value = "") => {
  if (!/[十百千万]/.test(value)) {
    const digits = [...value].map((character) =>
      CHINESE_NUMBER_VALUES.get(character)
    );

    return digits.every((digit) => digit !== undefined)
      ? Number(digits.join(""))
      : null;
  }

  const smallUnits = new Map([
    ["十", 10],
    ["百", 100],
    ["千", 1_000],
  ]);
  let total = 0;
  let section = 0;
  let pendingDigit = 0;

  for (const character of value) {
    if (CHINESE_NUMBER_VALUES.has(character)) {
      pendingDigit = CHINESE_NUMBER_VALUES.get(character);
      continue;
    }
    if (character === "万") {
      section += pendingDigit;
      total += (section || 1) * 10_000;
      section = 0;
      pendingDigit = 0;
      continue;
    }
    const unit = smallUnits.get(character);

    if (!unit) {
      return null;
    }

    section += (pendingDigit || 1) * unit;
    pendingDigit = 0;
  }

  return total + section + pendingDigit;
};

const normalizeEnglishNumberWords = (value = "") =>
  String(value ?? "")
    .replace(ENGLISH_MIXED_FRACTION_PATTERN, (match, wholeWord) => {
      const whole = ENGLISH_NUMBER_VALUES.get(String(wholeWord).toLowerCase());
      return Number.isFinite(whole) ? String(whole + 0.5) : match;
    })
    .replace(/\b(?:one[- ]half|a\s+half|half)\b/gi, "0.5")
    .replace(ENGLISH_DOZEN_PATTERN, (match, countWord) => {
      const count = countWord
        ? ENGLISH_NUMBER_VALUES.get(String(countWord).toLowerCase())
        : 1;
      return Number.isFinite(count) ? String(count * 12) : match;
    })
    .replace(ENGLISH_NUMBER_SEQUENCE_PATTERN, (match) => {
      const parsed = parseEnglishIntegerWords(match);
      return Number.isFinite(parsed) ? String(parsed) : match;
    });

const normalizeChineseNumberWords = (value = "") =>
  String(value ?? "").replace(
    CHINESE_NUMBER_WITH_UNIT_PATTERN,
    (match, numberWords) => {
      const parsed = parseChineseIntegerWords(numberWords);
      return Number.isFinite(parsed) ? String(parsed) : match;
    }
  );

export const normalizeDottedAbbreviationsForTokens = (value = "") =>
  String(value ?? "").replace(DOTTED_ABBREVIATION_PATTERN, (match) =>
    match.replaceAll(".", "")
  );

export const normalizeReportiveWrappersForTokens = (value = "") =>
  String(value ?? "").replace(
    REPORTIVE_STATED_WRAPPER_PATTERN,
    "$1 to be"
  );

export const extractOrderedFactTerms = (value = "") =>
  extractMeaningfulTokens(
    normalizeReportiveWrappersForTokens(
      normalizeDottedAbbreviationsForTokens(normalizeSemanticText(value))
    )
  ).map(canonicalizeFactTerm);

export const extractFactTerms = (value = "") =>
  uniqueValues(extractOrderedFactTerms(value));

export const normalizeNumericSyntax = (value = "") => {
  const normalizedSigns = normalizeSemanticText(value)
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .replace(/[()[\]{}]/g, " ")
    .replace(/[−﹣－]/g, "-")
    .replace(/[＋﹢]/g, "+")
    .replace(/([$€£¥])\s+(?=[+-]?\d)/g, "$1")
    .replace(/([$€£¥])\s*([+-])\s*(?=\d)/g, "$2$1")
    .replace(/([+-])\s*([$€£¥])\s*(?=\d)/g, "$1$2")
    .replace(/([+-])\s+(?=\d)/g, "$1");
  const normalizedWords = normalizeChineseNumberWords(
    normalizeEnglishNumberWords(normalizedSigns)
  );

  return normalizedWords
    .replace(/\b(?:minus|negative)\s+(?=[$€£¥]?\d)/gi, "-")
    .replace(/\b(?:plus|positive)\s+(?=[$€£¥]?\d)/gi, "+")
    .replace(/负\s*(?=[$€£¥]?\d)/g, "-")
    .replace(/正\s*(?=[$€£¥]?\d)/g, "+");
};

export const extractDateValues = (value = "") => {
  const text = normalizeNumericSyntax(value);
  DATE_PATTERN.lastIndex = 0;
  const dates = [...text.matchAll(DATE_PATTERN)].map((match) =>
    normalizeSearchText(match[0])
  );
  DATE_PATTERN.lastIndex = 0;

  return uniqueValues(dates);
};

export const stripNumericValueSurfaces = (value = "") => {
  return normalizeNumericSyntax(value).replace(
    /[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?/g,
    " "
  );
};

export const stripSourceLabels = (value = "") =>
  String(value ?? "").replace(SOURCE_LABEL_PATTERN, "").trim();

export const stripClaimLeadLabel = (value = "") =>
  stripSourceLabels(value)
    .replace(/^[-*]\s+/, "")
    .replace(CLAIM_LEAD_LABEL_PATTERN, "")
    .trim();

export const extractSourceRanks = (value = "") =>
  uniqueValues(
    [...String(value ?? "").matchAll(SOURCE_LABEL_CAPTURE_PATTERN)].map(
      (match) => Number(match[1])
    )
  ).filter((rank) => Number.isInteger(rank) && rank > 0);

export const normalizeGroupedSourceLabels = (value = "") =>
  String(value ?? "").replace(GROUPED_SOURCE_LABEL_PATTERN, (group) =>
    [...group.matchAll(/(?:source|来源)\s*(\d+)/gi)]
      .map((match) => `[Source ${match[1]}]`)
      .join(" ")
  );

export const normalizeNumericAnchor = (value = "") => {
  const compact = normalizeNumericSyntax(value)
    .replace(/,/g, "")
    .replace(/^([+-]?)[$€£¥]/, "$1")
    .trim();
  const percentage = compact.endsWith("%");
  const numericValue = Number(percentage ? compact.slice(0, -1) : compact);

  return Number.isFinite(numericValue)
    ? `${numericValue}${percentage ? "%" : ""}`
    : compact.toLowerCase();
};

export const normalizeNumericConstraint = (value = "") => {
  const compact = normalizeNumericSyntax(value)
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const outsideRange =
    /^(?:except(?:ing)?|excluding|outside(?:\s+of)?)\s+/.test(compact);
  const rangeSurface = compact
    .replace(/^(?:except(?:ing)?|excluding|outside(?:\s+of)?)\s+/, "")
    .replace(/^(?:between|from)\s+/, "");
  const range = rangeSurface.match(
    /^([+-]?[$€£¥]?\d+(?:\.\d+)?%?)\s*(?:-|–|—|to|through|and)\s*([+-]?[$€£¥]?\d+(?:\.\d+)?%?)$/
  );

  if (range) {
    return `${outsideRange ? "outside_range" : "range"}:${normalizeNumericAnchor(
      range[1]
    )}:${normalizeNumericAnchor(range[2])}`;
  }

  const numbers = compact.match(/[+-]?[$€£¥]?\d+(?:\.\d+)?%?/g) ?? [];
  const normalizedNumbers = numbers.map(normalizeNumericAnchor);

  if (
    /^(?:at least|at or above|greater than or equal to|higher than or equal to|minimum(?: of)?|no fewer than)\s+(?:about|approx(?:imately)?(?: equal to)?|around|ca\.?|circa|close to|near|roughly)\b/.test(
      compact
    )
  ) {
    return `gte_approx:${normalizedNumbers[0] ?? ""}`;
  }
  if (
    /^(?:up to|at most|at or below|less than or equal to|lower than or equal to|maximum(?: of)?|no more than|limit of|limited to|capped at)\s+(?:about|approx(?:imately)?(?: equal to)?|around|ca\.?|circa|close to|near|roughly)\b/.test(
      compact
    )
  ) {
    return `lte_approx:${normalizedNumbers[0] ?? ""}`;
  }
  if (
    /^(?:more than|greater than|higher than|over|above|exceeding)\s+(?:about|approx(?:imately)?(?: equal to)?|around|ca\.?|circa|close to|near|roughly)\b/.test(
      compact
    ) ||
    /^(?:超过|高于)(?:允许|可以|为|是)?(?:约|大约|大概|近)/.test(compact)
  ) {
    return `gt_approx:${normalizedNumbers[0] ?? ""}`;
  }
  if (
    /^(?:less than|fewer than|lower than|under|below)\s+(?:about|approx(?:imately)?(?: equal to)?|around|ca\.?|circa|close to|near|roughly)\b/.test(
      compact
    ) ||
    /^(?:少于|低于)(?:允许|可以|为|是)?(?:约|大约|大概|近)/.test(compact)
  ) {
    return `lt_approx:${normalizedNumbers[0] ?? ""}`;
  }
  if (
    /^within\s+(?:about|approx(?:imately)?(?: equal to)?|around|ca\.?|circa|close to|near|roughly)\b/.test(
      compact
    )
  ) {
    return `within_approx:${normalizedNumbers[0] ?? ""}`;
  }
  if (
    /^(?:至少|不少于)(?:允许|可以|为|是)?(?:约|大约|大概|近)/.test(
      compact
    )
  ) {
    return `gte_approx:${normalizedNumbers[0] ?? ""}`;
  }
  if (
    /^(?:最多|至多|不超过)(?:允许|可以|为|是)?(?:约|大约|大概|近)/.test(
      compact
    )
  ) {
    return `lte_approx:${normalizedNumbers[0] ?? ""}`;
  }

  if (/^(?:nearly|almost)\b/.test(compact)) {
    return `approx_below:${normalizedNumbers[0] ?? ""}`;
  }
  if (
    /^(?:about|approx(?:imately)?(?:\s+equal\s+to)?|around|ca\.?|circa|close\s+to|near|roughly|[~≈])\s*/.test(
      compact
    ) ||
    /^(?:约|大约|大概|近)(?:为|是)?/.test(compact) ||
    /\b(?:about|approx(?:imately)?|around|circa|roughly)$/.test(compact)
  ) {
    return `approx:${normalizedNumbers[0] ?? ""}`;
  }

  if (
    /^(?:at least|at or above|greater than or equal to|higher than or equal to|minimum(?: of)?|no fewer than)\b/.test(
      compact
    ) ||
    /^(?:至少|不少于)/.test(compact) ||
    /\b(?:at least|no fewer than)$/.test(compact) ||
    /(?:以上|起)$/.test(compact)
  ) {
    return `gte:${normalizedNumbers[0] ?? ""}`;
  }
  if (
    /^(?:up to|at most|at or below|less than or equal to|lower than or equal to|maximum(?: of)?|no more than|limit of|limited to|capped at)\b/.test(
      compact
    ) ||
    /\b(?:or|and)\s+(?:below|fewer|less|lower)$/.test(compact) ||
    /^(?:<=|≤|≦)/.test(compact) ||
    /^(?:最多|至多|不超过)/.test(compact) ||
    /\b(?:max(?:imum)?|tops?|at most|no more than)$/.test(compact) ||
    /(?:以下|以内|内)$/.test(compact)
  ) {
    return `lte:${normalizedNumbers[0] ?? ""}`;
  }
  if (/^within\b/.test(compact)) {
    return `within:${normalizedNumbers[0] ?? ""}`;
  }
  if (
    /^(?:only|just|exactly|equal to)\b/.test(compact) ||
    /\b(?:only|just)$/.test(compact) ||
    compact.startsWith("=") ||
    /^(?:恰好|仅)/.test(compact)
  ) {
    return `eq:${normalizedNumbers[0] ?? ""}`;
  }
  if (/左右$/.test(compact)) {
    return `approx:${normalizedNumbers[0] ?? ""}`;
  }
  if (
    compact.startsWith(">=") ||
    compact.startsWith("≥") ||
    compact.startsWith("≧") ||
    compact.endsWith("+") ||
    /\b(?:or|and)\s+(?:above|greater|higher|longer|more|over)$/.test(compact) ||
    /\b(?:minimum|min)$/.test(compact)
  ) {
    return `gte:${normalizedNumbers[0] ?? ""}`;
  }
  if (
    compact.startsWith(">") ||
    /^(?:more than|greater than|higher than|over|above|exceeding)\b/.test(compact) ||
    /^(?:超过|高于)/.test(compact)
  ) {
    return `gt:${normalizedNumbers[0] ?? ""}`;
  }
  if (
    compact.startsWith("<") ||
    /^(?:less than|fewer than|lower than|under|below)\b/.test(compact) ||
    /^(?:少于|低于)/.test(compact)
  ) {
    return `lt:${normalizedNumbers[0] ?? ""}`;
  }
  if (compact.startsWith("±")) {
    return `plusminus:${normalizedNumbers[0] ?? ""}`;
  }
  if (normalizedNumbers.length === 2) {
    return `range:${normalizedNumbers.join(":")}`;
  }

  return compact;
};

const extractNumericConstraintOccurrences = (value = "") => {
  const normalizedText = normalizeNumericSyntax(value);
  DATE_PATTERN.lastIndex = 0;
  const dateSpans = [...normalizedText.matchAll(DATE_PATTERN)].map((match) => ({
    end: (match.index ?? 0) + match[0].length,
    index: match.index ?? 0,
  }));
  DATE_PATTERN.lastIndex = 0;
  const overlapsDate = ({ end, index }) =>
    dateSpans.some((date) => index < date.end && end > date.index);
  const candidates = NUMERIC_CONSTRAINT_PATTERNS.flatMap((pattern) => {
    pattern.lastIndex = 0;
    const matches = [...normalizedText.matchAll(pattern)]
      .map((match) => ({
        end: (match.index ?? 0) + match[0].length,
        index: match.index ?? 0,
        normalized: normalizeNumericConstraint(match[0]),
        text: match[0],
      }))
      .filter((candidate) => !overlapsDate(candidate));
    pattern.lastIndex = 0;
    return matches;
  }).sort(
    (left, right) =>
      left.index - right.index ||
      right.end - right.index - (left.end - left.index)
  );
  const selected = [];
  let selectedEnd = -1;

  for (const candidate of candidates) {
    if (candidate.index < selectedEnd) {
      continue;
    }

    selected.push(candidate);
    selectedEnd = candidate.end;
  }

  return selected
    .map((candidate) => {
      const prefixText = normalizedText.slice(
        Math.max(0, candidate.index - 48),
        candidate.index
      );
      const suffixText = normalizedText.slice(
        candidate.end,
        Math.min(normalizedText.length, candidate.end + 48)
      );
      const unconsumedQualifier =
        UNPARSED_NUMERIC_PREFIX_HINT_PATTERN.test(prefixText) ||
        UNPARSED_NUMERIC_SUFFIX_HINT_PATTERN.test(suffixText);

      return unconsumedQualifier
        ? {
            ...candidate,
            normalized: `unknown:${candidate.normalized}`,
          }
        : candidate;
    })
    .sort((left, right) => left.index - right.index);
};

const UNPARSED_NUMERIC_PREFIX_HINT_PATTERN =
  /(?:\b(?:above|almost|approx(?:imately)?|around|at\s+least|at\s+most|at\s+or\s+(?:above|below)|below|cap(?:ped)?\s+at|circa|close\s+to|equal\s+to|except(?:ing)?|exceeding|excluding|fewer\s+than|greater\s+than|higher\s+than|less\s+than|lower\s+than|maximum(?:\s+of)?|minimum(?:\s+of)?|more\s+than|near|nearly|no\s+(?:fewer|more)\s+than|only|outside(?:\s+of)?|over|roughly|under|up\s+to|within)\s*|[~≈]\s*|(?:最多|至多|不超过|至少|不少于|少于|低于|超过|高于|恰好|仅|约|大约|大概|近)(?:允许|可以|为|是)?\s*)$/i;
const UNPARSED_NUMERIC_SUFFIX_HINT_PATTERN =
  /^\s*(?:(?:[a-z]+\s+){0,3}(?:(?:or|and)\s+(?:above|below|fewer|greater|higher|less|longer|lower|more|over)|at\s+least|at\s+most|no\s+(?:fewer|more)\s+than|about|approx(?:imately)?|around|circa|max(?:imum)?|min(?:imum)?|only|roughly|tops?)\b|(?:个?工作日|天|日|周|月|年|小时|分钟|个|人|次|项|元|席|页)?\s*(?:及|或)?(?:以上|以下|以内|左右|内|起))/i;

export const extractNumericOccurrences = (value = "") => {
  const normalizedText = normalizeNumericSyntax(value);
  const constraints = extractNumericConstraintOccurrences(normalizedText);
  DATE_PATTERN.lastIndex = 0;
  const dateSpans = [...normalizedText.matchAll(DATE_PATTERN)].map((match) => ({
    end: (match.index ?? 0) + match[0].length,
    index: match.index ?? 0,
  }));
  DATE_PATTERN.lastIndex = 0;
  NUMBER_PATTERN.lastIndex = 0;
  const bareNumbers = [...normalizedText.matchAll(NUMBER_PATTERN)]
    .filter((match) => {
      const index = match.index ?? 0;
      const end = index + match[0].length;

      return !constraints.some(
        (constraint) => index >= constraint.index && end <= constraint.end
      ) && !dateSpans.some((date) => index < date.end && end > date.index);
    })
    .map((match) => {
      const index = match.index ?? 0;
      const end = index + match[0].length;
      const prefixText = normalizedText.slice(Math.max(0, index - 48), index);
      const suffixText = normalizedText.slice(
        end,
        Math.min(normalizedText.length, end + 48)
      );
      const unknownQualifier =
        UNPARSED_NUMERIC_PREFIX_HINT_PATTERN.test(prefixText) ||
        UNPARSED_NUMERIC_SUFFIX_HINT_PATTERN.test(suffixText);
      const normalizedValue = normalizeNumericAnchor(match[0]);

      return {
        end,
        index,
        normalized: unknownQualifier
          ? `unknown:${normalizedValue}`
          : normalizedValue,
        operator: unknownQualifier ? "unknown" : "bare",
        text: match[0],
        type: unknownQualifier ? "numeric_constraint" : "number",
        values: [normalizedValue],
      };
    });
  NUMBER_PATTERN.lastIndex = 0;

  return [
    ...constraints.map((constraint) => ({
      ...constraint,
      operator: constraint.normalized.split(":", 1)[0],
      type: "numeric_constraint",
      values: constraint.normalized.split(":").slice(1),
    })),
    ...bareNumbers,
  ].sort((left, right) => left.index - right.index);
};

export const extractNumericConstraintTexts = (value = "") =>
  uniqueValues(
    extractNumericConstraintOccurrences(value).map(
      (occurrence) => occurrence.text
    )
  );

export const includesNormalizedPhrase = (text = "", phrase = "") =>
  (() => {
    const normalizedText = normalizeSearchText(text);
    const normalizedPhrase = normalizeSearchText(phrase);

    if (!normalizedPhrase) {
      return false;
    }

    if (/[一-鿿]/.test(normalizedPhrase)) {
      return normalizedText
        .replace(/\s+/g, "")
        .includes(normalizedPhrase.replace(/\s+/g, ""));
    }

    return ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
  })();

export const getChineseModalitySurfaceTerms = (value = "") => {
  CHINESE_MODALITY_SURFACE_PATTERN.lastIndex = 0;
  const matches = String(value ?? "").match(CHINESE_MODALITY_SURFACE_PATTERN) ?? [];
  CHINESE_MODALITY_SURFACE_PATTERN.lastIndex = 0;

  return new Set(matches.flatMap((match) => extractMeaningfulTokens(match)));
};

export const hasNegativePolarity = (value = "") =>
  NEGATIVE_POLARITY_PATTERN.test(normalizeSemanticText(value));

export const getTokenOverlap = ({ claimTerms, supportTerms }) => {
  if (claimTerms.length === 0) {
    return 1;
  }

  const matchedTerms = claimTerms.filter((term) => supportTerms.has(term));

  return Number((matchedTerms.length / claimTerms.length).toFixed(4));
};

export const haveSameValues = (leftValues = [], rightValues = []) => {
  const left = new Set(leftValues);
  const right = new Set(rightValues);

  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
};

export const normalizeStructuralClaimLabel = (value = "") =>
  stripSourceLabels(value)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\*\*([\s\S]*?)\*\*$/, "$1")
    .replace(/^__([\s\S]*?)__$/, "$1")
    .replace(/\s*(?:[:：]|[-–—]+)\s*$/, "")
    .trim();

export const isAnchorSupported = ({ anchor, rawSupportText = "" } = {}) => {
  if (anchor.type === "numeric_constraint") {
    if (String(anchor.normalized).startsWith("unknown:")) {
      return false;
    }

    return extractNumericConstraintTexts(rawSupportText).some(
      (candidate) =>
        normalizeNumericConstraint(candidate) === anchor.normalized
    );
  }

  if (anchor.type === "number") {
    return (rawSupportText.match(NUMBER_PATTERN) ?? []).some(
      (candidate) =>
        normalizeNumericAnchor(candidate) === normalizeNumericAnchor(anchor.text)
    );
  }

  return includesNormalizedPhrase(rawSupportText, anchor.normalized);
};
