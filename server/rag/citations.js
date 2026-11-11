const getPageNumber = (metadata = {}) =>
  metadata.pageNumber ?? metadata.loc?.pageNumber ?? metadata.page ?? null;

const cleanExcerpt = (text = "") =>
  text.replace(/\s+/g, " ").trim().slice(0, 220);

// Where a chunk of an Office file sits. The Office loaders (rag/office/) make
// one page per slide, visible sheet or top-level section and name it with
// locationUnit, plus locationLabel when it has a title (the slide title, the
// sheet name, the section heading); rag/chunker.js copies both onto every
// chunk cut from that page. pageNumber then counts that unit: the slide's
// position in the deck, the sheet's in the workbook, the section's in the
// document. A PDF chunk has neither field and its pageNumber is the page, so
// every projection below adds them only when present: a PDF citation, context
// entry, trace or stored record keeps exactly the shape it had before.
export const DOCUMENT_LOCATION_UNITS = Object.freeze(["slide", "sheet", "section"]);

// Labels are titles, not text: long enough for any slide title, sheet name or
// heading a reader would recognise, short enough for a citation chip. The
// chunker stores the label already cut this way (every chunk of a page
// repeats it), and every copy citations, feedback records and artifacts
// carry is cut again.
export const MAX_DOCUMENT_LOCATION_LABEL_LENGTH = 200;

/** "slide" | "sheet" | "section", or null for anything else (a PDF page). */
export const normalizeDocumentLocationUnit = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const unit = value.trim().toLowerCase();

  return DOCUMENT_LOCATION_UNITS.includes(unit) ? unit : null;
};

/**
 * A label on one line, without control characters, at most
 * MAX_DOCUMENT_LOCATION_LABEL_LENGTH characters; "" for a missing or blank
 * one. Cut by code point, so a label never ends in half a surrogate pair,
 * which PostgreSQL refuses in a json value (feedback and artifacts store
 * citations as json).
 */
export const normalizeDocumentLocationLabel = (value) => {
  if (typeof value !== "string") {
    return "";
  }

  const label = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const codePoints = Array.from(label);

  return codePoints.length > MAX_DOCUMENT_LOCATION_LABEL_LENGTH
    ? codePoints.slice(0, MAX_DOCUMENT_LOCATION_LABEL_LENGTH).join("").trimEnd()
    : label;
};

/**
 * { locationUnit, locationLabel? } of a chunk's metadata or a citation, or {}
 * when it names no known unit (every PDF chunk). A label is kept only with a
 * unit: without one there is nothing it could name. Spread it where the
 * projection lists pageNumber, so an Office citation reads "pageNumber,
 * locationUnit, locationLabel" and a PDF one is unchanged.
 */
export const pickDocumentLocation = (source) => {
  const locationUnit = normalizeDocumentLocationUnit(source?.locationUnit);

  if (!locationUnit) {
    return {};
  }

  const locationLabel = normalizeDocumentLocationLabel(source?.locationLabel);

  return locationLabel ? { locationUnit, locationLabel } : { locationUnit };
};

/**
 * The two fields exactly as a chunk's metadata holds them (strings only), for
 * a store that names its fields one by one (the Qdrant payload) and has to
 * give back what it was given. {} for a PDF chunk. Projections use
 * pickDocumentLocation instead.
 */
export const copyDocumentLocationFields = (source) => ({
  ...(typeof source?.locationUnit === "string" ? { locationUnit: source.locationUnit } : {}),
  ...(typeof source?.locationLabel === "string" ? { locationLabel: source.locationLabel } : {}),
});

/**
 * Where a citation points, as plain text (report artifacts): "page 4" for a
 * PDF ("" without a page number, as before), "slide 3", "section 2", and a
 * sheet by its name ("sheet Revenue"), else its position ("sheet 2").
 * `withLabel` adds a slide title or section heading the way the workbench
 * shows it ("slide 3 · Revenue"); a sheet's name is its location and never
 * repeats. No number is invented: a labelled slide without a position reads
 * as its label alone.
 */
export const formatCitationLocation = (citation, { withLabel = false } = {}) => {
  const pageNumber = citation?.pageNumber;
  const { locationUnit, locationLabel = "" } = pickDocumentLocation(citation);

  if (!locationUnit) {
    return pageNumber ? `page ${pageNumber}` : "";
  }

  if (locationUnit === "sheet") {
    const sheet = locationLabel || pageNumber;

    return sheet ? `sheet ${sheet}` : "";
  }

  const position = pageNumber ? `${locationUnit} ${pageNumber}` : "";

  if (!withLabel || !locationLabel) {
    return position;
  }

  return position ? `${position} · ${locationLabel}` : locationLabel;
};

export const buildCitation = (document, score, rank) => ({
  rank,
  score: Number(score.toFixed(4)),
  docId: document.metadata?.docId ?? null,
  fileName: document.metadata?.fileName ?? "Unknown document",
  filePath: document.metadata?.publicFilePath ?? "",
  pageNumber: getPageNumber(document.metadata),
  ...pickDocumentLocation(document.metadata),
  chunkIndex: document.metadata?.chunkIndex ?? null,
  excerpt: cleanExcerpt(document.pageContent),
  sectionHeading: document.metadata?.sectionHeading ?? null,
});

// The evidence-admission signal, kept deliberately separate from the fusion
// `score`. RRF (or weighted) fusion only ranks candidates; its output must never
// be read as a confidence or relevance probability. Admission is the strongest
// bounded raw retrieval signal a candidate carries -- dense cosine similarity or
// query-term coverage, both in [0, 1] -- so the gate that decides "is this real
// evidence" is judged on retrieval strength, not on a rank-sum that was scaled to
// clear a threshold. `sparseScore` (ts_rank_cd) is unbounded and ranking-only, so
// it is deliberately excluded here.
export const computeAdmissionScore = (result = {}) => {
  const vectorScore = Number(result?.vectorScore);
  const keywordScore = Number(result?.keywordScore);

  return Math.max(
    Number.isFinite(vectorScore) ? vectorScore : 0,
    Number.isFinite(keywordScore) ? keywordScore : 0
  );
};

// Prefer an admissionScore already stamped at fusion time; fall back to computing
// it from the raw components. Always returns a finite number, so callers can hand
// it straight to buildCitation without a guard.
export const getAdmissionScore = (result = {}) => {
  const stamped = Number(result?.admissionScore);

  return Number.isFinite(stamped) ? stamped : computeAdmissionScore(result);
};

/**
 * The location label a context section shows the model: a sheet's name, which
 * is how a workbook's sheets are told apart ("Sheet: Revenue"). A slide title
 * or section heading is not shown there (that line gives the position), so
 * this is null for them, as for a PDF. The answer writer screens this label
 * for prompt injection like the file name, since it is document text.
 */
export const getContextLocationLabel = (metadata) => {
  const { locationUnit, locationLabel } = pickDocumentLocation(metadata);

  return locationUnit === "sheet" && locationLabel ? locationLabel : null;
};

// "Page: N" for a PDF (no line without a page number, as before); "Slide: N"
// and "Section: N" for a slide or section; a sheet by its name, else by its
// position in the workbook.
const buildContextLocationLine = (metadata) => {
  const pageNumber = getPageNumber(metadata);
  const { locationUnit } = pickDocumentLocation(metadata);

  if (locationUnit === "sheet") {
    const sheet = getContextLocationLabel(metadata) ?? pageNumber;

    return sheet ? `Sheet: ${sheet}` : null;
  }

  if (!pageNumber) {
    return null;
  }

  if (locationUnit === "slide") {
    return `Slide: ${pageNumber}`;
  }

  return locationUnit === "section" ? `Section: ${pageNumber}` : `Page: ${pageNumber}`;
};

export const buildContextSection = (document, _score, rank) =>
  [
    `Source ${rank}`,
    `File: ${document.metadata?.fileName ?? "Unknown document"}`,
    buildContextLocationLine(document.metadata),
    document.metadata?.sectionHeading
      ? `Section: ${document.metadata.sectionHeading}`
      : null,
    `Evidence:`,
    document.pageContent,
  ]
    .filter(Boolean)
    .join("\n");

export const getResultKey = (resultOrDocument) => {
  const document = resultOrDocument.document ?? resultOrDocument;

  return `${document.metadata?.docId ?? "unknown"}:${document.metadata?.chunkIndex ?? document.id}`;
};

export const dedupeCitations = (citations, limit = citations.length) => {
  const seenCitationKeys = new Set();
  const dedupedCitations = [];

  for (const citation of citations) {
    const citationKey = `${citation.docId}:${citation.chunkIndex}:${citation.pageNumber}`;

    if (seenCitationKeys.has(citationKey)) {
      continue;
    }

    seenCitationKeys.add(citationKey);
    dedupedCitations.push(citation);

    if (dedupedCitations.length >= limit) {
      break;
    }
  }

  return dedupedCitations;
};

const normalizePositiveRank = (value) => {
  const rank = Number(value);

  return Number.isInteger(rank) && rank > 0 ? rank : null;
};

// locationUnit and locationLabel are not identity: docId, chunkIndex and
// pageNumber already name the chunk, and its unit follows from the document's
// format. dedupeCitations keys on the same three for the same reason; both
// keep the citation objects whole, location fields included.
const EXPLICIT_EVIDENCE_IDENTITY_FIELDS = Object.freeze([
  "docId",
  "docKey",
  "chunkIndex",
  "pageNumber",
  "fileName",
  "filePath",
  "url",
]);

const hasExplicitIdentityValue = (value) =>
  value !== null && value !== undefined && String(value).trim() !== "";

const normalizeIdentityValue = (value) => String(value).trim();

const hasExplicitIdentityConflict = (citation = {}, context = {}) =>
  EXPLICIT_EVIDENCE_IDENTITY_FIELDS.some((field) => {
    const citationValue = citation[field];
    const contextValue = context[field];

    return (
      hasExplicitIdentityValue(citationValue) &&
      hasExplicitIdentityValue(contextValue) &&
      normalizeIdentityValue(citationValue) !==
        normalizeIdentityValue(contextValue)
    );
  });

export const hasCompatibleEvidenceIdentity = (citation = {}, context = {}) => {
  const citationRank = normalizePositiveRank(citation.rank);
  const contextRank = normalizePositiveRank(context.rank);

  if (citationRank || contextRank) {
    return Boolean(
      citationRank &&
        contextRank &&
        citationRank === contextRank &&
        !hasExplicitIdentityConflict(citation, context)
    );
  }

  return Boolean(
    citation.docId &&
      context.docId &&
      citation.docId === context.docId &&
      citation.chunkIndex !== null &&
      citation.chunkIndex !== undefined &&
      citation.chunkIndex === context.chunkIndex &&
      !hasExplicitIdentityConflict(citation, context)
  );
};

export const attachRetrievedEvidence = ({
  citations = [],
  retrievedContexts = [],
} = {}) =>
  citations.map((citation) => {
    const context = retrievedContexts.find((candidate) =>
      hasCompatibleEvidenceIdentity(citation, candidate)
    );
    const evidenceText = String(context?.text ?? "").trim();

    return evidenceText
      ? {
          ...citation,
          evidenceText,
        }
      : citation;
  });
