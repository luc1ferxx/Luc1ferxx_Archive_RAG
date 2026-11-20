// The QA answer model's "the evidence does not answer this" marker.
//
// RAG_QA_ANSWER_VERDICT, which asked the model to open a reply with it and
// turned such a reply into an abstention, was deleted on 2026-11-20. The
// answer drafts (answer-drafts.js) never streamed a reply opening with the
// marker, with or without that flag, and still do not.

// Tolerates markdown around the marker and a missing or full-width colon.
const LEADING_MARKER_PATTERN = /^[\s*_`>#-]*NOT[_ ]IN[_ ]EVIDENCE[\s*_`]*[:：]?[\s*_`]*/i;

/** True when a (possibly partial) reply opens with the marker. */
export const startsWithNotInEvidenceVerdict = (text) =>
  LEADING_MARKER_PATTERN.test(String(text ?? ""));
