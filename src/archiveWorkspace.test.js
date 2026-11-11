import {
  buildPreviewSourceFromDocument,
  withDocumentMimeType,
} from "./archiveWorkspace";

const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const DOCUMENTS = [
  {
    docId: "policy",
    fileName: "policy.pdf",
    mimeType: "application/pdf",
    publicFilePath: "documents/policy/file",
  },
  {
    docId: "deck",
    fileName: "review.pptx",
    mimeType: PPTX_MIME_TYPE,
    publicFilePath: "documents/deck/file",
  },
];

describe("withDocumentMimeType", () => {
  test("gives an Office citation its document's type", () => {
    const citation = { docId: "deck", fileName: "review.pptx", pageNumber: 3 };

    expect(withDocumentMimeType(citation, DOCUMENTS)).toEqual({
      ...citation,
      mimeType: PPTX_MIME_TYPE,
    });
  });

  test("passes a PDF citation, an unknown document and a typed source on unchanged", () => {
    const pdfCitation = { docId: "policy", fileName: "policy.pdf", pageNumber: 4 };
    const unknownCitation = { docId: "gone", fileName: "gone.pdf", pageNumber: 1 };
    const typedSource = { docId: "deck", mimeType: "application/pdf" };

    expect(withDocumentMimeType(pdfCitation, DOCUMENTS)).toBe(pdfCitation);
    expect(withDocumentMimeType(unknownCitation, DOCUMENTS)).toBe(unknownCitation);
    expect(withDocumentMimeType(typedSource, DOCUMENTS)).toBe(typedSource);
    expect(withDocumentMimeType(null, DOCUMENTS)).toBeNull();
  });
});

describe("buildPreviewSourceFromDocument", () => {
  test("keeps a PDF preview source exactly as it was", () => {
    expect(buildPreviewSourceFromDocument(DOCUMENTS[0])).toEqual({
      docId: "policy",
      fileName: "policy.pdf",
      filePath: "documents/policy/file",
      pageNumber: 1,
      excerpt: "",
      chunkIndex: null,
    });
    expect(
      Object.keys(
        buildPreviewSourceFromDocument(DOCUMENTS[0], {
          chunkIndex: 2,
          excerpt: "Remote work requires approval.",
          pageNumber: 4,
        })
      )
    ).toEqual(["docId", "fileName", "filePath", "pageNumber", "excerpt", "chunkIndex"]);
  });

  test("keeps an Office citation's location and never invents a page 1", () => {
    expect(
      buildPreviewSourceFromDocument(DOCUMENTS[1], {
        chunkIndex: 5,
        excerpt: "Revenue grew 12%.",
        locationLabel: "Q3 results",
        locationUnit: "slide",
        pageNumber: 3,
      })
    ).toEqual({
      docId: "deck",
      fileName: "review.pptx",
      filePath: "documents/deck/file",
      pageNumber: 3,
      excerpt: "Revenue grew 12%.",
      chunkIndex: 5,
      locationUnit: "slide",
      locationLabel: "Q3 results",
      mimeType: PPTX_MIME_TYPE,
    });
    expect(buildPreviewSourceFromDocument(DOCUMENTS[1]).pageNumber).toBeNull();
    expect(
      buildPreviewSourceFromDocument(
        { docId: "untyped", fileName: "notes.docx" },
        { locationUnit: "section" }
      ).pageNumber
    ).toBeNull();
  });
});
