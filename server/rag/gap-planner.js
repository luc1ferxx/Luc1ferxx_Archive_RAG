import {
  extractAnchorGroups,
  extractMeaningfulTokens,
  normalizeSearchText,
} from "./text-utils.js";

const DATE_LIKE_PATTERN =
  /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/i;
const NUMBER_LIKE_PATTERN =
  /\b(?:\d[\d,./-]*%?|\$?\d[\d,./-]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;
const TIME_QUERY_PATTERN =
  /\b(when|effective|start|starting|begin|beginning|end|ending|expire|expiration|date|dated|validity|timeline|window)\b|何时|什么时候|生效|开始|截止|到期|日期|时间|有效期/i;
const TIME_EVIDENCE_PATTERN =
  /\b(effective|effective date|start date|end date|expires?|expiration|valid from|valid until|as of|dated?)\b|生效|截止|到期|日期|有效期/i;
const NUMBER_QUERY_PATTERN =
  /\b(how many|how much|amount|price|cost|fee|limit|cap|ceiling|minimum|maximum|percent|percentage|days|months|years)\b|多少|金额|费用|价格|上限|下限|比例|百分比|几天|几个月|几年/i;
const NUMBER_EVIDENCE_PATTERN =
  /\b(amount|price|cost|fee|limit|cap|ceiling|minimum|maximum|percent|percentage|days|months|years)\b|金额|费用|价格|上限|下限|比例|百分比|天|月|年/i;
const SCOPE_QUERY_PATTERN =
  /\b(scope|applicable|applies|eligibility|eligible|region|regions|country|countries|audience|who|which users)\b|适用|范围|对象|用户|地区|国家|哪些人|哪些地区/i;
const SCOPE_EVIDENCE_PATTERN =
  /\b(scope|applicable|applies|eligibility|eligible|region|regions|regional|country|countries|audience|coverage|available in|used by)\b|适用|范围|对象|地区|国家|覆盖/i;
const YES_NO_QUERY_PATTERN =
  /^(?:is|are|can|does|do|will|should|may|must)\b|是否|能否|可否|可不可以|有没有|是否可以/i;
const CONCLUSION_PATTERN =
  /\b(allow|allows|allowed|permit|permits|permitted|prohibit|prohibits|prohibited|deny|denies|denied|require|requires|required|must|may|eligible|includes?|excludes?|covered|not covered)\b|允许|可以|不得|禁止|需要|必须|适用|不适用|包含|不包含/i;
const LOW_RELEVANCE_KEYWORD_SCORE = 0.2;
const STRONG_TOPIC_COVERAGE = 0.6;
const PARTIAL_TOPIC_COVERAGE = 0.25;

const escapeRegExp = (value = "") =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TOPIC_STOP_TERMS = new Set([
  "when",
  "what",
  "which",
  "who",
  "how",
  "much",
  "many",
  "take",
  "takes",
  "effect",
  "apply",
  "applies",
  "does",
  "do",
  "it",
  "effective",
  "date",
  "dates",
  "scope",
  "applicable",
  "applies",
  "eligibility",
  "eligible",
  "region",
  "regions",
  "country",
  "countries",
  "amount",
  "price",
  "cost",
  "fee",
  "limit",
  "cap",
  "ceiling",
  "minimum",
  "maximum",
  "percent",
  "percentage",
  "days",
  "months",
  "years",
  "policy",
  "please",
  "tell",
  "show",
  "何时",
  "什么时候",
  "生效",
  "开始",
  "截止",
  "到期",
  "日期",
  "时间",
  "有效期",
  "适用",
  "范围",
  "对象",
  "用户",
  "地区",
  "国家",
  "多少",
  "金额",
  "费用",
  "价格",
  "上限",
  "下限",
  "比例",
  "几天",
  "几个月",
  "几年",
]);

const SECTION_HINTS = {
  time: [
    "effective",
    "date",
    "term",
    "timeline",
    "valid",
    "duration",
    "生效",
    "日期",
    "期限",
    "时间",
    "有效",
  ],
  number: [
    "amount",
    "price",
    "cost",
    "fee",
    "limit",
    "cap",
    "ceiling",
    "refund",
    "金额",
    "费用",
    "价格",
    "上限",
    "下限",
    "比例",
  ],
  scope: [
    "scope",
    "eligibility",
    "eligible",
    "applicable",
    "region",
    "country",
    "audience",
    "coverage",
    "适用",
    "范围",
    "对象",
    "地区",
    "国家",
    "资格",
  ],
  explicit_answer: [
    "policy",
    "rule",
    "requirement",
    "exception",
    "terms",
    "政策",
    "规则",
    "要求",
    "例外",
    "条款",
  ],
};

const uniq = (values) => [...new Set(values.filter(Boolean))];

const detectLanguage = (value = "") =>
  /[\u4e00-\u9fff]/.test(value) ? "zh" : "en";

const joinLabels = (labels, language) => {
  const cleanedLabels = uniq(labels);

  if (cleanedLabels.length === 0) {
    return "";
  }

  if (language === "zh") {
    return cleanedLabels.join("、");
  }

  if (cleanedLabels.length === 1) {
    return cleanedLabels[0];
  }

  if (cleanedLabels.length === 2) {
    return `${cleanedLabels[0]} and ${cleanedLabels[1]}`;
  }

  return `${cleanedLabels.slice(0, -1).join(", ")}, and ${cleanedLabels.at(-1)}`;
};

// The chunk text without its section heading, so a heading such as
// "2025 Fees" never counts as date or number evidence. The heading usually
// opens the chunk; when the chunker kept earlier heading-like lines that had
// no body of their own (rag/chunker.js), it sits on its own line further
// down, and only that whole line is removed.
export const stripSectionHeading = (text, sectionHeading) => {
  const escapedHeading = escapeRegExp(sectionHeading);
  const atStart = new RegExp(`^${escapedHeading}\\s*`, "i");

  if (atStart.test(text)) {
    return text.replace(atStart, "").trim();
  }

  return text
    .replace(new RegExp(`^${escapedHeading}[ \\t]*(?:\\r?\\n|$)`, "im"), "")
    .trim();
};

const buildSearchableEntry = (result, index) => {
  const fileName = result?.document?.metadata?.fileName ?? "Unknown document";
  const sectionHeading = result?.document?.metadata?.sectionHeading ?? null;
  const pageNumber =
    result?.document?.metadata?.pageNumber ??
    result?.document?.metadata?.loc?.pageNumber ??
    result?.document?.metadata?.page ??
    null;
  const excerpt = String(result?.document?.pageContent ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  const bodyText = String(result?.document?.pageContent ?? "");
  const bodyOnlyText = sectionHeading
    ? stripSectionHeading(bodyText, sectionHeading)
    : bodyText;
  const searchableText = [fileName, sectionHeading, result?.document?.pageContent]
    .filter(Boolean)
    .join("\n");
  const headingText = [fileName, sectionHeading].filter(Boolean).join("\n");
  const normalizedBodyOnly = normalizeSearchText(bodyOnlyText);
  const normalizedBody = normalizeSearchText(bodyText);
  const normalizedText = normalizeSearchText(searchableText);
  const normalizedHeading = normalizeSearchText(headingText);

  return {
    index,
    score: result?.score ?? 0,
    keywordScore:
      typeof result?.keywordScore === "number" ? result.keywordScore : null,
    fileName,
    filePath: result?.document?.metadata?.publicFilePath ?? "",
    docId: result?.document?.metadata?.docId ?? null,
    pageNumber,
    chunkIndex: result?.document?.metadata?.chunkIndex ?? null,
    sectionHeading,
    bodyText,
    bodyOnlyText,
    excerpt,
    searchableText,
    headingText,
    normalizedBodyOnly,
    normalizedBody,
    normalizedText,
    normalizedHeading,
  };
};

const buildTopicLabel = ({ query, language, anchorGroups }) => {
  if (anchorGroups.length > 0) {
    return anchorGroups[0].label;
  }

  const topicTerms = uniq(
    extractMeaningfulTokens(query).filter((term) => !TOPIC_STOP_TERMS.has(term))
  ).slice(0, language === "zh" ? 8 : 4);

  if (topicTerms.length > 0) {
    return language === "zh" ? topicTerms.join("") : topicTerms.join(" ");
  }

  return query.trim().replace(/[?？。!！]+$/g, "").slice(0, 48);
};

const buildTopicTerms = (topicLabel) => uniq(extractMeaningfulTokens(topicLabel));

const hasAllTerms = (normalizedText, terms) =>
  terms.length > 0 &&
  terms.every((term) => normalizedText.includes(normalizeSearchText(term)));

const countMatchedTerms = (normalizedText, terms) =>
  terms.reduce(
    (matchedCount, term) =>
      matchedCount + (normalizedText.includes(normalizeSearchText(term)) ? 1 : 0),
    0
  );

const buildTopicRequirement = ({ query, language, anchorGroups }) => {
  const label = buildTopicLabel({
    query,
    language,
    anchorGroups,
  });
  const topicTerms = buildTopicTerms(label);

  if (topicTerms.length === 0) {
    return null;
  }

  return {
    id: "topic",
    kind: "topic",
    label,
    headingHints: topicTerms,
    directMatch(entry) {
      const matchedTerms = countMatchedTerms(entry.normalizedText, topicTerms);
      return matchedTerms / topicTerms.length >= STRONG_TOPIC_COVERAGE;
    },
    partialMatch(entry) {
      const matchedTerms = countMatchedTerms(entry.normalizedText, topicTerms);
      return matchedTerms / topicTerms.length >= PARTIAL_TOPIC_COVERAGE;
    },
  };
};

const buildAnchorRequirements = ({ query, confidence }) => {
  const sourceAnchors =
    confidence?.missingAnchorGroups?.length > 0
      ? confidence.missingAnchorGroups
      : extractAnchorGroups(query);

  return sourceAnchors.map((anchorGroup, index) => ({
    id: `anchor-${index}`,
    kind: "anchor",
    label: anchorGroup.label,
    headingHints: anchorGroup.terms,
    directMatch(entry) {
      return (
        entry.normalizedText.includes(anchorGroup.normalizedValue) ||
        hasAllTerms(entry.normalizedText, anchorGroup.terms)
      );
    },
    partialMatch(entry) {
      return (
        anchorGroup.terms.length > 0 &&
        anchorGroup.terms.some((term) =>
          entry.normalizedText.includes(normalizeSearchText(term))
        )
      );
    },
  }));
};

const buildOptionalRequirements = ({ query, language }) => {
  const requirements = [];

  if (TIME_QUERY_PATTERN.test(query)) {
    requirements.push({
      id: "time",
      kind: "time",
      label: language === "zh" ? "生效日期或时间条件" : "effective date or timing",
      headingHints: SECTION_HINTS.time,
      directMatch(entry) {
        return (
          DATE_LIKE_PATTERN.test(entry.bodyOnlyText) ||
          TIME_EVIDENCE_PATTERN.test(entry.bodyOnlyText)
        );
      },
      headingMatch(entry) {
        return SECTION_HINTS.time.some((hint) =>
          entry.normalizedHeading.includes(normalizeSearchText(hint))
        );
      },
      partialMatch(entry) {
        return TIME_EVIDENCE_PATTERN.test(entry.bodyOnlyText);
      },
    });
  }

  if (NUMBER_QUERY_PATTERN.test(query)) {
    requirements.push({
      id: "number",
      kind: "number",
      label: language === "zh" ? "金额、比例或期限" : "amount, percentage, or duration",
      headingHints: SECTION_HINTS.number,
      directMatch(entry) {
        return NUMBER_LIKE_PATTERN.test(entry.bodyOnlyText);
      },
      headingMatch(entry) {
        return SECTION_HINTS.number.some((hint) =>
          entry.normalizedHeading.includes(normalizeSearchText(hint))
        );
      },
      partialMatch(entry) {
        return NUMBER_EVIDENCE_PATTERN.test(entry.bodyOnlyText);
      },
    });
  }

  if (SCOPE_QUERY_PATTERN.test(query)) {
    requirements.push({
      id: "scope",
      kind: "scope",
      label: language === "zh" ? "适用范围、对象或地区" : "scope, audience, or region",
      headingHints: SECTION_HINTS.scope,
      directMatch(entry) {
        return SCOPE_EVIDENCE_PATTERN.test(entry.bodyOnlyText);
      },
      headingMatch(entry) {
        return SECTION_HINTS.scope.some((hint) =>
          entry.normalizedHeading.includes(normalizeSearchText(hint))
        );
      },
      partialMatch(entry) {
        return SCOPE_EVIDENCE_PATTERN.test(entry.bodyOnlyText);
      },
    });
  }

  if (YES_NO_QUERY_PATTERN.test(query)) {
    requirements.push({
      id: "explicit-answer",
      kind: "explicit_answer",
      label: language === "zh" ? "明确结论" : "clear answer",
      headingHints: SECTION_HINTS.explicit_answer,
      directMatch(entry) {
        return CONCLUSION_PATTERN.test(entry.bodyOnlyText);
      },
      headingMatch(entry) {
        return SECTION_HINTS.explicit_answer.some((hint) =>
          entry.normalizedHeading.includes(normalizeSearchText(hint))
        );
      },
    });
  }

  return requirements;
};

const evaluateRequirement = (requirement, entries) => {
  const directMatches = [];
  const headingMatches = [];
  const partialMatches = [];

  for (const entry of entries) {
    if (requirement.directMatch?.(entry)) {
      directMatches.push(entry);
      continue;
    }

    if (requirement.headingMatch?.(entry)) {
      headingMatches.push(entry);
      continue;
    }

    if (requirement.partialMatch?.(entry)) {
      partialMatches.push(entry);
    }
  }

  return {
    ...requirement,
    directMatches,
    headingMatches,
    partialMatches,
    status:
      directMatches.length > 0
        ? "covered"
        : headingMatches.length > 0 || partialMatches.length > 0
          ? "partial"
          : "missing",
  };
};

const toSourceRef = (entry) => ({
  docId: entry.docId,
  fileName: entry.fileName,
  filePath: entry.filePath,
  pageNumber: entry.pageNumber,
  chunkIndex: entry.chunkIndex,
  sectionHeading: entry.sectionHeading,
  excerpt: entry.excerpt,
});

const buildMissingReason = ({ evaluation, language }) => {
  if (evaluation.kind === "anchor") {
    return language === "zh"
      ? `检索到的内容里没有明确提到“${evaluation.label}”。`
      : `The retrieved passages do not explicitly mention "${evaluation.label}".`;
  }

  if (evaluation.headingMatches.length > 0) {
    return language === "zh"
      ? "目前只在文件名或章节标题里看到相关线索，正文证据还不够。"
      : "I only found hints in file names or section headings, not enough body evidence yet.";
  }

  if (evaluation.partialMatches.length > 0) {
    return language === "zh"
      ? "目前只找到相关内容，但还不能直接回答这一点。"
      : "I found related material, but it still does not directly answer this part.";
  }

  return language === "zh"
    ? "当前检索结果里没有找到这一点的直接证据。"
    : "The current retrieval results do not contain direct evidence for this point.";
};

const buildLocationReason = ({ reasons, language }) => {
  const labels = uniq(reasons);

  if (labels.length === 0) {
    return language === "zh"
      ? "这是当前最接近问题的相关段落。"
      : "This is one of the closest related passages retrieved so far.";
  }

  return language === "zh"
    ? `这里可能补到：${joinLabels(labels, language)}。`
    : `This may help fill: ${joinLabels(labels, language)}.`;
};

const buildPossibleLocations = ({ missingEvaluations, entries, language }) => {
  const candidatesByKey = new Map();

  for (const evaluation of missingEvaluations) {
    const candidates = [
      ...evaluation.headingMatches,
      ...evaluation.partialMatches,
    ];

    for (const entry of candidates) {
      const key = `${entry.docId}:${entry.pageNumber}:${entry.chunkIndex}`;
      const existing = candidatesByKey.get(key);
      const nextScore =
        (existing?.score ?? 0) +
        3 +
        (entry.keywordScore ?? 0) +
        Math.max(entry.score, 0);

      candidatesByKey.set(key, {
        ...toSourceRef(entry),
        score: nextScore,
        reasons: uniq([...(existing?.reasons ?? []), evaluation.label]),
      });
    }
  }

  if (candidatesByKey.size === 0) {
    for (const entry of entries) {
      if ((entry.keywordScore ?? 0) < LOW_RELEVANCE_KEYWORD_SCORE) {
        continue;
      }

      const key = `${entry.docId}:${entry.pageNumber}:${entry.chunkIndex}`;
      candidatesByKey.set(key, {
        ...toSourceRef(entry),
        score: (entry.keywordScore ?? 0) + Math.max(entry.score, 0),
        reasons: [],
      });
    }
  }

  return [...candidatesByKey.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((candidate) => ({
      ...candidate,
      reason: buildLocationReason({
        reasons: candidate.reasons,
        language,
      }),
    }));
};

const buildFollowUpQuestion = ({ evaluation, topicLabel, language }) => {
  if (language === "zh") {
    if (evaluation.kind === "time") {
      return "请只找这份文档里的生效日期或时间条件，不要展开解释其他条款。";
    }

    if (evaluation.kind === "number") {
      return "请只找这份文档里的金额、比例或期限，不要总结整段政策。";
    }

    if (evaluation.kind === "scope") {
      return "请只找这份文档里的适用对象、适用范围或适用地区。";
    }

    if (evaluation.kind === "anchor") {
      return `请只查“${evaluation.label}”是否在文档里出现，并给出页码。`;
    }

    if (evaluation.kind === "explicit_answer") {
      return "请只回答是否允许、要求或禁止，并附上对应页码。";
    }

    return `请只找和“${topicLabel}”直接相关的段落，并给出页码。`;
  }

  if (evaluation.kind === "time") {
    return `Look only for the effective date or timing for ${topicLabel}.`;
  }

  if (evaluation.kind === "number") {
    return `Look only for the amount, percentage, or duration for ${topicLabel}.`;
  }

  if (evaluation.kind === "scope") {
    return `Look only for the scope, audience, or region for ${topicLabel}.`;
  }

  if (evaluation.kind === "anchor") {
    return `Find whether "${evaluation.label}" appears in the selected documents and cite the page.`;
  }

  if (evaluation.kind === "explicit_answer") {
    return "Answer only whether the document allows, requires, or prohibits this, and cite the page.";
  }

  return `Find passages that directly mention ${topicLabel}.`;
};

const buildSuggestedQuestions = ({ missingEvaluations, topicLabel, language }) =>
  uniq(
    missingEvaluations
      .slice(0, 3)
      .map((evaluation) =>
        buildFollowUpQuestion({
          evaluation,
          topicLabel,
          language,
        })
      )
  );

const buildSupplementalQuery = ({ evaluation, topicLabel, language }) => {
  if (language === "zh") {
    if (evaluation.kind === "time") {
      return `${topicLabel} 生效日期 时间`;
    }

    if (evaluation.kind === "number") {
      return `${topicLabel} 金额 比例 期限`;
    }

    if (evaluation.kind === "scope") {
      return `${topicLabel} 适用范围 适用地区`;
    }

    if (evaluation.kind === "anchor") {
      return evaluation.label;
    }

    if (evaluation.kind === "explicit_answer") {
      return `${topicLabel} 是否允许 是否要求`;
    }

    return topicLabel;
  }

  if (evaluation.kind === "time") {
    return `${topicLabel} effective date timing`;
  }

  if (evaluation.kind === "number") {
    return `${topicLabel} amount percentage duration`;
  }

  if (evaluation.kind === "scope") {
    return `${topicLabel} scope region eligibility`;
  }

  if (evaluation.kind === "anchor") {
    return evaluation.label;
  }

  if (evaluation.kind === "explicit_answer") {
    return `${topicLabel} allowed required prohibited`;
  }

  return topicLabel;
};

const buildSupplementalQueries = ({ missingEvaluations, topicLabel, language }) => {
  const seenQueries = new Set();

  return missingEvaluations
    .slice(0, 3)
    .map((evaluation) => ({
      label: evaluation.label,
      kind: evaluation.kind,
      query: buildSupplementalQuery({
        evaluation,
        topicLabel,
        language,
      }),
    }))
    .filter((entry) => {
      const normalizedQuery = normalizeSearchText(entry.query);

      if (!normalizedQuery || seenQueries.has(normalizedQuery)) {
        return false;
      }

      seenQueries.add(normalizedQuery);
      return true;
    });
};

const buildSummary = ({
  relatedEvidenceFound,
  topicLabel,
  missingEvaluations,
  language,
}) => {
  const missingLabels = missingEvaluations.map((evaluation) => evaluation.label);
  const missingLabelText = joinLabels(missingLabels, language);

  if (language === "zh") {
    return relatedEvidenceFound
      ? missingLabelText
        ? `我找到了一些和“${topicLabel}”相关的内容，但还不能可靠确认${missingLabelText}。`
        : `我找到了一些和“${topicLabel}”相关的内容，但还不能可靠作答。`
      : `我还没有找到能直接回答“${topicLabel}”的可靠证据。`;
  }

  return relatedEvidenceFound
    ? missingLabelText
      ? `I found material related to ${topicLabel}, but I still cannot confirm ${missingLabelText} reliably.`
      : `I found material related to ${topicLabel}, but the answer is still not reliable enough.`
    : `I have not found reliable evidence that directly answers ${topicLabel}.`;
};

export const planQaEvidenceGap = ({
  query,
  results = [],
  confidence = {},
}) => {
  const language = detectLanguage(query);
  const entries = results.slice(0, 6).map((result, index) => buildSearchableEntry(result, index));
  const anchorGroups =
    confidence?.missingAnchorGroups?.length > 0
      ? confidence.missingAnchorGroups
      : extractAnchorGroups(query);
  const requirements = [
    buildTopicRequirement({
      query,
      language,
      anchorGroups,
    }),
    ...buildAnchorRequirements({
      query,
      confidence,
    }),
    ...buildOptionalRequirements({
      query,
      language,
    }),
  ].filter(Boolean);
  const evaluations = requirements.map((requirement) =>
    evaluateRequirement(requirement, entries)
  );
  const coveredAspects = evaluations
    .filter((evaluation) => evaluation.status === "covered")
    .map((evaluation) => ({
      label: evaluation.label,
      status: "covered",
      sources: evaluation.directMatches.slice(0, 2).map(toSourceRef),
    }));
  const missingEvaluations = evaluations.filter(
    (evaluation) => evaluation.status !== "covered"
  );
  const missingAspects = missingEvaluations.map((evaluation) => ({
    label: evaluation.label,
    status: evaluation.status,
    reason: buildMissingReason({
      evaluation,
      language,
    }),
  }));
  const relatedEvidenceFound =
    coveredAspects.length > 0 ||
    evaluations.some(
      (evaluation) =>
        evaluation.partialMatches.length > 0 || evaluation.headingMatches.length > 0
    ) ||
    entries.some((entry) => (entry.keywordScore ?? 0) >= LOW_RELEVANCE_KEYWORD_SCORE);
  const possibleLocations = buildPossibleLocations({
    missingEvaluations,
    entries,
    language,
  });
  const topicLabel =
    evaluations.find((evaluation) => evaluation.kind === "topic")?.label ??
    query.trim();
  const supplementalQueries = buildSupplementalQueries({
    missingEvaluations,
    topicLabel,
    language,
  });
  const summary = buildSummary({
    relatedEvidenceFound,
    topicLabel,
    missingEvaluations,
    language,
  });

  return {
    language,
    summary,
    userMessage: summary,
    coveredAspects,
    missingAspects,
    possibleLocations,
    supplementalQueries,
    topicLabel,
    reason: confidence?.reason ?? null,
  };
};
