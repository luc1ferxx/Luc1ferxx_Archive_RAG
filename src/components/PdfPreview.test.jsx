import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { createTranslator } from "../archiveI18n";
import PdfPreview from "./PdfPreview";

const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const archiveApiMocks = vi.hoisted(() => ({
  fetchDocumentFile: vi.fn(),
}));

vi.mock("../archiveApi", () => archiveApiMocks);

const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL"
);
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL"
);

describe("PdfPreview", () => {
  beforeEach(() => {
    archiveApiMocks.fetchDocumentFile.mockReset();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:authenticated-document"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();

    if (originalCreateObjectUrl) {
      Object.defineProperty(URL, "createObjectURL", originalCreateObjectUrl);
    } else {
      delete URL.createObjectURL;
    }

    if (originalRevokeObjectUrl) {
      Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectUrl);
    } else {
      delete URL.revokeObjectURL;
    }
  });

  test("renders selected source as one evidence object without fake citation counts", () => {
    render(
      <PdfPreview
        source={{
          docId: "renewal-policy",
          fileName: "Renewal Policy.pdf",
          pageNumber: 4,
          chunkIndex: 2,
          rank: 1,
          score: 0.87,
          excerpt: "Renewal notices must be sent before the contract end date.",
        }}
      />
    );

    expect(screen.getByText("Evidence object")).toBeInTheDocument();
    expect(screen.getAllByText("Renewal Policy.pdf").length).toBeGreaterThan(0);
    expect(screen.getByText("Citation")).toBeInTheDocument();
    expect(screen.queryByText("Citations (5)")).not.toBeInTheDocument();
    expect(screen.getByText("Rank")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("Score")).toBeInTheDocument();
    expect(screen.getByText("0.87")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Citation"));

    expect(screen.getByText("Selected citation")).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "Renewal notices must be sent before the contract end date."
      ).length
    ).toBeGreaterThan(0);
    expect(archiveApiMocks.fetchDocumentFile).not.toHaveBeenCalled();
  });

  test("loads protected PDF content through the authenticated API client", async () => {
    archiveApiMocks.fetchDocumentFile.mockResolvedValue({
      blob: new Blob(["%PDF-authenticated"], {
        type: "application/pdf",
      }),
      fileName: "Renewal Policy.pdf",
      mimeType: "application/pdf",
    });

    render(
      <PdfPreview
        source={{
          docId: "renewal-policy",
          fileName: "Renewal Policy.pdf",
          filePath: "documents/renewal-policy/file",
          pageNumber: 4,
        }}
      />
    );

    await waitFor(() => {
      expect(archiveApiMocks.fetchDocumentFile).toHaveBeenCalledWith(
        "renewal-policy",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });

    const frame = await screen.findByTitle("Renewal Policy.pdf preview");
    expect(frame).toHaveAttribute(
      "src",
      "blob:authenticated-document#page=4&view=FitH"
    );
    expect(screen.getByRole("link", { name: /Open/ })).toHaveAttribute(
      "href",
      "blob:authenticated-document#page=4&view=FitH"
    );
    expect(screen.getByRole("link", { name: /Open/ })).toHaveAttribute(
      "target",
      "_blank"
    );
    expect(screen.getByRole("link", { name: /Open/ })).toHaveAttribute(
      "rel",
      "noopener noreferrer"
    );
    expect(document.body.innerHTML).not.toContain(
      "http://localhost:5001/documents/renewal-policy/file"
    );

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(screen.getByTitle("Renewal Policy.pdf preview")).toHaveAttribute(
      "src",
      "blob:authenticated-document#page=5&view=FitH"
    );
    expect(archiveApiMocks.fetchDocumentFile).toHaveBeenCalledTimes(1);
  });

  test("shows a safe error without exposing failed auth details", async () => {
    archiveApiMocks.fetchDocumentFile.mockRejectedValue(
      new Error("401 for x-api-key super-secret-preview-token")
    );

    render(
      <PdfPreview
        source={{
          docId: "renewal-policy",
          fileName: "Renewal Policy.pdf",
          filePath: "documents/renewal-policy/file",
          pageNumber: 4,
        }}
      />
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Preview unavailable"
    );
    expect(document.body.innerHTML).not.toContain(
      "super-secret-preview-token"
    );
    expect(
      screen.queryByTitle("Renewal Policy.pdf preview")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open/ })).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  test("does not request a file when the source lacks a document ID", () => {
    render(
      <PdfPreview
        source={{
          fileName: "Unknown.pdf",
          filePath: "documents/untrusted/file",
          pageNumber: 1,
        }}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Preview unavailable");
    expect(archiveApiMocks.fetchDocumentFile).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain("documents/untrusted/file");
  });

  test("keeps the PDF preview's page labels and controls", async () => {
    archiveApiMocks.fetchDocumentFile.mockResolvedValue({
      blob: new Blob(["%PDF-authenticated"], { type: "application/pdf" }),
      fileName: "Renewal Policy.pdf",
      mimeType: "application/pdf",
    });

    render(
      <PdfPreview
        source={{
          docId: "renewal-policy",
          fileName: "Renewal Policy.pdf",
          filePath: "documents/renewal-policy/file",
          mimeType: "application/pdf",
          pageNumber: 4,
          chunkIndex: 2,
        }}
      />
    );

    expect(await screen.findByTitle("Renewal Policy.pdf preview")).toBeInTheDocument();
    expect(screen.getByText("Source · Page 4")).toBeInTheDocument();
    expect(screen.getByText("Page 4", { selector: ".archive-page-stepper" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeInTheDocument();
    expect(screen.getAllByText("PDF").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("This format has no inline preview. Download the file to open it.")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
  });

  describe("a file the browser cannot show inline", () => {
    const deckSource = {
      docId: "deck-1",
      fileName: "Quarterly Review.pptx",
      filePath: "documents/deck-1/file",
      mimeType: PPTX_MIME_TYPE,
      pageNumber: 3,
      chunkIndex: 5,
      rank: 1,
      score: 0.82,
      locationUnit: "slide",
      locationLabel: "Q3 results",
      excerpt: "Revenue grew 12% in the third quarter.",
    };
    let savedFiles;

    beforeEach(() => {
      savedFiles = [];
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click() {
        savedFiles.push({ download: this.download, href: this.href });
      });
    });

    test("names the file and the cited slide and offers the download instead", async () => {
      archiveApiMocks.fetchDocumentFile.mockResolvedValue({
        blob: new Blob(["PK"], { type: PPTX_MIME_TYPE }),
        fileName: "Quarterly Review.pptx",
        mimeType: PPTX_MIME_TYPE,
      });

      render(<PdfPreview source={deckSource} />);

      expect(archiveApiMocks.fetchDocumentFile).not.toHaveBeenCalled();
      expect(
        screen.getByText("This format has no inline preview. Download the file to open it.")
      ).toBeInTheDocument();
      expect(screen.getByText("Source · Slide 3 · Q3 results")).toBeInTheDocument();
      expect(
        screen.getByText("Slide 3 · Q3 results", { selector: ".archive-preview-location" })
      ).toBeInTheDocument();
      expect(screen.getByText("Cited evidence")).toBeInTheDocument();
      expect(
        screen.getAllByText("Revenue grew 12% in the third quarter.").length
      ).toBeGreaterThan(0);
      expect(screen.getAllByText("PPTX").length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "File" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
      expect(screen.queryByTitle("Quarterly Review.pptx preview")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Open/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/Page \d/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /Download/ }));

      await waitFor(() => {
        expect(savedFiles).toEqual([
          { download: "Quarterly Review.pptx", href: "blob:authenticated-document" },
        ]);
      });
      expect(archiveApiMocks.fetchDocumentFile).toHaveBeenCalledTimes(1);
      expect(archiveApiMocks.fetchDocumentFile).toHaveBeenCalledWith(
        "deck-1",
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:authenticated-document");
      expect(document.body.innerHTML).not.toContain("documents/deck-1/file");
    });

    test("recognises an Office citation whose document type did not reach it", () => {
      render(
        <PdfPreview
          source={{
            docId: "budget-1",
            fileName: "Budget 2026.xlsx",
            filePath: "documents/budget-1/file",
            pageNumber: 2,
            locationUnit: "sheet",
            locationLabel: "Revenue",
            excerpt: "Sheet: Revenue",
          }}
        />
      );

      expect(archiveApiMocks.fetchDocumentFile).not.toHaveBeenCalled();
      expect(screen.getByText("Source · Sheet Revenue")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Download/ })).toBeInTheDocument();
      expect(screen.getAllByText("XLSX").length).toBeGreaterThan(0);
    });

    test("shows the server's refusal, and nothing else a failed download carried", async () => {
      archiveApiMocks.fetchDocumentFile
        .mockRejectedValueOnce({
          message: "Request failed with status code 404",
          response: { data: { error: "Document not found." }, status: 404 },
        })
        .mockRejectedValueOnce(new Error("401 for x-api-key super-secret-preview-token"));

      render(<PdfPreview source={deckSource} />);

      fireEvent.click(screen.getByRole("button", { name: /Download/ }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Document not found.");

      fireEvent.click(screen.getByRole("button", { name: /Download/ }));
      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "The file could not be downloaded."
        );
      });
      expect(document.body.innerHTML).not.toContain("super-secret-preview-token");
      expect(savedFiles).toEqual([]);
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    test("shows the cited evidence without a download for a source with no stored file", () => {
      render(
        <PdfPreview
          source={{
            docId: "demo-procurement",
            fileName: "Procurement Guidelines.docx",
            filePath: "",
            pageNumber: 4,
            locationUnit: "section",
            locationLabel: "Travel purchases",
            excerpt: "Vendor travel purchases require manager approval.",
          }}
        />
      );

      expect(
        screen.getByText("This format has no inline preview. Download the file to open it.")
      ).toBeInTheDocument();
      expect(screen.getByText("Source · Section 4 · Travel purchases")).toBeInTheDocument();
      expect(
        screen.getAllByText("Vendor travel purchases require manager approval.").length
      ).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
      expect(archiveApiMocks.fetchDocumentFile).not.toHaveBeenCalled();
    });

    test("does not offer a download when the source does not identify its document", () => {
      render(<PdfPreview source={{ ...deckSource, docId: " " }} />);

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Download unavailable: the selected source does not identify its document."
      );
      expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
      expect(archiveApiMocks.fetchDocumentFile).not.toHaveBeenCalled();
    });

    test("follows the app's locale", () => {
      render(
        <PdfPreview
          source={{
            docId: "contract-1",
            fileName: "Contract.docx",
            filePath: "documents/contract-1/file",
            mimeType: DOCX_MIME_TYPE,
            pageNumber: 2,
            locationUnit: "section",
            locationLabel: "Scope",
            excerpt: "The scope covers maintenance.",
          }}
          t={createTranslator("zh")}
        />
      );

      expect(
        screen.getByText("此格式不支持内嵌预览，请下载文件后打开。")
      ).toBeInTheDocument();
      expect(
        screen.getByText("第 2 节 · Scope", { selector: ".archive-preview-location" })
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /下载/ })).toBeInTheDocument();
      expect(screen.getByText("引用证据")).toBeInTheDocument();
    });
  });
});
