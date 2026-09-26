// The QA answer model's own "the evidence does not answer this" verdict.
//
// The confidence gate (confidence.js) is lexical: it can tell a chunk about a
// neighbouring thing from one using other words, but not whether a chunk that
// shares the question's words actually states the answer. On QASPER every
// lexical signal separates answerable from unanswerable questions at an AUC of
// about 0.6. With RAG_QA_ANSWER_VERDICT on, the answer prompt therefore asks
// the model, which reads the evidence, to start its reply with this marker when
// the evidence does not answer; the writer turns such a reply into an
// abstention. Off by default: see isQaAnswerVerdictEnabled in config.js.

export const QA_NOT_IN_EVIDENCE_MARKER = "NOT_IN_EVIDENCE:";

// Tolerates markdown around the marker and a missing or full-width colon.
const LEADING_MARKER_PATTERN = /^[\s*_`>#-]*NOT[_ ]IN[_ ]EVIDENCE[\s*_`]*[:：]?[\s*_`]*/i;
const ANY_MARKER_PATTERN = /[*_`]*NOT[_ ]IN[_ ]EVIDENCE[*_`]*[:：]?[ \t]*/gi;
const SOURCE_LABEL_PATTERN = /\s*\[Source \d+\]/g;

export const DEFAULT_NOT_IN_EVIDENCE_REASON =
  "The uploaded documents do not state the answer to this question.";

/** True when a (possibly partial) reply opens with the verdict marker. */
export const startsWithNotInEvidenceVerdict = (text) =>
  LEADING_MARKER_PATTERN.test(String(text ?? ""));

/**
 * Reads a finished QA reply. A reply that opens with the marker is an
 * abstention whose reason is the sentence after it (source labels removed:
 * an abstention cites nothing). A marker later in the reply follows a partial
 * answer, which is kept; only the marker is removed.
 */
export const readQaAnswerVerdict = (text) => {
  const value = String(text ?? "");

  if (startsWithNotInEvidenceVerdict(value)) {
    const reason = value
      .replace(LEADING_MARKER_PATTERN, "")
      .replace(SOURCE_LABEL_PATTERN, "")
      .trim();

    return { abstained: true, reason: reason || DEFAULT_NOT_IN_EVIDENCE_REASON };
  }

  return { abstained: false, text: value.replace(ANY_MARKER_PATTERN, "").trim() };
};
