import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import {
  useAuthenticatedDocumentDownload,
  useAuthenticatedDocumentPreview,
} from "./useAuthenticatedDocumentPreview";

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

const createDeferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve,
  };
};

const createPdfDownload = (content) => ({
  blob: new Blob([content], {
    type: "application/pdf",
  }),
  fileName: "document.pdf",
  mimeType: "application/pdf",
});

const PreviewHarness = ({ docId, onRender }) => {
  const preview = useAuthenticatedDocumentPreview({
    docId,
    enabled: true,
  });

  onRender?.({
    docId,
    ...preview,
  });

  return (
    <output data-testid="preview-state" data-status={preview.status}>
      {preview.objectUrl}
    </output>
  );
};

describe("useAuthenticatedDocumentPreview", () => {
  beforeEach(() => {
    archiveApiMocks.fetchDocumentFile.mockReset();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(),
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

  test("never exposes an object URL owned by the previous document", async () => {
    const secondDownload = createDeferred();
    const renders = [];
    URL.createObjectURL
      .mockReturnValueOnce("blob:document-a")
      .mockReturnValueOnce("blob:document-b");
    archiveApiMocks.fetchDocumentFile
      .mockResolvedValueOnce(createPdfDownload("%PDF-a"))
      .mockReturnValueOnce(secondDownload.promise);

    const { rerender } = render(
      <PreviewHarness
        docId="document-a"
        onRender={(preview) => renders.push(preview)}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-state")).toHaveTextContent(
        "blob:document-a"
      );
    });

    rerender(
      <PreviewHarness
        docId="document-b"
        onRender={(preview) => renders.push(preview)}
      />
    );

    expect(
      renders
        .filter((preview) => preview.docId === "document-b")
        .every((preview) => preview.objectUrl !== "blob:document-a")
    ).toBe(true);

    await act(async () => {
      secondDownload.resolve(createPdfDownload("%PDF-b"));
    });
  });

  test("ignores a late response after switching documents", async () => {
    const firstDownload = createDeferred();
    const secondDownload = createDeferred();
    URL.createObjectURL.mockReturnValue("blob:document-b");
    archiveApiMocks.fetchDocumentFile
      .mockReturnValueOnce(firstDownload.promise)
      .mockReturnValueOnce(secondDownload.promise);

    const { rerender } = render(<PreviewHarness docId="document-a" />);

    await waitFor(() => {
      expect(archiveApiMocks.fetchDocumentFile).toHaveBeenCalledTimes(1);
    });
    const firstSignal =
      archiveApiMocks.fetchDocumentFile.mock.calls[0][1].signal;

    rerender(<PreviewHarness docId="document-b" />);

    await waitFor(() => {
      expect(archiveApiMocks.fetchDocumentFile).toHaveBeenCalledTimes(2);
    });
    const secondSignal =
      archiveApiMocks.fetchDocumentFile.mock.calls[1][1].signal;
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);

    await act(async () => {
      secondDownload.resolve(createPdfDownload("%PDF-b"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("preview-state")).toHaveTextContent(
        "blob:document-b"
      );
    });

    await act(async () => {
      firstDownload.resolve(createPdfDownload("%PDF-a"));
    });

    expect(screen.getByTestId("preview-state")).toHaveTextContent(
      "blob:document-b"
    );
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  test("revokes each owned object URL on replacement and unmount", async () => {
    const secondDownload = createDeferred();
    URL.createObjectURL
      .mockReturnValueOnce("blob:document-a")
      .mockReturnValueOnce("blob:document-b");
    archiveApiMocks.fetchDocumentFile
      .mockResolvedValueOnce(createPdfDownload("%PDF-a"))
      .mockReturnValueOnce(secondDownload.promise);

    const { rerender, unmount } = render(
      <PreviewHarness docId="document-a" />
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-state")).toHaveTextContent(
        "blob:document-a"
      );
    });

    rerender(<PreviewHarness docId="document-b" />);

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:document-a");

    await act(async () => {
      secondDownload.resolve(createPdfDownload("%PDF-b"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("preview-state")).toHaveTextContent(
        "blob:document-b"
      );
    });

    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenLastCalledWith("blob:document-b");
  });

  test("rejects conflicting PDF and Blob MIME types without creating a URL", async () => {
    archiveApiMocks.fetchDocumentFile.mockResolvedValue({
      blob: new Blob(["<script>unsafe()</script>"], {
        type: "text/html",
      }),
      fileName: "document.pdf",
      mimeType: "application/pdf",
    });

    render(<PreviewHarness docId="document-a" />);

    await waitFor(() => {
      expect(screen.getByTestId("preview-state")).toHaveAttribute(
        "data-status",
        "error"
      );
    });

    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  test("fails closed without requesting a blank document ID", () => {
    render(<PreviewHarness docId="   " />);

    expect(screen.getByTestId("preview-state")).toHaveAttribute(
      "data-status",
      "error"
    );
    expect(archiveApiMocks.fetchDocumentFile).not.toHaveBeenCalled();
  });
});

const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const createDeckDownload = (fileName = "Quarterly Review.pptx") => ({
  blob: new Blob(["PK"], { type: PPTX_MIME_TYPE }),
  fileName,
  mimeType: PPTX_MIME_TYPE,
});

const DownloadHarness = ({ docId, fileName = "deck.pptx" }) => {
  const download = useAuthenticatedDocumentDownload({ docId, fileName });

  return (
    <div>
      <button type="button" onClick={() => void download.download()}>
        Download
      </button>
      <output data-testid="download-state" data-status={download.status}>
        {download.errorMessage}
      </output>
    </div>
  );
};

describe("useAuthenticatedDocumentDownload", () => {
  let savedFiles;

  beforeEach(() => {
    archiveApiMocks.fetchDocumentFile.mockReset();
    savedFiles = [];
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:document-file"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click() {
      savedFiles.push({
        attached: document.body.contains(this),
        download: this.download,
        href: this.href,
      });
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

  test("saves the stored file under the server's name, then revokes its URL", async () => {
    archiveApiMocks.fetchDocumentFile.mockResolvedValue(createDeckDownload());

    render(<DownloadHarness docId=" deck-1 " />);
    expect(archiveApiMocks.fetchDocumentFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => {
      expect(savedFiles).toEqual([
        { attached: true, download: "Quarterly Review.pptx", href: "blob:document-file" },
      ]);
    });
    expect(archiveApiMocks.fetchDocumentFile).toHaveBeenCalledWith(
      "deck-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:document-file");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(screen.getByTestId("download-state")).toHaveAttribute("data-status", "idle");
  });

  test("falls back to the source's file name", async () => {
    archiveApiMocks.fetchDocumentFile.mockResolvedValue(createDeckDownload(""));

    render(<DownloadHarness docId="deck-1" fileName="Board deck.pptx" />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => {
      expect(savedFiles.map((file) => file.download)).toEqual(["Board deck.pptx"]);
    });
  });

  test("ignores a click while a download runs", async () => {
    const pending = createDeferred();
    archiveApiMocks.fetchDocumentFile.mockReturnValue(pending.promise);

    render(<DownloadHarness docId="deck-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(screen.getByTestId("download-state")).toHaveAttribute(
      "data-status",
      "downloading"
    );
    expect(archiveApiMocks.fetchDocumentFile).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(createDeckDownload());
    });

    expect(savedFiles).toHaveLength(1);
  });

  test("saves nothing for a document the user moved away from", async () => {
    const pending = createDeferred();
    archiveApiMocks.fetchDocumentFile.mockReturnValue(pending.promise);

    const { rerender } = render(<DownloadHarness docId="deck-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const signal = archiveApiMocks.fetchDocumentFile.mock.calls[0][1].signal;

    rerender(<DownloadHarness docId="deck-2" />);

    expect(signal.aborted).toBe(true);
    expect(screen.getByTestId("download-state")).toHaveAttribute("data-status", "idle");

    await act(async () => {
      pending.resolve(createDeckDownload());
    });

    expect(savedFiles).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    // Back on the first document, the aborted download no longer shows, and a
    // click starts a new one.
    rerender(<DownloadHarness docId="deck-1" />);
    expect(screen.getByTestId("download-state")).toHaveAttribute("data-status", "idle");

    archiveApiMocks.fetchDocumentFile.mockResolvedValue(createDeckDownload());
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => {
      expect(savedFiles.map((file) => file.download)).toEqual(["Quarterly Review.pptx"]);
    });
    expect(archiveApiMocks.fetchDocumentFile).toHaveBeenCalledTimes(2);
  });

  test("an aborted download that settles late leaves a newer download of the same document alone", async () => {
    const first = createDeferred();
    const second = createDeferred();
    archiveApiMocks.fetchDocumentFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { rerender } = render(<DownloadHarness docId="deck-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    rerender(<DownloadHarness docId="deck-2" />);
    rerender(<DownloadHarness docId="deck-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(screen.getByTestId("download-state")).toHaveAttribute("data-status", "downloading");

    // The first, aborted request settles only now.
    await act(async () => {
      first.resolve(createDeckDownload("stale.pptx"));
    });
    expect(screen.getByTestId("download-state")).toHaveAttribute("data-status", "downloading");

    await act(async () => {
      second.resolve(createDeckDownload("fresh.pptx"));
    });
    expect(savedFiles.map((file) => file.download)).toEqual(["fresh.pptx"]);
    expect(screen.getByTestId("download-state")).toHaveAttribute("data-status", "idle");
  });

  test("saves nothing after unmounting", async () => {
    const pending = createDeferred();
    archiveApiMocks.fetchDocumentFile.mockReturnValue(pending.promise);

    const { unmount } = render(<DownloadHarness docId="deck-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const signal = archiveApiMocks.fetchDocumentFile.mock.calls[0][1].signal;

    unmount();

    expect(signal.aborted).toBe(true);

    await act(async () => {
      pending.resolve(createDeckDownload());
    });

    expect(savedFiles).toEqual([]);
  });

  test("reports the server's refusal and keeps a client error's text out", async () => {
    archiveApiMocks.fetchDocumentFile
      .mockRejectedValueOnce({
        response: { data: { error: "Document not found." }, status: 404 },
      })
      .mockRejectedValueOnce(new Error("401 for x-api-key super-secret-download-token"));

    render(<DownloadHarness docId="deck-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => {
      expect(screen.getByTestId("download-state")).toHaveAttribute("data-status", "error");
    });
    expect(screen.getByTestId("download-state")).toHaveTextContent("Document not found.");

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => {
      expect(screen.getByTestId("download-state")).toHaveAttribute("data-status", "error");
    });
    expect(screen.getByTestId("download-state")).toHaveTextContent("");
    expect(document.body.innerHTML).not.toContain("super-secret-download-token");
    expect(savedFiles).toEqual([]);
  });

  test("never requests a blank document ID", () => {
    render(<DownloadHarness docId="  " />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(archiveApiMocks.fetchDocumentFile).not.toHaveBeenCalled();
    expect(screen.getByTestId("download-state")).toHaveAttribute("data-status", "idle");
  });
});
