// Redacting a deleted document's text out of the records other stores keep
// (rag/document-deletion-cascade.js, DOCUMENT_DELETE_REDACTION=on). Pure
// functions over plain JSON values; the stores decide which records to pass.
//
// What counts as the document's text: the text fields of any object that
// names the document, by `docId` or by `metadata.docId` (a citation, a
// retrieved chunk, a LangChain document, an evidence entry). Those fields are
// replaced with DELETED_SOURCE_TEXT_MARKER; every id, position and score
// stays, so counts, links and trace structure survive. Free text that quoted
// such a field verbatim (a report artifact's body) can be cleaned with
// replaceQuotedText, given the quotes the walk collected. Answer text a model
// wrote is not the document's text and is left alone.

export const DELETED_SOURCE_TEXT_MARKER = "[source document deleted]";

const REDACTED_TEXT_FIELDS = Object.freeze([
  "content",
  "evidence",
  "evidenceText",
  "excerpt",
  "pageContent",
  "quote",
  "sectionHeading",
  "snippet",
  "text",
]);

// Deep enough for every record these stores hold (run steps, graph
// checkpoints); a value nested deeper is left as it is.
const MAX_DEPTH = 64;

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const normalizeText = (value) => String(value ?? "").trim();

export const toDeletedDocIdSet = (docIds) =>
  new Set((Array.isArray(docIds) ? docIds : [docIds]).map(normalizeText).filter(Boolean));

const referencedDocId = (object) => {
  if (typeof object.docId === "string") {
    return object.docId.trim();
  }

  return isPlainObject(object.metadata) && typeof object.metadata.docId === "string"
    ? object.metadata.docId.trim()
    : "";
};

/**
 * `value` with the text of every object naming one of `docIds` replaced by
 * the marker. Copy on write: untouched branches keep their identity and
 * `changed` is false when nothing named the documents. `quotes` lists the
 * replaced texts (for replaceQuotedText); `redactedFieldCount` counts them.
 */
export const redactDocumentText = (value, docIds, { marker = DELETED_SOURCE_TEXT_MARKER } = {}) => {
  const deleted = docIds instanceof Set ? docIds : toDeletedDocIdSet(docIds);
  const quotes = new Set();
  let redactedFieldCount = 0;

  if (deleted.size === 0) {
    return { changed: false, quotes: [], redactedFieldCount: 0, value };
  }

  const visit = (node, depth) => {
    if (depth > MAX_DEPTH || node === null || typeof node !== "object") {
      return node;
    }

    if (Array.isArray(node)) {
      let copy = null;

      node.forEach((item, index) => {
        const next = visit(item, depth + 1);

        if (next !== item) {
          copy ??= [...node];
          copy[index] = next;
        }
      });

      return copy ?? node;
    }

    if (!isPlainObject(node)) {
      return node;
    }

    let copy = null;
    const docId = referencedDocId(node);

    if (docId && deleted.has(docId)) {
      for (const field of REDACTED_TEXT_FIELDS) {
        const text = node[field];

        if (typeof text === "string" && text.trim() && text !== marker) {
          quotes.add(text);
          copy ??= { ...node };
          copy[field] = marker;
          redactedFieldCount += 1;
        }
      }
    }

    for (const [key, child] of Object.entries(copy ?? node)) {
      if (child !== null && typeof child === "object") {
        const next = visit(child, depth + 1);

        if (next !== child) {
          copy ??= { ...node };
          copy[key] = next;
        }
      }
    }

    return copy ?? node;
  };

  const redacted = visit(value, 0);

  return {
    changed: redacted !== value,
    quotes: [...quotes],
    redactedFieldCount,
    value: redacted,
  };
};

/**
 * `text` with every verbatim occurrence of a quote (and of its JSON-escaped
 * form, for a body that is serialized JSON) replaced by the marker. Only
 * quotes longer than the marker are replaced, so the text never grows past a
 * size limit and short common strings (a one-word heading) are not hunted
 * down everywhere. Longest quotes first.
 */
export const replaceQuotedText = (text, quotes, { marker = DELETED_SOURCE_TEXT_MARKER } = {}) => {
  if (typeof text !== "string" || !text) {
    return text;
  }

  const forms = new Set();

  for (const quote of quotes ?? []) {
    if (typeof quote !== "string") {
      continue;
    }

    for (const form of [quote, quote.trim(), JSON.stringify(quote).slice(1, -1)]) {
      if (form.length > marker.length) {
        forms.add(form);
      }
    }
  }

  let result = text;

  for (const form of [...forms].sort((left, right) => right.length - left.length)) {
    if (result.includes(form)) {
      result = result.split(form).join(marker);
    }
  }

  return result;
};

/** replaceQuotedText over every string inside a JSON value (copy on write). */
export const replaceQuotedTextDeep = (value, quotes, options = {}, depth = 0) => {
  if (typeof value === "string") {
    return replaceQuotedText(value, quotes, options);
  }

  if (depth > MAX_DEPTH || value === null || typeof value !== "object" || (quotes ?? []).length === 0) {
    return value;
  }

  if (Array.isArray(value)) {
    let copy = null;

    value.forEach((item, index) => {
      const next = replaceQuotedTextDeep(item, quotes, options, depth + 1);

      if (next !== item) {
        copy ??= [...value];
        copy[index] = next;
      }
    });

    return copy ?? value;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  let copy = null;

  for (const [key, item] of Object.entries(value)) {
    const next = replaceQuotedTextDeep(item, quotes, options, depth + 1);

    if (next !== item) {
      copy ??= { ...value };
      copy[key] = next;
    }
  }

  return copy ?? value;
};

/**
 * Substrings that a serialized record naming one of `docIds` contains: the
 * `"docId": "<id>"` member as jsonb prints it and as JSON.stringify writes it
 * (a json column keeps the text it was given). A store narrows its candidates
 * with them before parsing anything; redactDocumentText decides.
 */
export const buildDocumentReferenceNeedles = (docIds) =>
  [...toDeletedDocIdSet(docIds)].flatMap((docId) => {
    const quoted = JSON.stringify(docId);

    return [`"docId": ${quoted}`, `"docId":${quoted}`];
  });

/** Whether a value, serialized, names one of the documents (in-memory stores). */
export const referencesDocuments = (value, docIds) => {
  const needles = buildDocumentReferenceNeedles(docIds);

  if (needles.length === 0) {
    return false;
  }

  let serialized;

  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return false;
  }

  return needles.some((needle) => serialized.includes(needle));
};
