import { createTranslator } from "../archiveI18n";
import { buildSourceEvidenceObject } from "./evidenceSpine";

const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("buildSourceEvidenceObject", () => {
  test("describes a PDF source as it always did", () => {
    const source = {
      docId: "renewal-policy",
      fileName: "Renewal Policy.pdf",
      filePath: "documents/renewal-policy/file",
      pageNumber: 4,
      chunkIndex: 2,
      rank: 1,
      score: 0.87,
      excerpt: "Renewal notices must be sent before the contract end date.",
    };

    expect(buildSourceEvidenceObject(source)).toMatchObject({
      chunkIndex: 2,
      citations: [source],
      excerpt: source.excerpt,
      fileName: "Renewal Policy.pdf",
      filePath: "documents/renewal-policy/file",
      fileType: "PDF",
      hasInlinePreview: true,
      isDemoPreview: false,
      locationText: "Page 4",
      metadataRows: [
        { label: "Document", value: "Renewal Policy.pdf" },
        { label: "Page", value: "Page 4" },
        { label: "Chunk", value: "2" },
        { label: "Rank", value: "#1" },
        { label: "Score", value: "0.87" },
        { label: "Doc ID", value: "renewal-policy" },
        { label: "Type", value: "PDF" },
      ],
      pageNumber: 4,
      pageRange: "4",
      title: "Renewal Policy.pdf · Page 4",
    });
    // A PDF source without a page still opens on page 1.
    expect(
      buildSourceEvidenceObject({ docId: "a", fileName: "a.pdf", filePath: "x" })
    ).toMatchObject({ pageNumber: 1, pageRange: "1", title: "a.pdf · Page 1" });
  });

  test("names a sheet and keeps the citation's own number", () => {
    const evidence = buildSourceEvidenceObject(
      {
        docId: "budget",
        fileName: "Budget",
        filePath: "documents/budget/file",
        mimeType: XLSX_MIME_TYPE,
        pageNumber: 2,
        chunkIndex: 0,
        locationUnit: "sheet",
        locationLabel: "Revenue",
        excerpt: "Sheet: Revenue",
      },
      { t: createTranslator("zh") }
    );

    expect(evidence).toMatchObject({
      fileType: "XLSX",
      hasInlinePreview: false,
      locationText: "工作表 Revenue",
      locationUnit: "sheet",
      pageNumber: 2,
      title: "Budget · 工作表 Revenue",
    });
    expect(evidence.metadataRows).toContainEqual({
      label: "Location",
      value: "工作表 Revenue",
    });
    expect(evidence.metadataRows.map((row) => row.label)).not.toContain("Page");
  });

  test("never gives an Office source a page 1 it does not have", () => {
    const evidence = buildSourceEvidenceObject({
      docId: "contract",
      fileName: "contract.docx",
      filePath: "documents/contract/file",
      locationUnit: "section",
    });

    expect(evidence.pageNumber).toBeNull();
    expect(evidence.pageRange).toBeNull();
    expect(evidence.locationText).toBe("");
    expect(evidence.title).toBe("contract.docx");
    expect(evidence.fileType).toBe("DOCX");
    expect(evidence.metadataRows.map((row) => row.label)).toEqual([
      "Document",
      "Doc ID",
      "Type",
    ]);
  });
});
