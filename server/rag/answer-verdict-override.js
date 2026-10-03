// RAG_QA_VERDICT_OVERRIDE=supported: a NOT_IN_EVIDENCE reply that answers anyway.
//
// With RAG_QA_ANSWER_VERDICT on, the QA answer model opens its reply with
// NOT_IN_EVIDENCE: when it judges that the evidence does not answer, and
// writeQaAnswer turns such a reply into an abstention (answer-verdict.js). A
// small model sometimes opens with the marker and then states the answer with
// its source anyway. This override reads the text after the marker and answers
// only when that text proves it, deterministically:
//
// 1. Sentences that say the evidence is absent, unclear or only partial
//    ("the documents do not state ...", "... is not specified", "the question
//    asks about ...") are hedges. They are removed, never counted as claims,
//    and never part of the answer.
// 2. One exception, the shape qwen2.5:7b used on verify:quality: a hedge whose
//    second half states what the evidence does say ("the documents do not
//    specify a limitation of liability beyond <fact>", "... except <fact>",
//    "..., only <fact>"). The hedge half is still removed; the part after
//    "beyond", "other than", "except (for)", "apart from", "aside from",
//    "besides" or ", only" (framing such as "stating that" removed) becomes a
//    residual claim, checked exactly like a separate sentence. English only.
//    The residual must be a statement: framed by "that" ("beyond stating
//    that <fact>") or holding a claim predicate (is, shall, must, ...). A bare
//    noun phrase ("other than indirect damages") borrows the hedge's verb,
//    which nothing checks, and is dropped with the hedge.
//    A sentence that points to where the answer is ("the notice period is
//    defined in Schedule 2", "the results are shown in Table 3") is a hedge
//    too: it says where the answer is, not what it is.
// 3. What remains is checked with the lexical claim check the finalizer uses
//    (evaluateClaimSupport: numbers present in the cited evidence, source and
//    attribution checks). The LLM claim judge is never called here. The
//    evidence is checked as the model was shown it: a sentence the prompt
//    injection screen removed (an instruction addressed to an AI system) is
//    no support.
// 4. The override applies only when at least one factual claim carries its
//    own [Source N] label and every factual claim is supported.
// 5. The claims must answer the question that was asked: together they must
//    name every anchor of the question (identifiers, quoted phrases; the QA
//    gate's anchor check); neither the claims nor the evidence they cite may
//    swap a query word for a rival on the same head word ("annual leave" for
//    "parental leave", "cobalt ceiling" for "amber ceiling"; the QA gate's
//    substitution veto, findQueryTermSubstitution), checked on the evidence
//    too because a claim can state the rival's value without naming it; and
//    the claims must share at least one meaningful term with the question
//    (the gate's query-term coverage above zero), so a fact on an unrelated
//    subject is not taken for the answer.
//    The question's names must be named by the claims and by the evidence they
//    cite (its text, section heading or file name): numbers, words written
//    with a capital after their first letter ("BERT", "SQuAD"), capitalized
//    words other than a sentence's first ("Acme"), and a single letter with
//    the word right before it ("Vendor B", "vendor b"). A verbatim, supported
//    quote about Vendor A does not answer a question about Vendor B. In a
//    question written in title case or in capitals, capitals name nothing.
//    One single claim must carry the answer (answersQuestion): it names every
//    name of the question and a query term besides them, and says something
//    the question does not ("Limitation of Liability [Source 1]" restates the
//    question); for a yes/no question, whose answer states its own
//    proposition, it names every query term instead. Names spread over two
//    claims ("Vendor A's cap is ...", "Vendor B signed ...") answer nothing.
//    A question the query decomposer split into parts is never overridden:
//    a reply that states one part and says another is missing is a partial
//    answer, and the override would drop the sentence saying what is missing.
// 6. A hedge that names words of the question as what the evidence lacks
//    ("the documents do not describe a refund policy", asked "what is the
//    refund policy for coverage?") must have at least one of those words
//    named by the claims too; a cited fact about another aspect ("coverage
//    lasts 30 days") does not answer what the reason said was missing. Words
//    hedges use to talk about the evidence itself ("documents", "paper",
//    "specified", ...) and words right after "other" / "additional" ("any
//    other limitation") do not count as named. A reason that names the asked
//    thing in words the claims do not repeat ("no limitation is mentioned",
//    then "total liability shall not exceed ...") is refused: it errs toward
//    the abstention.
//
// What this cannot tell: a supported, cited fact about another aspect of the
// same topic ("limitation of liability applies to Vendor A", asked what the
// limitation is) passes when the question has no anchors, names or rival word
// pair and the reason does not name the missing aspect in the question's
// words; an entity written in lower case ("acme") is not a name. The names
// rule errs toward the abstention: a question that writes a defined term with
// capitals ("the Effective Date") needs the answering claim to repeat it.
//
// Anything else keeps the abstention. Comparison answers never reach this
// code: only writeQaAnswer reads the verdict. Answer drafts are unchanged: a
// reply that opened with the marker is never streamed, whatever the override
// decides.

import { evaluateClaimSupport } from "./agent-self-check.js";
import { stripLeadingNotInEvidenceMarker } from "./answer-verdict.js";
import {
  computeQueryTermCoverage,
  findQueryTermSubstitution,
  findUncoveredQueryAnchors,
} from "./confidence.js";
import { isQaGateInflectionEnabled } from "./config.js";
import { normalizeGroundedClaimSupportForHeadings } from "./grounded-answer-finalizer.js";
import { SCREENED_SENTENCE_MARKER, screenUntrustedText } from "./prompt-injection-screen.js";
import {
  hasClaimPredicate,
  moveTrailingSourceLabelsBeforePunctuation,
  protectDottedAbbreviations,
  restoreProtectedPeriods,
} from "./self-check/claims.js";
import {
  CHECKABLE_CITATION_FIELDS,
  CLAIM_SPLIT_PATTERN,
  PROTECTED_PERIOD,
} from "./self-check/patterns.js";
import { normalizeGroupedSourceLabels, stripSourceLabels } from "./self-check/text.js";
import { buildTermSet, extractMeaningfulTokens, tokenize } from "./text-utils.js";

export const QA_VERDICT_OVERRIDE_REASONS = Object.freeze({
  applied: "supported_claims",
  hedgedTermUnanswered: "hedged_term_unanswered",
  missingAnchor: "missing_query_anchor",
  missingName: "missing_query_name",
  multiPartQuestion: "multi_part_question",
  noAnsweringClaim: "no_answering_claim",
  noCitedClaim: "no_cited_claim",
  noFactualClaim: "no_factual_claim",
  noQueryTerm: "no_query_term",
  substitution: "query_term_substitution",
  unsupportedClaim: "unsupported_claim",
});

const REPORTING_VERBS =
  "state|say|specify|mention|provide|include|contain|give|describe|indicate|address|list|report|define|detail|discuss|cover|answer|disclose|identify|offer|clarify|explain|confirm|show|establish|reveal|name|note|outline|present|reference|quantify|elaborate|spell|make clear";
const REPORTED_PARTICIPLES =
  "stated|said|specified|mentioned|provided|given|described|indicated|addressed|listed|reported|defined|detailed|discussed|covered|included|disclosed|identified|clarified|explained|confirmed|shown|established|revealed|named|noted|outlined|presented|referenced|quantified|spelled out|spelt out|available|known|clear|found|present|evident|apparent";
const ADVERB = "(?:[a-z]+ly\\s+)?";

// Sentences about the evidence rather than facts from it. A false positive
// only removes a sentence from the answer, never adds unchecked text.
const EVIDENCE_ABSENCE_PATTERNS = [
  // "do not state", "does not explicitly specify", "didn't mention"
  new RegExp(`\\b(?:do|does|did)\\s+not\\s+${ADVERB}(?:${REPORTING_VERBS})\\b`),
  new RegExp(`\\b(?:don't|doesn't|didn't)\\s+${ADVERB}(?:${REPORTING_VERBS})\\b`),
  // "is not stated", "are not explicitly mentioned", "isn't specified", "not available"
  new RegExp(`\\bnot\\s+${ADVERB}(?:${REPORTED_PARTICIPLES})\\b`),
  new RegExp(`n't\\s+${ADVERB}(?:${REPORTED_PARTICIPLES})\\b`),
  // "no information", "no explicit mention", "there is no data on"
  /\b(?:no|nothing|little)\s+(?:[a-z]+\s+){0,2}?(?:information|mention|details?|data|evidence|indication|reference|statement|specification|definition|description|explanation|figures?|numbers?)\b/,
  /\bnothing\s+(?:is\s+|was\s+)?(?:said|stated|mentioned|specified|given)\b/,
  // "no additional coverage is specified", "no cap was mentioned"
  /\bno\s+(?:[a-z-]+\s+){0,3}?(?:is|are|was|were)\s+(?:[a-z]+ly\s+)?(?:stated|specified|mentioned|provided|given|described|listed|reported|defined|indicated|noted)\b/,
  // "unclear", "unspecified", ...
  /\b(?:unclear|unknown|unspecified|unstated|unmentioned|undisclosed|undefined|undetermined|uncertain|ambiguous|unreported)\b/,
  // "cannot be determined", "unable to confirm"
  /\b(?:cannot|can\s+not|can't|could\s+not|couldn't|unable\s+to|impossible\s+to|not\s+possible\s+to)\s+(?:be\s+)?(?:[a-z]+ly\s+)?(?:determine|determined|confirm|confirmed|find|found|identify|identified|tell|told|infer|inferred|establish|established|answer|answered|verify|verified|deduce|deduced|conclude|concluded|say|said|know|known|ascertain|ascertained)\b/,
  // "insufficient information", "lacks details", "missing data"
  /\b(?:insufficient|not\s+enough|lacks?|lacking|absence\s+of|missing)\s+(?:[a-z]+\s+){0,2}?(?:information|evidence|details?|data|context|specifics?)\b/,
  // "without specifying"
  /\bwithout\s+(?:[a-z]+ly\s+)?(?:specifying|stating|mentioning|giving|providing|detailing|defining|indicating|saying)\b/,
  // "not in the evidence", "outside the documents"
  /\b(?:not\s+in|outside(?:\s+of)?)\s+(?:the\s+)?(?:provided\s+|given\s+|retrieved\s+)?(?:evidence|documents?|context|sources?|text|excerpts?|passages?)\b/,
  // "the documents only mention ...", "only the maximum is given"
  /\bthe\s+(?:provided\s+|given\s+|retrieved\s+|available\s+|uploaded\s+|cited\s+|shown\s+)?(?:documents?|evidence|excerpts?|passages?|sources?)\s+(?:[a-z]+\s+){0,2}?only\b/,
  /\bonly\s+(?:[a-z]+\s+){0,6}?(?:is|are|was|were)\s+(?:[a-z]+ly\s+)?(?:stated|specified|mentioned|provided|given|described|discussed|listed|reported|defined|noted|outlined)\b/,
  // "X is discussed / mentioned / described / addressed / dealt with" (but not
  // "described as")
  /\b(?:is|are|was|were)\s+(?:only\s+|also\s+|briefly\s+|generally\s+|merely\s+|separately\s+)?(?:described|discussed|mentioned|outlined|referenced|referred\s+to|touched\s+on|noted|addressed|dealt\s+with)\b(?!\s+as\b)/,
  // Where the answer is, not what it is: "the notice period is defined in
  // Schedule 2", "the results are shown in Table 3", "see Section 7".
  /\b(?:is|are|was|were)\s+(?:[a-z]+ly\s+)?(?:defined|set\s+(?:out|forth)|laid\s+out|specified|detailed|listed|given|found|contained|provided|stated|explained|shown|presented|reported|addressed|tabulated|summari[sz]ed)\s+(?:in|under|within|at)\s+(?:the\s+)?(?:[a-z]+\s+)?(?:sections?|subsections?|schedules?|appendix|appendices|annex(?:es)?|exhibits?|tables?|figures?|fig|chapters?|clauses?|articles?|paragraphs?|pages?|parts?|attachments?|addend(?:um|a)|supplements?|footnotes?)\b/,
  /\b(?:see|refer\s+to|consult)\s+(?:the\s+)?(?:[a-z]+\s+)?(?:sections?|subsections?|schedules?|appendix|appendices|annex(?:es)?|exhibits?|tables?|figures?|fig|chapters?|clauses?|articles?|paragraphs?|pages?|attachments?|addend(?:um|a)|footnotes?)\b/,
  // "the question asks about ..."
  /\bquestion\s+(?:asks|is\s+asking|refers|is\s+about|concerns)\b|\byou\s+(?:ask|asked)\b/,
];

const CJK_EVIDENCE_ABSENCE_PATTERNS = [
  /(?:未|没有|没|并未|并没有|不曾)(?:明确|具体|直接|详细|清楚)?(?:提及|提到|说明|规定|载明|列出|给出|提供|指出|写明|记载|涉及|定义|披露|描述|表明|注明|阐述|包含|讨论|说)/,
  /(?:无法|不能|难以)(?:确定|判断|得知|确认|回答|推断|得出|知道)/,
  /(?:不清楚|不明确|不详|未知|尚不清楚|没有(?:相关|具体|明确)?(?:信息|资料|内容|证据|说明|数据))/,
  /(?:文档|文件|证据|资料|材料|上下文)(?:中|里)?(?:只|仅)/,
];

/**
 * True when a sentence speaks about the evidence (absent, unclear, partial, or
 * merely discussed) instead of stating a fact from it. Source labels are
 * ignored.
 */
export const isEvidenceAbsenceHedge = (sentence = "") => {
  const text = stripSourceLabels(String(sentence ?? ""))
    .replace(/[’‘]/g, "'")
    .toLowerCase();

  if (!text.trim()) {
    return false;
  }

  return (
    EVIDENCE_ABSENCE_PATTERNS.some((pattern) => pattern.test(text)) ||
    CJK_EVIDENCE_ABSENCE_PATTERNS.some((pattern) => pattern.test(text))
  );
};

const SEGMENT_SPLIT_PATTERN = new RegExp(CLAIM_SPLIT_PATTERN.source, "gi");

// One line's sentences, split where the claim splitter splits (sentence ends
// and semicolons), each with the delimiter that followed it.
const splitLineSegments = (line) => {
  const prepared = moveTrailingSourceLabelsBeforePunctuation(
    protectDottedAbbreviations(line.replace(/\bvs\./gi, `vs${PROTECTED_PERIOD}`))
  );
  const segments = [];
  let start = 0;

  for (const match of prepared.matchAll(SEGMENT_SPLIT_PATTERN)) {
    segments.push({ text: prepared.slice(start, match.index), delimiter: match[0] });
    start = match.index + match[0].length;
  }

  segments.push({ text: prepared.slice(start), delimiter: "" });

  return segments.map((segment) => ({
    delimiter: segment.delimiter,
    text: restoreProtectedPeriods(segment.text),
  }));
};

// Where a hedge's second half begins to say what the evidence does state:
// "do not specify X beyond <fact>", "other than", "except (for)", "apart
// from", "aside from", "besides", and ", only <fact>" / ", but only <fact>".
// The first such word in the hedge wins.
const HEDGE_RESIDUAL_START_PATTERN =
  /\b(?:beyond|other\s+than|except(?:\s+for)?|apart\s+from|aside\s+from|besides)\s+|,\s*(?:but\s+)?only\s+/i;

// Framing in front of the stated fact: "beyond stating that <fact>", "beyond
// the clause stating that <fact>", "beyond the fact that <fact>".
const RESIDUAL_FRAMING_PATTERNS = [
  /^(?:the\s+|a\s+|an\s+)?(?:fact|exclusion|clause|provision|statement|section|sentence|term|condition|requirement|stipulation|note|line|passage)\s+(?:that\s+|which\s+)?(?:stating|saying|states|says|specifying|specifies|indicating|indicates|providing|provides|noting|notes|that)\s+(?:that\s+)?/i,
  /^(?:mentioning|stating|stipulating|saying|noting|indicating|specifying|providing|explaining|describing|establishing|confirming|clarifying|setting\s+out)\s+(?:that\s+)?/i,
  /^that\s+/i,
];

const stripResidualFraming = (clause) => {
  let text = clause;

  for (let pass = 0; pass < RESIDUAL_FRAMING_PATTERNS.length; pass += 1) {
    const before = text;

    for (const pattern of RESIDUAL_FRAMING_PATTERNS) {
      text = text.replace(pattern, "");
    }

    if (text === before) {
      break;
    }
  }

  return text;
};

/**
 * The fact a hedge sentence states after saying what the evidence lacks
 * ("the documents do not specify X beyond <fact> [Source 1]" gives
 * "<Fact> [Source 1]"), or null. Only the part after the residual word is
 * returned, so the hedge half never becomes a claim; a residual that is itself
 * a hedge, or holds no word besides source labels, gives null. So does one
 * that is not a statement: neither framed by "that" ("beyond stating that
 * <fact>") nor holding a claim predicate. "... other than indirect damages"
 * means "indirect damages are <the hedge's verb>", a verb nothing checks.
 */
export const extractHedgeResidualClaim = (sentence = "") => {
  const text = String(sentence ?? "");
  const match = HEDGE_RESIDUAL_START_PATTERN.exec(text);

  if (!match) {
    return null;
  }

  const rawResidual = text.slice(match.index + match[0].length).trim();
  const unframed = stripResidualFraming(rawResidual);
  const framing = rawResidual.slice(0, rawResidual.length - unframed.length);
  const residual = unframed.trim();

  if (!/[\p{L}\p{N}]/u.test(stripSourceLabels(residual)) || isEvidenceAbsenceHedge(residual)) {
    return null;
  }

  if (!/\bthat\s*$/i.test(framing) && !hasClaimPredicate(residual)) {
    return null;
  }

  return `${residual.charAt(0).toUpperCase()}${residual.slice(1)}`;
};

// removeEvidenceAbsenceHedges, plus the text of each hedge before its
// residual (what it says is missing), for the decision only.
const splitEvidenceAbsenceHedges = (text = "") => {
  let hedgeCount = 0;
  let residualClaimCount = 0;
  const lines = [];
  const hedgeTexts = [];

  for (const line of String(text ?? "").split("\n")) {
    const segments = splitLineSegments(line);
    let removed = 0;
    const kept = segments.flatMap((segment) => {
      if (!isEvidenceAbsenceHedge(segment.text)) {
        return [segment];
      }

      removed += 1;
      const residual = extractHedgeResidualClaim(segment.text);
      // What the hedge says is missing: the whole sentence, or the part
      // before its residual.
      const residualStart = residual ? HEDGE_RESIDUAL_START_PATTERN.exec(segment.text) : null;

      hedgeTexts.push(residualStart ? segment.text.slice(0, residualStart.index) : segment.text);

      if (!residual) {
        return [];
      }

      residualClaimCount += 1;
      const closed = /[.!?。！？]$/u.test(residual) || /[;；]/u.test(segment.delimiter);

      return [{ delimiter: segment.delimiter, text: closed ? residual : `${residual}.` }];
    });

    if (removed === 0) {
      lines.push(line);
      continue;
    }

    hedgeCount += removed;
    const rebuilt = kept
      .map((segment) => `${segment.text}${segment.delimiter}`)
      .join("")
      .replace(/(\S)(\[(?:source|来源)\s*\d+\])/giu, "$1 $2")
      .replace(/[\s;；]+$/u, "")
      .trim();

    if (stripSourceLabels(rebuilt).trim()) {
      lines.push(rebuilt);
    }
  }

  return { hedgeCount, hedgeTexts, residualClaimCount, text: lines.join("\n").trim() };
};

/**
 * Removes every hedge sentence (isEvidenceAbsenceHedge). A hedge that goes on
 * to state a fact (extractHedgeResidualClaim) is replaced by that fact alone.
 * A line with no hedge is kept exactly as written; a line left empty is
 * dropped.
 */
export const removeEvidenceAbsenceHedges = (text = "") => {
  const { hedgeCount, residualClaimCount, text: kept } = splitEvidenceAbsenceHedges(text);

  return { hedgeCount, residualClaimCount, text: kept };
};

// Words a hedge uses to talk about the evidence rather than the topic; a
// question that happens to contain one ("which documents are required?") does
// not make the hedge name it as the missing aspect. English only (Chinese
// text is matched per character).
const EVIDENCE_META_TERMS = new Set([
  "article",
  "context",
  "detail",
  "details",
  "document",
  "documents",
  "evidence",
  "excerpt",
  "excerpts",
  "explicitly",
  "given",
  "information",
  "mention",
  "mentioned",
  "mentions",
  "paper",
  "passage",
  "passages",
  "provide",
  "provided",
  "provides",
  "question",
  "retrieved",
  "source",
  "sources",
  "specific",
  "specifically",
  "specified",
  "specifies",
  "specify",
  "state",
  "stated",
  "states",
  "text",
  "uploaded",
]);

// "any other limitation", "an additional fee", "a separate cap": the hedge
// says something besides the asked thing is missing.
const OTHER_THAN_ASKED_TERMS = new Set(["additional", "another", "extra", "other", "separate"]);

// The question's words a hedge names as missing: evidence words, and words
// one or two words after "other" / "additional" / ..., left out.
const findHedgeNamedQueryTerms = ({ hedgeText, queryText }) => {
  const tokens = tokenize(stripSourceLabels(hedgeText));
  const hedgeTerms = buildTermSet(stripSourceLabels(hedgeText));
  const otherThanAsked = new Set(
    tokens.filter((_token, index) =>
      tokens.slice(Math.max(0, index - 2), index).some((previous) => OTHER_THAN_ASKED_TERMS.has(previous))
    )
  );

  return [...buildTermSet(queryText)].filter(
    (term) => hedgeTerms.has(term) && !EVIDENCE_META_TERMS.has(term) && !otherThanAsked.has(term)
  );
};

// The text of every citation a claim was verified against, as the gate's
// substitution veto reads a chunk: section heading and evidence, no file name.
const collectCitedEvidenceTexts = ({ citations, claims }) => {
  const citationByRank = new Map();

  citations.forEach((citation, index) => {
    const explicitRank = Number(citation?.rank);
    const rank = Number.isInteger(explicitRank) && explicitRank > 0 ? explicitRank : index + 1;

    if (!citationByRank.has(rank)) {
      citationByRank.set(rank, citation);
    }
  });

  const ranks = new Set(claims.flatMap((claim) => claim.supportedSourceRanks ?? []));

  return [...ranks]
    .map((rank) => citationByRank.get(rank))
    .filter(Boolean)
    .map((citation) =>
      [citation.sectionHeading, citation.evidenceText ?? citation.text ?? citation.excerpt]
        .filter(Boolean)
        .join("\n")
    );
};

// The citations as the answer model was shown them: every sentence the prompt
// injection screen removed (an instruction addressed to an AI system) is gone
// from the text the claims are checked against. Clean text is unchanged.
const screenCitationEvidence = (citations) =>
  citations.map((citation) => {
    if (!citation || typeof citation !== "object") {
      return citation;
    }

    const screened = { ...citation };

    for (const field of [...CHECKABLE_CITATION_FIELDS, "sectionHeading"]) {
      if (typeof citation[field] === "string") {
        const { removed, text } = screenUntrustedText(citation[field]);

        if (removed.length > 0) {
          screened[field] = text.replaceAll(SCREENED_SENTENCE_MARKER, " ").replace(/\s{2,}/g, " ").trim();
        }
      }
    }

    return screened;
  });

const LOCATION_REFERENCE_PATTERN =
  /\b(?:sections?|subsections?|schedules?|appendix|appendices|annex(?:es)?|exhibits?|tables?|figures?|fig|chapters?|clauses?|articles?|paragraphs?|pages?|parts?)\s+[\p{L}\p{N}][\p{L}\p{N}.-]*/giu;
const POLAR_QUESTION_PATTERN =
  /^\s*(?:is|are|was|were|am|do|does|did|can|could|will|would|shall|should|may|might|must|has|have|had|isn't|aren't|doesn't|don't|didn't)\b/i;

const stemTerm = (term) =>
  term.length > 3 && term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term;

// A claim says something the question does not: a meaningful word, other than
// one about the evidence or a location ("Section 7"), the question lacks.
const statesBeyondQuestion = ({ claimText, questionText }) => {
  const questionStems = new Set(extractMeaningfulTokens(questionText).map(stemTerm));

  return extractMeaningfulTokens(String(claimText ?? "").replace(LOCATION_REFERENCE_PATTERN, " ")).some(
    (token) => !questionStems.has(stemTerm(token)) && !EVIDENCE_META_TERMS.has(token)
  );
};

/**
 * One claim carries the answer: it names every name of the question and a
 * query term besides them, and, for a question that is not yes/no, says
 * something the question does not ("Limitation of Liability [Source 1]"
 * restates the question); a yes/no question is answered by stating its own
 * proposition, so that claim must name every query term. Names spread over
 * two claims ("Vendor A's cap is ..." and "Vendor B signed ...") answer
 * nothing.
 */
const answersQuestion = ({ claimText, question, questionNames }) => {
  const inflection = isQaGateInflectionEnabled();
  const claimNames = namesInText(claimText);

  if (questionNames.some((name) => !claimNames.includes(` ${name} `))) {
    return false;
  }

  if (POLAR_QUESTION_PATTERN.test(question)) {
    return computeQueryTermCoverage({ inflection, queryText: question, resultText: claimText }) === 1;
  }

  const nameTokens = new Set(questionNames.flatMap((name) => name.split(" ")));
  const topicalTerms = [...buildTermSet(question)].filter((term) => !nameTokens.has(term));

  return (
    (topicalTerms.length === 0 ||
      computeQueryTermCoverage({ inflection, queryText: topicalTerms.join(" "), resultText: claimText }) > 0) &&
    statesBeyondQuestion({ claimText, questionText: question })
  );
};

// Latin words and numbers only, as tokenize reads them; Chinese has no
// capitals to tell a name by.
const QUESTION_WORD_PATTERN = /[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*/g;
const SENTENCE_START_PATTERN = /(?:^|[.!?:;。！？：；\n])["'“‘(\[\s]*$/u;

// A single letter that designates something ("Vendor B", "party b", "Plan A"),
// not the pronoun "I" or the article "a" in front of a word.
const isLetterDesignator = ({ nextText, possessive, sentenceInitial, word }) => {
  if (!/^[A-Za-z]$/.test(word) || /^[Ii]$/.test(word)) {
    return false;
  }

  if (word === "a") {
    return possessive || /^\s*(?:[^\sA-Za-z0-9]|$)/.test(nextText);
  }

  return !(word === "A" && sentenceInitial);
};

/**
 * The names a question asks about, each as its token sequence: numbers
 * ("2023", "GPT-4"), words with a capital after their first letter ("BERT",
 * "SQuAD"), capitalized words other than a sentence's first ("Acme"), and a
 * single letter with the word right before it ("Vendor B", "party b"). When
 * most words after a sentence's first are capitalized (title case), capitals
 * say nothing and only numbers and single letters count.
 */
export const extractQuestionNames = (question = "") => {
  const text = String(question ?? "");
  const words = [...text.matchAll(QUESTION_WORD_PATTERN)].map((match) => ({
    end: match.index + match[0].length,
    nextText: text.slice(match.index + match[0].length),
    possessive: /['’]s$/i.test(match[0]),
    sentenceInitial: SENTENCE_START_PATTERN.test(text.slice(0, match.index)),
    start: match.index,
    word: match[0].replace(/['’]s$/iu, ""),
  }));
  // Title case ("What Is The Limitation Of Liability?") or all capitals: the
  // share of words after a sentence's first, of two letters or more, written
  // that way.
  const laterWords = words.filter(
    (entry) => !entry.sentenceInitial && (entry.word.match(/[A-Za-z]/g) ?? []).length > 1
  );
  const shareOf = (predicate) =>
    laterWords.length === 0 ? 0 : laterWords.filter((entry) => predicate(entry.word)).length / laterWords.length;
  const allCapitals = shareOf((word) => /[A-Z]/.test(word) && !/[a-z]/.test(word)) > 0.5;
  const titleCase = allCapitals || shareOf((word) => /^[A-Z]/.test(word)) > 0.5;
  const names = new Set();

  words.forEach((entry, index) => {
    const { sentenceInitial, word } = entry;
    const previous = words[index - 1];

    if (isLetterDesignator(entry)) {
      // Paired with the word right before it when that word names something
      // ("Vendor B"), not a function word ("Is A liable?").
      const paired =
        previous &&
        /^\s+$/.test(text.slice(previous.end, entry.start)) &&
        extractMeaningfulTokens(previous.word).length > 0;
      const key = tokenize(paired ? `${previous.word} ${word}` : word).join(" ");

      if (key) {
        names.add(key);
      }

      return;
    }

    const hasDigit = /[0-9]/.test(word);
    const innerCapital = /[A-Z]/.test(word.slice(1)) && (word.match(/[A-Za-z]/g) ?? []).length > 1;
    const capitalized = /^[A-Z]/.test(word) && !sentenceInitial && word !== "I";

    if (hasDigit || (!allCapitals && innerCapital) || (!titleCase && capitalized)) {
      const key = tokenize(word).join(" ");

      if (key) {
        names.add(key);
      }
    }
  });

  return [...names];
};

const namesInText = (text) => ` ${tokenize(String(text ?? "")).join(" ")} `;

// The text of every citation a claim was verified against, with its file
// name: where a document names itself.
const collectCitedNameTexts = ({ citations, claims }) => {
  const ranks = new Set(claims.flatMap((claim) => claim.supportedSourceRanks ?? []));

  return citations
    .filter((citation, index) => {
      const explicitRank = Number(citation?.rank);

      return ranks.has(Number.isInteger(explicitRank) && explicitRank > 0 ? explicitRank : index + 1);
    })
    .map((citation) =>
      [
        citation.fileName,
        citation.sectionHeading,
        ...CHECKABLE_CITATION_FIELDS.map((field) => citation[field]),
      ]
        .filter((value) => typeof value === "string")
        .join("\n")
    )
    .join("\n");
};

/**
 * Decides whether a reply that opened with NOT_IN_EVIDENCE: is answered
 * anyway. `citations` are the answer's citations with their retrieved
 * evidence attached (as the finalizer checks them); `questions` are the
 * question as asked and as resolved; `questionPartCount` is how many parts
 * the query decomposer split it into. Returns the answer text (hedges
 * removed) when it applies, else the reason it does not; only counts and
 * codes, never text, are meant for traces.
 */
export const overrideNotInEvidenceVerdict = ({
  citations: answerCitations = [],
  questionPartCount = 1,
  questions = [],
  replyText = "",
} = {}) => {
  const citations = screenCitationEvidence(answerCitations);
  const remainder = normalizeGroupedSourceLabels(stripLeadingNotInEvidenceMarker(replyText));
  const { hedgeCount, hedgeTexts, residualClaimCount, text } = splitEvidenceAbsenceHedges(remainder);
  const claimSupport = text
    ? normalizeGroundedClaimSupportForHeadings(evaluateClaimSupport({ answerText: text, citations }))
    : { claims: [] };
  const factualClaims = (claimSupport.claims ?? []).filter((claim) => !claim.heading);
  const summary = {
    factualClaimCount: factualClaims.length,
    hedgeCount,
    residualClaimCount,
    supportedClaimCount: factualClaims.filter((claim) => claim.supported).length,
  };
  const decline = (reason) => ({ overridden: false, reason, ...summary });

  if (Number(questionPartCount) > 1) {
    return decline(QA_VERDICT_OVERRIDE_REASONS.multiPartQuestion);
  }

  if (factualClaims.length === 0) {
    return decline(QA_VERDICT_OVERRIDE_REASONS.noFactualClaim);
  }

  if (!factualClaims.some((claim) => claim.sourceRanks.length > 0 && !claim.sourceRanksInherited)) {
    return decline(QA_VERDICT_OVERRIDE_REASONS.noCitedClaim);
  }

  if (factualClaims.some((claim) => !claim.supported)) {
    return decline(QA_VERDICT_OVERRIDE_REASONS.unsupportedClaim);
  }

  // One claim per line, so no word pair spans two claims.
  const claimText = factualClaims.map((claim) => claim.text).join("\n");
  const citedEvidenceTexts = collectCitedEvidenceTexts({ citations, claims: factualClaims });
  const askedQuestions = [...new Set(questions.map((question) => String(question ?? "").trim()).filter(Boolean))];

  const claimNames = namesInText(claimText);
  const evidenceNames = namesInText(collectCitedNameTexts({ citations, claims: factualClaims }));

  for (const question of askedQuestions) {
    if (findUncoveredQueryAnchors({ queryText: question, text: claimText }).length > 0) {
      return decline(QA_VERDICT_OVERRIDE_REASONS.missingAnchor);
    }

    const questionNames = extractQuestionNames(question);

    if (
      questionNames.some(
        (name) => !claimNames.includes(` ${name} `) || !evidenceNames.includes(` ${name} `)
      )
    ) {
      return decline(QA_VERDICT_OVERRIDE_REASONS.missingName);
    }

    if (
      findQueryTermSubstitution(question, claimText) ||
      citedEvidenceTexts.some((evidenceText) => findQueryTermSubstitution(question, evidenceText))
    ) {
      return decline(QA_VERDICT_OVERRIDE_REASONS.substitution);
    }

    // Null: the question has no meaningful term to share.
    const coverage = computeQueryTermCoverage({
      inflection: isQaGateInflectionEnabled(),
      queryText: question,
      resultText: claimText,
    });

    if (coverage === 0) {
      return decline(QA_VERDICT_OVERRIDE_REASONS.noQueryTerm);
    }

    if (!factualClaims.some((claim) => answersQuestion({ claimText: claim.text, question, questionNames }))) {
      return decline(QA_VERDICT_OVERRIDE_REASONS.noAnsweringClaim);
    }

    for (const hedgeText of hedgeTexts) {
      const namedTerms = findHedgeNamedQueryTerms({ hedgeText, queryText: question });

      if (
        namedTerms.length > 0 &&
        computeQueryTermCoverage({
          inflection: isQaGateInflectionEnabled(),
          queryText: namedTerms.join(" "),
          resultText: claimText,
        }) === 0
      ) {
        return decline(QA_VERDICT_OVERRIDE_REASONS.hedgedTermUnanswered);
      }
    }
  }

  return { overridden: true, reason: QA_VERDICT_OVERRIDE_REASONS.applied, text, ...summary };
};

/** The trace form of a decision: whether it applied, why, and counts only. */
export const describeVerdictOverride = (decision) => ({
  applied: decision.overridden === true,
  factualClaimCount: decision.factualClaimCount,
  hedgeCount: decision.hedgeCount,
  reason: decision.reason,
  residualClaimCount: decision.residualClaimCount,
  supportedClaimCount: decision.supportedClaimCount,
});
