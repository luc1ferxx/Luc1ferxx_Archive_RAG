import { createTranslator } from "./archiveI18n";

// Where a citation points inside its document, and what a document's page
// count counts. A PDF citation is a page and keeps today's wording ("Page N",
// "3 pages"). The Office formats the server ingests name their own unit on
// every citation they produce (locationUnit, plus a locationLabel when the
// unit has one): a PowerPoint slide (its title), an Excel sheet (its name) and
// a Word section (its heading). Their pageNumber is the slide's position in
// the deck, the sheet's position in the workbook or the section's position in
// the document, so it is never a page the PDF viewer could open.

const englishT = createTranslator("en");

export const PDF_MIME_TYPE = "application/pdf";
export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const DOCUMENT_FORMATS = Object.freeze({
  [PDF_MIME_TYPE]: Object.freeze({ id: "pdf", label: "PDF", unit: "page" }),
  [DOCX_MIME_TYPE]: Object.freeze({ id: "docx", label: "DOCX", unit: "section" }),
  [PPTX_MIME_TYPE]: Object.freeze({ id: "pptx", label: "PPTX", unit: "slide" }),
  [XLSX_MIME_TYPE]: Object.freeze({ id: "xlsx", label: "XLSX", unit: "sheet" }),
});

// The units a citation may name. A citation without one (every PDF citation)
// points at a page.
export const LOCATION_UNITS = Object.freeze(["slide", "sheet", "section"]);

const COUNT_UNIT_KEYS = Object.freeze({
  section: Object.freeze(["common.section", "common.sections"]),
  sheet: Object.freeze(["common.sheet", "common.sheets"]),
  slide: Object.freeze(["common.slide", "common.slides"]),
});

export const getBaseMimeType = (value) =>
  String(value ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

/**
 * The format a stored MIME type names ({ id, label, unit }), or null for a
 * missing or unknown type.
 */
export const getDocumentFormat = (mimeType) =>
  DOCUMENT_FORMATS[getBaseMimeType(mimeType)] ?? null;

/** "slide" | "sheet" | "section", or null for a page. */
export const getLocationUnit = (location) => {
  const unit = String(location?.locationUnit ?? "")
    .trim()
    .toLowerCase();

  return LOCATION_UNITS.includes(unit) ? unit : null;
};

const getLocationLabel = (location) =>
  String(location?.locationLabel ?? "").trim();

/**
 * Whether the browser can show the document inline (the authenticated PDF
 * preview). True for a PDF and, as before the Office formats, for a source
 * whose type is not known; false for any other stored type. A citation that
 * names a slide, sheet or section always comes from an Office file, so it is
 * never previewed as a PDF even when its document's type is not at hand.
 */
export const hasInlineDocumentPreview = (sourceOrDocument) => {
  if (getLocationUnit(sourceOrDocument)) {
    return false;
  }

  const mimeType = getBaseMimeType(sourceOrDocument?.mimeType);

  return !mimeType || mimeType === PDF_MIME_TYPE;
};

/**
 * The citation's location for display: "Page 4" for a PDF (empty without a
 * page, as before), "Slide 3 · Revenue", "Sheet Revenue" (a sheet without a
 * name: "Sheet 2") or "Section 2 · Scope". `withLabel: false` leaves a slide
 * title or section heading out (a sheet's name is its identity and stays).
 * Never invents a number: a slide or section without one shows its label alone.
 */
export const formatDocumentLocation = (
  location,
  t = englishT,
  { withLabel = true } = {}
) => {
  const unit = getLocationUnit(location);
  const number = location?.pageNumber;

  if (!unit) {
    return number ? t("location.page", { number }) : "";
  }

  const label = getLocationLabel(location);

  if (unit === "sheet") {
    if (label) {
      return t("location.sheet", { label });
    }

    return number ? t("location.sheetNumber", { number }) : "";
  }

  const position = number ? t(`location.${unit}`, { number }) : "";

  if (!withLabel || !label) {
    return position;
  }

  return position ? t("location.withLabel", { location: position, label }) : label;
};

/**
 * The i18n key of the unit an Office document's pageCount counts
 * ("common.slides", "common.sheet", ...); null for a PDF or a document whose
 * type is not known, so each caller keeps its own page wording unchanged.
 */
export const getDocumentCountUnitKey = (document, count) => {
  const keys = COUNT_UNIT_KEYS[getDocumentFormat(document?.mimeType)?.unit];

  if (!keys) {
    return null;
  }

  return Number(count) === 1 ? keys[0] : keys[1];
};

/** "12 slides", "1 sheet", "4 sections", or null for a PDF or unknown type. */
export const formatDocumentUnitCount = (document, count, t = englishT) => {
  const key = getDocumentCountUnitKey(document, count);

  return key ? `${count} ${t(key)}` : null;
};
