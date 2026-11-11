import { createTranslator } from "./archiveI18n";
import {
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
  formatDocumentLocation,
  formatDocumentUnitCount,
  getDocumentCountUnitKey,
  getDocumentFormat,
  getLocationUnit,
  hasInlineDocumentPreview,
} from "./documentLocation";

const en = createTranslator("en");
const zh = createTranslator("zh");

describe("formatDocumentLocation", () => {
  test("keeps today's page label for a citation without a unit", () => {
    expect(formatDocumentLocation({ pageNumber: 4 })).toBe("Page 4");
    expect(formatDocumentLocation({ pageNumber: 4 }, en)).toBe("Page 4");
    expect(formatDocumentLocation({ pageNumber: 4 }, zh)).toBe("第 4 页");
    // As before: no page, no label.
    expect(formatDocumentLocation({ pageNumber: null })).toBe("");
    expect(formatDocumentLocation({})).toBe("");
    expect(formatDocumentLocation(null)).toBe("");
  });

  test("labels a slide by its position and title", () => {
    const slide = { locationUnit: "slide", locationLabel: "Q3 results", pageNumber: 3 };

    expect(formatDocumentLocation(slide, en)).toBe("Slide 3 · Q3 results");
    expect(formatDocumentLocation(slide, zh)).toBe("第 3 张幻灯片 · Q3 results");
    expect(formatDocumentLocation({ locationUnit: "slide", pageNumber: 7 }, en)).toBe(
      "Slide 7"
    );
    expect(formatDocumentLocation({ locationUnit: "slide", pageNumber: 7 }, zh)).toBe(
      "第 7 张幻灯片"
    );
    expect(formatDocumentLocation(slide, en, { withLabel: false })).toBe("Slide 3");
  });

  test("labels a sheet by its name, else its position", () => {
    const sheet = { locationUnit: "sheet", locationLabel: "Revenue", pageNumber: 2 };

    expect(formatDocumentLocation(sheet, en)).toBe("Sheet Revenue");
    expect(formatDocumentLocation(sheet, zh)).toBe("工作表 Revenue");
    // The name is the sheet's identity, so it stays without the suffix too.
    expect(formatDocumentLocation(sheet, en, { withLabel: false })).toBe("Sheet Revenue");
    expect(formatDocumentLocation({ locationUnit: "sheet", pageNumber: 2 }, en)).toBe(
      "Sheet 2"
    );
    expect(formatDocumentLocation({ locationUnit: "sheet", pageNumber: 2 }, zh)).toBe(
      "第 2 个工作表"
    );
  });

  test("labels a section by its position and heading", () => {
    const section = { locationUnit: "section", locationLabel: "Scope", pageNumber: 2 };

    expect(formatDocumentLocation(section, en)).toBe("Section 2 · Scope");
    expect(formatDocumentLocation(section, zh)).toBe("第 2 节 · Scope");
    // A preface has no heading.
    expect(formatDocumentLocation({ locationUnit: "section", pageNumber: 1 }, en)).toBe(
      "Section 1"
    );
    expect(formatDocumentLocation({ locationUnit: "section", pageNumber: 1 }, zh)).toBe(
      "第 1 节"
    );
  });

  test("never invents a number for a unit without one", () => {
    expect(
      formatDocumentLocation({ locationUnit: "slide", locationLabel: "Agenda" }, en)
    ).toBe("Agenda");
    expect(formatDocumentLocation({ locationUnit: "section" }, en)).toBe("");
    expect(formatDocumentLocation({ locationUnit: "sheet" }, en)).toBe("");
  });

  test("reads the unit case-insensitively and treats an unknown one as a page", () => {
    expect(getLocationUnit({ locationUnit: " Slide " })).toBe("slide");
    expect(getLocationUnit({ locationUnit: "chapter" })).toBeNull();
    expect(getLocationUnit({})).toBeNull();
    expect(formatDocumentLocation({ locationUnit: "chapter", pageNumber: 5 }, en)).toBe(
      "Page 5"
    );
  });

  test("keeps a label's own braces as text", () => {
    expect(
      formatDocumentLocation(
        { locationUnit: "slide", locationLabel: "Plan {label} {number}", pageNumber: 1 },
        en
      )
    ).toBe("Slide 1 · Plan {label} {number}");
  });
});

describe("document formats", () => {
  test("maps the stored MIME types to their formats", () => {
    expect(getDocumentFormat(PDF_MIME_TYPE)).toMatchObject({ id: "pdf", unit: "page" });
    expect(getDocumentFormat(DOCX_MIME_TYPE)).toMatchObject({ id: "docx", unit: "section" });
    expect(getDocumentFormat(PPTX_MIME_TYPE)).toMatchObject({ id: "pptx", unit: "slide" });
    expect(getDocumentFormat(`${XLSX_MIME_TYPE}; charset=binary`)).toMatchObject({
      id: "xlsx",
      unit: "sheet",
    });
    expect(getDocumentFormat(undefined)).toBeNull();
    expect(getDocumentFormat("text/plain")).toBeNull();
  });

  test("previews PDFs and sources of unknown type inline, nothing else", () => {
    expect(hasInlineDocumentPreview({ mimeType: PDF_MIME_TYPE })).toBe(true);
    expect(hasInlineDocumentPreview({})).toBe(true);
    expect(hasInlineDocumentPreview(null)).toBe(true);
    expect(hasInlineDocumentPreview({ mimeType: PPTX_MIME_TYPE })).toBe(false);
    expect(hasInlineDocumentPreview({ mimeType: "text/plain" })).toBe(false);
    // A citation that names a slide is never a PDF, whatever reached the preview.
    expect(hasInlineDocumentPreview({ locationUnit: "slide", pageNumber: 2 })).toBe(false);
  });

  test("counts slides, sheets and sections, and leaves PDFs to their callers", () => {
    expect(formatDocumentUnitCount({ mimeType: PPTX_MIME_TYPE }, 12, en)).toBe("12 slides");
    expect(formatDocumentUnitCount({ mimeType: PPTX_MIME_TYPE }, 1, en)).toBe("1 slide");
    expect(formatDocumentUnitCount({ mimeType: XLSX_MIME_TYPE }, 3, en)).toBe("3 sheets");
    expect(formatDocumentUnitCount({ mimeType: DOCX_MIME_TYPE }, 4, en)).toBe("4 sections");
    expect(formatDocumentUnitCount({ mimeType: PPTX_MIME_TYPE }, 12, zh)).toBe("12 张幻灯片");
    expect(formatDocumentUnitCount({ mimeType: XLSX_MIME_TYPE }, 3, zh)).toBe("3 个工作表");
    expect(formatDocumentUnitCount({ mimeType: DOCX_MIME_TYPE }, 4, zh)).toBe("4 节");
    expect(formatDocumentUnitCount({ mimeType: PDF_MIME_TYPE }, 3, en)).toBeNull();
    expect(formatDocumentUnitCount({}, 3, en)).toBeNull();
    expect(getDocumentCountUnitKey({ mimeType: XLSX_MIME_TYPE }, "?")).toBe("common.sheets");
  });
});
