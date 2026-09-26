// QASPER answer scoring, following the official evaluator
// (allenai/qasper-led-baseline, qasper_evaluator.py): SQuAD-style
// normalization, token F1, and the best score over all annotators' answers.
// An abstention is scored as the answer "Unanswerable", which is what the
// official gold string for an unanswerable question is.

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

/**
 * rows: { answerType, abstained, f1, shouldAbstain, evidenceHit }
 */
export const summarizeQasperRuns = (rows) => {
  const byType = {};

  for (const row of rows) {
    (byType[row.answerType ?? "unknown"] ??= []).push(row.f1);
  }

  const unanswerable = rows.filter((row) => row.shouldAbstain);
  const answerable = rows.filter((row) => !row.shouldAbstain);
  const abstained = rows.filter((row) => row.abstained);
  const evidenceRows = answerable.filter((row) => typeof row.evidenceHit === "boolean");
  const answeredEvidenceRows = evidenceRows.filter((row) => !row.abstained);

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
    // An abstention returns no sources, so it always counts as a miss here;
    // evidenceRecallWhenAnswered looks only at the answers actually given.
    evidenceRecall: mean(evidenceRows.map((row) => (row.evidenceHit ? 1 : 0))),
    evidenceRecallWhenAnswered: mean(answeredEvidenceRows.map((row) => (row.evidenceHit ? 1 : 0))),
    f1WhenAnswered: mean(answerable.filter((row) => !row.abstained).map((row) => row.f1)),
    unanswerableCases: unanswerable.length,
  };
};
