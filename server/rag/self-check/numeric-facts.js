import {
  CLAIM_PREDICATE_PATTERN,
  COMPARISON_SCAFFOLD_TERMS,
  DOCUMENT_ATTRIBUTION_VERBS,
  DOCUMENT_IDENTITY_TERMS,
  MODALITY_CLAIM_TERMS,
  NUMERIC_CONSTRAINT_SURFACE_TERMS,
} from "./patterns.js";
import {
  extractFactTerms,
  extractNumericOccurrences,
  normalizeNumericSyntax,
  stripNumericValueSurfaces,
  uniqueValues,
} from "./text.js";

export const NUMERIC_MEASUREMENT_TERMS = new Set([
  "allowance",
  "allowances",
  "amount",
  "amounts",
  "budget",
  "budgets",
  "count",
  "counts",
  "cost",
  "costs",
  "day",
  "days",
  "dollar",
  "dollars",
  "duration",
  "durations",
  "each",
  "every",
  "hour",
  "hours",
  "limit",
  "limits",
  "month",
  "months",
  "minute",
  "minutes",
  "percentage",
  "percentages",
  "per",
  "rate",
  "rates",
  "threshold",
  "thresholds",
  "time",
  "times",
  "unit",
  "units",
  "value",
  "values",
  "week",
  "weeks",
  "year",
  "years",
]);

const NUMERIC_ROLE_SYNTAX_TERMS = new Set([
  "addition",
  "alongside",
  "also",
  "following",
  "respectively",
  "together",
  "上",
  "下",
  "以",
  "内",
  "及",
  "右",
  "左",
  "或",
]);
const NUMERIC_METADATA_TERMS = new Set([
  "page",
  "policy",
  "revision",
  "rule",
  "section",
  "version",
]);

const POSITIONAL_TOKEN_PATTERN = /[A-Za-z]+|[\u4e00-\u9fff]/g;
const TRAILING_QUALIFIER_PATTERN =
  /\b(?:after|before|during|for|subject\s+to|to|unless)\s+([^,;.!?。！？]*)$/i;
const DIRECTIONAL_PREDICATE_PATTERN =
  /\b(?:assign(?:ed|s|ing)?|give(?:s|n|ing)?|grant(?:ed|s|ing)?|owe(?:d|s|ing)?|pay(?:s|ing|paid)?|provide(?:d|s|ing)?|receive(?:d|s|ing)?|send(?:s|ing|sent)?|transfer(?:red|s|ring)?)\b/i;

const normalizeDirectionalPredicate = (value = "") => {
  const predicate = value.toLowerCase();

  if (/^assign/.test(predicate)) return "assign";
  if (/^giv/.test(predicate)) return "give";
  if (/^grant/.test(predicate)) return "grant";
  if (/^ow/.test(predicate)) return "owe";
  if (/^(?:pay|paid)/.test(predicate)) return "pay";
  if (/^provid/.test(predicate)) return "provide";
  if (/^receiv/.test(predicate)) return "receive";
  if (/^(?:send|sent)/.test(predicate)) return "send";
  if (/^transfer/.test(predicate)) return "transfer";

  return predicate;
};

const CURRENCY_SYMBOLS = new Map([
  ["$", "USD"],
  ["€", "EUR"],
  ["£", "GBP"],
  ["¥", "JPY"],
]);
const MIXED_CURRENCY = "mixed";
const CURRENCY_WORD_PATTERNS = [
  { currency: "USD", pattern: /\b(?:usd|u\.?s\.?\s+dollars?|dollars?)\b/i },
  { currency: "EUR", pattern: /\b(?:eur|euros?)\b/i },
  { currency: "GBP", pattern: /\b(?:gbp|pounds?(?:\s+sterling)?)\b/i },
  { currency: "CNY", pattern: /\b(?:cny|rmb|renminbi|yuan)\b/i },
  { currency: "JPY", pattern: /\b(?:jpy|yen)\b/i },
];
const ENGLISH_MEASUREMENT_ALIASES = new Map([
  ["business day", "business_day"],
  ["business days", "business_day"],
  ["working day", "working_day"],
  ["working days", "working_day"],
  ["milliseconds", "millisecond"],
  ["millisecond", "millisecond"],
  ["minutes", "minute"],
  ["minute", "minute"],
  ["hours", "hour"],
  ["hour", "hour"],
  ["days", "day"],
  ["day", "day"],
  ["weeks", "week"],
  ["week", "week"],
  ["months", "month"],
  ["month", "month"],
  ["years", "year"],
  ["year", "year"],
  ["percentages", "percent"],
  ["percentage", "percent"],
  ["percent", "percent"],
]);
const ENGLISH_MEASUREMENT_MODIFIER_SOURCE =
  "(?:annual|calendar|consecutive|daily|monthly|remote|weekly|yearly)";
const CHINESE_MEASUREMENT_ALIASES = new Map([
  ["工作日", "day"],
  ["毫秒", "millisecond"],
  ["分钟", "minute"],
  ["小时", "hour"],
  ["天", "day"],
  ["日", "day"],
  ["周", "week"],
  ["月", "month"],
  ["年", "year"],
  ["元", "currency:CNY"],
  ["百分比", "percent"],
]);

const canonicalizeMeasurementTerm = (term = "") => {
  const normalized = term.toLowerCase();

  if (ENGLISH_MEASUREMENT_ALIASES.has(normalized)) {
    return ENGLISH_MEASUREMENT_ALIASES.get(normalized);
  }
  if (normalized.endsWith("ies") && normalized.length > 3) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (normalized.endsWith("s") && !normalized.endsWith("ss")) {
    return normalized.slice(0, -1);
  }

  return normalized;
};

const getCurrency = ({ occurrence = {}, text = "" } = {}) => {
  const occurrenceCurrencies = uniqueValues(
    [...CURRENCY_SYMBOLS].flatMap(([symbol, currency]) =>
      occurrence.text?.includes(symbol) ? [currency] : []
    )
  );

  if (occurrenceCurrencies.length > 1) {
    return MIXED_CURRENCY;
  }
  if (occurrenceCurrencies.length === 1) {
    return occurrenceCurrencies[0];
  }

  const prefixText = text.slice(Math.max(0, occurrence.index - 24), occurrence.index);
  const suffixText = text.slice(occurrence.end, occurrence.end + 24);

  for (const { currency, pattern } of CURRENCY_WORD_PATTERNS) {
    const source = pattern.source.replace(/^\\b/, "").replace(/\\b$/, "");
    const prefixPattern = new RegExp(`(?:${source})\\s*$`, "i");
    const suffixPattern = new RegExp(
      `^\\s*(?:${source})(?=\\s*(?:$|[.,;:!?，。；：！？)]|\\bper\\b))`,
      "i"
    );

    if (prefixPattern.test(prefixText) || suffixPattern.test(suffixText)) {
      return currency;
    }
  }

  const adjacentSymbol = prefixText.match(/([$€£¥])\s*$/)?.[1];

  return adjacentSymbol ? CURRENCY_SYMBOLS.get(adjacentSymbol) ?? "" : "";
};

const getLocalMeasurementTerms = ({
  currency = "",
  nextOccurrence,
  occurrence = {},
  text = "",
} = {}) => {
  if (currency) {
    return [`currency:${currency}`];
  }
  if (occurrence.text?.includes("%")) {
    return ["percent"];
  }

  const suffixEnd = Math.min(
    nextOccurrence?.index ?? text.length,
    occurrence.end + 40
  );
  const numericSurface = String(occurrence.text ?? "").match(
    /[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?/
  );
  const occurrenceTail = numericSurface
    ? String(occurrence.text ?? "").slice(
        (numericSurface.index ?? 0) + numericSurface[0].length
      )
    : String(occurrence.text ?? "");
  const trailingSurface = text
    .slice(occurrence.end, suffixEnd)
    .split(/[,.!?;，。！？；]|\b(?:and|but|while|whereas)\b/i, 1)[0];
  const localSurface = `${occurrenceTail} ${trailingSurface}`;
  const measurementSurface = localSurface.replace(
    /^\s*(?:(?:and|to|through|[-–—])\s*)?[+-]?[$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?%?\s*/i,
    ""
  );

  for (const [surface, measurement] of CHINESE_MEASUREMENT_ALIASES) {
    if (new RegExp(`^\\s*${surface}`).test(measurementSurface)) {
      return [measurement];
    }
  }
  for (const [surface, measurement] of ENGLISH_MEASUREMENT_ALIASES) {
    if (
      new RegExp(
        `^\\s*(?:${ENGLISH_MEASUREMENT_MODIFIER_SOURCE}\\s+){0,2}${surface.replace(" ", "\\s+")}\\b`,
        "i"
      ).test(measurementSurface)
    ) {
      return [measurement];
    }
  }

  const suffixTerms = extractFactTerms(
    stripNumericValueSurfaces(measurementSurface)
  ).filter(
    (term) =>
      !NUMERIC_CONSTRAINT_SURFACE_TERMS.has(term) &&
      !NUMERIC_ROLE_SYNTAX_TERMS.has(term) &&
      !CLAIM_PREDICATE_PATTERN.test(term)
  );

  if (suffixTerms.length > 0) {
    return [canonicalizeMeasurementTerm(suffixTerms[0])];
  }

  const prefixTerms = extractFactTerms(
    text.slice(Math.max(0, occurrence.index - 32), occurrence.index)
  ).filter((term) => NUMERIC_MEASUREMENT_TERMS.has(term));

  return prefixTerms.length > 0
    ? [canonicalizeMeasurementTerm(prefixTerms.at(-1))]
    : [];
};

const isRoleTerm = (term, ignoredTerms = new Set()) =>
  !ignoredTerms.has(term) &&
  !COMPARISON_SCAFFOLD_TERMS.has(term) &&
  !MODALITY_CLAIM_TERMS.has(term) &&
  !NUMERIC_CONSTRAINT_SURFACE_TERMS.has(term) &&
  !DOCUMENT_ATTRIBUTION_VERBS.has(term) &&
  !DOCUMENT_IDENTITY_TERMS.has(term) &&
  !NUMERIC_METADATA_TERMS.has(term) &&
  !NUMERIC_ROLE_SYNTAX_TERMS.has(term) &&
  !CLAIM_PREDICATE_PATTERN.test(term);

const extractPositionalRoleTerms = (text = "", ignoredTerms = new Set()) => {
  POSITIONAL_TOKEN_PATTERN.lastIndex = 0;
  const terms = [...text.matchAll(POSITIONAL_TOKEN_PATTERN)].flatMap((match) =>
    extractFactTerms(match[0])
      .filter((term) => isRoleTerm(term, ignoredTerms))
      .map((term) => ({
        end: (match.index ?? 0) + match[0].length,
        index: match.index ?? 0,
        term,
      }))
  );
  POSITIONAL_TOKEN_PATTERN.lastIndex = 0;
  return terms;
};

const distanceBetween = (term, occurrence) => {
  if (term.end <= occurrence.index) {
    return occurrence.index - term.end;
  }
  if (term.index >= occurrence.end) {
    return term.index - occurrence.end;
  }
  return 0;
};

const getNumericOccurrenceSignature = (occurrence) =>
  `${occurrence.type}:${occurrence.normalized}`;

const isMetadataNumericOccurrence = (text = "", occurrence = {}) => {
  const prefix = text.slice(Math.max(0, occurrence.index - 32), occurrence.index);
  const suffix = text.slice(occurrence.end, occurrence.end + 20);

  return (
    /\b(?:page|policy\s+version|rule|section|version)\s*$/i.test(prefix) ||
    /^\s*(?:policy|revision)\b/i.test(suffix) ||
    /第\s*$/.test(prefix)
  );
};

const getSharedSubjectTerms = ({
  ignoredTerms = new Set(),
  text = "",
} = {}) => {
  const predicate = CLAIM_PREDICATE_PATTERN.exec(text);

  if (!predicate || predicate.index === 0) {
    return [];
  }

  return uniqueValues(
    extractPositionalRoleTerms(text.slice(0, predicate.index), ignoredTerms).map(
      ({ term }) => term
    )
  );
};

const getTrailingQualifierTerms = ({
  ignoredTerms = new Set(),
  nextOccurrence,
  occurrence,
  text = "",
} = {}) => {
  const trailingText = text.slice(
    occurrence.end,
    nextOccurrence?.index ?? text.length
  ).replace(/[.!?。！？]+\s*$/g, "");
  const match = trailingText.match(TRAILING_QUALIFIER_PATTERN);

  return match
    ? uniqueValues(
        extractPositionalRoleTerms(match[1], ignoredTerms).map(
          ({ term }) => term
        )
      )
    : [];
};

const getRespectivelyBindingTerms = (text = "", ignoredTerms = new Set()) => {
  const occurrences = extractNumericOccurrences(text);
  const firstOccurrence = occurrences[0];

  if (!firstOccurrence || !/\brespectively\b/i.test(text)) {
    return [];
  }

  return extractPositionalRoleTerms(
    text.slice(0, firstOccurrence.index),
    ignoredTerms
  ).map(({ term }) => term);
};

const getDirectionalFrame = ({
  firstOccurrence,
  ignoredTerms = new Set(),
  text = "",
} = {}) => {
  const predicate = DIRECTIONAL_PREDICATE_PATTERN.exec(text);

  if (!predicate || !firstOccurrence) {
    return {
      actorTerms: [],
      objectTerms: [],
      predicate: "",
    };
  }

  const predicateEnd = predicate.index + predicate[0].length;
  const actorTerms = extractPositionalRoleTerms(
    text.slice(0, predicate.index),
    ignoredTerms
  )
    .map(({ term }) => term)
    .filter((term) => !NUMERIC_MEASUREMENT_TERMS.has(term));
  const objectTerms =
    predicateEnd < firstOccurrence.index
      ? extractPositionalRoleTerms(
          text.slice(predicateEnd, firstOccurrence.index),
          ignoredTerms
        )
          .map(({ term }) => term)
          .filter((term) => !NUMERIC_MEASUREMENT_TERMS.has(term))
      : [];

  return {
    actorTerms: uniqueValues(actorTerms),
    objectTerms: uniqueValues(objectTerms),
    predicate: normalizeDirectionalPredicate(predicate[0]),
  };
};

export const buildNumericOccurrenceFacts = (
  value = "",
  { ignoredTerms = new Set() } = {}
) => {
  const text = normalizeNumericSyntax(value);
  const occurrences = extractNumericOccurrences(text);

  if (occurrences.length === 0) {
    return {
      ambiguous: false,
      facts: [],
      respectivelyTerms: [],
    };
  }

  const metadataFlags = occurrences.map((occurrence) =>
    isMetadataNumericOccurrence(text, occurrence)
  );
  const factOccurrenceIndexes = metadataFlags.flatMap((metadata, index) =>
    metadata ? [] : [index]
  );
  const assignableOccurrenceIndexes =
    factOccurrenceIndexes.length > 0
      ? factOccurrenceIndexes
      : occurrences.map((_occurrence, index) => index);
  const positionalTerms = extractPositionalRoleTerms(text, ignoredTerms);
  const sharedSubjectTerms = getSharedSubjectTerms({ ignoredTerms, text });
  const directionalFrame = getDirectionalFrame({
    firstOccurrence: occurrences.find(
      (_occurrence, index) => !metadataFlags[index]
    ) ?? occurrences[0],
    ignoredTerms,
    text,
  });
  const qualifierTerms = occurrences.map((occurrence, index) =>
    getTrailingQualifierTerms({
      ignoredTerms,
      nextOccurrence: occurrences[index + 1],
      occurrence,
      text,
    })
  );
  const currencies = occurrences.map((occurrence) =>
    getCurrency({ occurrence, text })
  );
  const measurementTerms = occurrences.map((occurrence, index) =>
    getLocalMeasurementTerms({
      currency: currencies[index],
      nextOccurrence: occurrences[index + 1],
      occurrence,
      text,
    })
  );
  const allQualifierTerms = new Set(qualifierTerms.flat());
  const assignedTerms = occurrences.map(() => []);
  let ambiguous = currencies.includes(MIXED_CURRENCY);

  for (const term of positionalTerms) {
    if (allQualifierTerms.has(term.term)) {
      continue;
    }

    const distances = assignableOccurrenceIndexes.map((occurrenceIndex) =>
      distanceBetween(term, occurrences[occurrenceIndex])
    );
    const minimumDistance = Math.min(...distances);
    const nearestIndexes = distances.flatMap((distance, index) =>
      distance === minimumDistance ? [assignableOccurrenceIndexes[index]] : []
    );

    if (nearestIndexes.length > 1) {
      ambiguous = true;
      continue;
    }

    const occurrenceIndex = nearestIndexes[0];

    if (occurrenceIndex !== undefined) {
      assignedTerms[occurrenceIndex].push({
        ...term,
        distance: minimumDistance,
      });
    }
  }

  return {
    ambiguous,
    facts: occurrences.map((occurrence, index) => ({
      actorTerms: directionalFrame.actorTerms,
      directionalPredicate: directionalFrame.predicate,
      metadata: metadataFlags[index],
      measurementTerms: measurementTerms[index],
      objectTerms:
        index === assignableOccurrenceIndexes[0]
          ? directionalFrame.objectTerms
          : [],
      qualifierTerms: qualifierTerms[index],
      operator: occurrence.operator,
      roleTerms: uniqueValues([
        ...sharedSubjectTerms,
        ...assignedTerms[index].map(({ term }) => term),
      ]),
      signature: getNumericOccurrenceSignature(occurrence),
      values: occurrence.values,
    })),
    respectivelyTerms: getRespectivelyBindingTerms(text, ignoredTerms),
  };
};

const dropUnclaimedMetadataOccurrences = ({
  claimFacts = [],
  supportFacts = [],
} = {}) => {
  const claimCounts = claimFacts.reduce((counts, fact) => {
    counts.set(fact.signature, (counts.get(fact.signature) ?? 0) + 1);
    return counts;
  }, new Map());
  const supportCounts = supportFacts.reduce((counts, fact) => {
    counts.set(fact.signature, (counts.get(fact.signature) ?? 0) + 1);
    return counts;
  }, new Map());
  const excessCounts = new Map(
    [...supportCounts].map(([signature, count]) => [
      signature,
      Math.max(0, count - (claimCounts.get(signature) ?? 0)),
    ])
  );

  return supportFacts.filter((fact) => {
    const excess = excessCounts.get(fact.signature) ?? 0;

    if (!fact.metadata || excess === 0) {
      return true;
    }

    excessCounts.set(fact.signature, excess - 1);
    return false;
  });
};

const haveSameOrderedTerms = (left = [], right = []) =>
  left.length === right.length &&
  left.every((term, index) => right[index] === term);

const haveSameTermSet = (left = [], right = []) => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);

  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((term) => rightSet.has(term))
  );
};

const canMatchNumericFact = (claimFact, supportFact) => {
  const supportRoleTerms = new Set(supportFact.roleTerms);
  const supportActorTerms = new Set(supportFact.actorTerms);
  const supportObjectTerms = new Set(supportFact.objectTerms);

  return (
    claimFact.metadata === supportFact.metadata &&
    claimFact.signature === supportFact.signature &&
    claimFact.directionalPredicate === supportFact.directionalPredicate &&
    claimFact.actorTerms.every((term) => supportActorTerms.has(term)) &&
    claimFact.objectTerms.every((term) => supportObjectTerms.has(term)) &&
    claimFact.roleTerms.every((term) => supportRoleTerms.has(term)) &&
    haveSameTermSet(
      claimFact.measurementTerms,
      supportFact.measurementTerms
    ) &&
    haveSameTermSet(claimFact.qualifierTerms, supportFact.qualifierTerms)
  );
};

const canMatchNumericFacts = (claimFacts = [], supportFacts = []) => {
  if (claimFacts.length !== supportFacts.length) {
    return false;
  }

  const supportToClaim = new Array(supportFacts.length).fill(-1);

  const assignClaim = (claimIndex, visitedSupportIndexes) => {
    for (let supportIndex = 0; supportIndex < supportFacts.length; supportIndex += 1) {
      if (
        visitedSupportIndexes.has(supportIndex) ||
        !canMatchNumericFact(
          claimFacts[claimIndex],
          supportFacts[supportIndex]
        )
      ) {
        continue;
      }

      visitedSupportIndexes.add(supportIndex);
      const priorClaimIndex = supportToClaim[supportIndex];

      if (
        priorClaimIndex === -1 ||
        assignClaim(priorClaimIndex, visitedSupportIndexes)
      ) {
        supportToClaim[supportIndex] = claimIndex;
        return true;
      }
    }

    return false;
  };

  return claimFacts.every((_claimFact, claimIndex) =>
    assignClaim(claimIndex, new Set())
  );
};

export const haveSameNumericOccurrences = (
  claimText = "",
  supportText = "",
  {
    claimIgnoredTerms = new Set(),
    claimRoleTerms = null,
    supportRoleTerms = null,
  } = {}
) => {
  const claim = buildNumericOccurrenceFacts(claimText, {
    ignoredTerms: claimIgnoredTerms,
  });
  if (claim.facts.length === 1 && Array.isArray(claimRoleTerms)) {
    claim.facts[0].roleTerms = uniqueValues(
      claimRoleTerms.filter((term) => isRoleTerm(term, claimIgnoredTerms))
    );
  }
  const support = buildNumericOccurrenceFacts(supportText);
  const supportFactCount = support.facts.filter((fact) => !fact.metadata).length;

  if (Array.isArray(supportRoleTerms) && supportFactCount === 1) {
    const additionalTerms = supportRoleTerms.filter((term) => isRoleTerm(term));

    support.facts = support.facts.map((fact) => ({
      ...fact,
      roleTerms: fact.metadata
        ? fact.roleTerms
        : uniqueValues([...fact.roleTerms, ...additionalTerms]),
    }));
  }
  const supportFacts = dropUnclaimedMetadataOccurrences({
    claimFacts: claim.facts,
    supportFacts: support.facts,
  });
  const orderSensitive =
    /\brespectively\b/i.test(claimText) ||
    /\brespectively\b/i.test(supportText);

  if (
    claim.ambiguous ||
    support.ambiguous ||
    claim.facts.some((fact) => fact.signature.includes(":unknown:")) ||
    supportFacts.some((fact) => fact.signature.includes(":unknown:"))
  ) {
    return false;
  }

  if (
    orderSensitive &&
    !haveSameOrderedTerms(claim.respectivelyTerms, support.respectivelyTerms)
  ) {
    return false;
  }

  return (
    claim.facts.length === supportFacts.length &&
    canMatchNumericFacts(claim.facts, supportFacts)
  );
};
