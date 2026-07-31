import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import PdfPreview from "./PdfPreview";

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
});
