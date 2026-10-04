// QASPER answer scoring, following the official evaluator
// (allenai/qasper-led-baseline, qasper_evaluator.py): SQuAD-style
// normalization, token F1, and the best score over all annotators' answers.
// An abstention is scored as the answer "Unanswerable", which is what the
// official gold string for an unanswerable question is.
//
// Evidence is scored two ways, under names that keep them apart:
//   context  the pages the model was shown (the rag surface's
//            retrievedContexts). The QA path returns every context chunk as a
//            citation, so this measures retrieval plus context size, not what
//            the answer cites, and a gate abstention still carries its context.
//   cited    the pages of the sources the answer's [Source N] labels name,
//            resolved with the product's filterCitationsToSourceRanks; an
//            abstention cites nothing.

import { filterCitationsToSourceRanks } from "../rag/source-labels.js";
import { extractSourceRanks, normalizeGroupedSourceLabels } from "../rag/self-check/text.js";

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;
const SOURCE_LABEL = /\[Source \d+\]/g;

export const normalizeQasperAnswer = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(PUNCTUATION, "")
    .replace(/\b(?:a|an|the)\b/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

export const qasperTokenF1 = (prediction, reference) => {
  const predicted = normalizeQasperAnswer(prediction).split(" ").filter(Boolean);
  const gold = normalizeQasperAnswer(reference).split(" ").filter(Boolean);

  if (predicted.length === 0 || gold.length === 0) {
    return predicted.length === gold.length ? 1 : 0;
  }

  const counts = new Map();

  for (const token of gold) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  let same = 0;

  for (const token of predicted) {
    const remaining = counts.get(token) ?? 0;

    if (remaining > 0) {
      same += 1;
      counts.set(token, remaining - 1);
    }
  }

  if (same === 0) {
    return 0;
  }

  const precision = same / predicted.length;
  const recall = same / gold.length;

  return (2 * precision * recall) / (precision + recall);
};

export const qasperAnswerF1 = (prediction, references = []) =>
  references.length === 0
    ? 0
    : Math.max(...references.map((reference) => qasperTokenF1(prediction, reference)));

/**
 * The string this system's answer is scored as: an abstention is
 * "Unanswerable", anything else is the answer with its [Source N] labels
 * removed (they are citations, not answer tokens).
 */
export const toQasperPrediction = ({ abstained, text }) =>
  abstained ? "Unanswerable" : String(text ?? "").replace(SOURCE_LABEL, " ").trim();

const mean = (values) =>
  values.length === 0 ? null : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));

const toPageList = (pages = []) =>
  [...new Set((Array.isArray(pages) ? pages : []).map(Number).filter((page) => Number.isInteger(page) && page > 0))].sort(
    (left, right) => left - right
  );

/**
 * The distinct pages of the sources an answer cites: its [Source N] labels
 * (grouped labels split as the answer writer does) resolved against the
 * response's citations by rank. A label naming no citation is ignored; an
 * abstention cites nothing even when the response still carries citations.
 */
export const citedSourcePages = ({ abstained, citations = [], text }) => {
  if (abstained) {
    return [];
  }

  const sourceRanks = extractSourceRanks(normalizeGroupedSourceLabels(text));

  return toPageList(
    filterCitationsToSourceRanks({ citations, sourceRanks }).map((citation) => citation?.pageNumber)
  );
};

/**
 * Per-row evidence scores against the annotated evidence pages. All null for
 * an unanswerable question (it has no evidence to find).
 *   contextEvidenceHit  an evidence page was among the context pages
 *   citedEvidenceHit    an evidence page was among the cited pages
 *   citationPrecision   share of distinct cited pages that are evidence pages;
 *                       null when the answer cites no page
 */
export const scoreQasperEvidence = ({ abstained, citedPages = [], contextPages = [], expectedPages = [], shouldAbstain }) => {
  if (shouldAbstain) {
    return { citationPrecision: null, citedEvidenceHit: null, contextEvidenceHit: null };
  }

  const expected = new Set(toPageList(expectedPages));
  const cited = abstained ? [] : toPageList(citedPages);
  const citedEvidencePages = cited.filter((page) => expected.has(page)).length;

  return {
    citationPrecision: cited.length === 0 ? null : Number((citedEvidencePages / cited.length).toFixed(4)),
    citedEvidenceHit: citedEvidencePages > 0,
    contextEvidenceHit: toPageList(contextPages).some((page) => expected.has(page)),
  };
};

// Reports written before the cited/context split named the context hit
// evidenceHit; re-summarizing one keeps that figure under its explicit name.
const readContextEvidenceHit = (row) => row.contextEvidenceHit ?? row.evidenceHit;

/**
 * rows: { answerType, abstained, f1, shouldAbstain, contextEvidenceHit,
 *         citedEvidenceHit, citationPrecision, citedPages }
 */
export const summarizeQasperRuns = (rows) => {
  const byType = {};

  for (const row of rows) {
    (byType[row.answerType ?? "unknown"] ??= []).push(row.f1);
  }

  const unanswerable = rows.filter((row) => row.shouldAbstain);
  const answerable = rows.filter((row) => !row.shouldAbstain);
  const abstained = rows.filter((row) => row.abstained);
  const contextRows = answerable.filter((row) => typeof readContextEvidenceHit(row) === "boolean");
  const citedRows = answerable.filter((row) => typeof row.citedEvidenceHit === "boolean");
  const precisionRows = answerable.filter((row) => !row.abstained && typeof row.citationPrecision === "number");
  const answeredWithCitationData = rows.filter((row) => !row.abstained && Array.isArray(row.citedPages));

  return {
    answerF1: mean(rows.map((row) => row.f1)),
    answerF1ByType: Object.fromEntries(
      Object.entries(byType)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([type, scores]) => [type, { cases: scores.length, f1: mean(scores) }])
    ),
    answerableAbstainRate: mean(answerable.map((row) => (row.abstained ? 1 : 0))),
    // Of the times the system abstained, how often the question really was
    // unanswerable; and of the unanswerable questions, how many it caught.
    abstainPrecision: abstained.length === 0 ? null : mean(abstained.map((row) => (row.shouldAbstain ? 1 : 0))),
    abstainRecall: mean(unanswerable.map((row) => (row.abstained ? 1 : 0))),
    cases: rows.length,
    // Of the answerable questions it answered, the mean share of distinct
    // cited pages that hold annotated evidence; an answer citing nothing has
    // no precision and is counted by noCitationRateWhenAnswered instead.
    citationPrecision: mean(precisionRows.map((row) => row.citationPrecision)),
    citationPrecisionCases: precisionRows.length,
    // An annotated evidence page among the pages the answer cites. An
    // abstention cites nothing, so it counts as a miss; ...WhenAnswered looks
    // only at the answers actually given.
    citedEvidenceRecall: mean(citedRows.map((row) => (row.citedEvidenceHit ? 1 : 0))),
    citedEvidenceRecallWhenAnswered: mean(
      citedRows.filter((row) => !row.abstained).map((row) => (row.citedEvidenceHit ? 1 : 0))
    ),
    // The figure earlier reports called evidenceRecall: an evidence page among
    // the context pages (rag surface) whether or not the answer cites it, and
    // a gate abstention keeps its context. Not a citation metric.
    contextEvidenceRecall: mean(contextRows.map((row) => (readContextEvidenceHit(row) ? 1 : 0))),
    contextEvidenceRecallWhenAnswered: mean(
      contextRows.filter((row) => !row.abstained).map((row) => (readContextEvidenceHit(row) ? 1 : 0))
    ),
    f1WhenAnswered: mean(answerable.filter((row) => !row.abstained).map((row) => row.f1)),
    // Answers (answerable or not) whose labels resolve to no cited page.
    noCitationRateWhenAnswered: mean(answeredWithCitationData.map((row) => (row.citedPages.length === 0 ? 1 : 0))),
    unanswerableCases: unanswerable.length,
  };
};
