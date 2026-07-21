import { extractMeaningfulTokens, normalizeSearchText } from "./text-utils.js";
import { filterCitationsToSourceRanks } from "./source-labels.js";
import { attachRetrievedEvidence } from "./citations.js";

export const CHECKABLE_CITATION_FIELDS = [
  "evidenceText",
  "excerpt",
  "text",
  "pageContent",
  "content",
];

const normalizeEvidenceText = (value) => String(value ?? "").trim();

export const getCitationDocIds = (citations = []) =>
  new Set(
    citations
      .map((citation) => citation?.docId)
      .filter((docId) => typeof docId === "string" && docId.trim())
  );

export const hasCheckableCitationText = (citations = []) =>
  citations.some((citation) =>
    CHECKABLE_CITATION_FIELDS.some((field) =>
      normalizeEvidenceText(citation?.[field])
    )
  );

const SOURCE_LABEL_PATTERN = /\[(?:source|来源)\s*\d+\]/gi;
const SOURCE_LABEL_CAPTURE_PATTERN = /\[(?:source|来源)\s*(\d+)\]/gi;
const NUMBER_PATTERN =
  /(?<![\w.+-])[+-]?\$?\d+(?:,\d{3})*(?:\.\d+)?%?(?![\w%]|\.\d)/g;
const NUMERIC_CONSTRAINT_PATTERNS = [
  /\b(?:at\s+least|minimum(?:\s+of)?|no\s+fewer\s+than|up\s+to|at\s+most|maximum(?:\s+of)?|no\s+more\s+than)\s+\$?\d+(?:,\d{3})*(?:\.\d+)?%?/gi,
  /(?:<=|>=|<|>)\s*\$?\d+(?:,\d{3})*(?:\.\d+)?%?/g,
  /±\s*\$?\d+(?:,\d{3})*(?:\.\d+)?%?/g,
  /(?<![\d-])\d+(?:,\d{3})*(?:\.\d+)?%?\s*(?:-|–|—|to)\s*\d+(?:,\d{3})*(?:\.\d+)?%?(?![\d-])/gi,
];
const MONTH_PATTERN =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/gi;
const DATE_PATTERN = /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g;
const CODE_PATTERN = /\b[A-Z0-9]{2,}(?:-[A-Z0-9]{1,})+\b/g;
const CLAIM_SPLIT_PATTERN = /(?<=[.!?。！？])\s+|[;；]+/gi;
const SOURCE_AFTER_PUNCTUATION_PATTERN =
  /([.!?。！？])\s*((?:\[(?:source|来源)\s*\d+\]\s*)+)/gi;
const DOTTED_ABBREVIATION_PATTERN =
  /\b(?:(?:[A-Za-z]\.){2,}|(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|No)\.)/g;
const PROTECTED_PERIOD = "\uE000";
const CLAIM_PREDICATE_PATTERN =
  /\b(?:is|are|was|were|be|been|being|may|must|can|cannot|can't|will|shall|should|has|have|had|allow(?:ed|s|ing)?|permit(?:s|ted|ting)?|prohibit(?:ed|s|ing)?|require(?:d|s|ing)?|include(?:d|s|ing)?|provide(?:d|s|ing)?|limit(?:ed|s|ing)?|specif(?:y|ies|ied)|state(?:d|s|ing)?|use(?:d|s|ing)?|refer(?:red|s|ring)?|receive(?:d|s|ing)?|exist(?:ed|s|ing)?|complete(?:d|s|ing)?|differ(?:s|ed|ent)?)\b/i;
const SUPPORT_TOKEN_OVERLAP_THRESHOLD = 0.6;
const STRUCTURAL_SECTION_HEADING_PATTERN =
  /^(?:summary|per document|agreements?|differences?|gaps? or uncertainty|摘要|逐文档|共同点|差异|缺口或不确定性)$/i;
const COMPARISON_RELATION_PATTERN =
  /(?:\b(?:all|both|each|either|differ(?:s|ent)?|while|whereas|only|same|aligns?|conflicts?|versus|vs)\b|(?:两份|所有|各)(?:文档|政策|手册|来源).*都|而|但是?|然而|相比|相较)/i;
const CONTRAST_RELATION_PATTERN =
  /(?:\b(?:differ(?:s|ent)?|while|whereas|versus|vs)\b|而|但是?|然而|相比|相较)/i;
const AGREEMENT_RELATION_PATTERN =
  /(?:\b(?:both|all(?:\s+(?:\w+|\d+)){0,2}|each)\s+(?:documents?|polic(?:y|ies)|handbooks?|sources?|agreements?|contracts?)\b|(?:两份|所有|各)(?:文档|政策|手册|来源).*都)/i;
const EITHER_DOCUMENT_RELATION_PATTERN =
  /\beither\s+(?:documents?|polic(?:y|ies)|handbooks?|sources?|agreements?|contracts?)\b/i;
const EXCLUSIVE_RELATION_PATTERN =
  /\b(?:only|solely|exclusively|alone)\b/i;
const GENERIC_EXCLUSIVE_DOCUMENT_PATTERN =
  /\bonly\s+(?:(?:the\s+)?(?:first|second|former|latter|one)\s+)?(?:documents?|polic(?:y|ies)|handbooks?|sources?|agreements?|contracts?)\b/i;
const SOURCE_SCOPED_EXCLUSIVE_PATTERN =
  /^\s*[-*]?\s*only\s+(?:is|are|was|were|allows?|permits?|prohibits?|requires?|includes?|provides?|limits?|states?|specifies?)\b/i;
const NO_DIFFERENCE_RELATION_PATTERN =
  /\b(?:no\b.*\bdifferences?\b|no\b.*\b(?:conflicting values?|conflicts?)\b.*\b(?:retrieved|cited|evidence)\b|retrieved evidence aligns on (?:the )?key facts)\b/i;
const EVIDENCE_SCOPED_NO_DIFFERENCE_PATTERN =
  /\b(?:no\b.*\b(?:material differences?|conflicting values?|conflicts?)\b.*\b(?:retrieved|cited|evidence)|retrieved evidence aligns on (?:the )?key facts)\b/i;
const COMPARISON_SCAFFOLD_TERMS = new Set([
  "all",
  "both",
  "either",
  "differ",
  "differs",
  "each",
  "agreements",
  "contracts",
  "handbooks",
  "only",
  "sources",
  "whereas",
  "while",
  "两",
  "份",
  "文",
  "档",
  "都",
  "各",
]);
const CONTRAST_STYLE_TERMS = new Set([
  "clearly",
  "explicitly",
  "expressly",
  "formally",
  "specifically",
]);
const NEGATED_PERMISSION_PATTERN =
  /\b(?:not\s+(?:allowed|permitted)|cannot|can't|must\s+not|mustn't|may\s+not|needn't|shouldn't)\b/gi;
const NEGATED_PROHIBITION_PATTERN =
  /\b(?:not|never)\s+(?:prohibited|forbidden|disallowed)\b/i;
const ALLOW_MODALITY_PATTERN =
  /(?:\b(?:allow(?:ed|s|ing)?|permit(?:s|ted|ting)?|may)\b|允许|可以)/i;
const PROHIBIT_MODALITY_PATTERN =
  /(?:\b(?:prohibit(?:ed|s|ing)?|forbid(?:s|den|ding)?|disallow(?:ed|s|ing)?)\b|禁止|不得|不能|不可)/i;
const NEGATED_REQUIREMENT_PATTERN =
  /(?:\b(?:not\s+(?:required|necessary|mandatory|compulsory)|does?\s+not\s+require|needn't|optional|voluntary|waived|unnecessary|independent(?:ly)?\s+of|free\s+from|exempt(?:ed)?\s+from|without\b[^.!?。！？;；]*\b(?:approval|permission|requirement))\b|无需|不需要|非必须|可选|自愿|豁免)/gi;
const DOUBLE_NEGATIVE_REQUIREMENT_PATTERN =
  /\b(?:cannot|can't|may\s+not|must\s+not|mustn't|should\s+not|shouldn't)\b[^.!?。！？;；]*\bwithout\b[^.!?。！？;；]*\b(?:approval|permission|requirement)\b/i;
const REQUIRE_MODALITY_PATTERN =
  /(?:\b(?:require(?:d|s|ing)?|must|shall|mandatory|compulsory|mandate(?:d|s|ing)?|need(?:ed|s|ing)?|necessary|obligat(?:e|ed|es|ing|ion|ory))\b|要求|需要|必须|应当)/i;
const RECOMMEND_MODALITY_PATTERN = /\b(?:should|ought\s+to|recommended)\b/i;
const NEGATIVE_POLARITY_PATTERN =
  /(?:\b(?:no\s+longer|no|not|never|without|absent|missing|lacks?|cannot|can't|mustn't|needn't|shouldn't|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|hasn't|haven't|hadn't)\b|不|未|无|禁止|不得|不能|不可|没有|缺少)/i;
const NEGATIVE_POLARITY_TERMS = new Set([
  "absent",
  "lack",
  "lacks",
  "missing",
  "never",
  "without",
]);
const MODALITY_CLAUSE_SPLIT_PATTERN =
  /(?<=[.!?。！？])\s+|\n+|[,;，；]\s*|\b(?:and|but|whereas|while)\b/gi;
const MODALITY_CLAIM_TERMS = new Set([
  "allow",
  "allowed",
  "allows",
  "allowing",
  "permit",
  "permits",
  "permitted",
  "permitting",
  "prohibit",
  "prohibited",
  "prohibits",
  "prohibiting",
  "forbid",
  "forbids",
  "forbidden",
  "forbidding",
  "disallow",
  "disallowed",
  "disallows",
  "disallowing",
  "require",
  "required",
  "requires",
  "requiring",
  "must",
  "mandatory",
  "mandate",
  "mandated",
  "mandates",
  "mandating",
  "need",
  "needed",
  "needs",
  "needing",
  "necessary",
  "optional",
  "unnecessary",
  "independent",
  "independently",
  "obligate",
  "obligated",
  "obligates",
  "obligation",
  "obligatory",
  "shall",
  "should",
  "compulsory",
  "voluntary",
  "waived",
]);
const DOCUMENT_ATTRIBUTION_PREPOSITIONS = new Set([
  "according",
  "from",
  "in",
  "under",
  "versus",
  "vs",
  "whereas",
  "while",
]);
const DOCUMENT_ATTRIBUTION_VERBS = new Set([
  "allows",
  "limits",
  "permits",
  "provides",
  "require",
  "required",
  "requires",
  "refers",
  "restricts",
  "says",
  "sets",
  "specifies",
  "states",
  "uses",
]);
const DOCUMENT_IDENTITY_TERMS = new Set([
  "agreement",
  "archive",
  "contract",
  "doc",
  "document",
  "handbook",
  "manual",
  "policy",
  "report",
  "source",
]);
const CHINESE_DOCUMENT_IDENTITY_PATTERN =
  /(?:文档|政策|手册|合同|协议|报告|来源)/;
const CHINESE_ATTRIBUTION_PREFIX_PATTERN = /(?:根据|按照|依照|在|从)$/;
const CHINESE_ATTRIBUTION_VERB_PATTERN =
  /^(?:允许|要求|需要|必须|应当|规定|限制|禁止|不得|包含|包括|提供|说明|指出|采用|使用|为|有|无)/;
const FILE_EXTENSION_TERMS = new Set([
  "doc",
  "docx",
  "md",
  "pdf",
  "rtf",
  "txt",
]);
const CHINESE_MODALITY_SURFACE_PATTERN =
  /允许|可以|禁止|不得|不能|不可|要求|需要|必须|应当|无需|不需要|非必须|可选|自愿|豁免/g;
const FACT_TERM_ALIASES = new Map([
  ["remotely", "remote"],
]);
const CLAIM_LEAD_LABEL_PATTERN =
  /^(?:risk|unsupported|unknown|gap|difference|agreement|parties|key terms?|obligations?|deadlines?|finding)\s*:\s*/i;

const uniqueValues = (values = []) => [...new Set(values.filter(Boolean))];

const canonicalizeFactTerm = (term = "") => FACT_TERM_ALIASES.get(term) ?? term;

const normalizeDottedAbbreviationsForTokens = (value = "") =>
  String(value ?? "").replace(DOTTED_ABBREVIATION_PATTERN, (match) =>
    match.replaceAll(".", "")
  );

const extractFactTerms = (value = "") =>
  uniqueValues(
    extractMeaningfulTokens(normalizeDottedAbbreviationsForTokens(value)).map(
      canonicalizeFactTerm
    )
  );

const stripClaimLeadLabel = (value = "") =>
  stripSourceLabels(value)
    .replace(/^[-*]\s+/, "")
    .replace(CLAIM_LEAD_LABEL_PATTERN, "")
    .trim();

const getChineseModalitySurfaceTerms = (value = "") => {
  CHINESE_MODALITY_SURFACE_PATTERN.lastIndex = 0;
  const matches = String(value ?? "").match(CHINESE_MODALITY_SURFACE_PATTERN) ?? [];
  CHINESE_MODALITY_SURFACE_PATTERN.lastIndex = 0;

  return new Set(matches.flatMap((match) => extractMeaningfulTokens(match)));
};

const getModalityLabels = (value = "") => {
  const text = String(value ?? "");
  const labels = [];
  const negatedPermission = NEGATED_PERMISSION_PATTERN.test(text);
  const negatedRequirement = NEGATED_REQUIREMENT_PATTERN.test(text);
  const negatedProhibition = NEGATED_PROHIBITION_PATTERN.test(text);
  const doubleNegativeRequirement = DOUBLE_NEGATIVE_REQUIREMENT_PATTERN.test(
    text
  );
  NEGATED_PERMISSION_PATTERN.lastIndex = 0;
  NEGATED_REQUIREMENT_PATTERN.lastIndex = 0;

  if (
    negatedProhibition ||
    ALLOW_MODALITY_PATTERN.test(text.replace(NEGATED_PERMISSION_PATTERN, ""))
  ) {
    labels.push("allow");
  }
  NEGATED_PERMISSION_PATTERN.lastIndex = 0;

  if (
    !negatedProhibition &&
    (negatedPermission || PROHIBIT_MODALITY_PATTERN.test(text))
  ) {
    labels.push("prohibit");
  }

  if (
    doubleNegativeRequirement ||
    REQUIRE_MODALITY_PATTERN.test(
      text.replace(NEGATED_REQUIREMENT_PATTERN, "")
    )
  ) {
    labels.push("require");
  }
  NEGATED_REQUIREMENT_PATTERN.lastIndex = 0;

  if (negatedRequirement && !doubleNegativeRequirement) {
    labels.push("optional");
  }

  if (RECOMMEND_MODALITY_PATTERN.test(text)) {
    labels.push("recommend");
  }

  return labels;
};

const splitModalityClauses = (value = "") =>
  String(value ?? "")
    .split(MODALITY_CLAUSE_SPLIT_PATTERN)
    .map((clause) => clause.trim())
    .filter(Boolean);

const getModalityClaimTerms = ({
  claimText = "",
  anchor,
  documentAttributionTerms = new Set(),
} = {}) => {
  const matchingClauses = splitModalityClauses(claimText).filter((clause) =>
    getModalityLabels(clause).includes(anchor)
  );
  const scopedText = matchingClauses.length > 0
    ? matchingClauses.join(" ")
    : claimText;

  return uniqueValues(extractMeaningfulTokens(scopedText)).filter(
    (term) =>
      !MODALITY_CLAIM_TERMS.has(term) &&
      !COMPARISON_SCAFFOLD_TERMS.has(term) &&
      !documentAttributionTerms.has(term)
  );
};

const stripSourceLabels = (value = "") =>
  String(value ?? "").replace(SOURCE_LABEL_PATTERN, "").trim();

const extractSourceRanks = (value = "") =>
  uniqueValues(
    [...String(value ?? "").matchAll(SOURCE_LABEL_CAPTURE_PATTERN)].map(
      (match) => Number(match[1])
    )
  ).filter((rank) => Number.isInteger(rank) && rank > 0);

const normalizeStructuralClaimLabel = (value = "") =>
  stripSourceLabels(value)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/[：:]\s*$/, "")
    .trim();

const getCitationDocumentLabels = (citations = []) =>
  new Set(
    citations.flatMap((citation) => {
      const fileName = normalizeEvidenceText(citation?.fileName);
      const fileNameWithoutExtension = fileName.replace(/\.[^.]+$/, "");

      return [fileName, fileNameWithoutExtension, citation?.docId]
        .map(normalizeSearchText)
        .filter(Boolean);
    })
  );

const getCitationDocumentAliasEntries = (citation = {}) => {
  const fileName = normalizeEvidenceText(citation?.fileName);
  const fileNameWithoutExtension = fileName.replace(/\.[^.]+$/, "");
  const docId = normalizeEvidenceText(citation?.docId);
  const rawLabels = [
    { value: fileName, isDocId: false },
    { value: fileNameWithoutExtension, isDocId: false },
    { value: docId, isDocId: true },
  ].filter((entry) => entry.value);
  const entries = rawLabels.map(({ value, isDocId }) => {
    const normalized = normalizeSearchText(value);
    const terms = extractMeaningfulTokens(normalized);
    const identityLike =
      isDocId ||
      /\d/.test(value) ||
      CHINESE_DOCUMENT_IDENTITY_PATTERN.test(value) ||
      terms.some((term) => DOCUMENT_IDENTITY_TERMS.has(term));

    return {
      normalized,
      removable:
        identityLike && (terms.length >= 2 || /[-_]/.test(value)),
    };
  });

  for (const entry of [...entries]) {
    const terms = extractMeaningfulTokens(entry.normalized);
    const shortAlias = [...terms]
      .reverse()
      .find(
        (term) =>
          !FILE_EXTENSION_TERMS.has(term) &&
          !DOCUMENT_IDENTITY_TERMS.has(term)
      );

    if (entry.removable && shortAlias?.length >= 3) {
      entries.push({
        normalized: shortAlias,
        removable: true,
      });
    }
  }

  return [...new Map(entries.map((entry) => [entry.normalized, entry])).values()]
    .filter((entry) => entry.normalized)
    .sort((left, right) => right.normalized.length - left.normalized.length);
};

const getCitationDocumentAliases = (citation = {}) =>
  getCitationDocumentAliasEntries(citation).map((entry) => entry.normalized);

const includesNormalizedPhrase = (text = "", phrase = "") =>
  (() => {
    const normalizedText = normalizeSearchText(text);
    const normalizedPhrase = normalizeSearchText(phrase);

    if (!normalizedPhrase) {
      return false;
    }

    if (/[\u4e00-\u9fff]/.test(normalizedPhrase)) {
      return normalizedText
        .replace(/\s+/g, "")
        .includes(normalizedPhrase.replace(/\s+/g, ""));
    }

    return ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
  })();

const isExplicitDocumentAttribution = ({
  claimText = "",
  alias = "",
} = {}) => {
  if (/[\u4e00-\u9fff]/.test(alias) && includesNormalizedPhrase(claimText, alias)) {
    const compactClaim = normalizeSearchText(claimText).replace(/\s+/g, "");
    const compactAlias = normalizeSearchText(alias).replace(/\s+/g, "");
    const aliasIndex = compactClaim.indexOf(compactAlias);
    const beforeAlias = compactClaim.slice(0, aliasIndex);
    const afterAlias = compactClaim.slice(aliasIndex + compactAlias.length);

    if (
      aliasIndex >= 0 &&
      (CHINESE_ATTRIBUTION_PREFIX_PATTERN.test(beforeAlias) ||
        CHINESE_ATTRIBUTION_VERB_PATTERN.test(afterAlias))
    ) {
      return true;
    }
  }

  const claimTerms = normalizeSearchText(claimText).split(/\s+/g).filter(Boolean);
  const aliasTerms = normalizeSearchText(alias).split(/\s+/g).filter(Boolean);

  if (aliasTerms.length === 0 || claimTerms.length < aliasTerms.length) {
    return false;
  }

  const aliasPattern = aliasTerms
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^a-z0-9\u4e00-\u9fff]+");

  if (
    new RegExp(`(?:^|\\s|[-*])${aliasPattern}\\s*[:：]`, "i").test(
      claimText
    ) ||
    new RegExp(`[（(]\\s*${aliasPattern}\\s*[)）]`, "i").test(claimText)
  ) {
    return true;
  }

  for (let index = 0; index <= claimTerms.length - aliasTerms.length; index += 1) {
    const matches = aliasTerms.every(
      (term, offset) => claimTerms[index + offset] === term
    );

    if (!matches) {
      continue;
    }

    const previousTerm = claimTerms[index - 1] ?? "";
    const nextTerm = claimTerms[index + aliasTerms.length] ?? "";

    if (
      DOCUMENT_ATTRIBUTION_PREPOSITIONS.has(previousTerm) ||
      DOCUMENT_ATTRIBUTION_PREPOSITIONS.has(nextTerm) ||
      DOCUMENT_ATTRIBUTION_VERBS.has(nextTerm)
    ) {
      return true;
    }
  }

  return false;
};

const getDocumentAttributionTerms = ({
  claimText = "",
  citations = [],
  forceComparisonClaim = false,
} = {}) =>
  new Set(
    citations.flatMap((citation) =>
      getCitationDocumentAliasEntries(citation)
        .filter(
          (entry) =>
            entry.removable &&
            includesNormalizedPhrase(claimText, entry.normalized) &&
            (forceComparisonClaim ||
              isExplicitDocumentAttribution({
                claimText,
                alias: entry.normalized,
              }))
        )
        .flatMap((entry) => extractMeaningfulTokens(entry.normalized))
    )
  );

const getGenericDocumentAttributionTerms = (claimText = "") => {
  const terms = normalizeSearchText(claimText).split(/\s+/g).filter(Boolean);
  const attributionVerbIndex = terms.findIndex((term) =>
    DOCUMENT_ATTRIBUTION_VERBS.has(term)
  );

  if (
    attributionVerbIndex <= 0 ||
    !terms
      .slice(0, attributionVerbIndex)
      .some((term) => DOCUMENT_IDENTITY_TERMS.has(term))
  ) {
    return new Set();
  }

  return new Set(terms.slice(0, attributionVerbIndex + 1));
};

const getExplicitlyAttributedCitationIdentities = ({
  claimText = "",
  citations = [],
} = {}) =>
  uniqueValues(
    citations.flatMap((citation, index) => {
      const explicitlyAttributed = getCitationDocumentAliasEntries(citation).some(
        (entry) =>
          entry.removable &&
          includesNormalizedPhrase(claimText, entry.normalized) &&
          isExplicitDocumentAttribution({
            claimText,
            alias: entry.normalized,
          })
      );

      return explicitlyAttributed ? [getCitationIdentity(citation, index)] : [];
    })
  );

const getMetadataFactAnchors = ({ claimText = "", citations = [] } = {}) =>
  uniqueValues(
    citations.flatMap((citation) =>
      getCitationDocumentAliasEntries(citation)
        .filter(
          (entry) =>
            !entry.removable && includesNormalizedPhrase(claimText, entry.normalized)
        )
        .map((entry) => entry.normalized)
    )
  );

const isStructuralClaimLabel = ({ value = "", citations = [] } = {}) => {
  const label = normalizeStructuralClaimLabel(value);
  const normalizedLabel = normalizeSearchText(label);

  return (
    STRUCTURAL_SECTION_HEADING_PATTERN.test(label) ||
    getCitationDocumentLabels(citations).has(normalizedLabel)
  );
};

const extractNumericConstraintTexts = (value = "") =>
  uniqueValues(
    NUMERIC_CONSTRAINT_PATTERNS.flatMap((pattern) => {
      pattern.lastIndex = 0;
      const matches = String(value ?? "").match(pattern) ?? [];
      pattern.lastIndex = 0;
      return matches;
    })
  );

const extractClaimAnchors = (claimText = "") =>
  Array.from([
    ...extractNumericConstraintTexts(claimText).map((text) => ({
      text,
      type: "numeric_constraint",
    })),
    ...(claimText.match(NUMBER_PATTERN) ?? []).map((text) => ({
      text,
      type: "number",
    })),
    ...(claimText.match(MONTH_PATTERN) ?? []).map((text) => ({
      text,
      type: "month",
    })),
    ...(claimText.match(DATE_PATTERN) ?? []).map((text) => ({
      text,
      type: "date",
    })),
    ...(claimText.match(CODE_PATTERN) ?? []).map((text) => ({
      text,
      type: "code",
    })),
  ].reduce((anchors, anchor) => {
    const normalized =
      anchor.type === "numeric_constraint"
        ? normalizeNumericConstraint(anchor.text)
        : normalizeSearchText(anchor.text);
    const key = `${anchor.type}:${normalized}`;

    if (!anchors.has(key)) {
      anchors.set(key, {
        ...anchor,
        normalized,
      });
    }

    return anchors;
  }, new Map()).values());

const getClaimAnchors = (claimText = "") => [
  ...extractClaimAnchors(claimText),
];

const hasClaimPredicate = (value = "") =>
  CLAIM_PREDICATE_PATTERN.test(stripSourceLabels(value));

const splitCoordinatedClaim = (value = "") => {
  const parts = String(value ?? "").split(/\s+\band\b\s+/i);

  if (parts.length < 2) {
    return [value];
  }

  const claims = [];
  let current = parts[0];

  for (const part of parts.slice(1)) {
    if (hasClaimPredicate(current) && hasClaimPredicate(part)) {
      claims.push(current);
      current = part;
      continue;
    }

    current = `${current} and ${part}`;
  }

  claims.push(current);
  return claims;
};

const moveTrailingSourceLabelsBeforePunctuation = (value = "") =>
  String(value ?? "").replace(
    SOURCE_AFTER_PUNCTUATION_PATTERN,
    (_match, punctuation, labels) => `${labels.trim()}${punctuation} `
  );

const protectDottedAbbreviations = (value = "") =>
  String(value ?? "").replace(DOTTED_ABBREVIATION_PATTERN, (match) =>
    match.replaceAll(".", PROTECTED_PERIOD)
  );

const restoreProtectedPeriods = (value = "") =>
  String(value ?? "").replaceAll(PROTECTED_PERIOD, ".");

const splitAnswerClaims = (answerText = "", citations = []) =>
  String(answerText ?? "")
    .split(/\n+/g)
    .flatMap((line) => {
      const protectedLine = moveTrailingSourceLabelsBeforePunctuation(
        protectDottedAbbreviations(line.replace(/\bvs\./gi, `vs${PROTECTED_PERIOD}`))
      );

      return protectedLine
        .split(CLAIM_SPLIT_PATTERN)
        .flatMap((claim) => {
          const sourceRanks = extractSourceRanks(claim);

          return splitCoordinatedClaim(claim).map((coordinatedClaim) => ({
            rawText: restoreProtectedPeriods(coordinatedClaim).trim(),
            sourceRanks,
          }));
        });
    })
    .filter(
      (claim) =>
        !isStructuralClaimLabel({ value: claim.rawText, citations })
    )
    .map((claim) => ({
      text: stripSourceLabels(claim.rawText)
        .replace(/[.!?。！？]+$/g, "")
        .trim(),
      sourceRanks: claim.sourceRanks,
    }))
    .filter((claim) => {
      const meaningfulTermCount = extractMeaningfulTokens(claim.text).length;

      return Boolean(
        claim.text &&
          (meaningfulTermCount >= 1 ||
            getClaimAnchors(claim.text).length > 0 ||
            claim.sourceRanks.length > 0)
      );
    });

const buildCitationSupportSegments = (citations = []) =>
  uniqueValues(
    citations.flatMap((citation) =>
      CHECKABLE_CITATION_FIELDS.flatMap((field) =>
        String(citation?.[field] ?? "")
          .split(/(?<=[.!?。！？])\s+|\n+/g)
          .map((sentence) => sentence.trim())
          .filter(Boolean)
          .flatMap((sentence) => [sentence, ...splitModalityClauses(sentence)])
      )
    )
  );

const normalizeNumericAnchor = (value = "") => {
  const compact = String(value ?? "")
    .replace(/,/g, "")
    .replace(/^([+-]?)\$/, "$1")
    .trim();
  const percentage = compact.endsWith("%");
  const numericValue = Number(percentage ? compact.slice(0, -1) : compact);

  return Number.isFinite(numericValue)
    ? `${numericValue}${percentage ? "%" : ""}`
    : compact.toLowerCase();
};

const normalizeNumericConstraint = (value = "") => {
  const compact = String(value ?? "")
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const numbers = compact.match(/\$?\d+(?:\.\d+)?%?/g) ?? [];
  const normalizedNumbers = numbers.map(normalizeNumericAnchor);

  if (/^(?:at least|minimum(?: of)?|no fewer than)\b/.test(compact)) {
    return `gte:${normalizedNumbers[0] ?? ""}`;
  }
  if (/^(?:up to|at most|maximum(?: of)?|no more than)\b/.test(compact)) {
    return `lte:${normalizedNumbers[0] ?? ""}`;
  }
  if (compact.startsWith(">=")) {
    return `gte:${normalizedNumbers[0] ?? ""}`;
  }
  if (compact.startsWith("<=")) {
    return `lte:${normalizedNumbers[0] ?? ""}`;
  }
  if (compact.startsWith(">")) {
    return `gt:${normalizedNumbers[0] ?? ""}`;
  }
  if (compact.startsWith("<")) {
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

const isAnchorSupported = ({ anchor, rawSupportText = "" } = {}) => {
  if (anchor.type === "numeric_constraint") {
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

const hasNegativePolarity = (value = "") =>
  NEGATIVE_POLARITY_PATTERN.test(String(value ?? ""));

const getTokenOverlap = ({ claimTerms, supportTerms }) => {
  if (claimTerms.length === 0) {
    return 1;
  }

  const matchedTerms = claimTerms.filter((term) => supportTerms.has(term));

  return Number((matchedTerms.length / claimTerms.length).toFixed(4));
};

const getClaimBindingTerms = ({
  claimText = "",
  documentAttributionTerms = new Set(),
  forceComparisonClaim = false,
} = {}) => {
  if (forceComparisonClaim) {
    return [];
  }

  const factualClaim = stripClaimLeadLabel(claimText);
  const predicateMatch = CLAIM_PREDICATE_PATTERN.exec(factualClaim);

  if (!predicateMatch || predicateMatch.index === 0) {
    return [];
  }

  const genericDocumentAttributionTerms = getGenericDocumentAttributionTerms(
    factualClaim
  );

  return uniqueValues(
    extractFactTerms(factualClaim.slice(0, predicateMatch.index))
  ).filter(
    (term) =>
      !documentAttributionTerms.has(term) &&
      !genericDocumentAttributionTerms.has(term) &&
      !DOCUMENT_IDENTITY_TERMS.has(term) &&
      !DOCUMENT_ATTRIBUTION_PREPOSITIONS.has(term) &&
      !COMPARISON_SCAFFOLD_TERMS.has(term)
  );
};

const getAdditiveDetailTermGroups = ({
  claimText = "",
  documentAttributionTerms = new Set(),
} = {}) =>
  [
    ...String(claimText ?? "").matchAll(
      /\b(?:and|with|plus|including|along with|as well as)\b\s+([^,;.!?。！？]+)/gi
    ),
  ]
    .map((match) =>
      uniqueValues(extractMeaningfulTokens(match[1])).filter(
        (term) =>
          !documentAttributionTerms.has(term) &&
          !COMPARISON_SCAFFOLD_TERMS.has(term) &&
          !MODALITY_CLAIM_TERMS.has(term)
      )
    )
    .filter((terms) => terms.length > 0);

const buildClaimTerms = ({
  claimText,
  scopedCitations,
  documentLabelCitations = scopedCitations,
  forceComparisonClaim = false,
  supportTerms,
}) => {
  const factualClaimText = stripClaimLeadLabel(claimText);
  const citedDocCount = getCitationDocIds(scopedCitations).size;
  const mentionedDocCount = new Set(
    documentLabelCitations
      .filter((citation) =>
        getCitationDocumentAliases(citation).some((alias) =>
          includesNormalizedPhrase(factualClaimText, alias)
        )
      )
      .map((citation) => getCitationIdentity(citation))
  ).size;
  const comparisonClaim =
    forceComparisonClaim ||
    EITHER_DOCUMENT_RELATION_PATTERN.test(factualClaimText) ||
    (citedDocCount > 1 &&
      (COMPARISON_RELATION_PATTERN.test(factualClaimText) || mentionedDocCount > 1));
  const documentAttributionTerms = getDocumentAttributionTerms({
    claimText: factualClaimText,
    citations: documentLabelCitations,
    forceComparisonClaim: comparisonClaim,
  });
  const genericDocumentAttributionTerms = getGenericDocumentAttributionTerms(
    factualClaimText
  );
  const chineseModalitySurfaceTerms = getChineseModalitySurfaceTerms(
    factualClaimText
  );

  return extractFactTerms(factualClaimText).filter((term) => {
    if (
      documentAttributionTerms.has(term) ||
      genericDocumentAttributionTerms.has(term)
    ) {
      return false;
    }

    if (
      (MODALITY_CLAIM_TERMS.has(term) ||
        chineseModalitySurfaceTerms.has(term)) &&
      getModalityLabels(factualClaimText).length > 0
    ) {
      return false;
    }

    if (
      documentAttributionTerms.size > 0 &&
      DOCUMENT_ATTRIBUTION_PREPOSITIONS.has(term)
    ) {
      return false;
    }

    return !(
      comparisonClaim &&
      !supportTerms.has(term) &&
      COMPARISON_SCAFFOLD_TERMS.has(term)
    );
  });
};

const getCitationIdentity = (citation = {}, index = 0) =>
  normalizeEvidenceText(citation?.docId) ||
  normalizeSearchText(citation?.fileName) ||
  `citation-${index + 1}`;

const groupCitationsByDocument = (citations = []) => {
  const groupsByIdentity = new Map();

  citations.forEach((citation, index) => {
    const identity = getCitationIdentity(citation, index);
    const existing = groupsByIdentity.get(identity);

    if (existing) {
      existing.citations.push(citation);
      return;
    }

    groupsByIdentity.set(identity, {
      identity,
      docId: normalizeEvidenceText(citation?.docId) || null,
      citations: [citation],
    });
  });

  return [...groupsByIdentity.values()];
};

const getGroupDocumentAliases = (group = {}) =>
  uniqueValues(
    (group.citations ?? []).flatMap((citation) =>
      getCitationDocumentAliases(citation)
    )
  );

const evaluateClaimAgainstCitations = ({
  claimText,
  citations = [],
  documentLabelCitations = citations,
  forceComparisonClaim = false,
} = {}) => {
  const anchors = extractClaimAnchors(claimText);
  const modalityAnchors = getModalityLabels(claimText);
  const documentAttributionTerms = getDocumentAttributionTerms({
    claimText,
    citations: documentLabelCitations,
    forceComparisonClaim,
  });
  const supportSegments = buildCitationSupportSegments(citations);
  const claimHasNegativePolarity = hasNegativePolarity(claimText);
  const metadataFactAnchors = getMetadataFactAnchors({
    claimText,
    citations: documentLabelCitations,
  });
  const bindingTerms = getClaimBindingTerms({
    claimText,
    documentAttributionTerms,
    forceComparisonClaim,
  });
  const additiveDetailTermGroups = getAdditiveDetailTermGroups({
    claimText,
    documentAttributionTerms,
  });
  const segmentChecks = supportSegments.map((segment) => {
    const supportTerms = new Set(extractFactTerms(segment));
    const claimTerms = buildClaimTerms({
      claimText,
      documentLabelCitations,
      forceComparisonClaim,
      scopedCitations: citations,
      supportTerms,
    });
    const missingAnchors = anchors
      .filter((anchor) => !isAnchorSupported({ anchor, rawSupportText: segment }))
      .map((anchor) => anchor.text);
    const missingModalityAnchors = modalityAnchors.filter(
      (anchor) => !getModalityLabels(segment).includes(anchor)
    );
    const missingMetadataFactAnchors = metadataFactAnchors.filter(
      (anchor) => !includesNormalizedPhrase(segment, anchor)
    );
    const missingBindingTerms = bindingTerms.filter(
      (term) => !supportTerms.has(term)
    );
    const missingClaimTerms = claimTerms.filter(
      (term) => !supportTerms.has(term)
    );
    const additiveDetailsSupported = additiveDetailTermGroups.every((terms) =>
      terms.every((term) => supportTerms.has(term))
    );
    const polaritySupported =
      hasNegativePolarity(segment) === claimHasNegativePolarity;
    const tokenOverlap = getTokenOverlap({ claimTerms, supportTerms });

    return {
      supported:
        missingAnchors.length === 0 &&
        missingModalityAnchors.length === 0 &&
        missingMetadataFactAnchors.length === 0 &&
        missingBindingTerms.length === 0 &&
        missingClaimTerms.length === 0 &&
        additiveDetailsSupported &&
        polaritySupported &&
        tokenOverlap >= SUPPORT_TOKEN_OVERLAP_THRESHOLD,
      tokenOverlap,
      missingAnchors: [
        ...missingAnchors,
        ...missingModalityAnchors,
        ...missingMetadataFactAnchors,
        ...missingBindingTerms.map((term) => `subject:${term}`),
        ...missingClaimTerms.map((term) => `term:${term}`),
        ...(additiveDetailsSupported ? [] : ["additive_detail"]),
        ...(polaritySupported ? [] : ["polarity"]),
      ],
    };
  });
  const bestCheck = segmentChecks.sort(
    (left, right) =>
      Number(right.supported) - Number(left.supported) ||
      right.tokenOverlap - left.tokenOverlap ||
      left.missingAnchors.length - right.missingAnchors.length
  )[0] ?? {
    supported: false,
    tokenOverlap: 0,
    missingAnchors: [],
  };

  return {
    supported: bestCheck.supported,
    tokenOverlap: bestCheck.tokenOverlap,
    anchors: [
      ...anchors.map((anchor) => anchor.text),
      ...modalityAnchors,
      ...metadataFactAnchors,
    ],
    missingAnchors: bestCheck.missingAnchors,
  };
};

const getCitationSourceRank = ({
  citation,
  scopedCitations = [],
  sourceRanks = [],
} = {}) => {
  const explicitRank = Number(citation?.rank);

  if (Number.isInteger(explicitRank) && explicitRank > 0) {
    return explicitRank;
  }

  const citationIndex = scopedCitations.indexOf(citation);
  const fallbackRank = Number(sourceRanks[citationIndex]);

  return Number.isInteger(fallbackRank) && fallbackRank > 0
    ? fallbackRank
    : null;
};

const evaluateDocumentGroupSupport = ({
  claimText,
  group,
  documentLabelCitations,
  scopedCitations,
  sourceRanks,
} = {}) => {
  const check = evaluateClaimAgainstCitations({
    claimText,
    citations: group.citations,
    documentLabelCitations,
    forceComparisonClaim: true,
  });

  if (!check.supported) {
    return {
      check,
      supportedSourceRanks: [],
    };
  }

  const individuallySupportingCitations = group.citations.filter((citation) =>
    evaluateClaimAgainstCitations({
      claimText,
      citations: [citation],
      documentLabelCitations,
      forceComparisonClaim: true,
    }).supported
  );

  if (individuallySupportingCitations.length > 0) {
    return {
      check,
      supportedSourceRanks: uniqueValues(
        individuallySupportingCitations.map((citation) =>
          getCitationSourceRank({ citation, scopedCitations, sourceRanks })
        )
      ),
    };
  }

  let contributingCitations = [...group.citations];

  for (const citation of group.citations) {
    const reducedCitations = contributingCitations.filter(
      (candidate) => candidate !== citation
    );

    if (
      reducedCitations.length > 0 &&
      evaluateClaimAgainstCitations({
        claimText,
        citations: reducedCitations,
        documentLabelCitations,
        forceComparisonClaim: true,
      }).supported
    ) {
      contributingCitations = reducedCitations;
    }
  }

  return {
    check,
    supportedSourceRanks: uniqueValues(
      contributingCitations.map((citation) =>
        getCitationSourceRank({ citation, scopedCitations, sourceRanks })
      )
    ),
  };
};

const buildUnsupportedRelationCheck = (claimText = "") => ({
  supported: false,
  tokenOverlap: 0,
  anchors: extractClaimAnchors(claimText).map((anchor) => anchor.text),
  missingAnchors: [],
  supportedSourceRanks: [],
});

const haveSameValues = (leftValues = [], rightValues = []) => {
  const left = new Set(leftValues);
  const right = new Set(rightValues);

  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
};

const buildContrastFactSignature = ({
  clause = "",
  citations = [],
} = {}) => {
  const factualClause = String(clause ?? "").replace(
    /^.*?\bdiffer(?:s|ed|ent)?\b\s*:?\s*/i,
    ""
  );
  const attributionTerms = getDocumentAttributionTerms({
    claimText: factualClause,
    citations,
    forceComparisonClaim: true,
  });
  const terms = extractMeaningfulTokens(factualClause).filter(
    (term) =>
      !attributionTerms.has(term) &&
      !COMPARISON_SCAFFOLD_TERMS.has(term) &&
      !CONTRAST_STYLE_TERMS.has(term) &&
      !MODALITY_CLAIM_TERMS.has(term) &&
      !DOCUMENT_ATTRIBUTION_VERBS.has(term) &&
      !DOCUMENT_IDENTITY_TERMS.has(term)
  );
  const anchors = extractClaimAnchors(factualClause).map((anchor) =>
    anchor.type === "number"
      ? `${anchor.type}:${normalizeNumericAnchor(anchor.text)}`
      : `${anchor.type}:${anchor.normalized}`
  );

  return {
    fact: uniqueValues([...terms, ...anchors]).sort().join("|"),
    modality: getModalityLabels(factualClause).sort().join("|"),
  };
};

const hasSubstantiveContrast = (factSignatures = []) => {
  const factValues = factSignatures.map((signature) => signature.fact);

  if (new Set(factValues.filter(Boolean)).size > 1) {
    return true;
  }

  const modalityValues = factSignatures.map((signature) => signature.modality);

  return (
    modalityValues.every(Boolean) && new Set(modalityValues).size > 1
  );
};

const evaluateContrastClaimSupport = ({
  claimText,
  scopedCitations,
  sourceRanks = [],
} = {}) => {
  if (!CONTRAST_RELATION_PATTERN.test(claimText)) {
    return null;
  }

  const documentGroups = groupCitationsByDocument(scopedCitations);

  if (documentGroups.length < 2) {
    return null;
  }

  const mentionsComparedDocument = documentGroups.some((group) =>
    getGroupDocumentAliases(group).some((alias) =>
      includesNormalizedPhrase(claimText, alias)
    )
  );

  if (!mentionsComparedDocument) {
    const documentSupport = documentGroups.map((group) =>
      evaluateDocumentGroupSupport({
        claimText,
        group,
        documentLabelCitations: scopedCitations,
        scopedCitations,
        sourceRanks,
      })
    );
    const documentChecks = documentSupport.map((result) => result.check);

    return {
      supported: documentChecks.every((check) => check.supported),
      tokenOverlap: Math.min(
        ...documentChecks.map((check) => check.tokenOverlap)
      ),
      anchors: uniqueValues(
        documentChecks.flatMap((check) => check.anchors)
      ),
      missingAnchors: uniqueValues(
        documentChecks.flatMap((check) => check.missingAnchors)
      ),
      supportedSourceRanks: uniqueValues(
        documentSupport.flatMap((result) => result.supportedSourceRanks)
      ),
    };
  }

  if (documentGroups.length < 2 || sourceRanks.length === 0) {
    return buildUnsupportedRelationCheck(claimText);
  }

  const clauses = String(claimText ?? "")
    .split(
      /\s*(?:,|，)?\s*(?:\b(?:while|whereas|versus|vs)\b|而|但是?|然而|相比之下|相较之下)\s*/i
    )
    .map((clause) => clause.trim())
    .filter(Boolean);
  const clauseChecks = [];
  const factSignatures = [];
  const supportingSourceRanks = [];
  const boundDocumentIdentities = new Set();

  for (const clause of clauses) {
    const matchingGroups = documentGroups.filter((group) =>
      getGroupDocumentAliases(group).some((alias) =>
        includesNormalizedPhrase(clause, alias)
      )
    );

    for (const group of matchingGroups) {
      boundDocumentIdentities.add(group.identity);
      factSignatures.push(
        buildContrastFactSignature({
          clause,
          citations: scopedCitations,
        })
      );
      const groupSupport = evaluateDocumentGroupSupport({
        claimText: clause,
        group,
        documentLabelCitations: scopedCitations,
        scopedCitations,
        sourceRanks,
      });
      clauseChecks.push(groupSupport.check);
      supportingSourceRanks.push(...groupSupport.supportedSourceRanks);
    }
  }

  if (
    clauseChecks.length < 2 ||
    boundDocumentIdentities.size !== documentGroups.length
  ) {
    return buildUnsupportedRelationCheck(claimText);
  }

  return {
    supported:
      clauseChecks.every((check) => check.supported) &&
      hasSubstantiveContrast(factSignatures),
    tokenOverlap: Math.min(...clauseChecks.map((check) => check.tokenOverlap)),
    anchors: uniqueValues(clauseChecks.flatMap((check) => check.anchors)),
    missingAnchors: uniqueValues(
      clauseChecks.flatMap((check) => check.missingAnchors)
    ),
    supportedSourceRanks: uniqueValues(supportingSourceRanks),
  };
};

const evaluateAgreementClaimSupport = ({
  claimText,
  scopedCitations,
  sourceRanks = [],
} = {}) => {
  if (!AGREEMENT_RELATION_PATTERN.test(claimText)) {
    return null;
  }

  const documentGroups = groupCitationsByDocument(scopedCitations);

  if (documentGroups.length < 2 || sourceRanks.length === 0) {
    return buildUnsupportedRelationCheck(claimText);
  }

  const documentSupport = documentGroups.map((group) =>
    evaluateDocumentGroupSupport({
      claimText,
      group,
      documentLabelCitations: scopedCitations,
      scopedCitations,
      sourceRanks,
    })
  );
  const documentChecks = documentSupport.map((result) => result.check);

  return {
    supported: documentChecks.every((check) => check.supported),
    tokenOverlap: Math.min(...documentChecks.map((check) => check.tokenOverlap)),
    anchors: uniqueValues(documentChecks.flatMap((check) => check.anchors)),
    missingAnchors: uniqueValues(
      documentChecks.flatMap((check) => check.missingAnchors)
    ),
    supportedSourceRanks: uniqueValues(
      documentSupport.flatMap((result) => result.supportedSourceRanks)
    ),
  };
};

const evaluateExclusiveClaimSupport = ({
  allCitations,
  claimText,
  sourceRanks = [],
} = {}) => {
  if (!EXCLUSIVE_RELATION_PATTERN.test(claimText)) {
    return null;
  }

  const allDocumentGroups = groupCitationsByDocument(allCitations);

  if (allDocumentGroups.length < 2) {
    return null;
  }

  const exclusiveClause = String(claimText ?? "")
    .split(/\s*,?\s*\b(?:while|whereas)\b\s*/i)[0]
    .trim();
  const normalizedClauseTerms = normalizeSearchText(exclusiveClause).split(/\s+/g);
  const exclusiveTokenIndexes = normalizedClauseTerms
    .map((term, index) =>
      ["only", "solely", "exclusively", "alone"].includes(term)
        ? index
        : -1
    )
    .filter((index) => index >= 0);
  const exclusiveDirectlyTargetsAlias = allDocumentGroups.some((group) =>
    getGroupDocumentAliases(group).some((alias) => {
      const normalizedAlias = normalizeSearchText(alias);
      const aliasTerms = normalizedAlias.split(/\s+/g);
      const aliasIndex = normalizedClauseTerms.findIndex((term, index) =>
        aliasTerms.every(
          (aliasTerm, offset) => normalizedClauseTerms[index + offset] === aliasTerm
        )
      );

      if (aliasIndex < 0) {
        return false;
      }

      const aliasEndIndex = aliasIndex + aliasTerms.length - 1;

      return exclusiveTokenIndexes.some(
        (exclusiveIndex) =>
          (exclusiveIndex < aliasIndex && aliasIndex - exclusiveIndex <= 3) ||
          (exclusiveIndex > aliasEndIndex && exclusiveIndex - aliasEndIndex <= 2)
      );
    })
  );
  const genericDocumentExclusive = GENERIC_EXCLUSIVE_DOCUMENT_PATTERN.test(
    exclusiveClause
  );
  const sourceScopedExclusive =
    sourceRanks.length > 0 && SOURCE_SCOPED_EXCLUSIVE_PATTERN.test(exclusiveClause);

  if (
    !exclusiveDirectlyTargetsAlias &&
    !genericDocumentExclusive &&
    !sourceScopedExclusive
  ) {
    return null;
  }

  return buildUnsupportedRelationCheck(claimText);
};

const evaluateNoDifferenceClaimSupport = ({
  claimText,
  comparisonAnalysisSummary,
  scopedCitations,
  sourceRanks = [],
} = {}) => {
  if (!NO_DIFFERENCE_RELATION_PATTERN.test(claimText)) {
    return null;
  }

  const explicitConflictPairs = Array.isArray(
    comparisonAnalysisSummary?.explicitConflictPairs
  )
    ? comparisonAnalysisSummary.explicitConflictPairs
    : [];
  const comparedDocIds = Array.isArray(
    comparisonAnalysisSummary?.comparedDocIds
  )
    ? comparisonAnalysisSummary.comparedDocIds
        .map((docId) => normalizeEvidenceText(docId))
        .filter(Boolean)
    : [];
  const scopedDocumentGroups = groupCitationsByDocument(scopedCitations);
  const scopedDocIds = scopedDocumentGroups
    .map((group) => group.docId)
    .filter(Boolean);
  const supported =
    EVIDENCE_SCOPED_NO_DIFFERENCE_PATTERN.test(claimText) &&
    sourceRanks.length >= 2 &&
    scopedDocumentGroups.length >= 2 &&
    scopedDocIds.length === scopedDocumentGroups.length &&
    haveSameValues(comparedDocIds, scopedDocIds) &&
    comparisonAnalysisSummary?.shouldShortCircuitNoMaterialDifference === true &&
    explicitConflictPairs.length === 0;

  return {
    supported,
    tokenOverlap: supported ? 1 : 0,
    anchors: extractClaimAnchors(claimText).map((anchor) => anchor.text),
    missingAnchors: [],
    supportedSourceRanks: supported
      ? uniqueValues(
          scopedDocumentGroups.map((group) =>
            getCitationSourceRank({
              citation: group.citations[0],
              scopedCitations,
              sourceRanks,
            })
          )
        )
      : [],
  };
};

const combineRelationSupportChecks = (checks = []) => {
  const activeChecks = checks.filter(Boolean);

  if (activeChecks.length === 0) {
    return null;
  }

  return {
    supported: activeChecks.every((check) => check.supported),
    tokenOverlap: Math.min(...activeChecks.map((check) => check.tokenOverlap)),
    anchors: uniqueValues(activeChecks.flatMap((check) => check.anchors)),
    missingAnchors: uniqueValues(
      activeChecks.flatMap((check) => check.missingAnchors)
    ),
    supportedSourceRanks: uniqueValues(
      activeChecks.flatMap((check) => check.supportedSourceRanks ?? [])
    ),
  };
};

export const evaluateClaimSupport = ({
  answerText = "",
  citations = [],
  comparisonAnalysisSummary = null,
} = {}) => {
  const claims = splitAnswerClaims(answerText, citations);
  const citationRankEntries = citations.map((citation, index) => {
    const explicitRank = Number(citation?.rank);
    const rank =
      Number.isInteger(explicitRank) && explicitRank > 0
        ? explicitRank
        : index + 1;

    return { citation, rank };
  });
  const citationRankCounts = citationRankEntries.reduce((counts, entry) => {
    counts.set(entry.rank, (counts.get(entry.rank) ?? 0) + 1);
    return counts;
  }, new Map());
  const citationByRank = new Map();

  for (const entry of citationRankEntries) {
    if (!citationByRank.has(entry.rank)) {
      citationByRank.set(entry.rank, entry.citation);
    }
  }

  if (claims.length === 0) {
    return {
      checked: false,
      supportedClaimCount: 0,
      unsupportedClaimCount: 0,
      claims: [],
    };
  }

  const checkedClaims = claims.map(({ text: claimText, sourceRanks }) => {
    const missingSourceRanks = sourceRanks.filter(
      (rank) => !citationByRank.has(rank)
    );
    const ambiguousSourceRanks = sourceRanks.filter(
      (rank) => (citationRankCounts.get(rank) ?? 0) > 1
    );
    const scopedCitations =
      sourceRanks.length > 0
        ? sourceRanks
            .map((rank) => citationByRank.get(rank))
            .filter(Boolean)
        : citations;
    const scopedCitationIdentities = new Set(
      scopedCitations.map((citation, index) =>
        getCitationIdentity(citation, index)
      )
    );
    const misattributedCitationIdentities =
      getExplicitlyAttributedCitationIdentities({
        claimText,
        citations,
      }).filter((identity) => !scopedCitationIdentities.has(identity));
    const defaultSupport = evaluateClaimAgainstCitations({
      claimText,
      citations: scopedCitations,
      documentLabelCitations: citations,
    });
    const contrastSupport = evaluateContrastClaimSupport({
      claimText,
      scopedCitations,
      sourceRanks,
    });
    const agreementSupport = evaluateAgreementClaimSupport({
      claimText,
      scopedCitations,
      sourceRanks,
    });
    const exclusiveSupport = evaluateExclusiveClaimSupport({
      allCitations: citations,
      claimText,
      scopedCitations,
      sourceRanks,
    });
    const noDifferenceSupport = evaluateNoDifferenceClaimSupport({
      claimText,
      comparisonAnalysisSummary,
      scopedCitations,
      sourceRanks,
    });
    const relationSupport = combineRelationSupportChecks([
      noDifferenceSupport,
      contrastSupport,
      agreementSupport,
      exclusiveSupport,
    ]);
    const tokenOverlap =
      relationSupport?.tokenOverlap ?? defaultSupport.tokenOverlap;
    const missingAnchors =
      relationSupport?.missingAnchors ?? defaultSupport.missingAnchors;
    const individuallySupportedSourceRanks = sourceRanks.filter((rank) => {
      if (
        !citationByRank.has(rank) ||
        (citationRankCounts.get(rank) ?? 0) !== 1
      ) {
        return false;
      }

      return evaluateClaimAgainstCitations({
        claimText,
        citations: [citationByRank.get(rank)],
        documentLabelCitations: citations,
      }).supported;
    });
    const verifiedSourceRanks = (relationSupport
      ? uniqueValues([
          ...relationSupport.supportedSourceRanks,
          ...individuallySupportedSourceRanks,
        ])
      : individuallySupportedSourceRanks
    ).sort((left, right) => left - right);
    const explicitSourcesArePrecise =
      sourceRanks.length === 0 || haveSameValues(sourceRanks, verifiedSourceRanks);
    const supported =
      sourceRanks.length > 0 &&
      missingSourceRanks.length === 0 &&
      ambiguousSourceRanks.length === 0 &&
      misattributedCitationIdentities.length === 0 &&
      explicitSourcesArePrecise &&
      (relationSupport?.supported ?? defaultSupport.supported);
    const supportedSourceRanks = supported ? verifiedSourceRanks : [];
    const supportedCitedDocIds = uniqueValues(
      supportedSourceRanks.map(
        (rank) => normalizeEvidenceText(citationByRank.get(rank)?.docId)
      )
    );

    return {
      text: claimText,
      supported,
      tokenOverlap,
      anchors: relationSupport?.anchors ?? defaultSupport.anchors,
      sourceRanks,
      citedDocIds: [...getCitationDocIds(scopedCitations)],
      verifiedSourceRanks,
      supportedSourceRanks,
      supportedCitedDocIds,
      missingSourceRanks,
      ambiguousSourceRanks,
      misattributedCitationIdentities,
      missingAnchors,
    };
  });
  const unsupportedClaimCount = checkedClaims.filter((claim) => !claim.supported).length;

  return {
    checked: true,
    supportedClaimCount: checkedClaims.length - unsupportedClaimCount,
    unsupportedClaimCount,
    claims: checkedClaims,
  };
};

const getEvidenceScore = (ragResult) => {
  if (!ragResult?.ok) {
    return -1;
  }

  const value = ragResult.value ?? {};
  const citations = attachRetrievedEvidence({
    citations: value.citations ?? [],
    retrievedContexts: value.retrievedContexts ?? [],
  });
  const citedDocIds = getCitationDocIds(citations);
  const answerLength = typeof value.text === "string" ? value.text.trim().length : 0;
  const claimSupport = evaluateClaimSupport({
    answerText: value.text,
    citations,
    comparisonAnalysisSummary: value.comparisonAnalysisSummary,
  });

  return (
    citations.length * 2 +
    citedDocIds.size +
    (answerLength > 0 ? 1 : 0) +
    claimSupport.supportedClaimCount -
    claimSupport.unsupportedClaimCount * 3
  );
};

export const evaluateAnswerEvidence = ({
  answerLabel = "Document answer",
  answerText = "",
  citations = [],
  comparisonAnalysisSummary = null,
  docIds = [],
  emptyAnswerReason = `${answerLabel} is empty.`,
  initialReasons = [],
  missingCheckableCitationReason = `${answerLabel} citations do not include checkable evidence text.`,
  missingCitationReason = `${answerLabel} has no citations.`,
  normalizeClaimSupport = (claimSupport) => claimSupport,
  requireCheckableCitationText = false,
  requireDocCoverage = true,
  retryRecommended = false,
  unsupportedClaimReason = (claimCount) =>
    `${claimCount} answer claim${claimCount === 1 ? "" : "s"} lacks citation support.`,
} = {}) => {
  const safeCitations = Array.isArray(citations) ? citations : [];
  const safeDocIds = Array.isArray(docIds) ? docIds : [];
  const requiredDocCoverage = requireDocCoverage
    ? Math.min(Math.max(safeDocIds.length, 1), 2)
    : 0;
  const claimSupport = normalizeClaimSupport(
    evaluateClaimSupport({
      answerText,
      citations: safeCitations,
      comparisonAnalysisSummary,
    })
  );
  const answerCitations = filterCitationsToSourceRanks({
    sourceRanks: claimSupport.claims.flatMap(
      (claim) => claim.supportedSourceRanks ?? []
    ),
    citations: safeCitations,
  });
  const citedDocIds = getCitationDocIds(answerCitations);
  const reasons = [...initialReasons];

  if (!normalizeEvidenceText(answerText)) {
    reasons.push(emptyAnswerReason);
  }

  if (safeCitations.length === 0) {
    reasons.push(missingCitationReason);
  }

  if (requireCheckableCitationText && !hasCheckableCitationText(safeCitations)) {
    reasons.push(missingCheckableCitationReason);
  }

  if (requiredDocCoverage > 0 && citedDocIds.size < requiredDocCoverage) {
    reasons.push(
      `Citations cover ${citedDocIds.size} of ${requiredDocCoverage} required documents.`
    );
  }

  if (claimSupport.unsupportedClaimCount > 0) {
    reasons.push(unsupportedClaimReason(claimSupport.unsupportedClaimCount));
  }

  const result = {
    answerLabel,
    citationCount: safeCitations.length,
    citedDocCount: citedDocIds.size,
    claimSupport,
    passed: reasons.length === 0,
    reasons,
    requiredCitationCount: 1,
    requiredDocCoverage,
    retryRecommended,
  };

  return {
    ...result,
    gaps: buildEvidenceGaps(result),
  };
};

export const evaluateDocumentEvidence = ({ ragResult, docIds = [] } = {}) => {
  if (!ragResult?.ok) {
    return {
      passed: false,
      retryRecommended: false,
      reasons: ["Document RAG failed."],
      citationCount: 0,
      citedDocCount: 0,
      requiredCitationCount: 1,
      requiredDocCoverage: Math.min(Math.max(docIds.length, 1), 2),
      gaps: [
        {
          type: "skill_failure",
          severity: "blocking",
          message: "Document RAG failed.",
        },
      ],
    };
  }

  const value = ragResult.value ?? {};
  const verificationCitations = attachRetrievedEvidence({
    citations: value.citations ?? [],
    retrievedContexts: value.retrievedContexts ?? [],
  });
  const result = evaluateAnswerEvidence({
    answerLabel: "Document answer",
    answerText: value.text,
    citations: verificationCitations,
    comparisonAnalysisSummary: value.comparisonAnalysisSummary,
    docIds,
    emptyAnswerReason: "Document answer is empty.",
    initialReasons: value.abstained
      ? ["Document RAG explicitly reported insufficient evidence."]
      : [],
    missingCitationReason: "Document answer has no citations.",
    requireDocCoverage: true,
    retryRecommended: false,
  });
  const retryRecommended = !result.passed && !value.abstained && ragResult.ok;

  return {
    ...result,
    retryRecommended,
  };
};

export function buildEvidenceGaps(check = {}) {
  const gaps = [];
  const answerLabel = check.answerLabel ?? "Document answer";

  if (check.reasons?.some((reason) => /insufficient evidence/i.test(reason))) {
    gaps.push({
      type: "insufficient_evidence",
      severity: "blocking",
      message: "Document RAG reported insufficient evidence.",
    });
  }

  if (check.reasons?.some((reason) => /empty/i.test(reason))) {
    gaps.push({
      type: "empty_answer",
      severity: "blocking",
      message: `${answerLabel} is empty.`,
    });
  }

  if (check.citationCount === 0) {
    gaps.push({
      type: "missing_citations",
      severity: "blocking",
      message: `${answerLabel} has no citations.`,
    });
  }

  if (
    Number.isFinite(Number(check.requiredDocCoverage)) &&
    Number(check.requiredDocCoverage) > 1 &&
    Number(check.citedDocCount) < Number(check.requiredDocCoverage)
  ) {
    gaps.push({
      type: "document_coverage",
      severity: "repairable",
      message: `Citations cover ${check.citedDocCount ?? 0} of ${
        check.requiredDocCoverage
      } required documents.`,
      citedDocCount: check.citedDocCount ?? 0,
      requiredDocCoverage: check.requiredDocCoverage,
    });
  }

  for (const claim of check.claimSupport?.claims ?? []) {
    if (claim.supported) {
      continue;
    }

    gaps.push({
      type: "unsupported_claim",
      severity: "repairable",
      message: "Answer claim lacks citation support.",
      claim: claim.text,
      missingAnchors: claim.missingAnchors ?? [],
      tokenOverlap: claim.tokenOverlap ?? null,
    });
  }

  return gaps.length > 0
    ? gaps
    : (check.reasons ?? []).map((reason) => ({
        type: "evidence_check",
        severity: "repairable",
        message: reason,
      }));
}

export const buildEvidenceRetryQuestion = ({ question, check } = {}) => {
  const reasonText = check?.reasons?.length
    ? check.reasons.join(" ")
    : "The first answer did not provide enough grounded evidence.";

  return [
    "Re-check the uploaded documents for cited support before answering.",
    `Original question: ${question}`,
    `Evidence issue: ${reasonText}`,
    check?.claimSupport?.unsupportedClaimCount
      ? `Unsupported claims: ${check.claimSupport.claims
          .filter((claim) => !claim.supported)
          .map((claim) => claim.text)
          .join(" | ")}`
      : "",
    "Return the best answer only if it is backed by page-level citations.",
  ].filter(Boolean).join("\n");
};

export const selectBetterRagResult = ({ primary, retry } = {}) => {
  if (!retry?.ok) {
    return primary;
  }

  if (!primary?.ok) {
    return retry;
  }

  return getEvidenceScore(retry) > getEvidenceScore(primary) ? retry : primary;
};
