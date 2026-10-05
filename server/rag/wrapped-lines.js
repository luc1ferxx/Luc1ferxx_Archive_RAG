// The one rule for whether a line break inside a paragraph is a soft wrap:
// the previous line has no sentence-final punctuation and the next one
// continues in lowercase. joinWrappedLines (self-check/attribution.js) and the
// pdf.js paragraph detection (pdf-paragraphs.js) both use it, so evidence
// matching and ingest read a wrapped sentence the same way. Headings ("Remote
// Work Policy" / "Employees may ..."), list items and labelled values
// ("Fee: 100" / "Term: 12 months") start in uppercase or follow a colon and
// are never joined; scripts without case, such as Chinese, are not rejoined.
export const isWrappedLineContinuation = (previous = "", line = "") =>
  !/[.!?。！？:：;；]$/.test(previous) && /^[a-z]/.test(line);
